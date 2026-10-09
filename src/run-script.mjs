// Runs one Pine Script over a candle series with PineTS and shapes the result for TraderX:
// the script's inputs, its plots, its alerts, and, for strategy() scripts, the trade ledger
// turned into the four signals TraderX executes (entry long, exit long, entry short, exit short).
//
// Pure: no network, no globals. The server calls it inside a worker thread.

import { PineTS, Indicator } from 'pinets';

/** Hyperliquid interval → PineTS/TradingView timeframe string. */
export const TIMEFRAMES = {
  '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30',
  '1h': '60', '2h': '120', '4h': '240', '8h': '480', '12h': '720',
  '1d': 'D', '3d': '3D', '1w': 'W', '1M': 'M',
};

export const SIGNAL_TYPES = ['entry-long', 'exit-long', 'entry-short', 'exit-short'];

/** Plot keys PineTS uses for drawing objects, not series. */
const DRAWING_KEYS = new Set(['__labels__', '__lines__', '__boxes__', '__linefills__', '__polylines__', '__tables__']);

/**
 * @param {object} req
 * @param {string} req.source Pine Script v5/v6 source.
 * @param {{openTime:number, closeTime?:number, open:number, high:number, low:number, close:number, volume:number}[]} req.candles Oldest first.
 * @param {string} req.interval Hyperliquid interval, e.g. "1h".
 * @param {string} [req.symbol]
 * @param {Record<string, unknown>} [req.inputs] Overrides keyed by input title.
 */
export async function runScript({ source, candles, interval, symbol = 'COIN', inputs = {} }) {
  const timeframe = TIMEFRAMES[interval];
  if (!timeframe) throw new UserError(`Unsupported interval "${interval}".`);
  if (!Array.isArray(candles) || candles.length === 0) throw new UserError('No candles to run on.');

  const indicator = new Indicator(source, inputs);
  const declaration = indicator.getDeclarationType();
  const inputsMeta = indicator.getInputsMeta().map((i) => ({
    id: i.id, title: i.title ?? i.name, type: i.type, defval: i.defval,
    options: i.options, minval: i.minval, maxval: i.maxval, step: i.step, group: i.group, tooltip: i.tooltip,
  }));

  const pine = new PineTS(candles, symbol, timeframe);
  // Backtests need every historical alert, not only those on a live bar (TradingView's default).
  pine.setAlertMode('all');
  const ctx = await pine.run(indicator);

  const plots = {};
  for (const [title, plot] of Object.entries(ctx.plots ?? {})) {
    if (DRAWING_KEYS.has(title)) continue;
    plots[title] = (plot.data ?? []).map((p) => ({ time: p.time, value: Number.isFinite(p.value) ? p.value : null }));
  }

  const alerts = (ctx.alerts ?? []).map((a) => ({ id: a.id, title: a.title ?? null, message: a.message, bar: a.bar_index, time: a.time }));

  const strategy = ctx.strategy ? summarizeStrategy(ctx.strategy, candles) : null;

  // Whether the script draws on the price pane (overlay=true) or its own pane, and its title.
  const declared = ctx.indicator ?? ctx.strategy?.config ?? {};

  return {
    declaration,
    title: declared.title ?? null,
    overlay: Boolean(declared.overlay),
    inputs: inputsMeta,
    bars: candles.length,
    /** Open time of the first bar and close time of the last, so a backtest can use the same window. */
    range: { from: candles[0].openTime, to: candles.at(-1).closeTime ?? candles.at(-1).openTime },
    plots,
    alerts,
    strategy,
    signals: strategy ? strategy.signals : [],
    warnings: (ctx.warnings ?? []).slice(0, 50),
  };
}

/**
 * The ledger as trades plus the four TraderX signals, ordered by bar.
 *
 * The ledger records the bar an order FILLED on. TraderX acts on the bar a decision was made (a closed candle), so each
 * signal carries the decision bar: the bar before a fill at that bar's open (a market order placed on the previous
 * close, PineTS's default), else the fill bar itself. A stop or limit that fills mid-bar can't be known before that
 * bar, so it signals on its fill bar and TraderX acts one bar later, never earlier than the script could have.
 */
export function summarizeStrategy(state, candles = []) {
  const onClose = Boolean(state.config?.process_orders_on_close);
  const decisionBar = (bar, price) => {
    if (bar == null) return null;
    if (onClose || bar === 0) return bar;
    const open = candles[bar]?.open;
    return open != null && Math.abs(price - open) <= Math.abs(open) * 1e-9 ? bar - 1 : bar;
  };
  const all = [...(state.closedtrades ?? []), ...(state.opentrades ?? [])];
  const trades = all.map((t) => ({
    side: t.size > 0 ? 'long' : 'short',
    size: Math.abs(t.size),
    entryBar: decisionBar(t.entry_bar_index, t.entry_price), entryFillBar: t.entry_bar_index,
    entryDecisionTime: candles[decisionBar(t.entry_bar_index, t.entry_price)]?.openTime ?? t.entry_time,
    entryTime: t.entry_time, entryPrice: t.entry_price, entryId: t.entry_id,
    exitBar: decisionBar(t.exit_bar_index ?? null, t.exit_price), exitFillBar: t.exit_bar_index ?? null,
    exitDecisionTime: t.exit_bar_index == null ? null : candles[decisionBar(t.exit_bar_index, t.exit_price)]?.openTime ?? t.exit_time,
    exitTime: t.exit_time ?? null, exitPrice: t.exit_price ?? null, exitId: t.exit_id ?? null,
    profit: t.profit ?? null,
    status: t.status,
  }));
  return { trades, signals: tradesToSignals(trades), netProfit: state.netprofit ?? 0, wins: state.wintrades ?? 0, losses: state.losstrades ?? 0 };
}

/**
 * One signal per position change, timed by its decision bar's open time (what TraderX matches candles on). Pyramided lots that open on the same bar and side collapse into one entry, and
 * lots closed together into one exit. A reversal on one bar gives the exit before the new entry.
 */
export function tradesToSignals(trades) {
  const seen = new Set();
  const out = [];
  const add = (type, bar, time, price) => {
    if (bar == null) return;
    const key = `${type}:${bar}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ type, bar, time, price });
  };
  for (const t of trades) {
    add(t.side === 'long' ? 'entry-long' : 'entry-short', t.entryBar, t.entryDecisionTime ?? t.entryTime, t.entryPrice);
    if (t.exitBar != null) add(t.side === 'long' ? 'exit-long' : 'exit-short', t.exitBar, t.exitDecisionTime ?? t.exitTime, t.exitPrice);
  }
  const order = { 'exit-long': 0, 'exit-short': 0, 'entry-long': 1, 'entry-short': 1 };
  return out.sort((a, b) => a.bar - b.bar || order[a.type] - order[b.type]);
}

/** A problem with the script or request, safe to show the user. */
export class UserError extends Error {}

// Runs one Pine Script over a candle series with PineTS and shapes the result for TraderX:
// the script's inputs, its plots, its alerts, and, for strategy() scripts, the trade ledger
// turned into the four signals TraderX executes (entry long, exit long, entry short, exit short).
//
// No globals. The only network use is request.security loading other timeframes or symbols from Hyperliquid
// (see provider.mjs). The server calls it inside a worker thread.

import { PineTS, Indicator } from 'pinets';
import { UserError } from './errors.mjs';
import { conditionsToSignals, hasConditions, validateConditions } from './conditions.mjs';
import { createProvider } from './provider.mjs';

export { UserError };

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
 * @param {Record<string, object[]>} [req.conditions] Rules set on our side (see conditions.mjs). When given, they decide
 *   the signals instead of the script's own strategy calls.
 * @param {Function} [req.loadCandles] (coin, interval, startTime, endTime) → candles, for request.security. The worker
 *   passes one that asks the parent process; without it, candles are fetched from Hyperliquid directly.
 */
export async function runScript({ source, candles, interval, symbol = 'COIN', inputs = {}, conditions = null, loadCandles }) {
  const timeframe = TIMEFRAMES[interval];
  if (!timeframe) throw new UserError(`Unsupported interval "${interval}".`);
  if (!Array.isArray(candles) || candles.length === 0) throw new UserError('No candles to run on.');
  validateConditions(conditions);

  const indicator = new Indicator(source, inputs);
  const declaration = indicator.getDeclarationType();
  const inputsMeta = indicator.getInputsMeta().map((i) => ({
    id: i.id, title: i.title ?? i.name, type: i.type, defval: i.defval,
    options: i.options, minval: i.minval, maxval: i.maxval, step: i.step, group: i.group, tooltip: i.tooltip,
  }));

  // A provider rather than the bare candles, so request.security can load other timeframes and symbols.
  const pine = new PineTS(createProvider({ coin: symbol, timeframe, candles, loadCandles }), symbol, timeframe);
  // Backtests need every historical alert, not only those on a live bar (TradingView's default).
  pine.setAlertMode('all');
  const ctx = await pine.run(indicator);

  // Lines (plot, hline) are numeric series. Arrows and characters (plotshape, plotchar) are true/false per bar, and
  // background shading (bgcolor) is a color per bar: those are events, like alerts and labels.
  const plots = {};
  const events = [];
  for (const [rawTitle, plot] of Object.entries(ctx.plots ?? {})) {
    if (DRAWING_KEYS.has(rawTitle)) continue;
    // An untitled plot comes back as "#0", "#1"…; name it the way TradingView's legend does.
    const title = /^#\d+$/.test(rawTitle) ? `Plot ${Number(rawTitle.slice(1)) + 1}` : rawTitle;
    const data = plot.data ?? [];
    // bgcolor: true on shaded bars.
    if (plot.options?.style === 'background') {
      events.push({ key: `background:${title}`, title, kind: 'background', times: data.filter((p) => p.value === true || p.options?.color).map((p) => p.time) });
      continue;
    }
    if (data.some((p) => typeof p.value === 'boolean')) {
      events.push({
        key: `shape:${title}`,
        title,
        kind: data.some((p) => p.options?.char) ? 'char' : 'shape',
        times: data.filter((p) => p.value === true).map((p) => p.time),
      });
      continue;
    }
    plots[title] = data.map((p) => ({ time: p.time, value: Number.isFinite(p.value) ? p.value : null }));
  }

  // Labels (label.new), grouped by their text. Pine keeps only the newest max_labels_count (50 by default), so older
  // ones are gone by the end of the run and labels cover recent history only.
  const labelsByText = new Map();
  for (const label of ctx.plots?.__labels__?.data?.[0]?.value ?? []) {
    const text = String(label.text ?? '').trim();
    if (!text) continue;
    const time = label.xloc === 'bt' ? label.x : candles[label.x]?.openTime;
    if (time == null) continue;
    if (!labelsByText.has(text)) labelsByText.set(text, []);
    labelsByText.get(text).push(time);
  }
  for (const [text, times] of labelsByText) events.push({ key: `label:${text}`, title: text, kind: 'label', times: times.sort((a, b) => a - b) });

  // alertcondition(cond, title=..., message=...) with named arguments comes back from PineTS as title: { title, message }.
  const alerts = (ctx.alerts ?? []).map((a) => {
    const named = a.title && typeof a.title === 'object' ? a.title : null;
    return { id: a.id, title: (named ? named.title : a.title) ?? null, message: (named ? named.message : a.message) ?? '', bar: a.bar_index, time: a.time };
  });
  const alertTimes = new Map();
  for (const a of alerts) {
    const title = a.title ?? a.id;
    if (!alertTimes.has(title)) alertTimes.set(title, []);
    alertTimes.get(title).push(a.time);
  }
  for (const [title, times] of alertTimes) events.push({ key: `alert:${title}`, title, kind: 'alert', times });

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
    /** Arrows, characters, background shading, labels and alerts, as things that happen on bars (key: kind:title). */
    events,
    alerts,
    strategy,
    signals: hasConditions(conditions)
      ? conditionsToSignals(conditions, plots, events, candles)
      : strategy ? strategy.signals : [],
    signalSource: hasConditions(conditions) ? 'conditions' : strategy ? 'strategy' : 'none',
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
  const signals = mergeSignals(tradesToSignals(trades), pendingSignals(state, candles));
  return { trades, signals, netProfit: state.netprofit ?? 0, wins: state.wintrades ?? 0, losses: state.losstrades ?? 0 };
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

/**
 * Market orders the script placed on the last bar. They fill at the next bar's open, which hasn't happened yet, so they
 * are not in the ledger. Live trading acts on exactly these: the decision just made on the candle that closed.
 * Stop and limit orders are not decisions until they trigger, so they are left out.
 */
export function pendingSignals(state, candles) {
  const last = candles.length - 1;
  if (last < 0) return [];
  const time = candles[last].openTime;
  const price = candles[last].close;
  const position = state.position_size ?? 0;
  const out = [];
  for (const o of state.pending_orders ?? []) {
    if (o.status !== 'pending' || o.type !== 'market' || o.bar !== last) continue;
    if (o.category === 'exit') {
      if (position > 0) out.push({ type: 'exit-long', bar: last, time, price });
      else if (position < 0) out.push({ type: 'exit-short', bar: last, time, price });
      continue;
    }
    const long = o.direction > 0;
    if (long && position < 0) out.push({ type: 'exit-short', bar: last, time, price });
    if (!long && position > 0) out.push({ type: 'exit-long', bar: last, time, price });
    if ((long && position <= 0) || (!long && position >= 0)) out.push({ type: long ? 'entry-long' : 'entry-short', bar: last, time, price });
  }
  return out;
}

/** Ledger and pending signals together, one per type and bar, exits before entries. */
export function mergeSignals(...lists) {
  const seen = new Set();
  const order = { 'exit-long': 0, 'exit-short': 0, 'entry-long': 1, 'entry-short': 1 };
  return lists
    .flat()
    .filter((s) => {
      const key = `${s.type}:${s.bar}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.bar - b.bar || order[a.type] - order[b.type]);
}


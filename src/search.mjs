// AI mode: find the conditions that trade an indicator best, the way BB TraderX AI Studio's Find does.
//
// 1. Atoms: every sensible rule the indicator's output allows — line crosses line, price crosses line, an oscillator
//    crosses a level, a line crosses zero, an arrow/label/alert appears — plus trend filters (price above a line, a line
//    above another).
// 2. Candidates: always-in-market flips (an entry and its mirror), long-only and short-only with an exit, and the same
//    with a trend filter. Each is played through one position exactly like conditions.mjs (enter when flat, long wins a
//    tie, the opposite entry reverses), fills at the next bar's open, with Hyperliquid fees and slippage.
// 3. Robustness: the first 80% of history is split into four periods; a candidate must trade enough and make money in
//    at least three of them. Survivors are ranked on that history.
// 4. Unseen check: the top ranked are graded on the last 20%, which the search never looked at, against holding the
//    coin over the same stretch. Results come back best first, each as conditions ready to use.
//
// Numbers here are the search's own simulation. The page backtests the chosen conditions with the TraderX engine,
// which is what users see as results.

import { conditionsToSignals } from './conditions.mjs';

const TRAIN_SHARE = 0.8;
const PERIODS = 4;
const MIN_PERIODS_PROFITABLE = 3;
const MIN_TRAIN_TRADES = 12;
const FINALISTS = 25;
const RESULTS = 5;
const MAX_LINES = 6;
const OSC_LEVELS = [20, 30, 40, 50, 60, 70, 80];

/** Round-trip cost in percent: taker + builder fee on both sides, plus slippage on both fills (TraderX backtest model). */
export const DEFAULT_COST_PCT = 2 * (0.045 + 0.1) + 2 * 0.02;

/**
 * @param {{plots: Record<string, {time:number, value:number|null}[]>, events: {key:string, title:string, kind:string, times:number[]}[], overlay: boolean}} run
 * @param {{openTime:number, open:number, close:number}[]} candles
 */
export function searchConditions(run, candles, { costPct = DEFAULT_COST_PCT, deadlineMs = Infinity } = {}) {
  const started = Date.now();
  const n = candles.length;
  const barByTime = new Map(candles.map((c, i) => [c.openTime, i]));
  const close = candles.map((c) => c.close);
  const open = candles.map((c) => (c.open > 0 ? c.open : c.close));

  // ── Series ────────────────────────────────────────────────────────────────────────────────────
  const lines = [];
  for (const [title, points] of Object.entries(run.plots)) {
    const values = new Array(n).fill(null);
    for (const p of points) {
      const i = barByTime.get(p.time);
      if (i != null && p.value != null && Number.isFinite(p.value)) values[i] = p.value;
    }
    const finite = values.filter((v) => v != null);
    if (finite.length < n * 0.5) continue;
    const min = Math.min(...finite), max = Math.max(...finite);
    if (max - min <= 0) continue; // a flat line (an hline level) can't cross anything usefully on its own
    lines.push({ key: `plot:${title}`, title, values, min, max });
    if (lines.length >= MAX_LINES) break;
  }
  const price = { key: 'price:close', title: 'Close', values: close };
  // Lines on the price scale: those whose values sit within the price's range.
  const pMin = Math.min(...close), pMax = Math.max(...close);
  const onPriceScale = (l) => l.min > pMin * 0.5 && l.max < pMax * 1.5;

  // ── Atoms: boolean per bar, with the rule that produces it and its mirror ─────────────────────
  const atoms = [];
  const add = (rule, mirror, values) => {
    if (values.some(Boolean)) atoms.push({ rule, mirror, values });
  };
  const crossUp = (a, b) => a.map((v, i) => i > 0 && v != null && b[i] != null && a[i - 1] != null && b[i - 1] != null && a[i - 1] <= b[i - 1] && v > b[i]);
  const crossDown = (a, b) => a.map((v, i) => i > 0 && v != null && b[i] != null && a[i - 1] != null && b[i - 1] != null && a[i - 1] >= b[i - 1] && v < b[i]);
  const constant = (x) => new Array(n).fill(x);
  const rule = (left, op, right) => (right == null ? { left, op } : { left, op, right });

  // Line crosses line (both on the same scale), and price crosses line.
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i], b = lines[j];
      if (onPriceScale(a) !== onPriceScale(b)) continue;
      const up = rule(a.key, 'crosses_above', { series: b.key });
      const down = rule(a.key, 'crosses_below', { series: b.key });
      add(up, down, crossUp(a.values, b.values));
      add(down, up, crossDown(a.values, b.values));
    }
    if (onPriceScale(lines[i])) {
      const up = rule(price.key, 'crosses_above', { series: lines[i].key });
      const down = rule(price.key, 'crosses_below', { series: lines[i].key });
      add(up, down, crossUp(close, lines[i].values));
      add(down, up, crossDown(close, lines[i].values));
    }
  }
  // Oscillators (0–100) cross levels; mirror of "crosses above 30" is "crosses below 70".
  for (const l of lines) {
    if (l.min >= 0 && l.max <= 100 && l.max - l.min > 20) {
      for (const level of OSC_LEVELS) {
        const up = rule(l.key, 'crosses_above', { value: level });
        const down = rule(l.key, 'crosses_below', { value: 100 - level });
        add(up, down, crossUp(l.values, constant(level)));
        add(down, up, crossDown(l.values, constant(100 - level)));
      }
    } else if (l.min < 0 && l.max > 0) {
      const up = rule(l.key, 'crosses_above', { value: 0 });
      const down = rule(l.key, 'crosses_below', { value: 0 });
      add(up, down, crossUp(l.values, constant(0)));
      add(down, up, crossDown(l.values, constant(0)));
    }
  }
  // Events: the script's own arrows, labels and alerts. Background shading is a state, used as a filter below.
  const eventSeries = (e) => {
    const v = new Array(n).fill(false);
    for (const t of e.times) {
      const i = barByTime.get(t);
      if (i != null) v[i] = true;
    }
    return v;
  };
  const signalEvents = (run.events ?? []).filter((e) => e.kind !== 'background' && e.times.length > 0);
  for (const e of signalEvents) {
    // An event's mirror is the opposite-sounding event when there is one (Buy ↔ Sell), else none.
    const opposite = signalEvents.find((o) => o !== e && isOpposite(e.title, o.title));
    add(rule(e.key, 'fires'), opposite ? rule(opposite.key, 'fires') : null, eventSeries(e));
  }

  // Filters: states that hold for stretches, to only take entries with the trend.
  const filters = [];
  for (const l of lines.filter(onPriceScale)) {
    const above = rule(price.key, 'above', { series: l.key });
    const below = rule(price.key, 'below', { series: l.key });
    filters.push({ rule: above, mirror: below, values: close.map((c, i) => l.values[i] != null && c > l.values[i]) });
    filters.push({ rule: below, mirror: above, values: close.map((c, i) => l.values[i] != null && c < l.values[i]) });
  }
  for (const e of (run.events ?? []).filter((x) => x.kind === 'background')) {
    filters.push({ rule: rule(e.key, 'fires'), mirror: null, values: eventSeries(e) });
  }

  // ── Simulation ─────────────────────────────────────────────────────────────────────────────────
  const trainEnd = Math.floor(n * TRAIN_SHARE);
  const periodEdges = Array.from({ length: PERIODS + 1 }, (_, k) => Math.floor((trainEnd * k) / PERIODS));
  const cost = costPct / 100;

  /** Play the four boolean arrays through one position over [from, to); returns trades as {entry, exit, ret}. */
  const simulate = (longIn, longOut, shortIn, shortOut, from, to) => {
    const trades = [];
    let pos = 0, entryBar = -1;
    const close_ = (exitDecision) => {
      const fill = exitDecision + 1;
      if (fill >= to) return false;
      const e = open[entryBar], x = open[fill];
      const gross = pos > 0 ? x / e - 1 : e / x - 1;
      trades.push({ entry: entryBar, exit: fill, ret: gross - cost });
      return true;
    };
    for (let i = from; i < to - 1; i++) {
      const li = longIn?.[i] === true, si = shortIn?.[i] === true;
      if (pos === 0) {
        if (li) { pos = 1; entryBar = i + 1; }
        else if (si) { pos = -1; entryBar = i + 1; }
      } else if (i >= entryBar) {
        if (pos === 1) {
          if (si) { close_(i); pos = -1; entryBar = i + 1; }
          else if (longOut?.[i]) { close_(i); pos = 0; }
        } else {
          if (li) { close_(i); pos = 1; entryBar = i + 1; }
          else if (shortOut?.[i]) { close_(i); pos = 0; }
        }
      }
    }
    if (pos !== 0 && entryBar < to - 1) {
      const e = open[entryBar], x = close[to - 1];
      trades.push({ entry: entryBar, exit: to - 1, ret: (pos > 0 ? x / e - 1 : e / x - 1) - cost, open: true });
    }
    return trades;
  };
  const totalReturn = (trades) => trades.reduce((eq, t) => eq * (1 + Math.max(t.ret, -1)), 1) - 1;
  const stats = (trades, from, to) => {
    const wins = trades.filter((t) => t.ret > 0).length;
    const gainSum = trades.filter((t) => t.ret > 0).reduce((s, t) => s + t.ret, 0);
    const lossSum = -trades.filter((t) => t.ret <= 0).reduce((s, t) => s + t.ret, 0);
    // Max drawdown on the closed-trade equity curve.
    let eq = 1, peak = 1, dd = 0;
    for (const t of trades) { eq *= 1 + Math.max(t.ret, -1); peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak); }
    return {
      returnPct: totalReturn(trades) * 100,
      trades: trades.length,
      winRatePct: trades.length ? (wins / trades.length) * 100 : 0,
      profitFactor: lossSum > 0 ? gainSum / lossSum : gainSum > 0 ? 99 : 0,
      maxDrawdownPct: dd * 100,
      holdPct: (close[to - 1] / close[from] - 1) * 100,
    };
  };
  const and = (a, b) => (b ? a.map((v, i) => v && b[i]) : a);

  // ── Candidates ─────────────────────────────────────────────────────────────────────────────────
  // Flips (an entry and its mirror, always in the market), and one-sided trades: every entry with every other rule as its
  // exit. Each may also take entries only with a trend filter (its mirror for the short side).
  const candidates = [];
  const byRule = new Map(atoms.map((a) => [JSON.stringify(a.rule), a]));
  const atomOf = (r) => (r ? byRule.get(JSON.stringify(r)) : null);
  const filterOf = (r) => (r ? filters.find((x) => JSON.stringify(x.rule) === JSON.stringify(r)) : null);
  const withFilters = (v) => {
    candidates.push(v);
    for (const f of filters) {
      if (v.longIn && v.shortIn) {
        const fm = filterOf(f.mirror);
        if (fm) candidates.push({ ...v, filterLong: f, filterShort: fm, filtered: true });
      } else if (v.longIn) candidates.push({ ...v, filterLong: f, filtered: true });
      else candidates.push({ ...v, filterShort: f, filtered: true });
    }
  };
  for (const a of atoms) {
    const mirror = atomOf(a.mirror);
    if (mirror) withFilters({ kind: 'flip', longIn: a, shortIn: mirror });
    for (const exit of atoms) {
      if (exit === a) continue;
      withFilters({ kind: 'long', longIn: a, longOut: exit });
      withFilters({ kind: 'short', shortIn: a, shortOut: exit });
    }
  }

  // ── Evaluate on the training history ────────────────────────────────────────────────────────────
  const scored = [];
  let tested = 0;
  for (const c of candidates) {
    if (Date.now() - started > deadlineMs) break;
    tested++;
    const longIn = c.longIn ? and(c.longIn.values, c.filterLong?.values) : null;
    const shortIn = c.shortIn ? and(c.shortIn.values, c.filterShort?.values) : null;
    const longOut = c.longOut?.values ?? null;
    const shortOut = c.shortOut?.values ?? null;
    const train = simulate(longIn, longOut, shortIn, shortOut, 0, trainEnd);
    if (train.length < MIN_TRAIN_TRADES) continue;
    let profitable = 0;
    for (let k = 0; k < PERIODS; k++) {
      const inPeriod = train.filter((t) => t.entry >= periodEdges[k] && t.entry < periodEdges[k + 1]);
      if (inPeriod.length > 0 && totalReturn(inPeriod) > 0) profitable++;
    }
    if (profitable < MIN_PERIODS_PROFITABLE) continue;
    const s = stats(train, 0, trainEnd);
    if (s.returnPct <= 0) continue;
    // Rank on return per unit of drawdown, so a smooth curve beats a lucky spike.
    const score = s.returnPct / Math.max(5, s.maxDrawdownPct);
    scored.push({ c, longIn, longOut, shortIn, shortOut, train: { ...s, periodsProfitable: profitable }, score });
  }
  scored.sort((a, b) => b.score - a.score);

  // ── Grade the finalists on the unseen last 20% ─────────────────────────────────────────────────
  const finalists = scored.slice(0, FINALISTS).map((x) => {
    // Warm the position through the training history, then count only what happens after it.
    const all = simulate(x.longIn, x.longOut, x.shortIn, x.shortOut, 0, n);
    const unseen = all.filter((t) => t.entry >= trainEnd);
    return { ...x, test: stats(unseen, trainEnd, n) };
  });
  finalists.sort(compareResults);

  const results = finalists.slice(0, RESULTS).map((x) => {
    const conditions = toConditions(x.c);
    // Sanity: the runner's own condition engine must agree with the search's simulation on entries.
    const check = conditionsToSignals(conditions, run.plots, run.events ?? [], candles).filter((s) => s.type.startsWith('entry-')).length;
    return {
      conditions,
      kind: x.c.kind,
      train: x.train,
      test: x.test,
      beatsHold: x.test.trades >= 2 && x.test.returnPct > x.test.holdPct && x.test.returnPct > 0,
      entries: check,
    };
  });

  return {
    tested,
    survived: scored.length,
    atoms: atoms.length,
    filters: filters.length,
    bars: n,
    trainBars: trainEnd,
    testFrom: candles[trainEnd]?.openTime ?? null,
    elapsedMs: Date.now() - started,
    results,
  };
}

/**
 * Best first: beating holding on the unseen stretch (and making money there) first, then the unseen return with a
 * quarter weight on the search history's, so a pick has to hold up on both.
 */
export function compareResults(a, b) {
  // Two unseen trades at least: one lucky trade is not a result.
  const beats = (x) => (x.test.trades >= 2 && x.test.returnPct > x.test.holdPct && x.test.returnPct > 0 ? 1 : 0);
  return beats(b) - beats(a) || b.test.returnPct + b.train.returnPct * 0.25 - (a.test.returnPct + a.train.returnPct * 0.25);
}

function toConditions(c) {
  const out = {};
  if (c.longIn) out['entry-long'] = [c.longIn.rule, ...(c.filterLong ? [c.filterLong.rule] : [])];
  if (c.longOut) out['exit-long'] = [c.longOut.rule];
  if (c.shortIn) out['entry-short'] = [c.shortIn.rule, ...(c.filterShort ? [c.filterShort.rule] : [])];
  if (c.shortOut) out['exit-short'] = [c.shortOut.rule];
  return out;
}

const PAIRS = [['buy', 'sell'], ['long', 'short'], ['bull', 'bear'], ['up', 'down']];
function isOpposite(a, b) {
  const x = a.toLowerCase(), y = b.toLowerCase();
  return PAIRS.some(([p, q]) => (x.includes(p) && y.includes(q)) || (x.includes(q) && y.includes(p)));
}

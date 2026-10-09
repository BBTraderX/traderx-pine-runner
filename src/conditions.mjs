// Conditions a user sets on our side for a script that has no trading rules of its own (most pasted indicators).
// Each of the four TraderX signals gets a list of rules over the script's plots, the price, numbers and the script's
// own alerts; all rules in a list must hold on a bar. The result is played through one position, the way a strategy
// would trade it, so it yields signals only when the position changes:
//
//   flat  → entry-long if its rules hold (long wins a tie), else entry-short if its rules hold
//   long  → exit-long if its rules hold; or, when the short entry's rules hold, exit-long then entry-short (a reversal)
//   short → the mirror
//
// A side with no exit rules is closed only by the opposite entry. Each signal sits on the bar its rules held on (the
// decision bar), which is what TraderX acts on, live and in the backtest.

import { UserError } from './errors.mjs';

export const OPERATORS = ['crosses_above', 'crosses_below', 'above', 'below', 'fires'];
const SIGNALS = ['entry-long', 'exit-long', 'entry-short', 'exit-short'];
const PRICE = ['open', 'high', 'low', 'close', 'volume'];
const MAX_RULES = 8;

/**
 * @typedef {{ left: string, op: string, right?: { series?: string, value?: number } }} Rule
 * Series names: `plot:<title>`, `price:<open|high|low|close|volume>`, and for `fires`, `alert:<title>`.
 */

/** Throws a UserError for anything malformed, before the script runs. */
export function validateConditions(conditions) {
  if (conditions == null) return;
  if (typeof conditions !== 'object' || Array.isArray(conditions)) throw new UserError('conditions must be an object.');
  for (const [signal, rules] of Object.entries(conditions)) {
    if (!SIGNALS.includes(signal)) throw new UserError(`Unknown signal "${signal}".`);
    if (!Array.isArray(rules)) throw new UserError(`Rules for ${signal} must be a list.`);
    if (rules.length > MAX_RULES) throw new UserError(`At most ${MAX_RULES} rules per signal.`);
    for (const rule of rules) {
      if (!rule || typeof rule.left !== 'string' || !OPERATORS.includes(rule.op)) throw new UserError(`A rule for ${signal} is incomplete.`);
      if (rule.op === 'fires') {
        if (!rule.left.startsWith('alert:')) throw new UserError('"fires" only applies to an alert.');
        continue;
      }
      const right = rule.right ?? {};
      if (typeof right.series !== 'string' && !Number.isFinite(right.value)) throw new UserError(`A rule for ${signal} needs something to compare with.`);
    }
  }
}

/** True when at least one signal has a rule. */
export function hasConditions(conditions) {
  return conditions != null && Object.values(conditions).some((rules) => Array.isArray(rules) && rules.length > 0);
}

/**
 * @param {Record<string, Rule[]>} conditions
 * @param {Record<string, {time:number, value:number|null}[]>} plots
 * @param {{time:number, title:string|null, id:string}[]} alerts
 * @param {{openTime:number, open:number, high:number, low:number, close:number, volume:number}[]} candles
 */
export function conditionsToSignals(conditions, plots, alerts, candles) {
  const n = candles.length;
  const barByTime = new Map(candles.map((c, i) => [c.openTime, i]));

  const seriesCache = new Map();
  const series = (name) => {
    if (seriesCache.has(name)) return seriesCache.get(name);
    let values;
    if (name.startsWith('price:')) {
      const field = name.slice(6);
      if (!PRICE.includes(field)) throw new UserError(`Unknown price "${field}".`);
      values = candles.map((c) => c[field]);
    } else if (name.startsWith('plot:')) {
      const points = plots[name.slice(5)];
      if (!points) throw new UserError(`The script has no plot named "${name.slice(5)}".`);
      values = new Array(n).fill(null);
      for (const p of points) {
        const i = barByTime.get(p.time);
        if (i != null) values[i] = p.value;
      }
    } else if (name.startsWith('alert:')) {
      const title = name.slice(6);
      // An alertcondition that never fired has no events; it just never holds.
      values = new Array(n).fill(false);
      for (const a of alerts) {
        if ((a.title ?? a.id) !== title) continue;
        const i = barByTime.get(a.time);
        if (i != null) values[i] = true;
      }
    } else {
      throw new UserError(`Unknown series "${name}".`);
    }
    seriesCache.set(name, values);
    return values;
  };

  const ruleHolds = (rule, i) => {
    if (rule.op === 'fires') return series(rule.left)[i] === true;
    const a = series(rule.left);
    const b = rule.right?.series != null ? series(rule.right.series) : null;
    const at = (arr, k) => (arr ? arr[k] : rule.right.value);
    const a0 = a[i], b0 = at(b, i);
    if (a0 == null || b0 == null) return false;
    switch (rule.op) {
      case 'above': return a0 > b0;
      case 'below': return a0 < b0;
      case 'crosses_above': {
        if (i === 0) return false;
        const a1 = a[i - 1], b1 = at(b, i - 1);
        return a1 != null && b1 != null && a1 <= b1 && a0 > b0;
      }
      case 'crosses_below': {
        if (i === 0) return false;
        const a1 = a[i - 1], b1 = at(b, i - 1);
        return a1 != null && b1 != null && a1 >= b1 && a0 < b0;
      }
      default: return false;
    }
  };

  const rules = Object.fromEntries(SIGNALS.map((s) => [s, conditions?.[s] ?? []]));
  const holds = (signal, i) => rules[signal].length > 0 && rules[signal].every((r) => ruleHolds(r, i));

  const out = [];
  const emit = (type, i) => out.push({ type, bar: i, time: candles[i].openTime, price: candles[i].close });
  let position = 0; // 1 long, -1 short
  for (let i = 0; i < n; i++) {
    const longIn = holds('entry-long', i);
    const shortIn = holds('entry-short', i);
    if (position === 0) {
      if (longIn) { emit('entry-long', i); position = 1; }
      else if (shortIn) { emit('entry-short', i); position = -1; }
    } else if (position === 1) {
      if (shortIn) { emit('exit-long', i); emit('entry-short', i); position = -1; }
      else if (holds('exit-long', i)) { emit('exit-long', i); position = 0; }
    } else {
      if (longIn) { emit('exit-short', i); emit('entry-long', i); position = 1; }
      else if (holds('exit-short', i)) { emit('exit-short', i); position = 0; }
    }
  }
  return out;
}

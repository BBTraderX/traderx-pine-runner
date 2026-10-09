// AI mode's outer loop: the indicator's own settings. Like BB TraderX AI Studio, which searches indicator parameters as
// well as rules, it runs the script at a few values of its main numeric inputs (half, three quarters, the default, one
// and a half, double), searches conditions at each, and keeps the best overall. A strategy whose edge only exists at
// one exact setting won't survive the unseen check, so this widens the search without loosening it.

import { runScript } from './run-script.mjs';
import { compareResults, searchConditions } from './search.mjs';

const FACTORS = [0.5, 0.75, 1, 1.5, 2];
const MAX_SWEPT_INPUTS = 2;
const RESULTS = 5;

function valuesFor(input) {
  const base = Number(input.defval);
  const seen = new Set();
  const out = [];
  for (const f of FACTORS) {
    let v = base * f;
    if (input.type === 'int') v = Math.max(1, Math.round(v));
    if (input.minval != null) v = Math.max(input.minval, v);
    if (input.maxval != null) v = Math.min(input.maxval, v);
    if (!Number.isFinite(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * @param {object} req the run request (source, candles, interval, symbol, inputs)
 * @param {{deadlineMs:number}} opts total time budget
 */
export async function sweepAndSearch(req, { deadlineMs }) {
  const started = Date.now();
  const left = () => deadlineMs - (Date.now() - started);

  // The defaults first: it tells us the settings, and is always searched.
  const first = await runScript({ ...req, conditions: null });
  const swept = first.inputs
    .filter((i) => (i.type === 'int' || i.type === 'float') && Number.isFinite(Number(i.defval)) && Number(i.defval) !== 0)
    .slice(0, MAX_SWEPT_INPUTS);

  // Every combination of the swept values, defaults first.
  let grid = [{}];
  for (const input of swept) {
    const next = [];
    for (const g of grid) for (const v of valuesFor(input)) next.push({ ...g, [input.title]: v });
    grid = next;
  }
  const isDefault = (g) => swept.every((i) => g[i.title] === Number(i.defval));
  grid.sort((a, b) => Number(isDefault(b)) - Number(isDefault(a)));

  let tested = 0;
  let survived = 0;
  let settingsTried = 0;
  const all = [];
  for (const g of grid) {
    if (left() < 2000) break;
    const inputs = { ...(req.inputs ?? {}), ...g };
    const run = isDefault(g) ? first : await runScript({ ...req, inputs, conditions: null });
    const search = searchConditions(run, req.candles, { deadlineMs: Math.max(1000, left() - 1000) });
    settingsTried++;
    tested += search.tested;
    survived += search.survived;
    for (const r of search.results) all.push({ ...r, inputs: Object.keys(g).length ? inputs : {} });
  }

  all.sort(compareResults);
  // One result per distinct set of conditions and settings.
  const seen = new Set();
  const results = [];
  for (const r of all) {
    const key = JSON.stringify([r.conditions, r.inputs]);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(r);
    if (results.length >= RESULTS) break;
  }

  return {
    declaration: first.declaration,
    title: first.title,
    overlay: first.overlay,
    bars: first.bars,
    range: first.range,
    search: {
      tested,
      survived,
      settingsTried,
      settingsSwept: swept.map((i) => i.title),
      trainShare: 0.8,
      elapsedMs: Date.now() - started,
      results,
    },
  };
}

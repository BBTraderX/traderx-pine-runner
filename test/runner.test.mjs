import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScript, tradesToSignals } from '../src/run-script.mjs';
import { handleRun, runInWorker } from '../src/server.mjs';

// A deterministic zig-zag: 20 bars up, 20 bars down, repeated, so EMA crosses happen at known places.
function zigzag(bars = 400) {
  const out = [];
  let price = 100;
  for (let i = 0; i < bars; i++) {
    price += Math.floor(i / 20) % 2 === 0 ? 1 : -1;
    const t = Date.UTC(2026, 0, 1) + i * 3600e3;
    out.push({ openTime: t, closeTime: t + 3600e3 - 1, open: price, high: price + 0.5, low: price - 0.5, close: price, volume: 10 });
  }
  return out;
}

const EMA_STRATEGY = `//@version=5
strategy("EMA Cross", overlay=true)
fast = input.int(5, "Fast")
slow = input.int(15, "Slow")
f = ta.ema(close, fast)
s = ta.ema(close, slow)
plot(f, "Fast EMA")
if ta.crossover(f, s)
    strategy.entry("L", strategy.long)
if ta.crossunder(f, s)
    strategy.entry("S", strategy.short)
`;

test('a strategy script returns its inputs, plots, trades and the four signals', async () => {
  const out = await runScript({ source: EMA_STRATEGY, candles: zigzag(), interval: '1h' });

  assert.equal(out.declaration, 'strategy');
  assert.deepEqual(out.inputs.map((i) => i.title), ['Fast', 'Slow']);
  assert.equal(out.plots['Fast EMA'].length, 400);
  assert.ok(out.strategy.trades.length > 5);
  // Always-in-market reversals: every exit is followed on the same bar by the opposite entry.
  const types = new Set(out.signals.map((s) => s.type));
  for (const t of ['entry-long', 'exit-long', 'entry-short', 'exit-short']) assert.ok(types.has(t), `missing ${t}`);
  for (let i = 1; i < out.signals.length; i++) assert.ok(out.signals[i].bar >= out.signals[i - 1].bar);
});

test('input overrides change the run', async () => {
  const a = await runScript({ source: EMA_STRATEGY, candles: zigzag(), interval: '1h' });
  const b = await runScript({ source: EMA_STRATEGY, candles: zigzag(), interval: '1h', inputs: { Fast: 2, Slow: 30 } });
  assert.notDeepEqual(a.signals.map((s) => s.bar), b.signals.map((s) => s.bar));
});

test('an indicator script returns alertcondition events on historical bars', async () => {
  const src = `//@version=5
indicator("Cross alerts")
f = ta.ema(close, 5)
s = ta.ema(close, 15)
plot(f, "Fast")
alertcondition(ta.crossover(f, s), "Buy", "fast crossed above")
alertcondition(ta.crossunder(f, s), "Sell", "fast crossed below")
`;
  const out = await runScript({ source: src, candles: zigzag(), interval: '1h' });
  assert.equal(out.declaration, 'indicator');
  assert.equal(out.strategy, null);
  assert.ok(out.alerts.length > 2);
});

test('a reversal on one bar exits before it enters', () => {
  const signals = tradesToSignals([
    { side: 'long', entryBar: 1, entryTime: 1, entryPrice: 1, exitBar: 5, exitTime: 5, exitPrice: 2 },
    { side: 'short', entryBar: 5, entryTime: 5, entryPrice: 2, exitBar: null },
  ]);
  assert.deepEqual(signals.map((s) => `${s.type}@${s.bar}`), ['entry-long@1', 'exit-long@5', 'entry-short@5']);
});

test('a script that never ends is stopped', async () => {
  const src = `//@version=5
indicator("Spin")
var x = 0
while true
    x += 1
plot(x)
`;
  const out = await runInWorker({ source: src, candles: zigzag(50), interval: '1h' }, { timeoutMs: 2000 });
  assert.equal(out.ok, false);
  assert.equal(out.userError, true);
});

test('bad requests are refused before running anything', async () => {
  assert.equal((await handleRun({ source: '', interval: '1h', candles: [] }))[0], 400);
  assert.equal((await handleRun({ source: 'x', interval: '7m', candles: [] }))[0], 400);
  assert.equal((await handleRun({ source: 'x', interval: '1h' }))[0], 400);
});

test('a broken script is a 422 with a message, not a crash', async () => {
  const [status, body] = await handleRun({ source: '//@version=5\nindicator("x")\nplot(ta.nope(close))\n', interval: '1h', candles: zigzag(50) });
  assert.equal(status, 422);
  assert.ok(body.error.length > 0);
});

test('signals sit on the decision bar, the bar before a next-open fill', async () => {
  // Crossover decided on bar k fills at bar k+1's open; TraderX must see the signal on bar k.
  const candles = zigzag(120).map((c) => ({ ...c, open: c.close - 0.3 }));
  for (const onClose of [false, true]) {
    const src = `//@version=5
strategy("x", overlay=true, process_orders_on_close=${onClose})
f = ta.ema(close, 5)
s = ta.ema(close, 15)
cu = ta.crossover(f, s)
plot(cu ? 1 : 0, "cu")
if cu
    strategy.entry("L", strategy.long)
if ta.crossunder(f, s)
    strategy.entry("S", strategy.short)
`;
    const out = await runScript({ source: src, candles, interval: '1h' });
    const crossBar = out.plots.cu.findIndex((p) => p.value === 1);
    const entry = out.signals.find((s) => s.type === 'entry-long');
    assert.equal(entry.bar, crossBar, `process_orders_on_close=${onClose}`);
  }
});

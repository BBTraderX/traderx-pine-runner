// One script run per worker thread. The parent kills the thread on timeout and caps its heap, so a
// script that loops forever or allocates without bound takes down only itself.
//
// Anything thrown here comes from the script (the request was validated before the worker started),
// so it is reported as the user's error, message and all.

import { parentPort, workerData } from 'node:worker_threads';
import { runScript } from './run-script.mjs';
import { sweepAndSearch } from './sweep.mjs';

// Candles for other timeframes (request.security) come from the parent, so every run shares its cache, and so do
// other timeframes' results (securityCache), which outlive this thread.
let nextId = 0;
const pending = new Map();
const ask = (msg) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ ...msg, id });
  });
parentPort.on('message', (msg) => {
  const p = pending.get(msg?.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(msg.error));
  else p.resolve(msg.candles ?? msg.entries);
});
const loadCandles = (coin, interval, startTime, endTime) => ask({ type: 'candles', coin, interval, startTime, endTime });
const securityCache = {
  get: (parts) => ask({ type: 'security-get', parts }),
  set: (parts, entry) => parentPort.postMessage({ type: 'security-set', parts, entry }),
};

// PineTS loads request.security candles in a promise it never catches, so a failed load ("Could not load BTC
// candles…") would otherwise kill the worker and come back as an internal error instead of the user's.
process.on('unhandledRejection', (err) => {
  parentPort.postMessage({ ok: false, userError: true, message: String(err?.message ?? err).slice(0, 2000) });
});

try {
  const req = { ...workerData, loadCandles, securityCache };
  if (workerData.mode === 'search') {
    // AI mode: sweep the script's main settings and search conditions at each.
    const result = await sweepAndSearch(req, { deadlineMs: workerData.searchDeadlineMs });
    parentPort.postMessage({ ok: true, result });
  } else {
    const result = await runScript(req);
    parentPort.postMessage({ ok: true, result });
  }
} catch (err) {
  parentPort.postMessage({ ok: false, userError: true, message: String(err?.message ?? err).slice(0, 2000) });
} finally {
  parentPort.unref();
}

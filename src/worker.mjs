// One script run per worker thread. The parent kills the thread on timeout and caps its heap, so a
// script that loops forever or allocates without bound takes down only itself.
//
// Anything thrown here comes from the script (the request was validated before the worker started),
// so it is reported as the user's error, message and all.

import { parentPort, workerData } from 'node:worker_threads';
import { runScript } from './run-script.mjs';
import { sweepAndSearch } from './sweep.mjs';

try {
  if (workerData.mode === 'search') {
    // AI mode: sweep the script's main settings and search conditions at each.
    const result = await sweepAndSearch(workerData, { deadlineMs: workerData.searchDeadlineMs });
    parentPort.postMessage({ ok: true, result });
  } else {
    const result = await runScript(workerData);
    parentPort.postMessage({ ok: true, result });
  }
} catch (err) {
  parentPort.postMessage({ ok: false, userError: true, message: String(err?.message ?? err).slice(0, 2000) });
}

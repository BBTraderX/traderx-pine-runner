// HTTP API for running Pine Script. Called by the BB TraderX backend, never by browsers directly.
//
//   POST /v1/run   { source, coin, interval, bars?, inputs? }  or  { source, candles, interval, inputs? }
//   GET  /healthz
//
// Every run happens in its own worker thread with a wall-clock timeout and a heap cap. The worker gets
// candles from this process, so the script itself never needs the network: when request.security wants another
// timeframe or symbol, the worker asks this process, which loads it from Hyperliquid through one shared cache.

import { createHash } from 'node:crypto';
import http from 'node:http';
import { Worker } from 'node:worker_threads';
import { fetchCandleRange, fetchCandles, MAX_BARS } from './candles.mjs';
import { conditionsToSignals, hasConditions, validateConditions } from './conditions.mjs';
import { prefetchTimeframes } from './provider.mjs';
import { TIMEFRAMES } from './run-script.mjs';

export const PORT = Number(process.env.PORT ?? 8787);
export const TOKEN = process.env.RUNNER_TOKEN ?? '';
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS ?? 60_000);
const HEAP_MB = Number(process.env.RUN_HEAP_MB ?? 512);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT ?? 3);
/** AI mode tests thousands of condition sets; it gets longer, but still a hard stop. */
const SEARCH_TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS ?? 120_000);
const MAX_SOURCE_BYTES = 100_000;
const MAX_BODY_BYTES = 2_000_000;
export const SOURCE_URL = process.env.SOURCE_URL ?? 'https://github.com/BBTraderX/traderx-pine-runner';

let running = 0;

export function runInWorker(payload, { timeoutMs = RUN_TIMEOUT_MS, heapMb = HEAP_MB, signal } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ ok: false, userError: true, message: 'Run cancelled.' });
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
      workerData: payload,
      resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: 32 },
    });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      resolve(value);
      worker.terminate();
    };
    // The caller went away (the page started a newer run): stop now and free the slot.
    const cancel = () => done({ ok: false, userError: true, message: 'Run cancelled.' });
    signal?.addEventListener('abort', cancel);
    const timer = setTimeout(
      () => done({ ok: false, userError: true, message: `Script took longer than ${timeoutMs / 1000}s and was stopped.` }),
      timeoutMs,
    );
    worker.on('message', (msg) => {
      if (msg?.type !== 'candles') return done(msg);
      // request.security wants another timeframe or symbol: load it here, through the shared cache.
      fetchCandleRange(msg.coin, msg.interval, msg.startTime, msg.endTime).then(
        (candles) => !settled && worker.postMessage({ id: msg.id, candles }),
        (err) => !settled && worker.postMessage({ id: msg.id, error: String(err?.message ?? err) }),
      );
    });
    worker.once('error', (err) =>
      done({ ok: false, userError: err?.code === 'ERR_WORKER_OUT_OF_MEMORY', message: err?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'Script used too much memory and was stopped.' : String(err?.message ?? err) }),
    );
    worker.once('exit', (code) => done({ ok: false, userError: false, message: `Worker exited (${code}).` }));
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'x-source-code': SOURCE_URL });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Body must be JSON.'), { status: 400 });
  }
}

/** Recent runs by script, settings and candles. Small: a result holds every plot's values for every bar. */
const results = new Map();
const MAX_RESULTS = 20;
const RESULT_MS = 5 * 60_000;

/** Null when the run's candles came with the request: those aren't worth keying on. */
function resultKey(source, coin, interval, inputs, series) {
  if (typeof coin !== 'string' || !series.length) return null;
  // The bars, not the live bar's price: that moves every few seconds, which would miss every time for a script that
  // runs for most of a minute. A new bar is a new key, and a remembered run lasts at most RESULT_MS.
  const candles = [series.length, series[0].openTime, series.at(-1).openTime];
  return createHash('sha256').update(JSON.stringify([source, coin.trim(), interval, inputs ?? {}, candles])).digest('hex');
}

function remember(key, entry) {
  results.delete(key);
  results.set(key, { ...entry, at: Date.now() });
  if (results.size > MAX_RESULTS) results.delete(results.keys().next().value);
}

/** A remembered run with other conditions applied: what running it again with them would return. */
function withConditions({ result, candles }, conditions) {
  if (hasConditions(conditions)) {
    return { ...result, signals: conditionsToSignals(conditions, result.plots, result.events, candles), signalSource: 'conditions' };
  }
  const strategy = result.strategy;
  return { ...result, signals: strategy ? strategy.signals : [], signalSource: strategy ? 'strategy' : 'none' };
}

export async function handleRun(body, { search = false, signal } = {}) {
  const { source, coin, interval, bars, candles, inputs, conditions } = body ?? {};
  if (typeof source !== 'string' || !source.trim()) return [400, { error: 'source is required.' }];
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) return [400, { error: 'Script is too long.' }];
  if (!TIMEFRAMES[interval]) return [400, { error: `interval must be one of ${Object.keys(TIMEFRAMES).join(', ')}.` }];
  if (inputs != null && (typeof inputs !== 'object' || Array.isArray(inputs))) return [400, { error: 'inputs must be an object.' }];

  let series = candles;
  if (series == null) {
    if (typeof coin !== 'string' || !coin.trim()) return [400, { error: 'coin or candles is required.' }];
    try {
      series = await fetchCandles(coin.trim(), interval, bars ?? 1000);
    } catch (err) {
      return [502, { error: `Could not load candles: ${err.message}` }];
    }
  } else if (!Array.isArray(series) || series.length > MAX_BARS) {
    return [400, { error: `candles must be an array of at most ${MAX_BARS}.` }];
  }

  // The same script, settings and candles ran a moment ago: only the conditions changed, and those are applied after
  // the script, so answer from that run. A heavy multi-timeframe script takes most of a minute on the host; a rule
  // change shouldn't.
  const key = search ? null : resultKey(source, coin, interval, inputs, series);
  const remembered = key && results.get(key);
  const prior = remembered && Date.now() - remembered.at < RESULT_MS ? remembered : null;
  if (prior) {
    try {
      validateConditions(conditions ?? null);
    } catch (err) {
      return [422, { error: err.message }];
    }
    return [200, withConditions(prior, conditions ?? null)];
  }

  if (!(await takeSlot(signal))) return [429, { error: 'Runner is busy, try again shortly.' }];
  try {
    if (typeof coin === 'string' && coin.trim()) {
      prefetchTimeframes({ source, coin: coin.trim(), timeframe: TIMEFRAMES[interval], candles: series });
    }
    const payload = { source, candles: series, interval, symbol: coin ?? 'COIN', inputs: inputs ?? {}, conditions: conditions ?? null };
    const out = search
      ? await runInWorker({ ...payload, mode: 'search', searchDeadlineMs: SEARCH_TIMEOUT_MS - 15_000 }, { timeoutMs: SEARCH_TIMEOUT_MS, signal })
      : await runInWorker(payload, { signal });
    if (out.ok && key) remember(key, { result: out.result, candles: series });
    if (out.ok) return [200, out.result];
    return out.userError ? [422, { error: out.message }] : [500, { error: 'Script run failed.' }];
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** Wait briefly for a free slot rather than refuse at once; false when none frees up or the caller leaves. */
const waiting = [];
const SLOT_WAIT_MS = 15_000;
async function takeSlot(signal) {
  const deadline = Date.now() + SLOT_WAIT_MS;
  while (running >= MAX_CONCURRENT) {
    if (signal?.aborted || Date.now() >= deadline || waiting.length >= 20) return false;
    await new Promise((resolve) => {
      const wake = () => { clearTimeout(t); resolve(); };
      const t = setTimeout(() => { const i = waiting.indexOf(wake); if (i >= 0) waiting.splice(i, 1); resolve(); }, deadline - Date.now());
      waiting.push(wake);
    });
  }
  running++;
  return true;
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true });
      const isSearch = req.url === '/v1/search';
      if (req.method !== 'POST' || (req.url !== '/v1/run' && !isSearch)) return send(res, 404, { error: 'Not found.' });
      if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'Unauthorized.' });
      // Closed before we answered: the caller no longer wants this run.
      const gone = new AbortController();
      res.once('close', () => { if (!res.writableFinished) gone.abort(); });
      const [status, body] = await handleRun(await readJson(req), { search: isSearch, signal: gone.signal });
      if (gone.signal.aborted) return;
      return send(res, status, body);
    } catch (err) {
      return send(res, err.status ?? 500, { error: err.status ? err.message : 'Internal error.' });
    }
  });
}


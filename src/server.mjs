// HTTP API for running Pine Script. Called by the BB TraderX backend, never by browsers directly.
//
//   POST /v1/run   { source, coin, interval, bars?, inputs? }  or  { source, candles, interval, inputs? }
//   GET  /healthz
//
// Every run happens in its own worker thread with a wall-clock timeout and a heap cap. The worker gets
// candles from this process, so the script itself never needs the network: when request.security wants another
// timeframe or symbol, the worker asks this process, which loads it from Hyperliquid through one shared cache.

import http from 'node:http';
import { Worker } from 'node:worker_threads';
import { fetchCandleRange, fetchCandles, MAX_BARS } from './candles.mjs';
import { TIMEFRAMES } from './run-script.mjs';

export const PORT = Number(process.env.PORT ?? 8787);
export const TOKEN = process.env.RUNNER_TOKEN ?? '';
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS ?? 30_000);
const HEAP_MB = Number(process.env.RUN_HEAP_MB ?? 512);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT ?? 3);
/** AI mode tests thousands of condition sets; it gets longer, but still a hard stop. */
const SEARCH_TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS ?? 120_000);
const MAX_SOURCE_BYTES = 100_000;
const MAX_BODY_BYTES = 2_000_000;
export const SOURCE_URL = process.env.SOURCE_URL ?? 'https://github.com/BBTraderX/traderx-pine-runner';

let running = 0;

export function runInWorker(payload, { timeoutMs = RUN_TIMEOUT_MS, heapMb = HEAP_MB } = {}) {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
      workerData: payload,
      resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: 32 },
    });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
      worker.terminate();
    };
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

export async function handleRun(body, { search = false } = {}) {
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

  if (running >= MAX_CONCURRENT) return [429, { error: 'Runner is busy, try again shortly.' }];
  running++;
  try {
    const payload = { source, candles: series, interval, symbol: coin ?? 'COIN', inputs: inputs ?? {}, conditions: conditions ?? null };
    const out = search
      ? await runInWorker({ ...payload, mode: 'search', searchDeadlineMs: SEARCH_TIMEOUT_MS - 15_000 }, { timeoutMs: SEARCH_TIMEOUT_MS })
      : await runInWorker(payload);
    if (out.ok) return [200, out.result];
    return out.userError ? [422, { error: out.message }] : [500, { error: 'Script run failed.' }];
  } finally {
    running--;
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true });
      const isSearch = req.url === '/v1/search';
      if (req.method !== 'POST' || (req.url !== '/v1/run' && !isSearch)) return send(res, 404, { error: 'Not found.' });
      if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'Unauthorized.' });
      const [status, body] = await handleRun(await readJson(req), { search: isSearch });
      return send(res, status, body);
    } catch (err) {
      return send(res, err.status ?? 500, { error: err.status ? err.message : 'Internal error.' });
    }
  });
}


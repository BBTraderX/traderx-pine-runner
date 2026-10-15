// Candles from Hyperliquid's public info API, oldest first. Hyperliquid keeps only the latest 5,000 bars per coin
// and interval, so that is the most any run can see.

const HL_INFO = process.env.HL_INFO_URL ?? 'https://api.hyperliquid.xyz/info';
export const MAX_BARS = 5000;

const INTERVAL_MS = {
  '1m': 60e3, '3m': 180e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3,
  '1h': 3600e3, '2h': 7200e3, '4h': 14400e3, '8h': 28800e3, '12h': 43200e3,
  '1d': 86400e3, '3d': 259200e3, '1w': 604800e3, '1M': 2592000e3,
};

const cache = new Map();
const CACHE_MS = 30_000;

/** @returns {Promise<{openTime:number, closeTime:number, open:number, high:number, low:number, close:number, volume:number}[]>} */
export async function fetchCandles(coin, interval, bars = 1000) {
  const step = INTERVAL_MS[interval];
  if (!step) throw new Error(`Unsupported interval "${interval}".`);
  const count = Math.min(Math.max(1, bars | 0), MAX_BARS);
  const endTime = Date.now();
  return cached(`${coin}|${interval}|${count}`, coin, interval, endTime - count * step, endTime);
}

/** Candles opening between startTime and endTime, at most the latest MAX_BARS of them. */
export async function fetchCandleRange(coin, interval, startTime, endTime) {
  const step = INTERVAL_MS[interval];
  if (!step) throw new Error(`Unsupported interval "${interval}".`);
  // Rounded to the bar, so runs within the same bar share the cache.
  const end = Math.ceil(endTime / step) * step;
  const start = Math.max(Math.floor(startTime / step) * step, end - MAX_BARS * step);
  return cached(`${coin}|${interval}|${start}|${end}`, coin, interval, start, end);
}

async function cached(key, coin, interval, startTime, endTime) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.candles;

  const res = await fetch(HL_INFO, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval, startTime, endTime } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Hyperliquid candles: HTTP ${res.status}`);
  const raw = await res.json();
  if (!Array.isArray(raw)) throw new Error('Hyperliquid candles: unexpected response');

  const candles = raw.map((c) => ({
    openTime: c.t, closeTime: c.T, open: +c.o, high: +c.h, low: +c.l, close: +c.c, volume: +c.v,
  }));
  cache.set(key, { at: Date.now(), candles });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return candles;
}

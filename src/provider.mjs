// Market data for one run, in the shape PineTS asks a provider for. The chart's own timeframe gets the run's
// candles; any other timeframe (request.security, request.security_lower_tf) is loaded from Hyperliquid, and
// timeframes Hyperliquid has no candles for (10m, 45m, 6h…) are built from a smaller one that divides them.

import { aggregateCandles, selectSubTimeframe } from 'pinets';
import { fetchCandleRange } from './candles.mjs';
import { UserError } from './errors.mjs';

/** Pine timeframe → Hyperliquid interval, for the timeframes Hyperliquid serves directly. */
const HL_INTERVALS = {
  '1': '1m', '3': '3m', '5': '5m', '15': '15m', '30': '30m',
  '60': '1h', '120': '2h', '240': '4h', '480': '8h', '720': '12h',
  'D': '1d', '3D': '3d', 'W': '1w', 'M': '1M',
};
const SUPPORTED = new Set(Object.keys(HL_INTERVALS));

/** Most other-timeframe loads one run may make, so a script cannot fan out without bound. */
const MAX_FEEDS = 24;

/** '1D' → 'D', '1h' → '60', '4H' → '240', '1W' → 'W'; anything else as given. */
function normalize(tf) {
  const s = String(tf).trim();
  const m = /^(\d*)([a-zA-Z]?)$/.exec(s);
  if (!m) return s;
  const n = m[1] === '' ? 1 : Number(m[1]);
  switch (m[2]) {
    case '': return String(n);
    case 'm': return String(n);
    case 'h': case 'H': return String(n * 60);
    case 'D': case 'd': return n === 1 ? 'D' : `${n}D`;
    case 'W': case 'w': return n === 1 ? 'W' : `${n}W`;
    case 'M': return n === 1 ? 'M' : `${n}M`;
    default: return s;
  }
}

/** How far before the chart's first bar PineTS 0.11 asks for another timeframe's candles. */
const LOOKBACK_MS = 30 * 86_400_000;

/** Hyperliquid interval that serves a Pine timeframe, directly or as the bars it is built from. */
function sourceInterval(tf) {
  if (HL_INTERVALS[tf]) return HL_INTERVALS[tf];
  const sub = /^\d+$|^\d*[DWM]$/.test(tf) ? selectSubTimeframe(tf, SUPPORTED) : null;
  return sub ? HL_INTERVALS[sub] : null;
}

/**
 * Start loading, all at once, the other timeframes a script looks likely to ask for. PineTS asks for them one
 * after another as the script reaches each request.security, which for a script that reads a dozen timeframes is
 * most of its run on a slow host. Timeframes are guessed from the script's string literals, so a guess can be
 * wrong; the script's own requests then load as usual and these just warm the cache. Errors are left to those.
 */
export function prefetchTimeframes({ source, coin, timeframe, candles, loadCandles = fetchCandleRange }) {
  if (!/\brequest\.security/.test(source) || !candles.length) return 0;
  const chartTf = normalize(timeframe);
  const intervals = new Set();
  for (const [, , text] of source.matchAll(/(["'])([^"'\n]{1,5})\1/g)) {
    const tf = normalize(text);
    const interval = tf !== chartTf && sourceInterval(tf);
    if (interval) intervals.add(interval);
  }
  const start = candles[0].openTime - LOOKBACK_MS;
  const end = candles.at(-1).closeTime;
  for (const interval of [...intervals].slice(0, MAX_FEEDS)) {
    Promise.resolve(loadCandles(coin, interval, start, end)).catch(() => {});
  }
  return Math.min(intervals.size, MAX_FEEDS);
}

const kline = (c) => ({
  ...c, quoteAssetVolume: 0, numberOfTrades: 0, takerBuyBaseAssetVolume: 0, takerBuyQuoteAssetVolume: 0, ignore: 0,
});

/**
 * @param {object} run
 * @param {string} run.coin Hyperliquid coin the run is for.
 * @param {string} run.timeframe The chart's Pine timeframe.
 * @param {object[]} run.candles The run's candles.
 * @param {Function} [run.loadCandles] (coin, interval, startTime, endTime) → candles; Hyperliquid directly by default.
 */
export function createProvider({ coin, timeframe, candles, loadCandles = fetchCandleRange }) {
  const chartTf = normalize(timeframe);
  const loaded = new Map();

  // A script names a symbol as syminfo.tickerid ("BTC"), with an exchange ("BINANCE:BTCUSDT"), or as another
  // Hyperliquid coin. PineTS keeps only the part after a colon, so "xyz:TSLA" arrives as "TSLA".
  const toCoin = (symbol) => {
    const s = String(symbol ?? '').trim();
    if (!s || s === coin || s === coin.split(':').at(-1)) return coin;
    return s.includes(':') ? s.split(':').at(-1) : s;
  };

  async function load(symbol, tf, sDate, eDate) {
    const key = `${symbol}|${tf}`;
    if (!loaded.has(key)) {
      if (loaded.size >= MAX_FEEDS) throw new UserError(`Scripts can load at most ${MAX_FEEDS} other symbols or timeframes.`);
      loaded.set(key, fetchTimeframe(symbol, tf, sDate, eDate));
    }
    return loaded.get(key);
  }

  async function fetchTimeframe(symbol, tf, sDate, eDate) {
    const end = eDate ?? candles.at(-1)?.closeTime ?? Date.now();
    const start = sDate ?? candles[0]?.openTime ?? end;
    try {
      if (HL_INTERVALS[tf]) return (await loadCandles(symbol, HL_INTERVALS[tf], start, end)).map(kline);
      const sub = selectSubTimeframe(tf, SUPPORTED);
      if (!sub) throw new UserError(`Timeframe "${tf}" is not available. Use minutes (1 to 720), D, W or M.`);
      const subCandles = (await loadCandles(symbol, HL_INTERVALS[sub], start, end)).map(kline);
      return aggregateCandles(subCandles, tf, sub, { calendarGrid: true });
    } catch (err) {
      if (err instanceof UserError) throw err;
      throw new UserError(`Could not load ${symbol} candles for timeframe "${tf}": ${err.message}`);
    }
  }

  return {
    configure() {},
    async getMarketData(tickerId, tf, _limit, sDate, eDate) {
      const symbol = toCoin(tickerId);
      const want = normalize(tf);
      if (symbol === coin && want === chartTf) return candles.map(kline);
      return load(symbol, want, sDate, eDate);
    },
    async getSymbolInfo(tickerId) {
      const symbol = toCoin(tickerId);
      return {
        tickerid: symbol, ticker: symbol, root: symbol, main_tickerid: symbol, current_contract: symbol, description: symbol,
        prefix: 'HYPERLIQUID', type: 'crypto', currency: 'USD', basecurrency: symbol, timezone: 'Etc/UTC', session: '24x7',
      };
    },
  };
}

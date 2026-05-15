import { backendApiUrl } from "./backend";

const BINANCE_BASE_URL = "https://api.binance.com/api/v3";
const BINANCE_STREAM_BASE_URL = "wss://stream.binance.com:9443/ws";
const NATIVE_INTERVALS = new Set(["1m", "5m", "15m", "30m", "1h", "4h"]);
const SUPPORTED_INTERVALS = new Set(["10m", "15m", "20m", "30m", "1h", "4h"]);
const CUSTOM_INTERVALS = {
  "10m": { base: "5m", minutes: 10 },
  "20m": { base: "5m", minutes: 20 },
};

function normalizeKline(kline) {
  const closeTime = Number(kline[6]);
  return {
    time: Math.floor(kline[0] / 1000),
    openTime: kline[0],
    closeTime,
    open: Number(kline[1]),
    high: Number(kline[2]),
    low: Number(kline[3]),
    close: Number(kline[4]),
    volume: Number(kline[5]),
    isClosed: closeTime <= Date.now(),
  };
}

async function requestSolKlines(interval, limit, endTime) {
  if (!NATIVE_INTERVALS.has(interval)) {
    throw new Error(`Unsupported Binance interval: ${interval}`);
  }

  const params = new URLSearchParams({
    symbol: "SOLUSDT",
    interval,
    limit: String(limit),
  });

  if (endTime) {
    params.set("endTime", String(endTime));
  }

  const response = await fetch(`${BINANCE_BASE_URL}/klines?${params.toString()}`);

  if (!response.ok) {
    throw new Error(`Binance request failed: ${response.status}`);
  }

  const klines = await response.json();

  if (!Array.isArray(klines)) {
    throw new Error("Binance returned an invalid kline payload.");
  }

  return klines.map(normalizeKline);
}

function intervalMinutes(interval) {
  if (interval.endsWith("m")) {
    return Number(interval.replace("m", ""));
  }

  if (interval.endsWith("h")) {
    return Number(interval.replace("h", "")) * 60;
  }

  return 1;
}

function aggregateCandles(candles, targetMinutes, nowMs = Date.now()) {
  const bucketMs = targetMinutes * 60 * 1000;
  const buckets = new Map();

  candles.forEach((candle) => {
    const bucketOpenTime = Math.floor(candle.openTime / bucketMs) * bucketMs;
    const existing = buckets.get(bucketOpenTime);

    if (!existing) {
      const closeTime = bucketOpenTime + bucketMs;
      buckets.set(bucketOpenTime, {
        time: Math.floor(bucketOpenTime / 1000),
        openTime: bucketOpenTime,
        closeTime,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        isClosed: closeTime <= nowMs && candle.isClosed !== false,
      });
      return;
    }

    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
    existing.volume += candle.volume;
    existing.isClosed = existing.closeTime <= nowMs && existing.isClosed && candle.isClosed !== false;
  });

  return [...buckets.values()].sort((left, right) => left.time - right.time);
}

export async function fetchSolKlines(interval = "15m", limit = 1000) {
  if (!SUPPORTED_INTERVALS.has(interval)) {
    throw new Error(`Unsupported Binance interval: ${interval}`);
  }

  const requestedLimit = Math.max(1, Math.min(Number(limit) || 1000, 10000));
  const customInterval = CUSTOM_INTERVALS[interval];
  const requestInterval = customInterval?.base ?? interval;
  const requestLimit = customInterval
    ? Math.min(50000, requestedLimit * (customInterval.minutes / intervalMinutes(requestInterval)) + 8)
    : requestedLimit;
  const chunkLimit = 1000;
  let remaining = requestLimit;
  let endTime = undefined;
  const chunks = [];

  while (remaining > 0) {
    const candles = await requestSolKlines(requestInterval, Math.min(chunkLimit, remaining), endTime);

    if (candles.length === 0) {
      break;
    }

    chunks.unshift(candles);
    remaining -= candles.length;
    endTime = candles[0].openTime - 1;

    if (candles.length < Math.min(chunkLimit, remaining + candles.length)) {
      break;
    }
  }

  const deduped = new Map();

  chunks.flat().forEach((candle) => {
    deduped.set(candle.time, candle);
  });

  const nativeCandles = [...deduped.values()]
    .sort((left, right) => left.time - right.time)
    .slice(-requestLimit);

  if (customInterval) {
    return aggregateCandles(nativeCandles, customInterval.minutes).slice(-requestedLimit);
  }

  return nativeCandles.slice(-requestedLimit);
}

export async function fetchHistoricalCandles({
  from,
  maxCandles = 90000,
  provider = "binance-futures",
  symbol = "SOLUSDT",
  timeframe = "15m",
  to,
} = {}) {
  const params = new URLSearchParams({
    maxCandles: String(maxCandles),
    provider,
    symbol,
    timeframe,
  });

  if (from) params.set("from", from);
  if (to) params.set("to", to);

  const response = await fetch(backendApiUrl(`/historical/candles?${params.toString()}`));
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.message || payload.error || `Historical candles failed: ${response.status}`);
  }

  if (!Array.isArray(payload.candles)) {
    throw new Error("Historical provider returned no candle array.");
  }

  return payload;
}

export function createSolKlineSocket(interval, { onCandle, onError }) {
  if (!SUPPORTED_INTERVALS.has(interval)) {
    throw new Error(`Unsupported Binance interval: ${interval}`);
  }

  const customInterval = CUSTOM_INTERVALS[interval];
  const streamInterval = customInterval?.base ?? interval;
  const socket = new WebSocket(`${BINANCE_STREAM_BASE_URL}/solusdt@kline_${streamInterval}`);
  const liveBaseCandles = new Map();

  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data);
      const kline = message.k;

      if (!kline) {
        return;
      }

      const candle = {
        time: Math.floor(kline.t / 1000),
        openTime: kline.t,
        open: Number(kline.o),
        high: Number(kline.h),
        low: Number(kline.l),
        close: Number(kline.c),
        volume: Number(kline.v),
        isClosed: Boolean(kline.x),
      };

      if (!customInterval) {
        onCandle(candle);
        return;
      }

      liveBaseCandles.set(candle.openTime, candle);
      const aggregated = aggregateCandles(
        [...liveBaseCandles.values()].slice(-customInterval.minutes / intervalMinutes(streamInterval) - 4),
        customInterval.minutes,
      );
      const latest = aggregated[aggregated.length - 1];

      if (latest) {
        onCandle(latest);
      }
    } catch (parseError) {
      onError?.(parseError);
    }
  });

  socket.addEventListener("error", () => {
    onError?.(new Error("Binance websocket connection error."));
  });

  return () => {
    socket.close();
  };
}

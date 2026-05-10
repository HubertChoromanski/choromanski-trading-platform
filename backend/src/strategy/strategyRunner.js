import { evaluateChoromanskiStrategy, STRATEGY_EVENT_TYPES } from "../../../hubert-platform/frontend/src/engine/strategyEngine.js";
import { toHeikenAshi } from "../../../hubert-platform/frontend/src/indicators/heikenAshi.js";
import { calculateNadarayaEnvelope } from "../../../hubert-platform/frontend/src/indicators/nadaraya.js";

const BINANCE_SPOT_BASE_URL = "https://api.binance.com/api/v3";
const BINANCE_FUTURES_BASE_URL = "https://fapi.binance.com/fapi/v1";
const MAX_BINANCE_LIMIT = 1500;
const MAX_HISTORICAL_CANDLES = Number(process.env.MAX_HISTORICAL_CANDLES || 90000);

const CUSTOM_INTERVALS = {
  "10m": { base: "5m", minutes: 10 },
  "20m": { base: "5m", minutes: 20 },
};

function normalizeKline(kline) {
  return {
    time: Math.floor(kline[0] / 1000),
    openTime: kline[0],
    open: Number(kline[1]),
    high: Number(kline[2]),
    low: Number(kline[3]),
    close: Number(kline[4]),
    volume: Number(kline[5]),
    isClosed: kline[6] < Date.now(),
  };
}

function aggregateCandles(candles, targetMinutes) {
  const bucketMs = targetMinutes * 60 * 1000;
  const buckets = new Map();

  candles.forEach((candle) => {
    const bucketOpenTime = Math.floor(candle.openTime / bucketMs) * bucketMs;
    const existing = buckets.get(bucketOpenTime);

    if (!existing) {
      buckets.set(bucketOpenTime, {
        time: Math.floor(bucketOpenTime / 1000),
        openTime: bucketOpenTime,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        isClosed: candle.isClosed,
      });
      return;
    }

    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
    existing.volume += candle.volume;
    existing.isClosed = existing.isClosed && candle.isClosed;
  });

  return [...buckets.values()].sort((left, right) => left.time - right.time);
}

function intervalMinutes(interval) {
  if (interval.endsWith("m")) return Number(interval.replace("m", ""));
  if (interval.endsWith("h")) return Number(interval.replace("h", "")) * 60;
  return 1;
}

function providerBaseUrl(provider = "binance-futures") {
  return provider === "binance-spot" ? BINANCE_SPOT_BASE_URL : BINANCE_FUTURES_BASE_URL;
}

async function requestKlines({ endTime, interval, limit, provider = "binance-futures", symbol }) {
  const params = new URLSearchParams({
    symbol,
    interval,
    limit: String(limit),
  });

  if (endTime) {
    params.set("endTime", String(endTime));
  }

  const response = await fetch(`${providerBaseUrl(provider)}/klines?${params.toString()}`);

  if (!response.ok) {
    throw new Error(`Binance ${provider} request failed: ${response.status}`);
  }

  const payload = await response.json();

  if (!Array.isArray(payload)) {
    throw new Error("Binance returned an invalid kline payload.");
  }

  return payload.map(normalizeKline);
}

export async function fetchCandles({
  endTime,
  from,
  limit = 1000,
  provider = "binance-futures",
  symbol,
  timeframe,
  to,
} = {}) {
  const custom = CUSTOM_INTERVALS[timeframe];
  const interval = custom?.base ?? timeframe;
  const startMs = from ? Number(from) * 1000 : undefined;
  const endMs = to ? Number(to) * 1000 : endTime;
  const rangeLimit = startMs && endMs
    ? Math.ceil((endMs - startMs) / (intervalMinutes(timeframe) * 60 * 1000)) + 4
    : 0;
  const requestedLimit = Math.max(
    1,
    Math.min(Number(limit) || rangeLimit || 1000, MAX_HISTORICAL_CANDLES),
  );
  const requestLimit = custom
    ? Math.min(MAX_HISTORICAL_CANDLES * 5, requestedLimit * (custom.minutes / intervalMinutes(interval)) + 8)
    : requestedLimit;
  const chunks = [];
  let nextEndTime = endMs;
  let remaining = requestLimit;

  while (remaining > 0) {
    const batchLimit = Math.min(MAX_BINANCE_LIMIT, remaining);
    const candles = await requestKlines({
      endTime: nextEndTime,
      interval,
      limit: batchLimit,
      provider,
      symbol,
    });

    if (candles.length === 0) {
      break;
    }

    chunks.unshift(candles);
    remaining -= candles.length;
    nextEndTime = candles[0].openTime - 1;

    if (candles.length < batchLimit) {
      break;
    }

    if (startMs && nextEndTime < startMs) {
      break;
    }
  }

  const deduped = new Map();
  chunks.flat().forEach((candle) => {
    deduped.set(candle.time, candle);
  });
  let candles = [...deduped.values()]
    .sort((left, right) => left.time - right.time)
    .filter((candle) => (!startMs || candle.openTime >= startMs) && (!endMs || candle.openTime <= endMs));

  if (custom) {
    candles = aggregateCandles(candles, custom.minutes);
  }

  return candles.slice(-requestedLimit);
}

export async function runStrategyForProfile(profile) {
  const rawCandles = await fetchCandles({
    limit: 1000,
    symbol: profile.symbol,
    timeframe: profile.timeframe,
  });
  const closedRaw = rawCandles.filter((candle) => candle.isClosed !== false);
  const sourceCandles =
    profile.strategyParameters.strategySource === "raw-exchange"
      ? closedRaw
      : toHeikenAshi(closedRaw);
  const envelope = calculateNadarayaEnvelope(sourceCandles, {
    bandwidth: profile.strategyParameters.bandwidth,
    multiplier: profile.strategyParameters.envelopeMultiplier,
  });
  const strategy = evaluateChoromanskiStrategy({
    sourceCandles,
    envelope,
    inputs: {
      atrLength: profile.strategyParameters.atrLength,
      atrMultiplier: profile.strategyParameters.atrMultiplier,
      maxSameSideFailures: profile.strategyParameters.maxSameSideFailures,
    },
  });
  const lastClosedIndex = sourceCandles.length - 1;
  const latestEvent = [...strategy.events]
    .reverse()
    .find(
      (event) =>
        event.type === STRATEGY_EVENT_TYPES.ENTRY_TRIGGERED &&
        event.index >= lastClosedIndex - 1,
    );

  return {
    latestEvent,
    rawCandles,
    sourceCandles,
    strategy,
  };
}

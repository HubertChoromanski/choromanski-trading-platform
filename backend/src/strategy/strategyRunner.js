import { evaluateChoromanskiStrategy, STRATEGY_EVENT_TYPES } from "../../../hubert-platform/frontend/src/engine/strategyEngine.js";
import { toHeikenAshi } from "../../../hubert-platform/frontend/src/indicators/heikenAshi.js";
import { calculateNadarayaEnvelope } from "../../../hubert-platform/frontend/src/indicators/nadaraya.js";

const BINANCE_BASE_URL = "https://api.binance.com/api/v3";

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

export async function fetchCandles({ limit = 1000, symbol, timeframe }) {
  const custom = CUSTOM_INTERVALS[timeframe];
  const interval = custom?.base ?? timeframe;
  const requestLimit = custom ? Math.min(1000, limit * (custom.minutes / 5) + 8) : limit;
  const params = new URLSearchParams({
    symbol,
    interval: timeframe === "1h" || timeframe === "4h" ? timeframe : interval,
    limit: String(Math.min(1000, requestLimit)),
  });
  const response = await fetch(`${BINANCE_BASE_URL}/klines?${params.toString()}`);

  if (!response.ok) {
    throw new Error(`Binance request failed: ${response.status}`);
  }

  const candles = (await response.json()).map(normalizeKline);

  if (custom) {
    return aggregateCandles(candles, custom.minutes).slice(-limit);
  }

  return candles.slice(-limit);
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

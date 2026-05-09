import { evaluateChoromanskiStrategy } from "../engine/strategyEngine.js";
import { toHeikenAshi } from "../indicators/heikenAshi.js";
import { calculateNadarayaEnvelope } from "../indicators/nadaraya.js";
import { bingxBroker } from "./bingxBroker.js";
import { runPaperBroker } from "./paperBroker.js";
import { POSITION_SIZE_MODES } from "./positionSizing.js";

export const defaultExecutionConfig = {
  allowLong: true,
  allowShort: true,
  autoExecution: false,
  emergencyStop: false,
  entryPriceMode: "trigger",
  equityPercent: 10,
  exchange: "BingX",
  fixedUsdt: 100,
  leverage: 1,
  marginMode: "isolated",
  maxDailyLossPercent: 5,
  maxWeeklyLossPercent: 10,
  minimumPositionSize: 5,
  maximumPositionSize: 10000,
  maxOpenPositions: 1,
  maxTradesPerDay: 5,
  mode: "paper",
  positionSizeMode: POSITION_SIZE_MODES.RISK_BASED,
  riskPerTradePercent: 1,
  startingBalance: 10000,
  symbol: "SOLUSDT",
  takeProfitRr: 2,
};

function sourceFromSettings(rawCandles, settings) {
  const closedRaw = rawCandles.filter((candle) => candle.isClosed !== false);

  if (settings.strategySource === "raw-exchange") {
    return closedRaw;
  }

  return toHeikenAshi(closedRaw);
}

export function runExecutionSimulation({ executionConfig = {}, rawCandles, strategySettings }) {
  const config = {
    ...defaultExecutionConfig,
    ...executionConfig,
  };
  const sourceCandles = sourceFromSettings(rawCandles, strategySettings);
  const envelope = calculateNadarayaEnvelope(sourceCandles, {
    bandwidth: strategySettings.bandwidth,
    multiplier: strategySettings.envelopeMultiplier,
  });
  const strategy = evaluateChoromanskiStrategy({
    sourceCandles,
    envelope,
    inputs: {
      atrLength: strategySettings.atrLength,
      atrMultiplier: strategySettings.atrMultiplier,
      maxSameSideFailures: strategySettings.maxSameSideFailures,
    },
  });

  if (config.mode !== "paper") {
    return {
      broker: bingxBroker,
      endingEquity: config.startingBalance,
      equityCurve: [],
      events: strategy.events,
      orders: [],
      skipped: [{ reason: "Live execution disabled. Switch to Paper mode." }],
      sourceCandles,
      trades: [],
    };
  }

  return {
    ...runPaperBroker({
      config,
      events: strategy.events,
      sourceCandles,
    }),
    events: strategy.events,
    sourceCandles,
  };
}

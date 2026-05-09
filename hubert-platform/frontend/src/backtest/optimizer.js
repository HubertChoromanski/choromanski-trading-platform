import { runBacktest } from "./backtestEngine";

function parseList(value, fallback) {
  const parsed = String(value)
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0);

  return parsed.length ? parsed : fallback;
}

function cartesian(lists) {
  return lists.reduce(
    (accumulator, list) =>
      accumulator.flatMap((prefix) => list.map((item) => [...prefix, item])),
    [[]],
  );
}

function scoreMetrics(metrics) {
  const profitFactor = Number.isFinite(metrics.profitFactor) ? metrics.profitFactor : 5;
  const tradePenalty = metrics.totalTrades < 20 ? (20 - metrics.totalTrades) * 4 : 0;

  return profitFactor * 35 + metrics.winRate * 0.35 + metrics.netProfit * 0.01 - metrics.maxDrawdown * 2 - tradePenalty;
}

export function runOptimization({
  backtestConfig,
  rawCandles,
  ranges,
  settings,
  maxRuns = 500,
}) {
  const bandwidths = parseList(ranges.bandwidth, [settings.bandwidth]);
  const multipliers = parseList(ranges.envelopeMultiplier, [settings.envelopeMultiplier]);
  const atrLengths = parseList(ranges.atrLength, [settings.atrLength]).map(Math.round);
  const atrMultipliers = parseList(ranges.atrMultiplier, [settings.atrMultiplier]);
  const combinations = cartesian([bandwidths, multipliers, atrLengths, atrMultipliers]).slice(
    0,
    maxRuns,
  );

  return combinations
    .map(([bandwidth, envelopeMultiplier, atrLength, atrMultiplier]) => {
      const testSettings = {
        ...settings,
        atrLength,
        atrMultiplier,
        bandwidth,
        envelopeMultiplier,
      };
      const result = runBacktest({
        backtestConfig,
        rawCandles,
        settings: testSettings,
      });

      return {
        atrLength,
        atrMultiplier,
        averageR:
          result.metrics.averageLoss === 0
            ? 0
            : result.metrics.averageTrade / Math.abs(result.metrics.averageLoss),
        bandwidth,
        envelopeMultiplier,
        expectancy: result.metrics.expectancy,
        maxDrawdown: result.metrics.maxDrawdown,
        netProfit: result.metrics.netProfit,
        profitFactor: result.metrics.profitFactor,
        score: scoreMetrics(result.metrics),
        totalTrades: result.metrics.totalTrades,
        winRate: result.metrics.winRate,
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      if (right.netProfit !== left.netProfit) {
        return right.netProfit - left.netProfit;
      }

      return left.maxDrawdown - right.maxDrawdown;
    })
    .slice(0, 20);
}

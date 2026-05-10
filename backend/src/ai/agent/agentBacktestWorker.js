import { parentPort, workerData } from "node:worker_threads";
import { runBacktest } from "../../../../hubert-platform/frontend/src/backtest/backtestEngine.js";

function sidePnl(trades = [], side) {
  return trades
    .filter((trade) => trade.direction === side)
    .reduce((sum, trade) => sum + Number(trade.netPnl ?? trade.pnl ?? 0), 0);
}

function backtestConclusion(metrics = {}) {
  const tradeCount = Number(metrics.totalTrades ?? 0);
  const netProfit = Number(metrics.netProfit ?? 0);
  const drawdown = Number(metrics.maxDrawdown ?? 0);
  const profitFactor = Number(metrics.profitFactor ?? 0);

  if (tradeCount === 0) {
    return "No trades were found in this sample. Check candle count, timeframe, and setup events.";
  }
  if (netProfit > 0 && profitFactor >= 1.5 && drawdown < 10) {
    return "The sample is positive and drawdown stayed controlled.";
  }
  if (netProfit > 0) {
    return "The sample is profitable, but risk quality depends on drawdown and trade count.";
  }
  return "The sample is not profitable for the selected period.";
}

function memorySnapshot() {
  const memory = process.memoryUsage();
  return {
    heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
    rssMb: Math.round(memory.rss / 1024 / 1024),
  };
}

function summarizeBacktestResult(result, prepared) {
  const candles = prepared.candles ?? [];
  return {
    ambiguity: result.ambiguity,
    ambiguousCandlesCount: result.ambiguousCandlesCount ?? result.ambiguity?.ambiguousCandlesCount ?? 0,
    candlesUsed: candles.length,
    conservativeAdjustedTrades: result.conservativeAdjustedTrades ?? result.ambiguity?.conservativeAdjustedTrades ?? 0,
    conservativeSkippedEntries: result.conservativeSkippedEntries ?? result.ambiguity?.conservativeSkippedEntries ?? 0,
    conclusion: backtestConclusion(result.metrics),
    diagnostics: {
      evaluatedSetupCount: result.diagnosticSummary?.evaluatedCandles ?? result.diagnosticSummary?.totalEvaluatedCandles ?? candles.length,
      setupCount: result.setupAudits?.length ?? result.setupAuditCount ?? 0,
    },
    fillMode: result.fillMode ?? prepared.backtestConfig?.fillMode ?? "legacy",
    longResult: sidePnl(result.trades, "LONG"),
    metrics: result.metrics,
    provider: prepared.provider,
    range: prepared.range,
    settings: prepared.settings,
    shortResult: sidePnl(result.trades, "SHORT"),
    symbol: prepared.symbol,
    timeframe: prepared.timeframe,
    trades: result.trades.slice(0, 100),
  };
}

try {
  const startedAt = Date.now();
  const prepared = workerData?.prepared ?? {};
  const result = runBacktest({
    backtestConfig: prepared.backtestConfig,
    rawCandles: prepared.candles ?? [],
    settings: prepared.settings,
  });
  parentPort.postMessage({
    diagnostics: {
      durationMs: Date.now() - startedAt,
      memory: memorySnapshot(),
      workerLabel: workerData?.label ?? "",
    },
    ok: true,
    result: summarizeBacktestResult(result, prepared),
  });
} catch (error) {
  parentPort.postMessage({
    diagnostics: {
      memory: memorySnapshot(),
      workerLabel: workerData?.label ?? "",
    },
    error: {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : "",
    },
    ok: false,
  });
}

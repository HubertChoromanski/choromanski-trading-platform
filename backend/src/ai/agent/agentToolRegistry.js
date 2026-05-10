function parseList(value, fallback, { integer = false, positive = false } = {}) {
  const source = Array.isArray(value) ? value : String(value ?? "").split(",");
  const parsed = source
    .map((item) => String(item).trim())
    .filter((item) => item !== "")
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item))
    .map((item) => (integer ? Math.round(item) : item))
    .filter((item) => (!positive || item > 0));
  return parsed.length ? parsed : fallback;
}

function scoreResult(metrics = {}, startingBalance = 10000) {
  const netProfit = Number(metrics.netProfit ?? 0);
  const netPercent = startingBalance > 0 ? (netProfit / startingBalance) * 100 : 0;
  const profitFactor = Math.min(Number(metrics.profitFactor ?? 0), 5);
  const drawdown = Math.max(0, Number(metrics.maxDrawdown ?? 0));
  const trades = Number(metrics.totalTrades ?? 0);
  const tradeQuality = trades < 12 ? -8 : Math.min(trades, 80) * 0.035;
  return netPercent + profitFactor * 1.5 + tradeQuality - drawdown * 0.75;
}

function sideValue(result, side) {
  return side === "LONG" ? result.longResult ?? 0 : result.shortResult ?? 0;
}

export function buildSweepCombinations(plan) {
  const parameters = plan.parameters ?? {};
  const sizingMode = plan.sizingMode ?? "position-percent";
  const bandwidths = parseList(parameters.bandwidthValues, [6, 7, 8, 9, 10], { positive: true });
  const envelopes = parseList(parameters.envelopeMultiplierValues, [2, 2.5, 3, 3.5, 4], { positive: true });
  const atrLengths = parseList(parameters.atrLengthValues, [10, 14], { integer: true, positive: true });
  const atrMultipliers = parseList(parameters.atrMultiplierValues, [0.8, 1, 1.2, 1.4, 1.6], { positive: true });
  const maxFailures = parseList(parameters.maxSameSideFailuresValues, [1, 2, 3], { integer: true });
  const sizingValues = parseList(parameters.sizingValues, sizingMode === "fixed-risk" ? [0.5, 1, 2] : [5, 10], { positive: true });
  const combos = [];

  bandwidths.forEach((bandwidth) => {
    envelopes.forEach((envelopeMultiplier) => {
      atrLengths.forEach((atrLength) => {
        atrMultipliers.forEach((atrMultiplier) => {
          maxFailures.forEach((maxSameSideFailures) => {
            sizingValues.forEach((sizingValue) => {
              combos.push({
                atrLength,
                atrMultiplier,
                bandwidth,
                envelopeMultiplier,
                maxSameSideFailures,
                sizingValue,
              });
            });
          });
        });
      });
    });
  });

  return combos;
}

export function createAgentToolRegistry({ tools }) {
  async function runBacktest(plan, overrides = {}) {
    const input = {
      fillMode: plan.fillMode ?? "legacy",
      from: plan.range?.from,
      maxCombinations: plan.maxCombinations,
      provider: plan.provider ?? "binance-futures",
      sizingMode: plan.sizingMode ?? "position-percent",
      symbol: plan.symbol ?? "SOLUSDT",
      timeframe: overrides.timeframe ?? plan.timeframe ?? "15m",
      to: plan.range?.to,
      ...overrides,
    };

    return tools.runHistoricalBacktest(input);
  }

  async function runLargeSweepBatched({ isCancelled, onProgress, plan }) {
    const allCombinations = buildSweepCombinations(plan);
    const combinations = allCombinations.slice(0, Number(plan.maxCombinations ?? 1000));
    const total = combinations.length;
    const rows = [];
    const startingBalance = Number(plan.startingBalance ?? 10000);
    const startedAt = Date.now();

    for (const [index, combo] of combinations.entries()) {
      if (await isCancelled()) {
        return {
          cancelled: true,
          rankedResults: rankSweepResults(rows),
          requestedCombinations: allCombinations.length,
          testedCombinations: rows.length,
          totalCombinations: total,
        };
      }

      const sizingMode = plan.sizingMode ?? "position-percent";
      const result = await runBacktest(plan, {
        ...combo,
        positionPercent: sizingMode === "position-percent" ? combo.sizingValue : undefined,
        riskPercent: sizingMode === "fixed-risk" ? combo.sizingValue : undefined,
        sizingMode,
      });
      const row = {
        candlesUsed: result.candlesUsed,
        fillMode: result.fillMode ?? plan.fillMode ?? "legacy",
        id: `agent-sweep-row-${Date.now()}-${index}`,
        longResult: sideValue(result, "LONG"),
        metrics: result.metrics ?? {},
        params: {
          ...combo,
          fillMode: result.fillMode ?? plan.fillMode ?? "legacy",
          sizingMode,
        },
        score: scoreResult(result.metrics, startingBalance),
        shortResult: sideValue(result, "SHORT"),
        symbol: result.symbol,
        timeframe: result.timeframe,
      };
      rows.push(row);

      if (index % 5 === 0 || index + 1 === total) {
        const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1000);
        const rate = (index + 1) / elapsedSeconds;
        await onProgress({
          completed: index + 1,
          percent: Math.round(((index + 1) / total) * 100),
          remainingSeconds: Math.round((total - index - 1) / Math.max(rate, 0.1)),
          total,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    return {
      cancelled: false,
      rankedResults: rankSweepResults(rows),
      requestedCombinations: allCombinations.length,
      testedCombinations: rows.length,
      totalCombinations: total,
    };
  }

  function rankSweepResults(rows = []) {
    return rows
      .slice()
      .sort((left, right) => Number(right.score ?? 0) - Number(left.score ?? 0))
      .slice(0, 100)
      .map((row, index) => ({
        ...row,
        maxDrawdown: row.metrics?.maxDrawdown ?? 0,
        netProfit: row.metrics?.netProfit ?? 0,
        profitFactor: row.metrics?.profitFactor ?? 0,
        rank: index + 1,
        totalTrades: row.metrics?.totalTrades ?? 0,
        winRate: row.metrics?.winRate ?? 0,
      }));
  }

  return {
    compareBacktests: tools.compareBacktests,
    createAlertDraft: tools.createAlertDraft,
    diagnoseIssue: tools.diagnoseIssue,
    explainCurrentSetup: tools.explainCurrentSetup,
    exportReport: tools.exportReport,
    getPlatformStatus: tools.getPlatformStatus,
    rankSweepResults,
    runBacktest,
    runLargeSweepBatched,
    runHistoricalBacktest: tools.runHistoricalBacktest,
    runSweepAnalysis: tools.runSweepAnalysis,
  };
}

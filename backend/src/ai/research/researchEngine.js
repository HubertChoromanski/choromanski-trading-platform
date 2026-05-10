import { rankResearchCandidates, selectRecommendations } from "./researchComparator.js";
import { buildResearchInsights } from "./researchInsights.js";
import { buildResearchNarrative } from "./researchNarrative.js";
import { researchStages } from "./researchPlanner.js";
import { analyzeRobustness } from "./robustnessAnalyzer.js";
import { splitIntoPeriods, summarizePeriods } from "./periodAnalyzer.js";
import { analyzeRegimeFromPeriods } from "./regimeAnalyzer.js";
import { compareFillModes } from "./sensitivityAnalyzer.js";
import { neighboringTimeframes, summarizeTimeframes } from "./timeframeAnalyzer.js";

function metrics(result = {}) {
  return result.metrics ?? {};
}

function rowFromResult(result = {}, extra = {}) {
  return {
    candlesUsed: result.candlesUsed,
    fillMode: result.fillMode,
    metrics: metrics(result),
    netProfit: metrics(result).netProfit ?? 0,
    profitFactor: metrics(result).profitFactor ?? 0,
    totalTrades: metrics(result).totalTrades ?? 0,
    winRate: metrics(result).winRate ?? 0,
    ...extra,
  };
}

function candidateOverrides(candidate = {}) {
  const params = candidate.params ?? {};
  const sizingMode = params.sizingMode ?? "position-percent";
  return {
    atrLength: params.atrLength,
    atrMultiplier: params.atrMultiplier,
    bandwidth: params.bandwidth,
    envelopeMultiplier: params.envelopeMultiplier,
    maxSameSideFailures: params.maxSameSideFailures,
    positionPercent: sizingMode === "position-percent" ? params.sizingValue : undefined,
    riskPercent: sizingMode === "fixed-risk" ? params.sizingValue : undefined,
    sizingMode,
  };
}

export async function runResearchWorkflow({ isCancelled, onProgress, plan, toolRegistry }) {
  const stages = researchStages(plan);
  const stageSummaries = [];
  const periodRowsForSummary = [];
  const timeframeRowsForSummary = [];

  await onProgress({ completed: 0, percent: 3, total: plan.maxCombinations ?? 1000 }, stages[0].name);
  const exploration = await toolRegistry.runLargeSweepBatched({
    isCancelled,
    onProgress: (progress) => onProgress({ ...progress, percent: Math.min(45, Math.round(progress.percent * 0.45)) }, "Exploration sweep"),
    plan,
  });

  if (exploration.cancelled) {
    return {
      ...exploration,
      cancelled: true,
      summary: `Research cancelled during exploration after ${exploration.testedCombinations} tests.`,
      toolsUsed: ["runLargeSweepBatched"],
    };
  }

  const initialRows = exploration.rankedResults ?? [];
  const validationCandidates = initialRows.slice(0, Math.min(20, initialRows.length));
  stageSummaries.push(`Exploration tested ${exploration.testedCombinations} combinations and kept ${validationCandidates.length} leaders.`);

  const periods = splitIntoPeriods(plan.range, 4);
  const validateTop = validationCandidates.slice(0, Math.min(8, validationCandidates.length));
  const detailedCandidates = [];
  let completed = 0;
  const totalValidationSteps = Math.max(1, validateTop.length * (periods.length + 4));

  for (const candidate of validateTop) {
    if (await isCancelled()) {
      return {
        cancelled: true,
        rankedResults: detailedCandidates,
        summary: "Research cancelled during validation.",
        toolsUsed: ["runHistoricalBacktest", "runLargeSweepBatched"],
      };
    }

    const overrides = candidateOverrides(candidate);
    const periodRows = [];

    for (const period of periods) {
      const result = await toolRegistry.runBacktest(
        { ...plan, range: { from: period.from, to: period.to }, timeframe: candidate.timeframe ?? plan.timeframe },
        overrides,
      );
      const row = rowFromResult(result, { label: period.label, period });
      periodRows.push(row);
      periodRowsForSummary.push(row);
      completed += 1;
      await onProgress({
        completed,
        percent: 45 + Math.round((completed / totalValidationSteps) * 45),
        total: totalValidationSteps,
      }, `Validating ${candidate.rank}: ${period.label}`);
    }

    const legacy = await toolRegistry.runBacktest(
      { ...plan, fillMode: "legacy", timeframe: candidate.timeframe ?? plan.timeframe },
      { ...overrides, fillMode: "legacy" },
    );
    completed += 1;
    const conservative = await toolRegistry.runBacktest(
      { ...plan, fillMode: "conservative", timeframe: candidate.timeframe ?? plan.timeframe },
      { ...overrides, fillMode: "conservative" },
    );
    completed += 1;

    const timeframeRows = [];
    for (const timeframe of neighboringTimeframes(candidate.timeframe ?? plan.timeframe).slice(0, 3)) {
      const result = await toolRegistry.runBacktest(
        { ...plan, timeframe },
        { ...overrides, timeframe },
      );
      const row = rowFromResult(result, { timeframe });
      timeframeRows.push(row);
      timeframeRowsForSummary.push(row);
      completed += 1;
      await onProgress({
        completed,
        percent: 45 + Math.round((completed / totalValidationSteps) * 45),
        total: totalValidationSteps,
      }, `Timeframe sensitivity ${timeframe}`);
    }

    const validation = {
      conservative: rowFromResult(conservative),
      fillSensitivity: compareFillModes({ conservative, legacy }),
      legacy: rowFromResult(legacy),
      periods: periodRows,
      timeframes: timeframeRows,
    };
    const research = analyzeRobustness(candidate, validation, { startingBalance: plan.startingBalance ?? 10000 });
    detailedCandidates.push({
      ...candidate,
      research,
      validation,
    });
  }

  const ranked = rankResearchCandidates(detailedCandidates.length ? detailedCandidates : initialRows);
  const recommendations = selectRecommendations(ranked);
  const periodSummary = summarizePeriods(periodRowsForSummary);
  const timeframeSummary = summarizeTimeframes(timeframeRowsForSummary);
  const regime = analyzeRegimeFromPeriods(periodRowsForSummary);
  const insights = buildResearchInsights({ periodSummary, ranked, recommendations, timeframeSummary });
  const narrative = buildResearchNarrative({ insights, plan, ranked, recommendations, stageSummaries });

  await onProgress({ completed: totalValidationSteps, percent: 100, total: totalValidationSteps }, stages.at(-1).name);

  return {
    best: recommendations.production,
    initialTop: initialRows.slice(0, 20),
    insights,
    narrative,
    nextTests: [
      "Run the production candidate on a separate forward period.",
      "Run a narrower parameter sweep around the stable candidate.",
      "Compare fixed-risk and position-percent sizing before deployment.",
    ],
    periodBreakdown: periodRowsForSummary,
    periodSummary,
    rankedResults: ranked.slice(0, 20),
    recommendations,
    regime,
    robustnessNotes: narrative.productionViability,
    stageSummaries,
    summary: narrative.executiveSummary,
    testedCombinations: exploration.testedCombinations,
    timeframeComparison: timeframeRowsForSummary,
    timeframeSummary,
    toolsUsed: ["runLargeSweepBatched", "runHistoricalBacktest", "robustnessAnalyzer", "overfitDetector"],
    totalCombinations: exploration.totalCombinations,
    warnings: [
      ...(exploration.requestedCombinations > exploration.totalCombinations
        ? [`Generated ${exploration.requestedCombinations} combinations and tested ${exploration.totalCombinations}.`]
        : []),
      "Research rankings are analytical recommendations only. AI cannot deploy or execute trades.",
    ],
  };
}

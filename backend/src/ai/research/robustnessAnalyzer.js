import { detectOverfit } from "./overfitDetector.js";
import { candidateLabel, metric, robustnessScore } from "./researchScoring.js";

function profitableRatio(rows = []) {
  if (!rows.length) return 0.5;
  return rows.filter((row) => metric(row, "netProfit") > 0).length / rows.length;
}

function sensitivityFromPair(base, comparison) {
  const baseProfit = Math.abs(metric(base, "netProfit"));
  if (baseProfit <= 0) return metric(comparison, "netProfit") < 0 ? 1 : 0;
  return Math.max(0, Math.min(1, (metric(base, "netProfit") - metric(comparison, "netProfit")) / baseProfit));
}

export function analyzeRobustness(candidate = {}, validation = {}, context = {}) {
  const periodConsistency = profitableRatio(validation.periods ?? []);
  const timeframeConsistency = profitableRatio(validation.timeframes ?? []);
  const consistencyScore = Number(((periodConsistency * 0.7) + (timeframeConsistency * 0.3)).toFixed(3));
  const fillModeSensitivity = validation.legacy && validation.conservative
    ? sensitivityFromPair(validation.legacy, validation.conservative)
    : 0;
  const timeframeSensitivity = validation.timeframes?.length
    ? 1 - timeframeConsistency
    : 0;
  const overfit = detectOverfit(candidate, validation);
  const analysis = {
    consistencyScore,
    fillModeSensitivity,
    timeframeSensitivity,
    overfitRiskScore: overfit.overfitRiskScore,
    startingBalance: context.startingBalance,
  };
  const score = robustnessScore(candidate, analysis);

  return {
    ...analysis,
    label: candidateLabel({ ...candidate, robustnessScore: score }, analysis),
    overfit,
    robustnessScore: score,
  };
}

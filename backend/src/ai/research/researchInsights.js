export function buildResearchInsights({ recommendations = {}, ranked = [], periodSummary = {}, timeframeSummary = {} }) {
  const insights = [];
  const production = recommendations.production;

  if (production) {
    insights.push(`Production candidate: rank ${production.rank} with robustness score ${production.research?.robustnessScore ?? production.score}.`);
  }

  if (recommendations.aggressive && recommendations.aggressive.id !== production?.id) {
    insights.push(`Aggressive candidate: rank ${recommendations.aggressive.rank}, higher upside but weaker stability controls.`);
  }

  if (periodSummary.strongestPeriods?.length) {
    insights.push(`Strongest periods: ${periodSummary.strongestPeriods.join(", ")}.`);
  }

  if (timeframeSummary.bestTimeframe) {
    insights.push(`Best neighboring timeframe in validation: ${timeframeSummary.bestTimeframe}.`);
  }

  const risky = ranked.filter((row) => row.research?.overfit?.label === "high").length;
  if (risky) {
    insights.push(`${risky} top candidate(s) show high overfit risk and should be avoided for production.`);
  }

  return insights.length ? insights : ["No strong conclusion emerged from the available validation sample."];
}

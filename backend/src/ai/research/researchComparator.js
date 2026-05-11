export function rankResearchCandidates(candidates = []) {
  return candidates
    .slice()
    .sort((left, right) => {
      const leftPassed = left.constraintStatus?.passed === false ? 0 : 1;
      const rightPassed = right.constraintStatus?.passed === false ? 0 : 1;
      if (leftPassed !== rightPassed) return rightPassed - leftPassed;
      return Number(right.research?.robustnessScore ?? right.robustnessScore ?? right.score ?? 0) - Number(left.research?.robustnessScore ?? left.robustnessScore ?? left.score ?? 0);
    })
    .map((candidate, index) => ({
      ...candidate,
      rank: index + 1,
    }));
}

export function selectRecommendations(candidates = []) {
  const ranked = rankResearchCandidates(candidates);
  return {
    aggressive: ranked.find((row) => row.research?.label === "aggressive candidate") ?? ranked.find((row) => Number(row.netProfit ?? row.metrics?.netProfit ?? 0) > 0) ?? null,
    avoid: ranked.filter((row) => ["unstable", "overfit risk", "low sample"].includes(row.research?.label)).slice(0, 5),
    production: ranked.find((row) => row.constraintStatus?.passed !== false && row.research?.label === "production candidate") ?? ranked.find((row) => row.constraintStatus?.passed !== false) ?? null,
    stable: ranked.find((row) => row.constraintStatus?.passed !== false && row.research?.consistencyScore >= 0.65 && Number(row.research?.overfitRiskScore ?? 1) < 0.4) ?? ranked.find((row) => row.constraintStatus?.passed !== false) ?? null,
  };
}

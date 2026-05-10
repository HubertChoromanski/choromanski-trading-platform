export function researchStages(plan = {}) {
  return [
    {
      id: "exploration",
      name: "Exploration",
      summary: `Run up to ${plan.maxCombinations ?? 1000} combinations and collect compact rankings.`,
    },
    {
      id: "filtering",
      name: "Filtering",
      summary: "Keep top candidates with enough trades and acceptable drawdown for validation.",
    },
    {
      id: "validation",
      name: "Validation",
      summary: "Re-test leaders across sub-periods, fill modes, and neighboring timeframes.",
    },
    {
      id: "robustness",
      name: "Robustness testing",
      summary: "Score consistency, sensitivity, and overfit risk.",
    },
    {
      id: "recommendation",
      name: "Recommendation",
      summary: "Produce production/aggressive/stable/avoid recommendations with evidence.",
    },
  ];
}

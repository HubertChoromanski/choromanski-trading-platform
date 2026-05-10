function paramSummary(row = {}) {
  const params = row.params ?? {};
  return `BW ${params.bandwidth ?? "?"}, NWE ${params.envelopeMultiplier ?? "?"}, ATR ${params.atrLength ?? "?"}/${params.atrMultiplier ?? "?"}, max failures ${params.maxSameSideFailures ?? "?"}, ${params.sizingMode ?? "position-percent"}`;
}

export function buildResearchNarrative({ insights = [], plan = {}, recommendations = {}, ranked = [], stageSummaries = [] }) {
  const production = recommendations.production;

  return {
    executiveSummary: production
      ? `The strongest research candidate is rank ${production.rank}: ${paramSummary(production)}. It is labeled "${production.research?.label}" with overfit risk "${production.research?.overfit?.label}".`
      : "No production candidate was identified from the available tests.",
    methodology: [
      "Ran initial exploration using the existing backtest engine.",
      "Filtered top candidates by robustness-adjusted score, not raw PnL alone.",
      "Validated leaders across periods, fill modes, and neighboring timeframes where practical.",
      "Applied overfit heuristics and sample-size checks before recommendations.",
    ],
    objective: plan.objective ?? "robustness-adjusted return",
    productionViability: production?.research?.label === "production candidate"
      ? "Candidate is viable for further paper/live observation after out-of-sample checks."
      : "Treat the result as research only until more validation improves stability.",
    recommendedConfigurations: {
      aggressive: recommendations.aggressive ? paramSummary(recommendations.aggressive) : null,
      avoid: recommendations.avoid?.map((row) => `${paramSummary(row)} (${row.research?.label})`) ?? [],
      production: production ? paramSummary(production) : null,
      stable: recommendations.stable ? paramSummary(recommendations.stable) : null,
    },
    sections: {
      dataUsed: `${plan.symbol ?? "SOLUSDT"} ${(plan.timeframes ?? [plan.timeframe]).join(", ")} ${plan.range?.from ?? ""} to ${plan.range?.to ?? ""} via ${plan.provider ?? "binance-futures"}.`,
      initialFindings: ranked.slice(0, 5).map((row) => `Rank ${row.rank}: ${paramSummary(row)} | robustness ${row.research?.robustnessScore ?? row.score} | ${row.research?.label}`),
      insights,
      stageSummaries,
      weaknesses: ranked.slice(0, 5).flatMap((row) => row.research?.overfit?.explanation ?? []).slice(0, 8),
    },
  };
}

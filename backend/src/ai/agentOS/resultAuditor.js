function metric(row = {}, key) {
  return row.canonical?.metrics?.[key] ??
    row.metrics?.[key] ??
    row[key] ??
    null;
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sorted(rows = [], selector, direction = "desc") {
  return [...rows].sort((left, right) => {
    const delta = numeric(selector(right)) - numeric(selector(left));
    return direction === "desc" ? delta : -delta;
  });
}

export function selectCategoryWinners(rows = []) {
  const usable = rows.filter((row) => numeric(metric(row, "totalTrades") ?? metric(row, "trades")) > 0);
  const source = usable.length ? usable : rows;
  const winners = {
    bestOverall: sorted(source, (row) => row.research?.robustnessScore ?? row.score)[0] ?? null,
    bestPF: sorted(source, (row) => metric(row, "profitFactor"))[0] ?? null,
    bestWinRate: sorted(source, (row) => metric(row, "winRate"))[0] ?? null,
    bestNetProfit: sorted(source, (row) => metric(row, "netProfit") ?? metric(row, "netPnl"))[0] ?? null,
    lowestDrawdown: sorted(source, (row) => metric(row, "maxDrawdown"), "asc")[0] ?? null,
  };
  return winners;
}

export function auditResultQuality(rows = [], winners = {}) {
  const warnings = [];
  const values = Object.values(winners).filter(Boolean);
  if (!rows.length) warnings.push("No ranked results were produced.");
  values.forEach((row) => {
    const trades = numeric(metric(row, "totalTrades") ?? metric(row, "trades"));
    const pf = numeric(metric(row, "profitFactor"));
    const dd = numeric(metric(row, "maxDrawdown"));
    if (trades < 30) warnings.push(`Rank ${row.rank ?? "?"}: low sample (${trades} trades).`);
    if (pf <= 1) warnings.push(`Rank ${row.rank ?? "?"}: PF is not above 1.`);
    if (dd > 25) warnings.push(`Rank ${row.rank ?? "?"}: drawdown is high (${dd}).`);
  });
  const strongEnough = values.some((row) => numeric(metric(row, "profitFactor")) > 1.2 && numeric(metric(row, "totalTrades") ?? metric(row, "trades")) >= 30);
  return {
    label: strongEnough ? "research candidates found" : "weak or incomplete results",
    strongEnough,
    warnings: [...new Set(warnings)],
  };
}

export function auditSearchCoverage({ agentPlan = {}, aiRun = {}, manualResult = null } = {}) {
  const differences = [];
  const plan = aiRun.plan ?? agentPlan;
  if (manualResult?.timeframe && manualResult.timeframe !== plan.timeframe) differences.push("timeframe differs");
  if (manualResult?.provider && manualResult.provider !== plan.provider) differences.push("provider differs");
  if (manualResult?.fillMode && manualResult.fillMode !== plan.fillMode) differences.push("fill mode differs");
  if (manualResult?.sizingMode && manualResult.sizingMode !== plan.sizingMode) differences.push("sizing mode differs");
  if (manualResult?.range?.from && plan.range?.from && manualResult.range.from !== plan.range.from) differences.push("from date differs");
  if (manualResult?.range?.to && plan.range?.to && manualResult.range.to !== plan.range.to) differences.push("to date differs");
  return {
    conclusion: differences.length
      ? "Manual and AH results are not directly comparable until these assumptions match."
      : "No obvious context mismatch was detected; compare exact parameters and cache provenance next.",
    differences,
    checked: ["range", "timeframe", "provider", "fill mode", "sizing mode", "strategy/MM assumptions"],
  };
}

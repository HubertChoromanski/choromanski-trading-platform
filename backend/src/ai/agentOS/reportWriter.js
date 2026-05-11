function number(value, digits = 2) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : "n/a";
}

function metric(row = {}, key) {
  return row.canonical?.metrics?.[key] ?? row.metrics?.[key] ?? row[key] ?? "";
}

function rrr(row = {}) {
  return metric(row, "rrr") || "RRR unavailable";
}

function avgR(row = {}) {
  return metric(row, "avgR") || row.averageR || "Avg R unavailable";
}

function params(row = {}) {
  const p = row.params ?? {};
  return `BW ${p.bandwidth ?? "?"}, NWE ${p.envelopeMultiplier ?? "?"}, ATR ${p.atrLength ?? "?"}/${p.atrMultiplier ?? "?"}, max ${p.maxSameSideFailures ?? "?"}, ${p.sizingMode ?? ""} ${p.sizingValue ?? ""}`.trim();
}

function winnerLine(label, row) {
  if (!row) return `- ${label}: no candidate found.`;
  return `- ${label}: rank ${row.rank ?? "?"}, net ${number(metric(row, "netProfit") ?? metric(row, "netPnl"))}, PF ${number(metric(row, "profitFactor"))}, win ${number(metric(row, "winRate"))}%, RRR ${rrr(row)}, Avg R/trade ${avgR(row)}, DD ${number(metric(row, "maxDrawdown"))}, trades ${metric(row, "totalTrades") ?? metric(row, "trades") ?? "n/a"}; ${params(row)}.`;
}

export function writeAgentOSMarkdown({ output = {}, plan = {}, run = {} } = {}) {
  const winners = output.categoryWinners ?? {};
  const quality = output.qualityAudit ?? {};
  const rows = output.rankedResults ?? output.rows ?? [];
  const isPolish = plan.language === "pl";
  const title = isPolish ? "# Raport Artificial Hubert Agent OS" : "# Artificial Hubert Agent OS Report";
  return [
    title,
    "",
    `## ${isPolish ? "Podsumowanie" : "Executive Summary"}`,
    output.summary ?? (isPolish ? "AH zakończył badanie." : "AH completed the research."),
    quality.strongEnough === false
      ? (isPolish ? "Nie znalazłem mocnego kandydata w tym zakresie; najlepsze wyniki traktuję jako eksploracyjne." : "I did not find a strong candidate in this range; best rows are exploratory.")
      : (isPolish ? "Znalazłem kandydatów badawczych, ale wymagają walidacji przed live." : "I found research candidates, but they need validation before live."),
    "",
    `## ${isPolish ? "Cel użytkownika" : "User Goal"}`,
    run.prompt ?? plan.userGoal ?? "",
    "",
    `## ${isPolish ? "Dane i założenia" : "Data and Assumptions"}`,
    `- Symbol/timeframe: ${plan.symbol ?? "SOLUSDT"} ${plan.timeframe ?? "15m"}`,
    `- Range: ${plan.range?.from ?? "auto"} → ${plan.range?.to ?? "auto"}`,
    `- Provider: ${plan.provider ?? "binance-futures"}`,
    `- Fill mode: ${plan.fillMode ?? "legacy"}`,
    `- Sizing mode: ${plan.sizingMode ?? "position-percent"}`,
    `- Requested/planned combinations: ${plan.requestedCombinations ?? plan.maxCombinations ?? "n/a"} / ${plan.plannedCombinations ?? plan.maxCombinations ?? "n/a"}`,
    "",
    `## ${isPolish ? "Metodyka" : "Methodology"}`,
    "- Stage 1: broad exploration sweep.",
    "- Stage 2: ranking by multiple objectives.",
    "- Stage 3: robustness/self-critique checks from available validation data.",
    "- Stage 4: artifact generation and manifest export.",
    "",
    `## ${isPolish ? "Zwycięzcy kategorii" : "Category Winners"}`,
    winnerLine(isPolish ? "Najlepszy PF" : "Best PF", winners.bestPF),
    winnerLine(isPolish ? "Najlepsza skuteczność" : "Best win rate", winners.bestWinRate),
    winnerLine(isPolish ? "Największy zysk" : "Best net profit", winners.bestNetProfit),
    winnerLine(isPolish ? "Najniższy DD" : "Lowest drawdown", winners.lowestDrawdown),
    winnerLine(isPolish ? "Najlepszy całościowo" : "Best overall", winners.bestOverall),
    "",
    `## ${isPolish ? "Top 10" : "Top 10"}`,
    "| Rank | Score | Net | PF | Win % | RRR | Avg R / trade | DD | Trades | Params |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...rows.slice(0, 10).map((row) => `| ${row.rank ?? ""} | ${number(row.score)} | ${number(metric(row, "netProfit") ?? metric(row, "netPnl"))} | ${number(metric(row, "profitFactor"))} | ${number(metric(row, "winRate"))} | ${rrr(row)} | ${avgR(row)} | ${number(metric(row, "maxDrawdown"))} | ${metric(row, "totalTrades") ?? metric(row, "trades") ?? ""} | ${params(row)} |`),
    "",
    `## ${isPolish ? "Słabości / self-critique" : "Weaknesses / Self-Critique"}`,
    ...(quality.warnings?.length ? quality.warnings.map((warning) => `- ${warning}`) : ["- No major quality warning was generated."]),
    "",
    `## ${isPolish ? "Rekomendacje" : "Recommendations"}`,
    output.recommendation ?? (isPolish
      ? "Nie używaj tych wyników do live bez Conservative fill, walidacji okresowej i ręcznego Open Backtest/Re-run exact."
      : "Do not use these results live without Conservative fill, period validation, and manual Open Backtest/Re-run exact."),
    "",
    `## ${isPolish ? "Następne eksperymenty" : "Next Experiments"}`,
    ...(output.nextTests ?? [
      "Validate top rows with Conservative fill.",
      "Run neighboring-parameter tests around category winners.",
      "Compare against any trusted manual baseline.",
    ]).map((item) => `- ${item}`),
  ].join("\n");
}

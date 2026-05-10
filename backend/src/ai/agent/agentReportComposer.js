function number(value, digits = 2) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : "n/a";
}

function metricValue(row, key) {
  return row?.metrics?.[key] ?? row?.[key] ?? "";
}

export function rowsToCsv(rows = []) {
  if (!rows.length) return "field,value\nmessage,\"No rows available\"\n";

  const flatRows = rows.map((row) => ({
    atrLength: row.params?.atrLength,
    atrMultiplier: row.params?.atrMultiplier,
    bandwidth: row.params?.bandwidth,
    conservativeNetProfit: row.conservative?.metrics?.netProfit,
    envelopeMultiplier: row.params?.envelopeMultiplier,
    fillMode: row.params?.fillMode ?? row.fillMode,
    legacyNetProfit: row.legacy?.metrics?.netProfit,
    maxDrawdown: metricValue(row, "maxDrawdown"),
    maxSameSideFailures: row.params?.maxSameSideFailures,
    netProfit: metricValue(row, "netProfit"),
    overfitRisk: row.research?.overfit?.label,
    overfitRiskScore: row.research?.overfitRiskScore,
    profitFactor: metricValue(row, "profitFactor"),
    rank: row.rank,
    researchLabel: row.research?.label,
    robustnessScore: row.research?.robustnessScore,
    score: row.score,
    sizingMode: row.params?.sizingMode,
    symbol: row.symbol,
    timeframe: row.timeframe,
    totalTrades: metricValue(row, "totalTrades"),
    winRate: metricValue(row, "winRate"),
  }));
  const headers = [...new Set(flatRows.flatMap((row) => Object.keys(row)))];
  const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;

  return [
    headers.join(","),
    ...flatRows.map((row) => headers.map((key) => escape(row[key])).join(",")),
  ].join("\n");
}

export function composeAgentMarkdown({ output = {}, plan = {}, run = {} }) {
  const topRows = output.rankedResults ?? output.rows ?? [];
  const best = topRows[0] ?? output.best ?? null;
  const narrative = output.narrative;
  const lines = [
    `# AI Agent Report`,
    "",
    "## Executive Summary",
    narrative?.executiveSummary ?? output.summary ?? (best
      ? `Best visible result is rank ${best.rank ?? 1} with score ${number(best.score)}.`
      : "The agent completed the requested analysis."),
    "",
    "## Task Interpreted",
    `- Prompt: ${run.prompt ?? ""}`,
    `- Objective: ${plan.objective ?? "robustness-adjusted return"}`,
    `- Symbol: ${plan.symbol ?? "SOLUSDT"}`,
    `- Timeframe(s): ${(plan.timeframes ?? [plan.timeframe ?? "15m"]).join(", ")}`,
    `- Range: ${plan.range?.from ?? "auto"} to ${plan.range?.to ?? "auto"}`,
    `- Provider: ${plan.provider ?? "binance-futures"}`,
    `- Fill mode: ${plan.fillMode ?? "legacy"}`,
    "",
    "## Data Used",
    `- Combinations tested: ${output.totalCombinations ?? output.testedCombinations ?? 0}`,
    `- Candles used: ${output.candlesUsed ?? output.best?.candlesUsed ?? "varies by test"}`,
    `- Backend tools: ${(output.toolsUsed ?? []).join(", ") || "existing platform tools"}`,
    "",
    "## Top Configurations",
  ];

  if (topRows.length) {
    lines.push("| Rank | Score | Net PnL | PF | Win % | Trades | Params |");
    lines.push("| ---: | ---: | ---: | ---: | ---: | ---: | --- |");
    topRows.slice(0, 5).forEach((row, index) => {
      const params = row.params
        ? `BW ${row.params.bandwidth}, NWE ${row.params.envelopeMultiplier}, ATR ${row.params.atrLength}/${row.params.atrMultiplier}, max ${row.params.maxSameSideFailures}, ${row.params.sizingMode ?? ""}`
        : row.timeframe ?? row.label ?? "result";
      lines.push(`| ${row.rank ?? index + 1} | ${number(row.score)} | ${number(metricValue(row, "netProfit"))} | ${number(metricValue(row, "profitFactor"))} | ${number(metricValue(row, "winRate"))} | ${metricValue(row, "totalTrades") ?? 0} | ${params} |`);
    });
  } else {
    lines.push("No ranked rows were produced.");
  }

  lines.push(
    "",
    "## Methodology",
    ...(narrative?.methodology?.length ? narrative.methodology.map((item) => `- ${item}`) : ["- Used existing platform tools without changing strategy or backtest math."]),
    "",
    "## Robustness",
    output.robustnessNotes ?? narrative?.productionViability ?? "Treat the ranking as a research result. Re-test nearby settings across neighboring periods before deployment.",
    "",
    "## Overfit Risk",
    ...(topRows.slice(0, 5).map((row) => `- Rank ${row.rank ?? "?"}: ${row.research?.overfit?.label ?? "not evaluated"} risk. ${(row.research?.overfit?.explanation ?? []).join(" ")}`)),
    "",
    "## Period / Regime Notes",
    ...(output.regime?.notes?.map((note) => `- ${note}`) ?? ["- Period validation was not available for this run."]),
    "",
    "## Recommendations",
    `- Production: ${narrative?.recommendedConfigurations?.production ?? "No production candidate"}`,
    `- Stable: ${narrative?.recommendedConfigurations?.stable ?? "No stable candidate"}`,
    `- Aggressive: ${narrative?.recommendedConfigurations?.aggressive ?? "No aggressive candidate"}`,
    "",
    "## Risks",
    ...(output.warnings?.length ? output.warnings.map((warning) => `- ${warning}`) : ["- Sample size and data freshness can change conclusions.", "- AI analysis cannot place trades and does not modify live execution."]),
    "",
    "## Recommended Next Tests",
    ...(output.nextTests?.length ? output.nextTests.map((item) => `- ${item}`) : ["- Re-run the best rows on a different period.", "- Compare legacy and conservative fill mode before trusting a configuration."]),
    "",
    "## Presentation Summary",
    "### Slide 1: Summary",
    output.summary ?? "Analysis completed.",
    "### Slide 2: Data/Assumptions",
    `${plan.symbol ?? "SOLUSDT"} on ${(plan.timeframes ?? [plan.timeframe ?? "15m"]).join(", ")} using ${plan.provider ?? "binance-futures"}.`,
    "### Slide 3: Best Configs",
    best ? JSON.stringify(best.params ?? best, null, 2) : "No best config.",
    "### Slide 4: Robustness",
    output.robustnessNotes ?? "Needs walk-forward checks.",
    "### Slide 5: Risks",
    (output.warnings ?? ["Check sample size."]).join(" "),
    "### Slide 6: Recommendation",
    output.recommendation ?? "Use the result as research, not automatic execution.",
  );

  return lines.join("\n");
}

export function composeEmailDraft({ markdown, plan = {} }) {
  return {
    attachments: [],
    body: markdown,
    provider: process.env.EMAIL_PROVIDER ?? "disabled",
    subject: `Trading analysis: ${plan.symbol ?? "SOLUSDT"} ${(plan.timeframes ?? [plan.timeframe ?? "15m"]).join(", ")}`,
  };
}

export function composeTelegramDraft({ markdown }) {
  const maxLength = 3500;
  const chunks = [];
  for (let index = 0; index < markdown.length; index += maxLength) {
    chunks.push(markdown.slice(index, index + maxLength));
  }

  return {
    chatConfigured: Boolean(process.env.TELEGRAM_CHAT_ID),
    chunks,
    provider: process.env.TELEGRAM_PROVIDER ?? "disabled",
  };
}

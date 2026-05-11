import { buildRunReasoningSummary } from "../reasoning/reasoningEngine.js";

function number(value, digits = 2) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : "n/a";
}

function metricValue(row, key) {
  if (key === "netProfit") return row?.canonical?.metrics?.netPnl ?? row?.metrics?.netProfit ?? row?.netProfit ?? "";
  if (key === "totalTrades") return row?.canonical?.metrics?.trades ?? row?.metrics?.totalTrades ?? row?.totalTrades ?? "";
  if (key === "maxDrawdown") return row?.canonical?.metrics?.maxDrawdown ?? row?.metrics?.maxDrawdown ?? row?.maxDrawdown ?? "";
  if (key === "profitFactor") return row?.canonical?.metrics?.profitFactor ?? row?.metrics?.profitFactor ?? row?.profitFactor ?? "";
  if (key === "winRate") return row?.canonical?.metrics?.winRate ?? row?.metrics?.winRate ?? row?.winRate ?? "";
  return row?.metrics?.[key] ?? row?.canonical?.metrics?.[key] ?? row?.[key] ?? "";
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
    integrityScore: row.integrity?.score,
    integrityStatus: row.integrity?.status,
    integrityWarnings: (row.integrity?.warnings ?? []).join("; "),
    canonicalConfigId: row.canonical?.configId,
    canonicalRunId: row.canonical?.runId,
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
  const reasoning = buildRunReasoningSummary({ run: { ...run, plan }, rows: topRows });
  const topReasoningSections = reasoning.sections ?? [];
  const evidenceSection = topReasoningSections.find((section) => section.title === "Evidence Used");
  const concernSection = topReasoningSections.find((section) => section.title === "What Worries Me")
    ?? topReasoningSections.find((section) => section.title === "Uncertainty");
  const combinationsTested = output.processedCombinations ?? output.testedCombinations ?? output.totalCombinations ?? output.resultSummary?.executedCombinations ?? 0;
  const integrity = output.integrity ?? {};
  const lines = [
    `# AI Agent Report`,
    "",
    "## Executive Summary",
    reasoning.headline ?? narrative?.executiveSummary ?? output.summary ?? (best
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
    `- Combinations tested: ${combinationsTested}`,
    `- Candles used: ${output.candlesUsed ?? output.best?.candlesUsed ?? "varies by test"}`,
    `- Backend tools: ${(output.toolsUsed ?? []).join(", ") || "existing platform tools"}`,
    `- Integrity score: ${integrity.score ?? "not evaluated"}`,
    `- Complete rows: ${integrity.completeRows ?? "n/a"}`,
    "",
    "## Integrity Warnings",
    ...(integrity.warnings?.length ? integrity.warnings.map((warning) => `- ${warning}`) : ["- No report integrity warning was produced."]),
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
    "## Key Evidence",
    ...(evidenceSection?.bullets?.length
      ? evidenceSection.bullets.map((item) => `- ${item}`)
      : ["- No compact evidence block was available for the top row."]),
    "",
    "## Why Top Configs Won",
    ...(topRows.slice(0, 5).map((row) => {
      const label = row.research?.label ?? "research candidate";
      const overfit = row.research?.overfit?.label ?? "not evaluated";
      return `- Rank ${row.rank ?? "?"}: ${label}. It scored ${number(row.research?.robustnessScore ?? row.score)} with net ${number(metricValue(row, "netProfit"))}, PF ${number(metricValue(row, "profitFactor"))}, drawdown ${number(metricValue(row, "maxDrawdown"))}, ${metricValue(row, "totalTrades") ?? 0} trades, and ${overfit} overfit risk.`;
    })),
    "",
    "## Methodology",
    ...(narrative?.methodology?.length ? narrative.methodology.map((item) => `- ${item}`) : ["- Used existing platform tools without changing strategy or backtest math."]),
    "",
    "## Robustness",
    output.robustnessNotes ?? narrative?.productionViability ?? "Treat the ranking as a research result. Re-test nearby settings across neighboring periods before deployment.",
    "",
    "## Weaknesses and Risks",
    ...(concernSection?.bullets?.length
      ? concernSection.bullets.map((item) => `- ${item}`)
      : (reasoning.risks ?? ["Sample size and validation coverage should be checked."]).map((item) => `- ${item}`)),
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
    "## Confidence Level",
    `- ${reasoning.confidence?.label ?? "unknown"} (${reasoning.confidence?.score ?? "n/a"}/100).`,
    ...(reasoning.confidence?.reasons?.length ? reasoning.confidence.reasons.map((item) => `- ${item}`) : ["- Confidence details were not available."]),
    "",
    "## What Could Invalidate This",
    "- A materially worse Conservative fill result.",
    "- Performance concentrated in one small historical period.",
    "- Neighboring parameters or timeframes collapsing.",
    "- Manual exact rerun metrics not matching the agent row provenance.",
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

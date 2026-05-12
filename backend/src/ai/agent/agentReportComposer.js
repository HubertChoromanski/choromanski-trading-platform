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
  if (key === "rrr") return row?.canonical?.metrics?.rrr ?? row?.metrics?.rrr ?? row?.rrr ?? "";
  if (key === "avgR") return row?.canonical?.metrics?.avgR ?? row?.metrics?.avgR ?? row?.avgR ?? row?.averageR ?? "";
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
    rangeFrom: row.provenance?.from ?? row.canonical?.range?.from,
    rangeTo: row.provenance?.to ?? row.canonical?.range?.to,
    legacyNetProfit: row.legacy?.metrics?.netProfit,
    maxDrawdown: metricValue(row, "maxDrawdown"),
    maxSameSideFailures: row.params?.maxSameSideFailures,
    primaryRankingObjective: row.primaryRankingObjective ?? row.params?.primaryRankingObjective ?? row.canonical?.primaryRankingObjective,
    primaryRankingObjectiveLabel: row.primaryRankingObjectiveLabel ?? row.params?.primaryRankingObjectiveLabel,
    netProfit: metricValue(row, "netProfit"),
    overfitRisk: row.research?.overfit?.label,
    overfitRiskScore: row.research?.overfitRiskScore,
    profitFactor: metricValue(row, "profitFactor"),
    rank: row.rank,
    researchLabel: row.research?.label,
    robustnessScore: row.research?.robustnessScore,
    score: row.score,
    sizingMode: row.params?.sizingMode,
    rrr: metricValue(row, "rrr") || "RRR unavailable",
    rrrSource: row.rrrSource ?? row.metrics?.rrrSource,
    avgRPerTrade: metricValue(row, "avgR") || "Avg R unavailable",
    avgRSource: row.avgRSource ?? row.metrics?.avgRSource,
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
  const isPolish = plan.language === "pl";
  const label = isPolish
    ? {
        confidence: "Poziom pewności",
        data: "Użyte dane",
        evidence: "Kluczowe dowody",
        executive: "Podsumowanie",
        integrity: "Ostrzeżenia integralności",
        methodology: "Metodyka",
        next: "Rekomendowane kolejne testy",
        overfit: "Ryzyko przeuczenia",
        presentation: "Podsumowanie prezentacyjne",
        recommendations: "Rekomendacje",
        risks: "Ryzyka",
        robustness: "Odporność wyniku",
        task: "Zinterpretowane zadanie",
        top: "Najlepsze konfiguracje",
        why: "Dlaczego te konfiguracje wygrały",
      }
    : {
        confidence: "Confidence Level",
        data: "Data Used",
        evidence: "Key Evidence",
        executive: "Executive Summary",
        integrity: "Integrity Warnings",
        methodology: "Methodology",
        next: "Recommended Next Tests",
        overfit: "Overfit Risk",
        presentation: "Presentation Summary",
        recommendations: "Recommendations",
        risks: "Risks",
        robustness: "Robustness",
        task: "Task Interpreted",
        top: "Top Configurations",
        why: "Why Top Configs Won",
      };
  const lines = [
    isPolish ? "# Raport Agenta AI" : "# AI Agent Report",
    "",
    `## ${label.executive}`,
    reasoning.headline ?? narrative?.executiveSummary ?? output.summary ?? (best
      ? `Best visible result is rank ${best.rank ?? 1} with score ${number(best.score)}.`
      : "The agent completed the requested analysis."),
    "",
    `## ${label.task}`,
    `- ${isPolish ? "Polecenie" : "Prompt"}: ${run.prompt ?? ""}`,
    `- ${isPolish ? "Cel" : "Objective"}: ${plan.objective ?? "robustness-adjusted return"}`,
    `- Symbol: ${plan.symbol ?? "SOLUSDT"}`,
    `- ${isPolish ? "Interwał(y)" : "Timeframe(s)"}: ${(plan.timeframes ?? [plan.timeframe ?? "15m"]).join(", ")}`,
    `- ${isPolish ? "Zakres" : "Range"}: ${plan.range?.from ?? "auto"} to ${plan.range?.to ?? "auto"}`,
    `- Provider: ${plan.provider ?? "binance-futures"}`,
    `- Fill mode: ${plan.fillMode ?? "legacy"}`,
    "",
    `## ${label.data}`,
    `- ${isPolish ? "Przetestowane kombinacje" : "Combinations tested"}: ${combinationsTested}`,
    `- ${isPolish ? "Użyte świece" : "Candles used"}: ${output.candlesUsed ?? output.best?.candlesUsed ?? "varies by test"}`,
    `- ${isPolish ? "Narzędzia backendu" : "Backend tools"}: ${(output.toolsUsed ?? []).join(", ") || "existing platform tools"}`,
    `- ${isPolish ? "Wynik integralności" : "Integrity score"}: ${integrity.score ?? "not evaluated"}`,
    `- ${isPolish ? "Kompletne wiersze" : "Complete rows"}: ${integrity.completeRows ?? "n/a"}`,
    "",
    `## ${label.integrity}`,
    ...(integrity.warnings?.length ? integrity.warnings.map((warning) => `- ${warning}`) : [isPolish ? "- Brak ostrzeżeń integralności raportu." : "- No report integrity warning was produced."]),
    "",
    `## ${label.top}`,
  ];

  if (topRows.length) {
    lines.push("| Rank | Score | Net PnL | PF | Win % | RRR | Avg R / trade | Trades | Params |");
    lines.push("| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
    topRows.slice(0, 5).forEach((row, index) => {
      const params = row.params
        ? `BW ${row.params.bandwidth}, NWE ${row.params.envelopeMultiplier}, ATR ${row.params.atrLength}/${row.params.atrMultiplier}, max ${row.params.maxSameSideFailures}, ${row.params.sizingMode ?? ""}`
        : row.timeframe ?? row.label ?? "result";
      lines.push(`| ${row.rank ?? index + 1} | ${number(row.score)} | ${number(metricValue(row, "netProfit"))} | ${number(metricValue(row, "profitFactor"))} | ${number(metricValue(row, "winRate"))} | ${metricValue(row, "rrr") || "RRR unavailable"} | ${metricValue(row, "avgR") || "Avg R unavailable"} | ${metricValue(row, "totalTrades") ?? 0} | ${params} |`);
    });
  } else {
    lines.push("No ranked rows were produced.");
  }

  lines.push(
    "",
    `## ${label.evidence}`,
    ...(evidenceSection?.bullets?.length
      ? evidenceSection.bullets.map((item) => `- ${item}`)
      : ["- No compact evidence block was available for the top row."]),
    "",
    `## ${label.why}`,
    ...(topRows.slice(0, 5).map((row) => {
      const label = row.research?.label ?? "research candidate";
      const overfit = row.research?.overfit?.label ?? "not evaluated";
      return `- Rank ${row.rank ?? "?"}: ${label}. It scored ${number(row.research?.robustnessScore ?? row.score)} with net ${number(metricValue(row, "netProfit"))}, PF ${number(metricValue(row, "profitFactor"))}, RRR ${metricValue(row, "rrr") || "unavailable"}, Avg R/trade ${metricValue(row, "avgR") || "unavailable"}, drawdown ${number(metricValue(row, "maxDrawdown"))}, ${metricValue(row, "totalTrades") ?? 0} trades, and ${overfit} overfit risk.`;
    })),
    "",
    `## ${label.methodology}`,
    ...(narrative?.methodology?.length ? narrative.methodology.map((item) => `- ${item}`) : [isPolish ? "- Użyto istniejących narzędzi platformy bez zmiany strategii ani matematyki backtestu." : "- Used existing platform tools without changing strategy or backtest math."]),
    "",
    `## ${label.robustness}`,
    output.robustnessNotes ?? narrative?.productionViability ?? "Treat the ranking as a research result. Re-test nearby settings across neighboring periods before deployment.",
    "",
    `## ${isPolish ? "Słabości i ryzyka" : "Weaknesses and Risks"}`,
    ...(concernSection?.bullets?.length
      ? concernSection.bullets.map((item) => `- ${item}`)
      : (reasoning.risks ?? ["Sample size and validation coverage should be checked."]).map((item) => `- ${item}`)),
    "",
    `## ${label.overfit}`,
    ...(topRows.slice(0, 5).map((row) => `- Rank ${row.rank ?? "?"}: ${row.research?.overfit?.label ?? "not evaluated"} risk. ${(row.research?.overfit?.explanation ?? []).join(" ")}`)),
    "",
    `## ${isPolish ? "Okresy / reżimy rynku" : "Period / Regime Notes"}`,
    ...(output.regime?.notes?.map((note) => `- ${note}`) ?? [isPolish ? "- Walidacja okresowa nie była dostępna dla tego przebiegu." : "- Period validation was not available for this run."]),
    "",
    `## ${label.recommendations}`,
    `- ${isPolish ? "Produkcyjna" : "Production"}: ${narrative?.recommendedConfigurations?.production ?? (isPolish ? "Brak kandydata produkcyjnego" : "No production candidate")}`,
    `- ${isPolish ? "Stabilna" : "Stable"}: ${narrative?.recommendedConfigurations?.stable ?? (isPolish ? "Brak stabilnego kandydata" : "No stable candidate")}`,
    `- ${isPolish ? "Agresywna" : "Aggressive"}: ${narrative?.recommendedConfigurations?.aggressive ?? (isPolish ? "Brak agresywnego kandydata" : "No aggressive candidate")}`,
    "",
    `## ${label.confidence}`,
    `- ${reasoning.confidence?.label ?? "unknown"} (${reasoning.confidence?.score ?? "n/a"}/100).`,
    ...(reasoning.confidence?.reasons?.length ? reasoning.confidence.reasons.map((item) => `- ${item}`) : ["- Confidence details were not available."]),
    "",
    `## ${isPolish ? "Co mogłoby unieważnić wniosek" : "What Could Invalidate This"}`,
    "- A materially worse Conservative fill result.",
    "- Performance concentrated in one small historical period.",
    "- Neighboring parameters or timeframes collapsing.",
    "- Manual exact rerun metrics not matching the agent row provenance.",
    "",
    `## ${label.risks}`,
    ...(output.warnings?.length ? output.warnings.map((warning) => `- ${warning}`) : (isPolish ? ["- Wielkość próby i świeżość danych mogą zmienić wnioski.", "- Analiza AI nie składa zleceń i nie modyfikuje live execution."] : ["- Sample size and data freshness can change conclusions.", "- AI analysis cannot place trades and does not modify live execution."])),
    "",
    `## ${label.next}`,
    ...(output.nextTests?.length ? output.nextTests.map((item) => `- ${item}`) : (isPolish ? ["- Uruchom najlepsze wiersze na innym okresie.", "- Porównaj tryb legacy i conservative przed zaufaniem konfiguracji."] : ["- Re-run the best rows on a different period.", "- Compare legacy and conservative fill mode before trusting a configuration."])),
    "",
    `## ${label.presentation}`,
    isPolish ? "### Slajd 1: Podsumowanie" : "### Slide 1: Summary",
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

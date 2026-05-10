const DEFAULT_TIMEFRAMES = ["10m", "15m", "20m", "30m", "1h", "4h"];

function normalizeTimeframe(value) {
  const text = String(value).toLowerCase();
  if (text === "1h" || text === "h1") return "1h";
  if (text === "4h" || text === "h4") return "4h";
  if (["10m", "15m", "20m", "30m"].includes(text)) return text;
  return null;
}

function parseTimeframes(text, fallback = ["15m"]) {
  const found = [...String(text).matchAll(/\b(10m|15m|20m|30m|1h|h1|4h|h4)\b/gi)]
    .map((match) => normalizeTimeframe(match[1]))
    .filter(Boolean);
  return [...new Set(found.length ? found : fallback)];
}

function parseSymbol(text) {
  const match = String(text).match(/\b([A-Z]{2,12}USDT)\b/i);
  return (match?.[1] ?? "SOLUSDT").toUpperCase();
}

function parseMaxCombinations(text, fallback) {
  const direct = String(text).match(/\b(\d{2,5})\s*(?:sweep\s*)?(?:combinations|combos|tests|runs)\b/i);
  if (direct) return Number(direct[1]);
  const sweep = /\b(sweep|optimi[sz]e|best settings|best configs?)\b/i.test(text);
  return sweep ? fallback : Math.min(fallback, 100);
}

function isoDate(date) {
  return date.toISOString();
}

function parseRange(text, options = {}) {
  if (options.from || options.to) {
    const to = options.to ? new Date(options.to) : new Date();
    const from = options.from ? new Date(options.from) : new Date(to.getTime() - 31 * 24 * 60 * 60 * 1000);
    return { from: isoDate(from), label: "custom", to: isoDate(to) };
  }

  const lower = String(text).toLowerCase();
  const to = new Date();
  let days = Number(options.lastDays) || 31;

  const yearMatch = lower.match(/last\s+(\d+)\s+years?/);
  const monthMatch = lower.match(/last\s+(\d+)\s+months?/);
  const dayMatch = lower.match(/last\s+(\d+)\s+days?/);
  const quarterMatch = lower.match(/\bq([1-4])\s+(\d{4})\b/i);

  if (yearMatch) days = Number(yearMatch[1]) * 365;
  if (monthMatch) days = Number(monthMatch[1]) * 30;
  if (dayMatch) days = Number(dayMatch[1]);

  if (quarterMatch) {
    const quarter = Number(quarterMatch[1]);
    const year = Number(quarterMatch[2]);
    const startMonth = (quarter - 1) * 3;
    const from = new Date(Date.UTC(year, startMonth, 1));
    const quarterTo = new Date(Date.UTC(year, startMonth + 3, 1));
    return { from: isoDate(from), label: `Q${quarter} ${year}`, to: isoDate(quarterTo) };
  }

  const from = new Date(to.getTime() - Math.max(1, days) * 24 * 60 * 60 * 1000);
  return { from: isoDate(from), label: `last ${days} days`, to: isoDate(to) };
}

function inferObjective(text, options = {}) {
  if (options.objective) return options.objective;
  const lower = String(text).toLowerCase();
  if (lower.includes("profit factor")) return "profit factor";
  if (lower.includes("win rate")) return "win rate";
  if (lower.includes("drawdown")) return "drawdown-adjusted return";
  if (lower.includes("net profit") || lower.includes("pnl")) return "net profit";
  return "robustness-adjusted return";
}

function inferKind(text) {
  const lower = String(text).toLowerCase();
  if (lower.includes("legacy") && lower.includes("conservative")) return "compare_fill_modes";
  if (lower.includes("timeframe") || /\b(10m|15m|20m|30m|1h|4h)\b.*\b(10m|15m|20m|30m|1h|4h)\b/i.test(text)) return "compare_timeframes";
  if (lower.includes("sweep") || lower.includes("optimize") || lower.includes("best setting") || lower.includes("best config")) return "sweep";
  if (lower.includes("backtest") || lower.includes("q1")) return "backtest";
  if (lower.includes("diagnose") || lower.includes("why") || lower.includes("issue") || lower.includes("worse")) return "diagnose";
  if (lower.includes("report") || lower.includes("presentation") || lower.includes("email") || lower.includes("telegram")) return "report";
  return "analysis";
}

function requestedArtifacts(text) {
  const lower = String(text).toLowerCase();
  return {
    csv: lower.includes("csv"),
    emailDraft: lower.includes("email"),
    json: lower.includes("json") || lower.includes("export"),
    markdown: true,
    presentation: lower.includes("presentation") || lower.includes("slides"),
    telegramDraft: lower.includes("telegram"),
  };
}

export function createAgentPlan({ options = {}, prompt = "" }) {
  const kind = options.kind ?? inferKind(prompt);
  const timeframes = options.timeframes?.length
    ? options.timeframes.map(normalizeTimeframe).filter(Boolean)
    : parseTimeframes(prompt, kind === "compare_timeframes" ? DEFAULT_TIMEFRAMES : [options.timeframe ?? "15m"]);
  const fillMode = /conservative/i.test(prompt) && !/legacy\s+vs\s+conservative|conservative\s+vs\s+legacy/i.test(prompt)
    ? "conservative"
    : options.fillMode ?? "legacy";
  const sizingMode = options.sizingMode ?? (/fixed risk|risk per/i.test(prompt) ? "fixed-risk" : "position-percent");
  const maxCombinations = Math.max(1, Math.min(parseMaxCombinations(prompt, Number(options.maxCombinations) || 1000), 5000));

  return {
    artifacts: requestedArtifacts(prompt),
    fillMode,
    kind,
    maxCombinations,
    objective: inferObjective(prompt, options),
    outputFormat: options.outputFormat ?? "markdown",
    parameters: {
      atrLengthValues: options.atrLengthValues,
      atrMultiplierValues: options.atrMultiplierValues,
      bandwidthValues: options.bandwidthValues,
      envelopeMultiplierValues: options.envelopeMultiplierValues,
      maxSameSideFailuresValues: options.maxSameSideFailuresValues,
      sizingValues: options.sizingValues,
    },
    provider: options.provider ?? "binance-futures",
    range: parseRange(prompt, options),
    reportStyle: /presentation|slides/i.test(prompt) ? "presentation" : "operator",
    sizingMode,
    symbol: options.symbol ? String(options.symbol).toUpperCase() : parseSymbol(prompt),
    timeframe: timeframes[0] ?? "15m",
    timeframes,
  };
}

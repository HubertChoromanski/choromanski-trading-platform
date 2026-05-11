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
  const direct =
    String(text).match(/\b(\d{1,5})\s*(?:sweep\s*)?(?:combination|combinations|combos|tests|runs)\b/i) ??
    String(text).match(/\b(\d{1,5})\s*(?:kombinacji|kombinacje|testow|testów|uruchomien|uruchomień)\b/i) ??
    String(text).match(/\b(?:sweep|test|run|przetestuj|uruchom)\s*(\d{1,5})\s*(?:combination|combinations|combos|tests|runs|kombinacji|testow|testów)?\b/i);
  if (direct) {
    return {
      explicit: true,
      requested: Number(direct[1]),
    };
  }
  const sweep = /\b(sweep|optimi[sz]e|best settings|best configs?|najlepsze ustawienia|najlepsze parametry|najlepsza konfiguracja)\b/i.test(text);
  return {
    explicit: false,
    requested: sweep ? fallback : Math.min(fallback, 100),
  };
}

function parseStartingBalance(text, fallback = 10000) {
  const match = String(text).match(/\b(?:starting\s+balance|start(?:ing)?\s+capital|capital|balance)\s*(?:=|:|of|is)?\s*(\d+(?:[.,]\d+)?)\s*(?:usdt|usd)?\b/i);
  if (!match) return Number(fallback) || 10000;
  const parsed = Number(String(match[1]).replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Number(fallback) || 10000;
}

function isoDate(date) {
  return date.toISOString();
}

function parseFlexibleDate(value) {
  const match = String(value).trim().match(/^(\d{4})[.-](\d{1,2})[.-](\d{1,2})$/);
  if (!match) return null;
  const [, year, month, day] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

function parseExplicitDateRange(text) {
  const source = String(text);
  const datePattern = String.raw`(\d{4}[.-]\d{1,2}[.-]\d{1,2})`;
  const range =
    source.match(new RegExp(`from\\s+${datePattern}\\s+(?:to|until|through|-)\\s+${datePattern}`, "i")) ??
    source.match(new RegExp(`${datePattern}\\s*(?:→|->|to|until|through|-)\\s*${datePattern}`, "i"));

  if (range) {
    const from = parseFlexibleDate(range[1]);
    const to = parseFlexibleDate(range[2]);
    if (from && to && to > from) {
      return {
        from: isoDate(from),
        label: `${range[1]} to ${range[2]}`,
        requestedFrom: range[1],
        requestedTo: range[2],
        to: isoDate(to),
      };
    }
  }

  return null;
}

function parseRange(text, options = {}) {
  if (options.from || options.to) {
    const to = options.to ? (parseFlexibleDate(options.to) ?? new Date(options.to)) : new Date();
    const from = options.from ? (parseFlexibleDate(options.from) ?? new Date(options.from)) : new Date(to.getTime() - 31 * 24 * 60 * 60 * 1000);
    return { from: isoDate(from), label: "custom", to: isoDate(to) };
  }

  const lower = String(text).toLowerCase();
  const explicitRange = parseExplicitDateRange(text);
  if (explicitRange) return explicitRange;

  const to = new Date();
  let days = Number(options.lastDays) || 31;

  const yearMatch = lower.match(/last\s+(\d+)\s+years?/);
  const monthMatch = lower.match(/last\s+(\d+)\s+months?/);
  const dayMatch = lower.match(/last\s+(\d+)\s+days?/);
  const quarterMatch = lower.match(/\bq([1-4])\s+(\d{4})\b/i);
  const previousYear = lower.includes("previous full year") || lower.includes("last calendar year");

  if (previousYear) {
    const year = new Date().getUTCFullYear() - 1;
    return {
      from: isoDate(new Date(Date.UTC(year, 0, 1))),
      label: `${year} calendar year`,
      requestedFrom: `${year}-01-01`,
      requestedTo: `${year + 1}-01-01`,
      to: isoDate(new Date(Date.UTC(year + 1, 0, 1))),
    };
  }

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

function parseBaselineQuery(text, options = {}) {
  if (options.baselineQuery) return String(options.baselineQuery).trim();
  const source = String(text);
  const patterns = [
    /\b(?:compare|porownaj|porównaj)\b.*?\b(?:with|to|z|do)\s*["“]?([a-z0-9][a-z0-9 _.-]{1,60})["”]?/i,
    /\b(?:compare|porownaj|porównaj)\s+(?:with|to|z|do)?\s*["“]?([a-z0-9][a-z0-9 _.-]{1,60})["”]?/i,
    /\b(?:worse|better|gorszy|gorsze|lepszy|lepsze)\s+(?:than|niz|niż)\s*["“]?([a-z0-9][a-z0-9 _.-]{1,60})["”]?/i,
    /\b(?:baseline|baz[ae]|punkt odniesienia)\s*[:=]?\s*["“]?([a-z0-9][a-z0-9 _.-]{1,60})["”]?/i,
    /\b(?:uzyj|użyj)\s+(?:backtestu|testu|wyniku)\s+["“]?([a-z0-9][a-z0-9 _.-]{1,60})["”]?\s+(?:jako|as)\s+(?:baseline|baze|bazę|punkt odniesienia)/i,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) {
      return match[1]
        .replace(/\b(?:as|jako|baseline|baze|bazę|punkt|odniesienia|and|i|oraz)\b.*$/i, "")
        .trim();
    }
  }
  return "";
}

function inferKind(text) {
  const lower = String(text).toLowerCase();
  if (
    lower.includes("robust") ||
    lower.includes("overfit") ||
    lower.includes("production candidate") ||
    lower.includes("stable settings") ||
    lower.includes("najlepsze ustawienia") ||
    lower.includes("najlepsze parametry") ||
    lower.includes("najlepsza konfiguracja") ||
    lower.includes("quant") ||
    lower.includes("research")
  ) return "research";
  if (lower.includes("legacy") && lower.includes("conservative")) return "compare_fill_modes";
  if (lower.includes("timeframe") || /\b(10m|15m|20m|30m|1h|4h)\b.*\b(10m|15m|20m|30m|1h|4h)\b/i.test(text)) return "compare_timeframes";
  if (lower.includes("find the best") || lower.includes("best settings") || lower.includes("best config")) return "research";
  if (lower.includes("sweep") || lower.includes("optimize")) return "sweep";
  if (lower.includes("backtest") || lower.includes("q1")) return "backtest";
  if (lower.includes("diagnose") || lower.includes("why") || lower.includes("issue") || lower.includes("worse") || lower.includes("czemu") || lower.includes("dlaczego") || lower.includes("gorszy") || lower.includes("lepszy") || lower.includes("porównaj") || lower.includes("porownaj") || lower.includes("baseline")) return "diagnose";
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

function inferLanguage(text, options = {}) {
  if (options.language) return options.language;
  return /[ąćęłńóśźż]/i.test(text) || /\b(najlepsze|ustawienia|porownaj|porównaj|czemu|dlaczego|wynik|gorszy|lepszy|uzyj|użyj|backtestu)\b/i.test(text)
    ? "pl"
    : "en";
}

export function createAgentPlan({ options = {}, prompt = "" }) {
  const kind = options.kind ?? inferKind(prompt);
  const timeframes = options.timeframes?.length
    ? options.timeframes.map(normalizeTimeframe).filter(Boolean)
    : parseTimeframes(prompt, kind === "compare_timeframes" ? DEFAULT_TIMEFRAMES : [options.timeframe ?? "15m"]);
  const fillMode = /conservative/i.test(prompt) && !/legacy\s+vs\s+conservative|conservative\s+vs\s+legacy/i.test(prompt)
    ? "conservative"
    : options.fillMode ?? "legacy";
  const sizingModeExplicit = Boolean(options.sizingMode || /fixed risk|risk per|fixed risk per trade|ryzyko na/i.test(prompt));
  const sizingMode = options.sizingMode ?? (sizingModeExplicit ? "fixed-risk" : "position-percent");
  const fallbackCombinations = Number(options.maxCombinations) || (kind === "research" ? 100 : 1000);
  const combinationRequest = parseMaxCombinations(prompt, fallbackCombinations);
  const requestedCombinations = Math.max(1, combinationRequest.requested);
  const maxCombinations = Math.max(1, Math.min(requestedCombinations, 5000));
  const startingBalance = parseStartingBalance(prompt, options.startingBalance ?? 10000);

  return {
    artifacts: requestedArtifacts(prompt),
    baselineQuery: parseBaselineQuery(prompt, options),
    fillMode,
    kind,
    language: inferLanguage(prompt, options),
    maxCombinations,
    plannedCombinations: maxCombinations,
    requestedCombinations,
    requestedCombinationsExplicit: combinationRequest.explicit,
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
    sizingModeExplicit,
    startingBalance,
    symbol: options.symbol ? String(options.symbol).toUpperCase() : parseSymbol(prompt),
    timeframe: timeframes[0] ?? "15m",
    timeframes,
  };
}

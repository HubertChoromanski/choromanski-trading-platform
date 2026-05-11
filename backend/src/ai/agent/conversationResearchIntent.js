function normalizeText(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function numberValue(value) {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function unique(values = [], { integer = false, positive = false } = {}) {
  return [...new Set(values
    .map(numberValue)
    .filter((value) => Number.isFinite(value))
    .map((value) => (integer ? Math.round(value) : Number(value.toFixed(8))))
    .filter((value) => (!positive || value > 0)))]
    .sort((left, right) => left - right);
}

function expandRange(from, to, { integer = false, maxPoints = 9, step = null } = {}) {
  const start = numberValue(from);
  const end = numberValue(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  const low = Math.min(start, end);
  const high = Math.max(start, end);
  if (integer) {
    const values = [];
    for (let value = Math.round(low); value <= Math.round(high); value += 1) values.push(value);
    return unique(values, { integer, positive: true }).slice(0, 40);
  }
  const chosenStep = step ?? Math.max(0.1, Number(((high - low) / Math.max(1, maxPoints - 1)).toFixed(2)));
  const values = [];
  for (let value = low; value <= high + chosenStep / 2; value += chosenStep) {
    values.push(Number(value.toFixed(4)));
  }
  return unique(values, { positive: true }).slice(0, maxPoints);
}

function parseRangeByAliases(text, aliases, options = {}) {
  const source = String(text);
  const alias = aliases.join("|");
  const pattern = new RegExp(`(?:${alias})\\s*(?:=|:)?\\s*(\\d+(?:[.,]\\d+)?)\\s*(?:-|–|do|to)\\s*(\\d+(?:[.,]\\d+)?)`, "i");
  const match = source.match(pattern);
  if (!match) return null;
  return expandRange(match[1], match[2], options);
}

function parseSingleByAliases(text, aliases) {
  const source = String(text);
  const alias = aliases.join("|");
  const pattern = new RegExp(`(?:${alias})\\s*(?:=|:)?\\s*(\\d+(?:[.,]\\d+)?)\\s*%?`, "i");
  const match = source.match(pattern);
  return match ? numberValue(match[1]) : null;
}

function isoDate(date) {
  return date.toISOString();
}

function parseDate(value) {
  const match = String(value).match(/^(\d{4})[.-](\d{1,2})[.-](\d{1,2})$/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function parseExplicitDateRange(text) {
  const source = String(text);
  const datePattern = String.raw`(\d{4}[.-]\d{1,2}[.-]\d{1,2})`;
  const match =
    source.match(new RegExp(`(?:od|from)\\s+${datePattern}\\s+(?:do|to|until|-)\\s+${datePattern}`, "i")) ??
    source.match(new RegExp(`${datePattern}\\s*(?:→|->|do|to|until|-)\\s*${datePattern}`, "i"));
  if (!match) return null;
  const from = parseDate(match[1]);
  const to = parseDate(match[2]);
  if (!from || !to || to <= from) return null;
  return {
    explicit: true,
    from: isoDate(from),
    label: `${match[1]} → ${match[2]}`,
    to: isoDate(to),
  };
}

const MONTHS = {
  april: 3,
  august: 7,
  december: 11,
  february: 1,
  january: 0,
  july: 6,
  june: 5,
  kwiecien: 3,
  kwietnia: 3,
  lipca: 6,
  lipiec: 6,
  listopad: 10,
  listopada: 10,
  luty: 1,
  lutego: 1,
  maj: 4,
  maja: 4,
  march: 2,
  marzec: 2,
  marca: 2,
  may: 4,
  november: 10,
  october: 9,
  pazdziernik: 9,
  pazdziernika: 9,
  sierpien: 7,
  sierpnia: 7,
  styczen: 0,
  stycznia: 0,
  september: 8,
  wrzesien: 8,
  wrzesnia: 8,
  grudzien: 11,
  grudnia: 11,
  czerwiec: 5,
  czerwca: 5,
};

function parseMonthRange(text) {
  const normalized = normalizeText(text);
  const match = normalized.match(/\b(styczen|stycznia|luty|lutego|marzec|marca|kwiecien|kwietnia|maj|maja|czerwiec|czerwca|lipiec|lipca|sierpien|sierpnia|wrzesien|wrzesnia|pazdziernik|pazdziernika|listopad|listopada|grudzien|grudnia|january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/i);
  if (!match) return null;
  const month = MONTHS[match[1]];
  const year = Number(match[2]);
  if (!Number.isFinite(month) || !Number.isFinite(year)) return null;
  const from = new Date(Date.UTC(year, month, 1));
  const to = new Date(Date.UTC(year, month + 1, 1));
  return {
    explicit: true,
    from: isoDate(from),
    label: `${match[1]} ${year}`,
    to: isoDate(to),
  };
}

function parseSymbol(text, fallback = null) {
  const match = String(text).match(/\b([A-Z]{2,12}USDT)\b/i);
  return match?.[1]?.toUpperCase() ?? fallback ?? null;
}

function parseTimeframe(text, fallback = null) {
  const match = String(text).match(/\b(10m|15m|20m|30m|1h|h1|4h|h4)\b/i);
  if (!match) return fallback ?? null;
  const value = match[1].toLowerCase();
  if (value === "h1") return "1h";
  if (value === "h4") return "4h";
  return value;
}

function parseCombinations(text) {
  const match =
    String(text).match(/\b(\d{2,5})\s*(?:kombinacj|kombinacje|testow|testów|combination|combinations|tests|runs)\b/i) ??
    String(text).match(/\b(?:zrob|zrób|run|odpal|uruchom)\s*(\d{2,5})\b/i) ??
    (String(text).trim().match(/^(\d{2,5})$/));
  return match ? Number(match[1]) : null;
}

function parseBaseline(text, fallback = "") {
  if (/\bhubert\b/i.test(text)) return "hubert";
  const match = String(text).match(/\b(?:baseline|porownaj do|porównaj do|lepsze od|lepszy od|better than|worse than)\s+["“]?([a-z0-9][a-z0-9 _.-]{1,50})["”]?/i);
  return match?.[1]?.trim() ?? fallback ?? "";
}

function parseConstraints(text, previous = {}) {
  const normalized = normalizeText(text);
  const next = { ...(previous ?? {}) };
  const pf =
    normalized.match(/\b(?:pf|profit factor)\s*(?:min|minimum|>=|co najmniej|powyzej|powyżej)?\s*(\d+(?:[.,]\d+)?)/i) ??
    normalized.match(/\b(?:min|minimum|co najmniej)\s*(?:pf|profit factor)\s*(\d+(?:[.,]\d+)?)/i);
  if (pf?.[1]) next.minProfitFactor = numberValue(pf[1]);

  const dd =
    normalized.match(/\b(?:dd|drawdown).{0,28}(?:max|maks|maximum|<=|nie wieksz|nie większ|ponizej|poniżej)\s*(\d+(?:[.,]\d+)?)\s*%?/i) ??
    normalized.match(/\b(?:dd|drawdown)\s*(?:nie wiekszy niz|nie większy niż)\s*(\d+(?:[.,]\d+)?)\s*%?/i);
  if (dd?.[1]) next.maxDrawdown = numberValue(dd[1]);

  const trades =
    normalized.match(/\b(?:minimum|min|co najmniej)\s*(\d{1,5})\s*(?:trade|trades|transakc|transakcji|wejsc|wejść)/i) ??
    normalized.match(/\b(?:trade|trades|transakc|transakcji).{0,18}(?:minimum|min|co najmniej)\s*(\d{1,5})/i);
  if (trades?.[1]) next.minTrades = Number(trades[1]);

  return next;
}

function parseParameters(text, previous = {}) {
  const next = { ...(previous ?? {}) };
  const atrMultiplier = parseRangeByAliases(text, ["atr\\s*(?:multiplier|mult|mnoznik|mnożnik)"], { maxPoints: 7, step: 0.2 });
  if (atrMultiplier?.length) next.atrMultiplierValues = atrMultiplier;

  const atrLength = parseRangeByAliases(text, ["atr(?!\\s*(?:mult|multiplier|mnoznik|mnożnik))", "atr\\s*(?:length|len|okres)"], { integer: true });
  if (atrLength?.length) next.atrLengthValues = atrLength;

  const envelope = parseRangeByAliases(text, ["nwe", "envelope(?:\\s*multiplier)?", "nwe\\s*(?:multiplier|mnoznik|mnożnik)"], { maxPoints: 7, step: 0.5 });
  if (envelope?.length) next.envelopeMultiplierValues = envelope;

  const bandwidth = parseRangeByAliases(text, ["bandwidth", "bw"], { integer: true });
  if (bandwidth?.length) next.bandwidthValues = bandwidth;

  const failures = parseRangeByAliases(text, ["max\\s*(?:same[-\\s]*side\\s*)?failures", "max\\s*failures", "failures", "max\\s*sl", "max\\s*porazek", "max\\s*porażek"], { integer: true });
  if (failures?.length) next.maxSameSideFailuresValues = failures;

  const fixedRisk = parseSingleByAliases(text, ["fixed\\s*risk", "risk\\s*per\\s*trade", "ryzyko"]);
  if (fixedRisk) next.sizingValues = [fixedRisk];

  return next;
}

function inferObjective(text, previous = null) {
  const normalized = normalizeText(text);
  if ((normalized.includes("duzy zysk") || normalized.includes("duży zysk") || normalized.includes("large profit")) && /(stabil|dd|drawdown|robust)/i.test(normalized)) {
    return "risk-adjusted return";
  }
  if (normalized.includes("profit factor") || /\bpf\b/i.test(normalized)) return "profit factor";
  if (normalized.includes("duzy zysk") || normalized.includes("duży zysk") || normalized.includes("net") || normalized.includes("pnl")) return "net profit";
  if (normalized.includes("robust") || normalized.includes("stabil")) return "robustness-adjusted return";
  return previous ?? null;
}

function inferMethodology(intent = {}, text = "") {
  const normalized = normalizeText(text);
  if (/(zawez|zawęź|narrow|wokol|wokół|neighbor)/i.test(normalized)) return "adaptive two-stage search";
  if (intent.baselineQuery) return "baseline-seeded grid";
  if (normalized.includes("optymal") || normalized.includes("best") || normalized.includes("najlepsze")) return "adaptive two-stage search";
  if (normalized.includes("conservative") || normalized.includes("walidac")) return "robustness validation";
  return intent.methodology ?? "grid search";
}

function compactUnknowns(intent = {}) {
  const unknown = [];
  if (!intent.range?.from || !intent.range?.to) unknown.push("range");
  if (!intent.symbol) unknown.push("symbol");
  if (!intent.timeframe) unknown.push("timeframe");
  if (!intent.combinations) unknown.push("combinations");
  return unknown;
}

export function isResearchPlanningMessage(message = "") {
  const normalized = normalizeText(message);
  return /(ustawien|ustawienia|najlepsze|optymal|sweep|kombinacj|testuj|zrob|zrób|zawez|zawęź|narrow|wokol|wokół|configu|config #|atr|nwe|bandwidth|\bpf\b|profit factor|\bdd\b|drawdown|trade|transakc|hubert|baseline|conservative|fixed risk|ryzyko|marzec|marca|styczen|stycznia|luty|lutego|kwiecien|kwietnia|maj|maja|czerwiec|czerwca|lipiec|lipca|sierpien|sierpnia|wrzesien|wrzesnia|pazdziernik|pazdziernika|listopad|listopada|grudzien|grudnia)/i.test(normalized);
}

export function updateResearchIntent({ message = "", previous = null, workspaceContext = null } = {}) {
  const previousIntent = previous && typeof previous === "object" ? previous : {};
  const chart = workspaceContext?.chart ?? {};
  const range = parseExplicitDateRange(message) ?? parseMonthRange(message) ?? previousIntent.range ?? null;
  const symbol = parseSymbol(message, previousIntent.symbol ?? chart.symbol ?? "SOLUSDT");
  const timeframe = parseTimeframe(message, previousIntent.timeframe ?? chart.timeframe ?? "15m");
  const combinations = parseCombinations(message) ?? previousIntent.combinations ?? null;
  const baselineQuery = parseBaseline(message, previousIntent.baselineQuery ?? "");
  const constraints = parseConstraints(message, previousIntent.constraints);
  const parameterRanges = parseParameters(message, previousIntent.parameterRanges);
  const fillMode = /conservative/i.test(message)
    ? "conservative"
    : /legacy/i.test(message)
      ? "legacy"
      : previousIntent.fillMode ?? "legacy";
  const sizingMode = /(fixed risk|risk per trade|ryzyko)/i.test(message)
    ? "fixed-risk"
    : /(position percent|pozycj|exposure)/i.test(message)
      ? "position-percent"
      : previousIntent.sizingMode ?? "position-percent";
  const objective = inferObjective(message, previousIntent.objective) ?? "robustness-adjusted return";
  const focusConfig = String(message).match(/\b(?:config|konfig|configu)\s*#?\s*(\d+)/i);
  const next = {
    baselineQuery,
    combinations,
    confidence: "working",
    constraints,
    fillMode,
    focusConfigRank: focusConfig?.[1] ? Number(focusConfig[1]) : previousIntent.focusConfigRank ?? null,
    methodology: inferMethodology({ baselineQuery, methodology: previousIntent.methodology }, message),
    notes: [
      { message: String(message).slice(0, 500), time: new Date().toISOString() },
      ...(previousIntent.notes ?? []),
    ].slice(0, 10),
    objective,
    parameterRanges,
    provider: previousIntent.provider ?? "binance-futures",
    range,
    sizingMode,
    symbol,
    timeframe,
    updatedAt: new Date().toISOString(),
  };
  next.unknownFields = compactUnknowns(next);
  return next;
}

export function researchIntentToPlanOptions(intent = {}, baseOptions = {}, workspaceContext = {}) {
  return {
    ...baseOptions,
    atrLengthValues: intent.parameterRanges?.atrLengthValues,
    atrMultiplierValues: intent.parameterRanges?.atrMultiplierValues,
    bandwidthValues: intent.parameterRanges?.bandwidthValues,
    baselineQuery: intent.baselineQuery || baseOptions.baselineQuery,
    constraints: intent.constraints,
    envelopeMultiplierValues: intent.parameterRanges?.envelopeMultiplierValues,
    fillMode: intent.fillMode ?? baseOptions.fillMode,
    focusConfigRank: intent.focusConfigRank ?? baseOptions.focusConfigRank,
    from: intent.range?.from ?? baseOptions.from,
    kind: baseOptions.kind ?? "research",
    maxCombinations: intent.combinations ?? baseOptions.maxCombinations,
    maxCombinationsFromIntent: Boolean(intent.combinations),
    maxSameSideFailuresValues: intent.parameterRanges?.maxSameSideFailuresValues,
    methodology: intent.methodology,
    objective: intent.objective ?? baseOptions.objective,
    provider: intent.provider ?? baseOptions.provider,
    researchIntent: intent,
    sizingMode: intent.sizingMode ?? baseOptions.sizingMode,
    sizingValues: intent.parameterRanges?.sizingValues,
    symbol: intent.symbol ?? workspaceContext?.chart?.symbol ?? baseOptions.symbol,
    timeframe: intent.timeframe ?? workspaceContext?.chart?.timeframe ?? baseOptions.timeframe,
    to: intent.range?.to ?? baseOptions.to,
    userNotes: intent.notes,
    workspaceContext,
  };
}

export function clarificationForIntent(intent = {}, { polish = false } = {}) {
  if (!intent.range?.from || !intent.range?.to) {
    return polish ? "Jaki okres mam testować?" : "Which date range should I test?";
  }
  if (!intent.symbol || !intent.timeframe) {
    return polish ? "Mam użyć obecnego SOLUSDT 15m?" : "Should I use the current SOLUSDT 15m?";
  }
  if (!intent.combinations) {
    return polish
      ? "Ile kombinacji chcesz: 200 szybki test, 500 solidnie, czy 1000 mocniej?"
      : "How many combinations do you want: 200 quick, 500 solid, or 1000 stronger?";
  }
  return "";
}

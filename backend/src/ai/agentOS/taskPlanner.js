import { AGENT_OS_TOOL_CATALOG } from "./fileManifest.js";
import { designAdaptiveExperiment } from "./experimentDesigner.js";
import { summarizeWorkspaceForAgentOS } from "./workspaceState.js";

function normalize(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function parseDateRange(text = "") {
  const date = String.raw`(\d{4}[.-]\d{1,2}[.-]\d{1,2})`;
  const match =
    String(text).match(new RegExp(`${date}\\s*(?:→|->|do|to|until|through|–|-)\\s*${date}`, "i")) ??
    String(text).match(new RegExp(`(?:od|from)\\s+${date}\\s+(?:do|to|until|through|–|-)\\s+${date}`, "i"));
  return match ? { from: match[1], to: match[2] } : null;
}

function parseSymbol(text = "", fallback = "SOLUSDT") {
  return String(text).match(/\b([A-Z]{2,12}USDT)\b/i)?.[1]?.toUpperCase() ?? fallback;
}

function parseTimeframe(text = "", fallback = "15m") {
  const match = String(text).match(/\b(10m|15m|20m|30m|1h|h1|4h|h4)\b/i);
  if (!match) return fallback;
  const value = match[1].toLowerCase();
  if (value === "h1") return "1h";
  if (value === "h4") return "4h";
  return value;
}

function parseCombinations(text = "") {
  const normalized = normalize(text);
  const explicit = String(text).match(/\b(\d{2,5})\s*(?:kombinacj|kombinacje|testow|testów|combination|combinations|tests|runs)\b/i);
  if (explicit) return Number(explicit[1]);
  if (/(adaptive|gleboki|głęboki|potezny|potężny|profesjonalny|research package|pakiet badawczy)/i.test(normalized)) return 1000;
  return 500;
}

function artifactRequests(text = "") {
  const normalized = normalize(text);
  return {
    csv: /csv|tabel/i.test(normalized),
    docx: /word|docx|dokument/i.test(normalized),
    json: true,
    markdown: true,
    xlsx: /excel|xlsx|arkusz/i.test(normalized),
  };
}

function objectives(text = "") {
  const normalized = normalize(text);
  const requested = [];
  if (/\bwin\s*%|\bwin rate|skutecznosc|trafnosc/i.test(normalized)) requested.push("best win rate");
  if (/\bpf\b|profit factor/i.test(normalized)) requested.push("best profit factor");
  if (/net profit|pnl|zysk|profit/i.test(normalized)) requested.push("best net profit");
  if (/niski\s+dd|lowest dd|low drawdown|drawdown|\bdd\b/i.test(normalized)) requested.push("lowest drawdown");
  if (/overall|calosciow|całościow|optymaln|robust|stabil/i.test(normalized)) requested.push("best overall");
  return requested.length ? [...new Set(requested)] : ["best overall"];
}

function expectedTools(task = {}) {
  const tools = [
    "runAdaptiveSearch",
    "runSweep",
    "runBacktest",
    "getTopByMetric",
    "rankByPF",
    "rankByWinRate",
    "rankByNetProfit",
    "rankByDrawdown",
    "rankOverall",
    "detectOverfit",
    "auditSearchCoverage",
    "createMarkdownReport",
    "createCSV",
    "exportZipManifest",
  ];
  if (task.artifacts.docx) tools.push("createWordReport");
  if (task.artifacts.xlsx) tools.push("createExcelWorkbook");
  if (task.methodology.includes("adaptive")) {
    tools.push("getClusterStability", "getParameterSensitivity", "validateOnConservative", "validateAcrossPeriods");
  }
  return tools.filter((tool) => AGENT_OS_TOOL_CATALOG.includes(tool));
}

export function isAgentOSGoal(message = "") {
  const normalized = normalize(message);
  return /(word|excel|docx|xlsx|raport|report|artifact|pakiet|wnioski|wykres|tabel|osobno|najwiekszy zysk|największy zysk|najlepszy win|skutecznosc|profit factor|adaptive search|multi[-\s]*objective)/i.test(normalized) &&
    /(znajdz|znajdź|zrob|zrób|przygotuj|stworz|stwórz|run|find|prepare|create|test|badanie|research|ustawien|ustawienia)/i.test(normalized);
}

export function planAgentOSTask({ message = "", options = {}, workspaceContext = {} } = {}) {
  const chart = workspaceContext.chart ?? {};
  const range = parseDateRange(message);
  const task = {
    artifacts: artifactRequests(message),
    confirmationRequired: true,
    estimatedDuration: "adaptive package: usually 15-45 minutes depending on combinations and cache",
    fillMode: options.fillMode ?? (/conservative/i.test(message) ? "conservative" : "legacy"),
    goal: String(message).slice(0, 1200),
    methodology: /adaptive/i.test(message) ? "adaptive multi-stage search" : "agent planned research",
    missingFields: [],
    objectives: objectives(message),
    provider: options.provider ?? "binance-futures",
    requestedCombinations: Math.min(Number(options.maxCombinations) || parseCombinations(message), 5000),
    safetyNotes: [
      "Analysis only. AH cannot place trades or modify live execution.",
      "Large adaptive searches run on backend workers and can be cancelled.",
      "Generated decks/configs are drafts until explicitly saved or deployed by the user.",
    ],
    sizingMode: options.sizingMode ?? (/fixed risk|risk per|ryzyko/i.test(message) ? "fixed-risk" : "position-percent"),
    symbol: options.symbol ?? parseSymbol(message, chart.symbol ?? "SOLUSDT"),
    timeframe: options.timeframe ?? parseTimeframe(message, chart.timeframe ?? "15m"),
  };
  if (!range) task.missingFields.push("date range");
  task.range = range;
  task.tools = expectedTools(task);
  task.experimentDesign = designAdaptiveExperiment(task);
  task.workspace = summarizeWorkspaceForAgentOS(workspaceContext);
  return task;
}

export function agentOSTaskToPlanOptions(task = {}, baseOptions = {}) {
  return {
    ...baseOptions,
    artifactFormats: Object.entries(task.artifacts ?? {})
      .filter(([, enabled]) => enabled)
      .map(([format]) => format),
    artifacts: task.artifacts,
    fillMode: task.fillMode,
    from: task.range?.from,
    kind: "agent_os",
    maxCombinations: task.requestedCombinations,
    methodology: task.methodology,
    objective: task.objectives?.join(" + ") || "multi-objective",
    provider: task.provider,
    sizingMode: task.sizingMode,
    symbol: task.symbol,
    timeframe: task.timeframe,
    to: task.range?.to,
    toolsPlanned: task.tools,
    experimentDesign: task.experimentDesign,
    userGoal: task.goal,
    workspaceSummary: task.workspace,
  };
}

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeForAi } from "./aiContextBuilder.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const ALLOWED_ROOTS = [
  path.join(PROJECT_ROOT, "backend/src"),
  path.join(PROJECT_ROOT, "hubert-platform/frontend/src"),
];
const BLOCKED_PARTS = new Set([".git", "node_modules", "dist", "build", "data", "logs", "coverage"]);
const BLOCKED_FILE_PATTERN = /(^|\/)(\.env|.*\.pem|.*secret.*|.*token.*|.*key.*)$/iu;
const SOURCE_FILE_PATTERN = /\.(js|jsx|css|json|cjs)$/iu;
const MAX_FILE_CHARS = 220_000;
const MAX_SNIPPET_CHARS = 16_000;
const MAX_SEARCH_FILES = 700;

const ACTION_TRACES = {
  "ask follow-up": {
    aliases: ["ask follow-up", "follow up", "ask about current result", "copilot follow-up"],
    searchTerms: ["askFollowUp", "/ai/agent/chat", "createAgentOrchestrator", "buildReasoningResponse"],
    backend: [
      "POST /ai/agent/chat in backend/src/index.js",
      "createAgentOrchestrator().chat in backend/src/ai/agent/agentOrchestrator.js",
      "buildReasoningResponse in backend/src/ai/reasoning/reasoningEngine.js for research-run follow-ups",
    ],
    exchange: [],
    frontend: [
      "AiAgentPanel.askFollowUp in hubert-platform/frontend/src/components/ControlCenter.jsx",
      "Copilot chat composer buttons in AiAgentPanel",
    ],
    notes: [
      "Follow-up is analysis-only and may reference the active run/result row.",
      "Platform evidence mode can answer without a completed research run.",
    ],
  },
  "move sl": {
    aliases: ["move sl", "sl", "stop loss", "move stop loss"],
    searchTerms: ["MOVE_SL", "placePositionStopLoss", "placeStopLoss", "verifyProtectiveAction", "/manual/action"],
    backend: [
      "POST /manual/action in backend/src/index.js",
      "executeManualAction handles MOVE_SL in backend/src/index.js",
      "createBingxClient().placePositionStopLoss in backend/src/exchanges/bingxClient.js",
      "createBingxClient().placeStopLoss fallback in backend/src/exchanges/bingxClient.js",
      "verifyProtectiveAction confirms only after fresh BingX sync in backend/src/index.js",
    ],
    exchange: [
      "POST /openApi/swap/v2/trade/order",
      "type=STOP_MARKET, closePosition=true, stopPrice, side=closing side, positionSide=LONG/SHORT; fallback uses quantity without closePosition if needed",
      "Active protection is verified from openOrders/position fields after fresh sync.",
    ],
    frontend: [
      "LivestreamPanel position card SL input / Move SL in hubert-platform/frontend/src/components/ControlCenter.jsx",
      "prepareCrisisAction(..., direct:true) posts MOVE_SL to /manual/action",
    ],
    notes: [
      "A BingX code=0 response is not enough; the backend must find active SL after sync.",
      "In hedge mode reduceOnly is omitted for SL/TP protective orders.",
    ],
  },
  "move tp": {
    aliases: ["move tp", "tp", "take profit", "move take profit"],
    searchTerms: ["MOVE_TP", "placePositionTakeProfit", "placeTakeProfit", "verifyProtectiveAction", "/manual/action"],
    backend: [
      "POST /manual/action in backend/src/index.js",
      "executeManualAction handles MOVE_TP in backend/src/index.js",
      "createBingxClient().placePositionTakeProfit in backend/src/exchanges/bingxClient.js",
      "createBingxClient().placeTakeProfit fallback in backend/src/exchanges/bingxClient.js",
      "verifyProtectiveAction confirms only after fresh BingX sync in backend/src/index.js",
    ],
    exchange: [
      "POST /openApi/swap/v2/trade/order",
      "type=TAKE_PROFIT_MARKET, closePosition=true, stopPrice, side=closing side, positionSide=LONG/SHORT; fallback uses quantity without closePosition if needed",
      "Active protection is verified from openOrders/position fields after fresh sync.",
    ],
    frontend: [
      "LivestreamPanel position card TP input / Move TP in hubert-platform/frontend/src/components/ControlCenter.jsx",
      "prepareCrisisAction(..., direct:true) posts MOVE_TP to /manual/action",
    ],
    notes: [
      "A request accepted by BingX is reported as unconfirmed unless fresh exchange state contains matching TP.",
    ],
  },
  "open backtest": {
    aliases: ["open backtest", "view on chart", "analyze on chart"],
    searchTerms: ["onOpenAiBacktest", "rerunExact", "/ai/agent/runs", "runHistoricalBacktest"],
    backend: [
      "POST /ai/agent/runs/:id/rerun in backend/src/index.js",
      "createAgentOrchestrator().rerunExact in backend/src/ai/agent/agentOrchestrator.js",
      "runHistoricalBacktest in backend/src/ai/aiTools.js uses the existing backtest engine",
    ],
    exchange: [],
    frontend: [
      "AiAgentPanel.rerunExact(..., openPanel:true) in hubert-platform/frontend/src/components/ControlCenter.jsx",
      "onOpenAiBacktest / Backtests panel wiring in hubert-platform/frontend/src/components/ControlCenter.jsx",
      "TradingViewChart receives the active backtest analysis session for overlays",
    ],
    notes: [
      "Open Backtest should use exact stored config/range/provider/fill/sizing from the AI row.",
    ],
  },
  "verify integrity": {
    aliases: ["verify integrity", "metric diff", "rerun exact", "compare metric"],
    searchTerms: ["verifyIntegrity", "metricDiff", "normalizeResearchResult", "/verify"],
    backend: [
      "POST /ai/agent/runs/:id/verify in backend/src/index.js",
      "createAgentOrchestrator().verifyIntegrity in backend/src/ai/agent/agentOrchestrator.js",
      "normalizeResearchResult / metricDiff in backend/src/ai/agent/agentResultIntegrity.js",
    ],
    exchange: [],
    frontend: [
      "AiAgentPanel.verifyIntegrity in hubert-platform/frontend/src/components/ControlCenter.jsx",
      "Result card Verify integrity / Show metric diff actions",
    ],
    notes: [
      "The integrity check compares stored AI row metrics with an exact rerun where possible.",
    ],
  },
  "pf calculation": {
    aliases: ["pf", "profit factor", "where is pf calculated"],
    searchTerms: ["calculateBacktestMetrics", "profitFactor", "grossProfit", "grossLoss"],
    backend: [],
    exchange: [],
    frontend: [
      "calculateBacktestMetrics in hubert-platform/frontend/src/backtest/metrics.js",
      "Backtest and AI tools consume metrics returned by runBacktest.",
    ],
    notes: [
      "Profit factor is grossProfit / grossLoss. If grossLoss is zero, positive grossProfit returns Infinity, otherwise 0.",
    ],
  },
};

function normalizeText(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9/_.:-]+/g, " ")
    .trim();
}

function relativePath(filePath) {
  return path.relative(PROJECT_ROOT, filePath).replaceAll(path.sep, "/");
}

function isInside(root, filePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(filePath);
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
}

function resolveSafePath(filePath = "") {
  const relative = String(filePath).replaceAll("\\", "/").replace(/^\/+/, "");
  const absolute = path.resolve(PROJECT_ROOT, relative);
  if (!relative || !ALLOWED_ROOTS.some((root) => isInside(root, absolute))) {
    throw new Error("That file is outside the safe AI source-inspection area.");
  }
  if (isBlockedPath(absolute)) {
    throw new Error("That file is blocked from AI inspection.");
  }
  return absolute;
}

function isBlockedPath(filePath) {
  const relative = relativePath(filePath);
  if (BLOCKED_FILE_PATTERN.test(relative)) return true;
  return relative.split("/").some((part) => BLOCKED_PARTS.has(part));
}

async function walk(dir, rows = []) {
  if (rows.length >= MAX_SEARCH_FILES) return rows;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (isBlockedPath(fullPath)) continue;
    if (entry.isDirectory()) {
      await walk(fullPath, rows);
    } else if (SOURCE_FILE_PATTERN.test(entry.name)) {
      rows.push(fullPath);
    }
    if (rows.length >= MAX_SEARCH_FILES) break;
  }
  return rows;
}

async function allowedFiles() {
  return (await Promise.all(ALLOWED_ROOTS.map((root) => walk(root, [])))).flat();
}

function lineNumberedSnippet(text, centerLine, radius = 10) {
  const lines = text.split("\n");
  const center = Math.max(1, Number(centerLine) || 1);
  const from = Math.max(1, center - radius);
  const to = Math.min(lines.length, center + radius);
  return {
    from,
    snippet: lines
      .slice(from - 1, to)
      .map((line, index) => `${from + index}: ${line}`)
      .join("\n")
      .slice(0, MAX_SNIPPET_CHARS),
    to,
    totalLines: lines.length,
  };
}

async function readSourceFile(filePath) {
  const absolute = resolveSafePath(filePath);
  const info = await stat(absolute);
  if (info.size > MAX_FILE_CHARS) {
    throw new Error("That file is too large for direct inspection. Use search or a function query.");
  }
  return {
    absolute,
    relative: relativePath(absolute),
    text: await readFile(absolute, "utf8"),
  };
}

function classifyFile(relative) {
  if (relative.includes("/components/")) return "frontend component";
  if (relative.includes("/backtest/")) return "backtest engine";
  if (relative.includes("/engine/")) return "strategy engine";
  if (relative.includes("/indicators/")) return "indicator logic";
  if (relative.includes("/execution/")) return relative.startsWith("backend/") ? "backend execution" : "frontend execution";
  if (relative.includes("/exchanges/")) return "exchange client";
  if (relative.includes("/state/")) return "backend state store";
  if (relative.includes("/ai/")) return "AI module";
  if (relative.endsWith("backend/src/index.js")) return "backend routes";
  return "supporting source";
}

function summarizeText(relative, text) {
  const lines = text.split("\n");
  const imports = lines.filter((line) => line.trim().startsWith("import ")).slice(0, 18);
  const functions = [];
  const routes = [];
  const exports = [];

  lines.forEach((line, index) => {
    const functionMatch =
      line.match(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/u) ??
      line.match(/(?:const|let)\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(/u) ??
      line.match(/(?:export\s+)?class\s+([A-Za-z0-9_]+)/u);
    if (functionMatch) {
      functions.push({ line: index + 1, name: functionMatch[1] });
    }
    if (line.includes("pathname ===") || line.includes("pathname.startsWith")) {
      routes.push({ line: index + 1, text: line.trim().slice(0, 220) });
    }
    if (line.trim().startsWith("export ")) {
      exports.push({ line: index + 1, text: line.trim().slice(0, 220) });
    }
  });

  return {
    category: classifyFile(relative),
    exports: exports.slice(0, 20),
    functions: functions.slice(0, 50),
    imports,
    lines: lines.length,
    path: relative,
    routes: routes.slice(0, 60),
  };
}

function actionKey(actionName = "") {
  const normalized = normalizeText(actionName);
  const exact = Object.keys(ACTION_TRACES).find((key) => normalizeText(key) === normalized);
  if (exact) return exact;
  return Object.entries(ACTION_TRACES).find(([, trace]) =>
    trace.aliases.some((alias) => normalized.includes(normalizeText(alias)) || normalizeText(alias).includes(normalized)),
  )?.[0] ?? null;
}

function extractKeywords(question = "") {
  const normalized = normalizeText(question);
  const preferred = [
    "move sl",
    "move tp",
    "open backtest",
    "verify integrity",
    "ask follow-up",
    "profit factor",
    "pf",
    "hubert",
    "backtest",
    "livestream",
    "manual action",
  ].filter((keyword) => normalized.includes(normalizeText(keyword)));
  if (preferred.length) return preferred;
  return normalized.split(" ").filter((word) => word.length >= 4).slice(0, 5);
}

function isPolishQuestion(value = "") {
  const normalized = normalizeText(value);
  return /(^|\s)(co|czemu|dlaczego|jak|gdzie|porownaj|porównaj|wynik|dziala|działa|nadal|robi|robia|robią|ustawienia|blad|błąd)(\s|$)/iu.test(String(value)) ||
    normalized.includes("czemu") ||
    normalized.includes("dlaczego") ||
    normalized.includes("porownaj") ||
    normalized.includes("robi");
}

function formatRuntimePosition(position = {}) {
  return {
    attachedOrders: (position.attachedOrders ?? []).slice(0, 6).map((order) => ({
      closePosition: order.closePosition,
      orderId: order.orderId,
      positionSide: order.positionSide,
      side: order.side,
      status: order.status,
      stopPrice: order.stopPrice,
      type: order.type,
    })),
    entryPrice: position.entryPrice,
    positionId: position.positionId,
    positionSide: position.positionSide,
    protectionSource: position.protectionSource,
    quantity: position.quantity,
    side: position.side,
    stopLoss: position.stopLoss,
    symbol: position.symbol,
    takeProfit: position.takeProfit,
    unrealizedPnl: position.unrealizedPnl,
  };
}

export function createAiPlatformAccess({
  buildLivestreamPayload,
  dataAvailability,
  publicApiProfiles,
  publicStatusPayload,
  store,
}) {
  async function searchCodeByKeyword(input = {}) {
    const keyword = String(input.keyword ?? input.query ?? "").trim();
    if (!keyword) {
      return { ok: false, message: "Provide a keyword or query to search for." };
    }
    const normalizedKeyword = keyword.toLowerCase();
    const maxMatches = Math.max(1, Math.min(Number(input.limit ?? 80), 120));
    const files = await allowedFiles();
    const matches = [];
    for (const filePath of files) {
      const text = await readFile(filePath, "utf8").catch(() => "");
      const lines = text.split("\n");
      lines.forEach((line, index) => {
        if (line.toLowerCase().includes(normalizedKeyword)) {
          matches.push({
            category: classifyFile(relativePath(filePath)),
            line: index + 1,
            path: relativePath(filePath),
            text: line.trim().slice(0, 240),
          });
        }
      });
      if (matches.length >= maxMatches) break;
    }
    return {
      blocked: ["secrets, .env files, backend/data, backend/logs, node_modules, build output"],
      keyword,
      matches: matches.slice(0, maxMatches),
      ok: true,
    };
  }

  async function getFileSummary(input = {}) {
    const { relative, text } = await readSourceFile(input.filePath ?? input.path);
    return {
      ok: true,
      summary: summarizeText(relative, text),
    };
  }

  async function getFunctionOrRouteDetails(input = {}) {
    const query = String(input.query ?? input.name ?? input.route ?? "").trim();
    if (!query) return { ok: false, message: "Provide a function name, route, or keyword." };
    const files = input.filePath ? [resolveSafePath(input.filePath)] : await allowedFiles();
    const normalized = query.toLowerCase();
    const details = [];
    for (const filePath of files) {
      const text = await readFile(filePath, "utf8").catch(() => "");
      const lines = text.split("\n");
      lines.forEach((line, index) => {
        const lower = line.toLowerCase();
        const likelyDeclaration =
          lower.includes(normalized) &&
          (/function\s+|const\s+|export\s+|pathname|request\.method|if\s*\(/u.test(line) || query.startsWith("/"));
        if (likelyDeclaration) {
          details.push({
            category: classifyFile(relativePath(filePath)),
            line: index + 1,
            path: relativePath(filePath),
            preview: line.trim().slice(0, 240),
            ...lineNumberedSnippet(text, index + 1, Number(input.window ?? 8)),
          });
        }
      });
      if (details.length >= Number(input.limit ?? 12)) break;
    }
    return {
      details: details
        .sort((left, right) => {
          const leftTrace = left.path.includes("aiPlatformAccess.js") ? 1 : 0;
          const rightTrace = right.path.includes("aiPlatformAccess.js") ? 1 : 0;
          if (leftTrace !== rightTrace) return leftTrace - rightTrace;
          return left.path.localeCompare(right.path) || left.line - right.line;
        })
        .slice(0, Math.max(1, Math.min(Number(input.limit ?? 12), 30))),
      ok: true,
      query,
    };
  }

  async function buildPlatformMap() {
    const files = await allowedFiles();
    const summaries = [];
    for (const relative of [
      "hubert-platform/frontend/src/components/ControlCenter.jsx",
      "hubert-platform/frontend/src/components/TradingViewChart.jsx",
      "hubert-platform/frontend/src/engine/strategyEngine.js",
      "hubert-platform/frontend/src/backtest/backtestEngine.js",
      "hubert-platform/frontend/src/backtest/metrics.js",
      "backend/src/index.js",
      "backend/src/exchanges/bingxClient.js",
      "backend/src/ai/aiTools.js",
      "backend/src/ai/agent/agentOrchestrator.js",
      "backend/src/state/store.js",
    ]) {
      const absolute = path.join(PROJECT_ROOT, relative);
      if (files.includes(absolute)) {
        const text = await readFile(absolute, "utf8").catch(() => "");
        summaries.push(summarizeText(relative, text));
      }
    }

    return {
      aiTools: [
        "getPlatformMap",
        "searchPlatformCode",
        "getFileSummary",
        "getFunctionOrRouteDetails",
        "explainDataFlow",
        "traceAction",
        "getRuntimeState",
        "getCurrentWorkspaceState",
        "getOpenBacktestState",
        "getChartContext",
        "getSelectedTrade",
        "getLoadedDecks",
        "getFavoriteBaselines",
        "getExecutionState",
        "getLivestreamHealth",
        "getCurrentManualPositionState",
        "answerFromPlatformEvidence",
        "resolveLibraryItem",
        "getLibraryItemDetail",
        "getBacktestDetail",
      ],
      blocked: ["BingX secrets", "OpenAI keys", "Telegram tokens", ".env files", "backend/data raw files", "backend/logs raw files"],
      executionPaths: Object.keys(ACTION_TRACES),
      filesScanned: files.length,
      generatedAt: new Date().toISOString(),
      map: {
        backendRoutes: "backend/src/index.js",
        backtestEngine: "hubert-platform/frontend/src/backtest/backtestEngine.js",
        chart: "hubert-platform/frontend/src/components/TradingViewChart.jsx",
        exchangeClient: "backend/src/exchanges/bingxClient.js",
        frontendControlCenter: "hubert-platform/frontend/src/components/ControlCenter.jsx",
        stateStore: "backend/src/state/store.js",
        strategyEngine: "hubert-platform/frontend/src/engine/strategyEngine.js",
      },
      summaries,
    };
  }

  async function getRuntimeState(input = {}) {
    const profiles = await publicApiProfiles({ fresh: input.fresh === true }).catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
    const live = Array.isArray(profiles) ? buildLivestreamPayload(profiles) : null;
    const latestRun = (store.getCollection("aiAgentRuns") ?? [])[0] ?? null;
    return sanitizeForAi({
      ai: latestRun
        ? {
            currentStep: latestRun.currentStep,
            id: latestRun.id,
            progress: latestRun.progress,
            status: latestRun.status,
            updatedAt: latestRun.updatedAt,
          }
        : null,
      availability: input.includeAvailability === false ? undefined : await dataAvailability().catch(() => []),
      collections: {
        backtests: (store.getCollection("backtests") ?? []).map((item) => ({ id: item.id, name: item.name, timeframe: item.timeframe })).slice(-20),
        battleDecks: (store.getCollection("battleDecks") ?? []).map((item) => ({ id: item.id, name: item.name, status: item.status })).slice(-20),
        favorites: (store.getCollection("favorites") ?? []).map((item) => ({ category: item.category, id: item.id, itemId: item.itemId, name: item.name })).slice(-40),
        mmDecks: (store.getCollection("mmDecks") ?? []).map((item) => ({ id: item.id, mode: item.mode, name: item.name })).slice(-20),
        strategyDecks: (store.getCollection("strategyDecks") ?? []).map((item) => ({ id: item.id, name: item.name, symbol: item.symbol, timeframe: item.timeframe })).slice(-20),
      },
      live: live
        ? {
            accountSummary: live.accountSummary,
            lastSync: live.lastSync,
            positions: (live.positions ?? []).map(formatRuntimePosition),
            source: live.source,
          }
        : { error: profiles.error },
      logs: store.getLogs().slice(-Number(input.logLimit ?? 20)).map((log) => ({
        context: log.context,
        message: log.message,
        time: log.time,
      })),
      status: publicStatusPayload(),
    });
  }

  async function traceAction(input = {}) {
    const key = actionKey(input.actionName ?? input.action ?? input.query ?? "");
    if (!key) {
      return {
        availableActions: Object.keys(ACTION_TRACES),
        ok: false,
        message: "I do not have a named trace for that action yet.",
      };
    }
    const trace = ACTION_TRACES[key];
    const keywords = [...(trace.searchTerms ?? []), key, ...(trace.aliases ?? [])].slice(0, 8);
    const evidence = [];
    for (const keyword of keywords) {
      const matches = await searchCodeByKeyword({ keyword, limit: 8 });
      evidence.push(...(matches.matches ?? []));
    }
    return {
      action: key,
      confidence: "high",
      ok: true,
      path: trace,
      codeEvidence: evidence
        .filter((item, index, list) => list.findIndex((entry) => entry.path === item.path && entry.line === item.line) === index)
        .slice(0, 18),
      unknown: [
        "The trace explains platform code paths. Exchange-side behavior still needs live verification for the specific account/mode.",
      ],
      suggestedVerification: [
        "Use the UI action with a tiny test position.",
        "Inspect the returned diagnostics and then force a fresh BingX sync.",
      ],
    };
  }

  async function explainDataFlow(input = {}) {
    const action = String(input.actionName ?? input.flow ?? input.query ?? "").trim();
    const traced = await traceAction({ actionName: action });
    if (traced.ok) {
      return {
        ...traced,
        dataFlow: [
          "User clicks frontend control.",
          "Frontend builds a sanitized request payload.",
          "Backend route validates token and dispatches to a controlled function.",
          "Backend calls the exchange/client or analysis engine.",
          "Backend returns sanitized response/diagnostics to the UI.",
        ],
      };
    }
    return traced;
  }

  async function answerFromPlatformEvidence(input = {}) {
    const question = String(input.question ?? input.message ?? "").trim();
    if (!question) return { ok: false, message: "Ask a platform question first." };
    const normalized = normalizeText(question);
    const polish = isPolishQuestion(question);
    const inspected = [];
    const evidence = [];
    let answer = "";
    let confidence = "medium";
    let unknown = ["No live browser click was performed by this answer."];
    let suggestedVerification = ["Open the relevant panel and run the exact UI action after reading the trace."];

    if ((normalized.includes("sl") || normalized.includes("stop loss")) && (normalized.includes("czemu") || normalized.includes("dlaczego") || normalized.includes("nadal") || normalized.includes("nie dziala") || normalized.includes("nie działa"))) {
      const runtime = await getRuntimeState({ fresh: true, includeAvailability: false, logLimit: 8 });
      const slPositions = runtime.live?.positions ?? [];
      const protectedPositions = slPositions.filter((position) => Number(position.stopLoss ?? 0) > 0 || position.attachedOrders?.some((order) => String(order.type ?? "").includes("STOP")));
      inspected.push(
        "runtime fresh BingX livestream state",
        "backend/src/index.js buildLivestreamPayload",
        "backend/src/index.js verifyProtectiveAction",
        "backend/src/exchanges/bingxClient.js placePositionStopLoss/placeStopLoss",
      );
      evidence.push(
        `Fresh positions: ${slPositions.length}`,
        `Positions with detected SL/protection: ${protectedPositions.length}`,
        ...slPositions.slice(0, 4).map((position) =>
          `${position.symbol} ${position.positionSide ?? position.side}: SL=${position.stopLoss ?? 0}, source=${position.protectionSource ?? "unknown"}, attachedOrders=${position.attachedOrders?.length ?? 0}`,
        ),
      );
      answer = polish
        ? protectedPositions.length
          ? `Według świeżego syncu BingX ochrona SL istnieje, ale źródłem jest open order, a nie pole pozycji. Dlatego stary UI mógł pokazywać SL=0, jeśli patrzył tylko na position.stopLoss. Aktualnie wykryte pozycje z SL: ${protectedPositions.map((position) => `${position.symbol} ${position.positionSide ?? position.side} SL ${position.stopLoss ?? "?"} (${position.protectionSource ?? "źródło nieznane"})`).join("; ")}. Jeśli przycisk nadal mówi sukces bez aktywnego ordera, błąd jest w warstwie potwierdzenia/verifiera, nie w strategii.`
          : "Świeży sync BingX nie pokazuje aktywnej ochrony SL dla widocznych pozycji. W takim stanie UI nie powinien mówić „confirmed”. Trzeba sprawdzić diagnostykę /manual/action: endpoint, payload, raw response oraz czy openOrders/protectiveOrders po syncu zawierają STOP_MARKET dla tego positionSide."
        : protectedPositions.length
          ? `Fresh BingX sync sees SL protection, but it is coming from an open order rather than a position field: ${protectedPositions.map((position) => `${position.symbol} ${position.positionSide ?? position.side} SL ${position.stopLoss ?? "?"} (${position.protectionSource ?? "unknown"})`).join("; ")}. Old UI could show SL=0 if it looked only at the position field.`
          : "Fresh BingX sync does not show active SL protection for the visible positions, so the UI must not say confirmed. Inspect /manual/action diagnostics and openOrders/protectiveOrders after sync.";
      confidence = "high";
      unknown = ["This answer uses the latest backend sync. The BingX mobile app view still has to be checked manually if the app display differs."];
      suggestedVerification = polish
        ? ["Kliknij Force Sync na karcie pozycji.", "Rozwiń Last exchange response po Move SL i sprawdź endpoint, payload, raw response oraz verification.source.", "W BingX app sprawdź aktywne conditional/open orders dla tej pozycji."]
        : ["Click Force Sync on the position card.", "Expand Last exchange response after Move SL and inspect endpoint, payload, raw response, and verification.source.", "Check active conditional/open orders in the BingX app."];
    } else if (normalized.includes("currently loaded") || normalized.includes("current strategy") || normalized.includes("what strategy") || normalized.includes("jaka strategia") || normalized.includes("zaladowan")) {
      const runtime = await getRuntimeState({ includeAvailability: false, logLimit: 4 });
      const frontend = input.workspaceContext ?? {};
      const strategy = frontend.selectedDecks?.strategyDeck ?? runtime.collections?.strategyDecks?.at(-1) ?? null;
      const battle = frontend.selectedDecks?.battleDeck ?? runtime.collections?.battleDecks?.at(-1) ?? null;
      inspected.push("frontend workspaceContext selectedDecks", "backend/src/ai/aiPlatformAccess.js getRuntimeState", "backend state store strategyDecks/battleDecks");
      evidence.push(
        `Active panel: ${frontend.activePanel ?? "unknown"}`,
        `Chart: ${frontend.chart?.symbol ?? "unknown"} ${frontend.chart?.timeframe ?? "unknown"}`,
        strategy ? `Strategy deck: ${strategy.name ?? strategy.id} ${strategy.symbol ?? ""} ${strategy.timeframe ?? ""}` : "No selected strategy deck in workspace context.",
        battle ? `Battle deck: ${battle.name ?? battle.id}` : "No active battle deck in workspace context.",
      );
      answer = polish
        ? strategy
          ? `Aktualnie widzę strategię „${strategy.name ?? strategy.id}” dla ${strategy.symbol ?? frontend.chart?.symbol ?? "symbolu"} ${strategy.timeframe ?? frontend.chart?.timeframe ?? ""}. Biorę to z aktywnego kontekstu workspace, a nie zgaduję z tekstu.`
          : "W bieżącym kontekście workspace nie widzę konkretnego Strategy Decka. Widzę tylko panel/wykres; otwórz deck albo Battle Deck, wtedy Copilot będzie mógł wskazać dokładną konfigurację."
        : strategy
          ? `The currently visible Strategy Deck appears to be “${strategy.name ?? strategy.id}” for ${strategy.symbol ?? frontend.chart?.symbol ?? "symbol"} ${strategy.timeframe ?? frontend.chart?.timeframe ?? ""}. I am reading this from the active workspace context, not guessing.`
          : "I do not see a concrete selected Strategy Deck in the current workspace context. Open a deck or Battle Deck and ask again for exact configuration.";
      confidence = strategy ? "high" : "medium";
      suggestedVerification = ["Check the Run Context header in AI Copilot.", "Open Strategy Decks or Battle Decks if you need exact deck parameters."];
    } else if (normalized.includes("chart lag") || normalized.includes("chart slow") || normalized.includes("freez") || normalized.includes("wykres") && (normalized.includes("lag") || normalized.includes("woln"))) {
      const frontend = input.workspaceContext ?? {};
      inspected.push("frontend workspaceContext chart diagnostics", "hubert-platform/frontend/src/components/TradingViewChart.jsx chart render budgets");
      evidence.push(
        `Rendered candles: ${frontend.chart?.renderedCandles ?? "unknown"}`,
        `Full candles: ${frontend.chart?.fullCandles ?? "unknown"}`,
        `Provider/source: ${frontend.chart?.provider ?? "unknown"}`,
        `Analysis mode: ${frontend.chart?.analysisMode ? "yes" : "no"}`,
      );
      const rendered = Number(frontend.chart?.renderedCandles ?? 0);
      answer = polish
        ? rendered > 3000
          ? `Najbardziej prawdopodobna przyczyna laga to zbyt duża liczba renderowanych świec: widzę ${rendered}. Chart powinien pracować na lekkim oknie, a pełna historia powinna zostać tylko dla backtestu.`
          : `Nie widzę oczywistego przekroczenia budżetu świec w kontekście workspace: renderowane świece ${rendered || "unknown"}. Jeśli lag nadal występuje, trzeba sprawdzić liczbę markerów/SL/TP/debug overlays i console performance.`
        : rendered > 3000
          ? `The likely chart lag cause is too many rendered candles: I see ${rendered}. The chart should stay on a lightweight window while full history remains for backtests.`
          : `I do not see an obvious candle-budget breach from workspace context: rendered candles ${rendered || "unknown"}. If it still lags, inspect markers/SL/TP/debug overlays and console performance.`;
      confidence = rendered ? "medium" : "low";
      suggestedVerification = ["Open chart diagnostics.", "Turn debug overlays off.", "Jump to a smaller chart window and compare responsiveness."];
    } else if ((normalized.includes("verify integrity") || normalized.includes("integrity")) && (normalized.includes("rerun exact") || normalized.includes("re run exact") || normalized.includes("re-run exact"))) {
      inspected.push(
        "AiAgentPanel.verifyIntegrity in hubert-platform/frontend/src/components/ControlCenter.jsx",
        "AiAgentPanel.rerunExact in hubert-platform/frontend/src/components/ControlCenter.jsx",
        "POST /ai/agent/runs/:id/verify in backend/src/index.js",
        "POST /ai/agent/runs/:id/rerun in backend/src/index.js",
        "createAgentOrchestrator().verifyIntegrity/rerunExact in backend/src/ai/agent/agentOrchestrator.js",
      );
      evidence.push(
        "Verify integrity reruns/compares the stored AI row against exact platform metrics and reports mismatches.",
        "Re-run exact runs the selected AI config again using stored symbol/timeframe/range/provider/sizing/fill/params.",
        "Neither action changes live execution or places orders.",
      );
      answer = polish
        ? "Verify integrity sprawdza, czy wynik AI jest spójny z dokładnym ponownym uruchomieniem tej samej konfiguracji. Pokazuje różnice metryk, np. PF, net, candles, zakres i tryb sizing/fill. Re-run exact po prostu odpala jeszcze raz dokładnie tę samą konfigurację z karty wyniku AI, żeby zobaczyć, czy wynik da się odtworzyć. Oba przyciski są analityczne: nie handlują i nie zmieniają decków."
        : "Verify integrity checks whether the stored AI result matches an exact platform rerun and reports metric/context diffs. Re-run exact reruns the selected AI config with the stored symbol, timeframe, range, provider, sizing, fill mode, and parameters. Both are analysis-only.";
      confidence = "high";
      suggestedVerification = polish
        ? ["Otwórz kartę wyniku AI, kliknij Verify integrity, potem porównaj sekcję metric diff.", "Kliknij Re-run exact i sprawdź, czy zakres/candles/PF są identyczne."]
        : ["Open an AI result card, click Verify integrity, then inspect metric diff.", "Click Re-run exact and confirm the range/candles/PF match."];
    } else {
    const tracedKey = actionKey(question);
    if (tracedKey) {
      const traced = await traceAction({ actionName: tracedKey });
      inspected.push(...traced.path.frontend, ...traced.path.backend, ...traced.path.exchange);
      evidence.push(...traced.path.notes, ...traced.codeEvidence.slice(0, 8).map((item) => `${item.path}:${item.line} ${item.text}`));
      answer = tracedKey === "pf calculation"
        ? polish
          ? "PF jest liczony w calculateBacktestMetrics w pliku hubert-platform/frontend/src/backtest/metrics.js jako grossProfit / grossLoss. Jeśli grossLoss = 0 i jest zysk, PF jest Infinity; jeśli nie ma strat ani zysku, PF jest 0. AI i raporty biorą tę metrykę z runBacktest, nie liczą jej osobno."
          : "Profit factor is calculated in calculateBacktestMetrics inside hubert-platform/frontend/src/backtest/metrics.js as grossProfit / grossLoss. If grossLoss is zero, positive grossProfit returns Infinity; otherwise PF is 0. AI/backtest reports consume that metric from runBacktest rather than recalculating it separately."
        : polish
          ? `Ścieżka ${tracedKey}: ${traced.path.frontend.join(" → ")} → ${traced.path.backend.join(" → ")}${traced.path.exchange.length ? ` → ${traced.path.exchange.join(" / ")}` : ""}`
          : `${tracedKey} path: ${traced.path.frontend.join(" → ")} → ${traced.path.backend.join(" → ")}${traced.path.exchange.length ? ` → ${traced.path.exchange.join(" / ")}` : ""}`;
      confidence = "high";
      unknown = traced.unknown;
      suggestedVerification = polish
        ? ["Wykonaj akcję na małej pozycji testowej.", "Sprawdź diagnostykę odpowiedzi i wymuś świeży sync z BingX."]
        : traced.suggestedVerification;
    } else if (normalized.includes("pf") || normalized.includes("profit factor")) {
      const details = await getFunctionOrRouteDetails({ query: "profitFactor", filePath: "hubert-platform/frontend/src/backtest/metrics.js", limit: 6 });
      inspected.push("hubert-platform/frontend/src/backtest/metrics.js calculateBacktestMetrics");
      evidence.push(...details.details.map((item) => `${item.path}:${item.line} ${item.preview}`));
      answer = polish
        ? "PF jest liczony w calculateBacktestMetrics jako grossProfit / grossLoss. Jeśli grossLoss = 0 i grossProfit > 0, PF jest Infinity; w przeciwnym razie 0."
        : "Profit factor is calculated in calculateBacktestMetrics as grossProfit / grossLoss. If grossLoss is zero, positive grossProfit becomes Infinity; otherwise it is 0.";
      confidence = "high";
      suggestedVerification = ["Open hubert-platform/frontend/src/backtest/metrics.js and inspect calculateBacktestMetrics."];
    } else if (normalized.includes("hubert") || normalized.includes("saved backtest") || normalized.includes("ai config differ")) {
      const backtests = store.getCollection("backtests") ?? [];
      const favorites = store.getCollection("favorites") ?? [];
      const hubert = [...backtests, ...favorites].find((item) => normalizeText(item.name ?? item.id).includes("hubert"));
      inspected.push("backend/data saved collections through state store", "backend/src/ai/aiLibraryTools.js resolver");
      evidence.push(hubert ? `Found possible saved item: ${hubert.name ?? hubert.id}` : "No saved item named hubert was found in current collections.");
      answer = hubert
        ? polish
          ? "Widzę zapisany element pasujący do „hubert”. AI może porównać go przez resolveLibraryItem/getBacktestDetail i compareAgentResultToBacktest. Żeby porównanie było uczciwe, trzeba zestawić zakres, timeframe, provider, fill mode, sizing mode, candles used, parametry strategii oraz metryki. Jeśli kontekst się różni, wynik AI i hubert nie są bezpośrednio porównywalne."
          : "The AI can compare against the saved Hubert baseline through resolveLibraryItem/getBacktestDetail and compareAgentResultToBacktest. If metrics differ, the exact range, provider, fill mode, sizing mode, candles, and strategy params must be compared before judging the AI row."
        : polish
          ? "Nie widzę zapisanego elementu o nazwie „hubert” w bezpiecznym widoku kolekcji. Sprawdź nazwę w Favorites/Backtests albo użyj bezpośredniego ID backtestu."
          : "I could not see a saved item named Hubert in the current sanitized collections. The next step is to check Favorites/Backtests spelling or use the direct saved backtest id.";
      confidence = hubert ? "high" : "medium";
      suggestedVerification = ["Use the AI result card action: Compare to saved backtest, with name hubert.", "If ambiguous, use the saved backtest id."];
    } else {
      const keywords = extractKeywords(question);
      for (const keyword of keywords) {
        const matches = await searchCodeByKeyword({ keyword, limit: 12 });
        evidence.push(...matches.matches.map((item) => `${item.path}:${item.line} ${item.text}`));
      }
      inspected.push(...new Set(evidence.map((line) => line.split(":")[0]).filter(Boolean)));
      answer = evidence.length
        ? `I searched the platform source for ${keywords.join(", ")} and found ${evidence.length} code evidence lines. Use the evidence list to narrow the exact route/function.`
        : "I did not find direct code evidence for that wording. Try naming the button, route, or metric more directly.";
      confidence = evidence.length ? "medium" : "low";
    }
    }

    return sanitizeForAi({
      answer,
      confidence,
      evidence: evidence.slice(0, 30),
      inspected: [...new Set(inspected)].slice(0, 30),
      mode: input.mode ?? "platform-evidence",
      ok: true,
      question,
      suggestedVerification,
      unknown,
    });
  }

  return {
    answerFromPlatformEvidence,
    explainDataFlow,
    getFileSummary,
    getFunctionOrRouteDetails,
    getPlatformMap: buildPlatformMap,
    getRuntimeState,
    searchPlatformCode: searchCodeByKeyword,
    traceAction,
  };
}

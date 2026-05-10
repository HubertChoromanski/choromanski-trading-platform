import { useEffect, useMemo, useRef, useState } from "react";
import { runBacktest } from "../backtest/backtestEngine";

const PANEL_TABS = [
  "System",
  "Livestream",
  "Indicator",
  "Strategy Decks",
  "Backtests",
  "Compare",
  "MM Decks",
  "Decision",
  "Battle Decks",
  "Execution",
  "Crisis",
  "Analytics",
  "Communication",
  "AI",
  "Favorites",
];

const BACKEND_URL = normalizeBackendUrl(
  import.meta.env.VITE_BACKEND_URL ?? (import.meta.env.PROD ? "/api" : "http://127.0.0.1:8787"),
);
const DASHBOARD_TOKEN = import.meta.env.VITE_DASHBOARD_TOKEN ?? "";
const TIMEFRAMES = [
  { label: "10m", interval: "10m", minutes: 10 },
  { label: "15m", interval: "15m", minutes: 15 },
  { label: "20m", interval: "20m", minutes: 20 },
  { label: "30m", interval: "30m", minutes: 30 },
  { label: "1H", interval: "1h", minutes: 60 },
  { label: "4H", interval: "4h", minutes: 240 },
];
const PREVIEW_CURVE_POINTS = 420;
const BACKTEST_CHART_TRADE_LIMIT = 500;
const TRADE_TABLE_PAGE_SIZE = 50;
const STORED_BACKTEST_EVENT_LIMIT = 1000;
const SWEEP_MAX_COMBINATIONS = 100;

const defaultStrategyDeck = {
  allowLong: true,
  allowShort: true,
  atrLength: 14,
  atrMultiplier: 1.2,
  atrPositionSizing: true,
  bandwidth: 8,
  confirmedEntries: true,
  diagnosticSetups: false,
  envelopeMultiplier: 3,
  maxSameSideFailures: 2,
  name: "",
  negatedSetups: false,
  showSl: true,
  showTrigger: false,
  slLines: true,
  strategySource: "pine-ha",
  symbol: "SOLUSDT",
  timeframe: "15m",
  triggerLines: false,
};

const defaultMmDeck = {
  fixedNotional: 100,
  mode: "run",
  name: "",
  oneSlPercent: 1,
  positionPercent: 10,
};

const defaultBacktestForm = {
  commissionPercent: 0.04,
  from: "",
  lastDays: 31,
  mmDeckId: "",
  name: "",
  slippagePercent: 0,
  startingBalance: 10000,
  strategyDeckId: "",
  manualTo: "",
};

const defaultSweepForm = {
  atrLengths: "",
  atrMultipliers: "",
  atrPositionSizing: "current",
  bandwidths: "",
  envelopeMultipliers: "",
  fixedNotionalValues: "",
  manualAtrLengths: "14",
  manualAtrMultipliers: "1.2",
  manualBandwidths: "8",
  manualEnvelopeMultipliers: "3",
  manualFixedNotionalValues: "100",
  manualFrom: "",
  manualLastDays: 31,
  manualMaxSameSideFailures: "2",
  manualPositionValues: "10",
  manualRiskValues: "1",
  manualSizingMode: "run-risk",
  manualStartingBalance: 10000,
  manualStrategySource: "pine-ha",
  manualSymbol: "SOLUSDT",
  manualTimeframe: "15m",
  maxCombinations: SWEEP_MAX_COMBINATIONS,
  maxSameSideFailures: "",
  mode: "manual",
  positionValues: "",
  riskValues: "",
  to: "",
};

const collectionRoutes = {
  backtests: "/backtests",
  battleDecks: "/decks/battle",
  favorites: "/favorites",
  mmDecks: "/decks/mm",
  strategyDecks: "/decks/strategy",
};

function normalizeBackendUrl(value) {
  if (!value) return "http://127.0.0.1:8787";
  if (value.toLowerCase() === "/api") return "/api";
  return value.replace(/\/$/, "");
}

function apiUrl(path) {
  if (BACKEND_URL.startsWith("http")) return `${BACKEND_URL}${path}`;
  return `${BACKEND_URL}${path}`;
}

async function apiFetch(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(DASHBOARD_TOKEN ? { "X-Dashboard-Token": DASHBOARD_TOKEN } : {}),
    ...(options.headers ?? {}),
  };
  const response = await fetch(apiUrl(path), {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(payload.message || payload.reason || payload.error || "The backend did not accept this request.");
    error.status = response.status;
    throw error;
  }

  return payload;
}

function humanError(error) {
  const message = error instanceof Error ? error.message : String(error);

  if (error?.status === 404 || message.includes("404")) {
    return "The dashboard could not find that backend service. Rebuild and restart the backend, then refresh.";
  }

  if (message.includes("Failed to fetch")) {
    return "The backend is offline or unreachable. Check PM2/Caddy and refresh status.";
  }

  return message;
}

function fmt(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return number.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function hasKnownProfileBalance(rows = []) {
  return rows.some((profile) => profile.futuresBalance !== null && Number.isFinite(Number(profile.futuresBalance)));
}

function totalProfileBalance(rows = []) {
  return rows.reduce((sum, profile) => sum + Number(profile.futuresBalance ?? 0), 0);
}

function profileBalanceText(profile) {
  return profile?.futuresBalance === null || profile?.futuresBalance === undefined ? "Syncing" : fmt(profile.futuresBalance);
}

function isBlank(value) {
  return value === "" || value === null || value === undefined;
}

function requireNumber(value, label, { min = -Infinity, positive = false } = {}) {
  if (!value && typeof value === "object") {
    throw new Error(`${label} needs a valid number.`);
  }

  const number = Number(value);

  if (isBlank(value) || !Number.isFinite(number) || number < min || (positive && number <= 0)) {
    throw new Error(`${label} needs a valid number.`);
  }

  return number;
}

function normalizeStrategyDeck(deck) {
  return {
    ...deck,
    atrLength: requireNumber(deck.atrLength, "ATR length", { positive: true }),
    atrMultiplier: requireNumber(deck.atrMultiplier, "ATR multiplier", { positive: true }),
    bandwidth: requireNumber(deck.bandwidth, "Bandwidth", { positive: true }),
    envelopeMultiplier: requireNumber(deck.envelopeMultiplier, "NWE multiplier", { positive: true }),
    maxSameSideFailures: requireNumber(deck.maxSameSideFailures, "Max same-side failures", { min: 0 }),
  };
}

function normalizeMmDeck(deck) {
  if (deck.mode === "constant") {
    return {
      ...deck,
      fixedNotional: requireNumber(deck.fixedNotional, "Fixed position size", { positive: true }),
    };
  }

  return {
    ...deck,
    oneSlPercent: requireNumber(deck.oneSlPercent, "Risk per SL hit", { positive: true }),
    positionPercent: requireNumber(deck.positionPercent, "Position size", { positive: true }),
  };
}

function normalizeBacktestForm(form) {
  return {
    ...form,
    commissionPercent: requireNumber(form.commissionPercent, "Commission", { min: 0 }),
    lastDays: requireNumber(form.lastDays, "Last X days", { positive: true }),
    slippagePercent: requireNumber(form.slippagePercent, "Slippage", { min: 0 }),
    startingBalance: requireNumber(form.startingBalance, "Starting balance", { positive: true }),
  };
}

function dateText(time) {
  if (!time) return "--";
  const value = typeof time === "number" ? time * 1000 : time;
  return new Date(value).toLocaleString();
}

function displayBotStatus(status) {
  if (!status || status === "STOPPED" || status === "PAPER" || status === "PAPER_RUNNING") return "OFF";
  if (status === "LIVE_RUNNING") return "ON";
  if (status === "LIVE_ARMED") return "Armed";
  if (status === "NEEDS_RECONCILIATION") return "Needs check";
  if (status === "EMERGENCY_STOP") return "Emergency";
  return status.replaceAll("_", " ");
}

function compact(value) {
  return String(value ?? "").replace("-", "").toUpperCase();
}

function daysFromCandles(candles, interval) {
  const minutes = TIMEFRAMES.find((item) => item.interval === interval)?.minutes ?? 15;
  return candles.length * minutes / 1440;
}

function strategyToSettings(deck, fallbackSettings) {
  return {
    ...fallbackSettings,
    atrLength: Number(deck.atrLength ?? fallbackSettings.atrLength),
    atrMultiplier: Number(deck.atrMultiplier ?? fallbackSettings.atrMultiplier),
    bandwidth: Number(deck.bandwidth ?? fallbackSettings.bandwidth),
    envelopeMultiplier: Number(deck.envelopeMultiplier ?? fallbackSettings.envelopeMultiplier),
    maxSameSideFailures: Number(deck.maxSameSideFailures ?? fallbackSettings.maxSameSideFailures),
    showBenchmarks: Boolean(deck.diagnosticSetups),
    showEntries: deck.confirmedEntries !== false,
    showNegated: Boolean(deck.negatedSetups),
    showSl: deck.slLines !== false,
    showTrigger: Boolean(deck.triggerLines),
    strategySource: deck.strategySource ?? fallbackSettings.strategySource,
  };
}

function filterCandlesByBacktestForm(rawCandles, form) {
  if (rawCandles.length === 0) return rawCandles;
  const lastTime = rawCandles.at(-1).time;
  let from = form.from ? Math.floor(new Date(form.from).getTime() / 1000) : lastTime - Number(form.lastDays || 31) * 86400;
  const to = form.to ? Math.floor(new Date(form.to).getTime() / 1000) : lastTime;

  if (!Number.isFinite(from)) from = lastTime - 31 * 86400;
  return rawCandles.filter((candle) => candle.time >= from && candle.time <= to);
}

function rangeFromBacktestCandles(candles = []) {
  return {
    from: candles[0]?.time ?? null,
    to: candles.at(-1)?.time ?? null,
  };
}

function analyzeBacktest(result) {
  if (!result) return "Run a backtest to see the story behind the numbers.";
  const { metrics } = result;
  if (metrics.totalTrades < 5) {
    return "This test has very few trades. Treat the result as a preview, not a reliable pattern.";
  }
  if (metrics.netProfit > 0 && metrics.maxDrawdown < 15) {
    return "This deck is profitable in the tested window and drawdown stayed controlled. The next check is whether the trades cluster in one lucky period.";
  }
  if (metrics.netProfit > 0) {
    return "This deck made money, but drawdown is noticeable. It may work best with smaller MM sizing or a narrower active window.";
  }
  return "This deck lost money in the tested window. Review whether losses come from one side or from sideways market behavior.";
}

function sampleCurve(curve = [], maxPoints = PREVIEW_CURVE_POINTS) {
  if (curve.length <= maxPoints) return curve;
  const step = (curve.length - 1) / (maxPoints - 1);
  const sampled = [];
  let previousIndex = -1;

  for (let index = 0; index < maxPoints; index += 1) {
    const sourceIndex = Math.min(curve.length - 1, Math.round(index * step));

    if (sourceIndex !== previousIndex) {
      sampled.push(curve[sourceIndex]);
      previousIndex = sourceIndex;
    }
  }

  return sampled;
}

function equityPolyline(equityCurve) {
  const curve = sampleCurve(equityCurve);
  if (!curve?.length) return "";
  const values = curve.map((point) => point.equity);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return curve
    .map((point, index) => {
      const x = curve.length === 1 ? 0 : (index / (curve.length - 1)) * 100;
      const y = 100 - ((point.equity - min) / span) * 100;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

function drawdownPolyline(equityCurve) {
  const curve = sampleCurve(equityCurve);
  if (!curve?.length) return "";
  let peak = curve[0]?.equity ?? 0;
  const values = curve.map((point) => {
    peak = Math.max(peak, point.equity);
    return peak > 0 ? ((peak - point.equity) / peak) * 100 : 0;
  });
  const max = Math.max(...values, 1);
  return values
    .map((value, index) => {
      const x = values.length === 1 ? 0 : (index / (values.length - 1)) * 100;
      const y = (value / max) * 100;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

function sideBreakdown(trades = []) {
  return ["LONG", "SHORT"].map((side) => {
    const sideTrades = trades.filter((trade) => trade.direction === side);
    const pnl = sideTrades.reduce((sum, trade) => sum + Number(trade.netPnl ?? trade.pnl ?? 0), 0);
    const wins = sideTrades.filter((trade) => Number(trade.netPnl ?? trade.pnl ?? 0) > 0).length;
    return {
      pnl,
      side,
      total: sideTrades.length,
      winRate: sideTrades.length ? wins / sideTrades.length * 100 : 0,
    };
  });
}

function sidePnl(trades = [], side) {
  return trades
    .filter((trade) => trade.direction === side)
    .reduce((sum, trade) => sum + Number(trade.netPnl ?? trade.pnl ?? 0), 0);
}

function safeProfitFactor(value) {
  if (!Number.isFinite(value)) return value === Infinity ? 99 : 0;
  return value;
}

function sweepScore(metrics, startingBalance) {
  const netProfitPercent = startingBalance > 0 ? (metrics.netProfit / startingBalance) * 100 : 0;
  const drawdownPenalty = Number(metrics.maxDrawdown ?? 0);
  const tradeBonus = Math.min(Number(metrics.totalTrades ?? 0), 30) * 0.2;
  const factorBonus = Math.min(safeProfitFactor(metrics.profitFactor), 5) * 2;
  return netProfitPercent - drawdownPenalty + tradeBonus + factorBonus;
}

function parseSweepNumberList(value, label, { integer = false, min = -Infinity, positive = false } = {}) {
  const source = String(value ?? "").trim();
  if (!source) throw new Error(`${label} needs at least one value.`);
  const values = source
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => Number(item));

  if (values.some((number) => !Number.isFinite(number) || number < min || (positive && number <= 0))) {
    throw new Error(`${label} contains an invalid value.`);
  }

  if (integer && values.some((number) => !Number.isInteger(number))) {
    throw new Error(`${label} accepts whole numbers only.`);
  }

  return [...new Set(values)];
}

function parseOptionalSweepNumberList(value, fallbackValues, label, options) {
  return String(value ?? "").trim()
    ? parseSweepNumberList(value, label, options)
    : fallbackValues;
}

function sweepAtrSizingValues(mode, current) {
  if (mode === "both") return [true, false];
  if (mode === "on") return [true];
  if (mode === "off") return [false];
  return [Boolean(current)];
}

function sweepSizeKey(mmDeck, atrPositionSizing) {
  if (!mmDeck) return "";
  if (mmDeck.mode === "constant") return "fixedNotional";
  return atrPositionSizing ? "oneSlPercent" : "positionPercent";
}

function sweepSizeLabel(key) {
  if (key === "fixedNotional") return "CONSTANT fixed USDT";
  if (key === "oneSlPercent") return "RUN risk per SL";
  if (key === "positionPercent") return "RUN position %";
  return "Default size";
}

function hasExplicitSweepAtrMode(mode) {
  return mode === "on" || mode === "off" || mode === "both";
}

function sweepSizingSummary(mmDeck, strategyDeck, atrMode) {
  if (mmDeck?.mode === "constant") {
    return `Sweep sizing source: CONSTANT MM Deck. Every trade uses fixed USDT notional. ATR sizing ${hasExplicitSweepAtrMode(atrMode) ? "selection" : "state"} does not change position size.`;
  }

  if (mmDeck?.mode === "run") {
    const values = sweepAtrSizingValues(atrMode, strategyDeck?.atrPositionSizing);
    const modeText =
      values.length > 1
        ? "testing ATR ON and OFF"
        : values[0]
          ? "ATR ON"
          : "ATR OFF";

    return `Sweep sizing source: RUN MM Deck, ${modeText}.`;
  }

  return "Sweep sizing source: fallback. Without a RUN MM Deck, ATR ON/OFF may produce identical sizing.";
}

function sweepSizeValuesForKey(form, mmDeck, key) {
  if (!key) return [null];

  if (key === "fixedNotional") {
    return parseOptionalSweepNumberList(
      form.fixedNotionalValues,
      [Number(mmDeck?.fixedNotional ?? 0)],
      "Fixed notional values",
      { positive: true },
    );
  }

  if (key === "oneSlPercent") {
    return parseOptionalSweepNumberList(
      form.riskValues,
      [Number(mmDeck?.oneSlPercent ?? mmDeck?.riskPerSlPercent ?? 1)],
      "Risk per SL hit values",
      { positive: true },
    );
  }

  if (key === "positionPercent") {
    return parseOptionalSweepNumberList(
      form.positionValues,
      [Number(mmDeck?.positionPercent ?? mmDeck?.onePercentMovePercent ?? 10)],
      "Position size values",
      { positive: true },
    );
  }

  return [null];
}

function manualSweepSizeValues(form) {
  if (form.manualSizingMode === "constant") {
    return {
      atrPositionSizing: false,
      key: "fixedNotional",
      values: parseSweepNumberList(form.manualFixedNotionalValues, "Fixed notional values", { positive: true }),
    };
  }

  if (form.manualSizingMode === "run-position") {
    return {
      atrPositionSizing: false,
      key: "positionPercent",
      values: parseSweepNumberList(form.manualPositionValues, "Position size values", { positive: true }),
    };
  }

  return {
    atrPositionSizing: true,
    key: "oneSlPercent",
    values: parseSweepNumberList(form.manualRiskValues, "Risk per SL hit values", { positive: true }),
  };
}

function makeManualMmDeck(key, value) {
  if (key === "fixedNotional") {
    return {
      fixedNotional: value,
      id: "manual-sweep-mm",
      mode: "constant",
      name: "Manual Sweep MM",
    };
  }

  return {
    id: "manual-sweep-mm",
    mode: "run",
    name: "Manual Sweep MM",
    oneSlPercent: key === "oneSlPercent" ? value : 1,
    positionPercent: key === "positionPercent" ? value : 10,
  };
}

function sweepRangeForm(backtestForm, form) {
  if (form.mode !== "manual") return backtestForm;

  return {
    ...backtestForm,
    from: form.manualFrom,
    lastDays: form.manualLastDays,
    startingBalance: form.manualStartingBalance,
    to: form.manualTo,
  };
}

function rankSweepRows(rows) {
  return rows
    .slice()
    .sort((left, right) => right.score - left.score)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

function sizingAudit(trades = []) {
  const sizes = trades.map((trade) => Number(trade.size ?? 0)).filter((value) => value > 0);
  const leverages = trades.map((trade) => Number(trade.assumedLeverage ?? 0)).filter((value) => value > 0);
  const risks = trades.map((trade) => Number(trade.riskAmount ?? 0)).filter((value) => value > 0);

  return {
    averageLeverage: average(leverages),
    averageRisk: average(risks),
    averageSize: average(sizes),
    biggestExposure: sizes.length ? Math.max(...sizes) : 0,
    maxSize: sizes.length ? Math.max(...sizes) : 0,
    minSize: sizes.length ? Math.min(...sizes) : 0,
    note:
      sizes.length === 0
        ? "No position sizing data is available yet."
        : "ATR sizing changes position size when the SL distance changes. Fixed or percent sizing can look larger because it ignores the actual SL distance.",
  };
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function downloadText(fileName, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName.replace(/[^\w.-]+/g, "-");
  anchor.click();
  URL.revokeObjectURL(url);
}

function exportJson(fileName, value) {
  downloadText(fileName, JSON.stringify(value, null, 2), "application/json");
}

function exportCsv(fileName, trades = []) {
  const headers = ["entryTime", "direction", "entryPrice", "exitTime", "exitPrice", "netPnl", "exitReason"];
  const rows = trades.map((trade) =>
    headers
      .map((key) => JSON.stringify(trade[key] ?? trade[key === "netPnl" ? "pnl" : key] ?? ""))
      .join(","),
  );
  downloadText(fileName, [headers.join(","), ...rows].join("\n"), "text/csv");
}

function compactBacktestResult(result) {
  if (!result) return result;

  const { sourceCandles, ...rest } = result;

  return {
    ...rest,
    diagnosticEventCount: result.diagnosticEvents?.length ?? 0,
    diagnosticEvents: result.diagnosticEvents?.slice(-STORED_BACKTEST_EVENT_LIMIT) ?? [],
    diagnosticSummary: result.diagnosticSummary ?? {},
    eventCount: result.events?.length ?? 0,
    events: result.events?.slice(-STORED_BACKTEST_EVENT_LIMIT) ?? [],
    setupAuditCount: result.setupAudits?.length ?? 0,
    setupAudits: result.setupAudits?.slice(-STORED_BACKTEST_EVENT_LIMIT) ?? [],
  };
}

function renderedBacktestTradeCount(result, candles = []) {
  if (!result) return 0;
  const candleTimes = candles.length ? new Set(candles.map((candle) => candle.time)) : null;

  return (result.trades ?? [])
    .slice(-BACKTEST_CHART_TRADE_LIMIT)
    .filter((trade) => trade.entryTime && (!candleTimes || candleTimes.has(trade.entryTime)))
    .length;
}

function Help({ text }) {
  return (
    <span className="hubert-help" tabIndex="0" aria-label={text}>
      ?
    </span>
  );
}

function MiniStatus({ children, tone = "neutral" }) {
  return (
    <div className="hubert-mini-status" data-tone={tone}>
      {children}
    </div>
  );
}

export default function ControlCenter({
  activePanel,
  activeBacktestSession,
  backtestAnalysisActive,
  onApplyChart,
  onAnalyzeBacktest,
  onBacktestResult,
  onClearBacktest,
  onClose,
  onExitBacktestAnalysis,
  rawCandles,
  selectedInterval,
  setActivePanel,
  setSelectedInterval,
  settings,
  updateSetting,
}) {
  const [action, setAction] = useState({ key: "", message: "", state: "idle" });
  const [system, setSystem] = useState(null);
  const [strategyDecks, setStrategyDecks] = useState([]);
  const [mmDecks, setMmDecks] = useState([]);
  const [battleDecks, setBattleDecks] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [livestream, setLivestream] = useState({ accountSummary: {}, positions: [] });
  const [accountProfiles, setAccountProfiles] = useState([]);
  const [aiStatus, setAiStatus] = useState({
    configured: false,
    message: "Checking AI connection...",
    ok: false,
  });
  const [savedBacktests, setSavedBacktests] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [communication, setCommunication] = useState({ alertTypes: {}, enabled: false, telegramChatId: "" });
  const [aiContext, setAiContext] = useState({
    includeAnalytics: true,
    includeBacktests: true,
    includeDecks: true,
    includeErrors: true,
    includeLivePositions: true,
    includeSystemStatus: true,
  });
  const [aiMessages, setAiMessages] = useState([]);
  const [aiQuestion, setAiQuestion] = useState("");
  const [compareIds, setCompareIds] = useState([]);
  const [strategyForm, setStrategyForm] = useState({ ...defaultStrategyDeck, ...settings, name: "" });
  const [mmForm, setMmForm] = useState(defaultMmDeck);
  const [backtestForm, setBacktestForm] = useState(defaultBacktestForm);
  const [backtestResult, setBacktestResult] = useState(activeBacktestSession?.result ?? null);
  const [sweepForm, setSweepForm] = useState(defaultSweepForm);
  const [sweepProgress, setSweepProgress] = useState({
    completed: 0,
    message: "",
    running: false,
    total: 0,
  });
  const [sweepResults, setSweepResults] = useState([]);
  const sweepCancelRef = useRef(false);
  const [decision, setDecision] = useState({
    apiProfile: "main",
    battleName: "",
    mmDeckId: "",
    strategyDeckId: "",
    symbol: "SOLUSDT",
    timeframe: selectedInterval,
  });
  const [executionDeckId, setExecutionDeckId] = useState("");
  const [manualMessage, setManualMessage] = useState("");
  const [manualForm, setManualForm] = useState({
    quantity: "",
    stopPrice: "",
    symbol: "SOLUSDT",
    takeProfitPrice: "",
  });
  const [pendingManualAction, setPendingManualAction] = useState(null);

  const loadedDays = useMemo(
    () => daysFromCandles(rawCandles, selectedInterval),
    [rawCandles, selectedInterval],
  );
  const selectedStrategy = strategyDecks.find((deck) => deck.id === decision.strategyDeckId);
  const selectedMm = mmDecks.find((deck) => deck.id === decision.mmDeckId);
  const selectedBattleDeck = battleDecks.find((deck) => deck.id === executionDeckId) ?? battleDecks[0];
  const futuresBalance = hasKnownProfileBalance(accountProfiles)
    ? totalProfileBalance(accountProfiles)
    : Number(system?.state?.bingx?.activeExecutionBalance ?? 0);
  const decisionEstimate = useMemo(
    () => estimateDecision({ balance: futuresBalance, mmDeck: selectedMm, strategyDeck: selectedStrategy }),
    [futuresBalance, selectedMm, selectedStrategy],
  );
  const sweepPreview = useMemo(() => {
    const cap = Math.min(
      SWEEP_MAX_COMBINATIONS,
      Math.max(1, Number(sweepForm.maxCombinations) || SWEEP_MAX_COMBINATIONS),
    );

    try {
      const manualSweepForm = { ...sweepForm, mode: "manual" };
      const combinations = buildSweepCombinations({ baseDeck: null, baseMmDeck: null, form: manualSweepForm });
      return {
        cap,
        count: combinations.length,
        error: "",
        tooMany: combinations.length > cap,
      };
    } catch (error) {
      return {
        cap,
        count: 0,
        error: humanError(error),
        tooMany: false,
      };
    }
  }, [selectedInterval, sweepForm]);

  async function runAction(key, label, fn) {
    setAction({ key, message: `${label}...`, state: "loading" });

    try {
      const result = await fn();
      setAction({ key, message: `${label} done.`, state: "success" });
      window.setTimeout(() => setAction((current) => (current.key === key ? { key: "", message: "", state: "idle" } : current)), 1600);
      return result;
    } catch (error) {
      setAction({ key, message: humanError(error), state: "error" });
      return null;
    }
  }

  async function refreshAll() {
    const [
      nextSystem,
      nextLivestream,
      nextAccounts,
      nextStrategy,
      nextMm,
      nextBattle,
      nextFavorites,
      nextBacktests,
      nextAnalytics,
      nextCommunication,
      nextAiStatus,
    ] =
      await Promise.all([
        apiFetch("/system/status"),
        apiFetch("/livestream"),
        apiFetch("/accounts/profiles"),
        apiFetch("/decks/strategy"),
        apiFetch("/decks/mm"),
        apiFetch("/decks/battle"),
        apiFetch("/favorites"),
        apiFetch("/backtests"),
        apiFetch("/analytics"),
        apiFetch("/communication/settings"),
        apiFetch("/ai/status"),
      ]);
    setSystem(nextSystem);
    setLivestream(nextLivestream);
    setAccountProfiles(nextAccounts);
    setStrategyDecks(nextStrategy);
    setMmDecks(nextMm);
    setBattleDecks(nextBattle);
    setFavorites(nextFavorites);
    setSavedBacktests(nextBacktests.map(compactBacktestResult));
    setAnalytics(nextAnalytics);
    setCommunication(nextCommunication);
    setAiStatus(nextAiStatus);
    if (!executionDeckId && nextBattle[0]) setExecutionDeckId(nextBattle[0].id);
  }

  useEffect(() => {
    runAction("initial-load", "Sync platform", refreshAll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setBacktestResult(activeBacktestSession?.result ?? null);
  }, [activeBacktestSession?.id, activeBacktestSession?.result]);

  async function saveCollectionItem(collection, item, shouldRefresh = true) {
    const route = collectionRoutes[collection];
    const hasId = Boolean(item.id);
    const saved = await apiFetch(hasId ? `${route}/${encodeURIComponent(item.id)}` : route, {
      body: item,
      method: hasId ? "PUT" : "POST",
    });
    if (shouldRefresh) {
      await refreshAll();
    }
    return saved;
  }

  async function deleteCollectionItem(collection, item) {
    const route = collectionRoutes[collection];
    await apiFetch(`${route}/${encodeURIComponent(item.id)}`, { method: "DELETE" });
    await refreshAll();
  }

  async function addFavorite(category, item) {
    if (!item?.id) return null;
    const favorite = {
      category,
      createdAt: new Date().toISOString(),
      id: `fav-${category}-${item.id}`,
      itemId: item.id,
      name: item.name,
      shortDescription: item.symbol ? `${item.symbol} ${item.timeframe ?? ""}` : category,
    };
    const saved = await saveCollectionItem("favorites", favorite, false);
    return saved;
  }

  async function saveAndFavorite(collection, category, item) {
    const saved = await saveCollectionItem(collection, item, false);
    await addFavorite(category, saved);
    await refreshAll();
    return saved;
  }

  async function renameFavorite(favorite) {
    const name = window.prompt("New favorite name", favorite.name);
    if (!name?.trim()) return null;
    return saveCollectionItem("favorites", { ...favorite, name: name.trim() });
  }

  function prepareCrisisAction(position, action) {
    setManualForm((current) => ({
      ...current,
      apiProfile: position.apiProfile ?? "main",
      quantity: position.quantity ? Number(position.quantity).toFixed(3) : current.quantity,
      stopPrice: position.stopLoss ?? current.stopPrice,
      symbol: position.symbol ?? current.symbol ?? "SOLUSDT",
      takeProfitPrice: position.takeProfit ?? current.takeProfitPrice,
    }));
    setPendingManualAction(action);
    setActivePanel("Crisis");
    if (!action) {
      runAction("crisis-on-from-live", "Crisis ON", async () => {
        await apiFetch("/execution/crisis/on", { method: "POST" });
        await refreshAll();
      });
    }
  }

  function openFavorite(favorite) {
    if (favorite.category === "Strategy Decks") {
      const deck = strategyDecks.find((item) => item.id === favorite.itemId);
      if (deck) setStrategyForm(deck);
      setActivePanel("Strategy Decks");
      return;
    }

    if (favorite.category === "MM Decks") {
      const deck = mmDecks.find((item) => item.id === favorite.itemId);
      if (deck) setMmForm(deck);
      setActivePanel("MM Decks");
      return;
    }

    if (favorite.category === "Battle Decks") {
      const deck = battleDecks.find((item) => item.id === favorite.itemId);
      if (deck) setExecutionDeckId(deck.id);
      setActivePanel("Battle Decks");
      return;
    }

    if (favorite.category === "Backtests") {
      const result = savedBacktests.find((item) => item.id === favorite.itemId);
      if (result) {
        setBacktestResult(result);
        onBacktestResult(result);
      }
      setActivePanel("Backtests");
    }
  }

  function applyDeckToChart(deck) {
    const next = strategyToSettings(deck, settings);
    Object.entries(next).forEach(([key, value]) => updateSetting(key, value));
    setSelectedInterval(deck.timeframe ?? selectedInterval);
    onApplyChart(next);
  }

  function runBrowserBacktest(overrides = {}) {
    const form = normalizeBacktestForm({ ...backtestForm, ...(overrides.form ?? {}) });
    const rawDeck = overrides.strategyDeck ?? strategyDecks.find((item) => item.id === form.strategyDeckId) ?? strategyDecks[0];
    if (!rawDeck) throw new Error("Create or choose a Strategy Deck first.");
    const deck = normalizeStrategyDeck(rawDeck);
    const rawMmDeck =
      Object.hasOwn(overrides, "mmDeck")
        ? overrides.mmDeck
        : form.mmDeckId
          ? mmDecks.find((item) => item.id === form.mmDeckId)
          : null;
    const mmDeck = rawMmDeck ? normalizeMmDeck(rawMmDeck) : null;
    const candles = overrides.candles ?? filterCandlesByBacktestForm(rawCandles, form);
    if (candles.length < 550) {
      throw new Error("Not enough candles are loaded for this backtest. Request more history days or use a larger timeframe.");
    }
    const result = runBacktest({
      backtestConfig: {
        commissionPercent: Number(form.commissionPercent),
        atrPositionSizing: deck.atrPositionSizing,
        mmDeck,
        slippagePercent: Number(form.slippagePercent),
        startingBalance: Number(form.startingBalance),
      },
      rawCandles: candles,
      settings: strategyToSettings(deck, settings),
    });
    const analysisRange = rangeFromBacktestCandles(candles);
    const analysisSettings = strategyToSettings(deck, settings);
    const named = compactBacktestResult({
      ...result,
      analysisRange,
      analysisSettings,
      createdAt: new Date().toISOString(),
      id: `backtest-${Date.now()}`,
      mmDeckId: mmDeck?.id ?? "",
      mmDeckName: mmDeck?.name ?? "No MM deck",
      name: overrides.name ?? (form.name || `${deck.name} ${new Date().toLocaleDateString()}`),
      sweepParams: overrides.sweepParams ?? null,
      strategyDeckId: deck.id,
      strategyDeckName: deck.name,
      timeframe: overrides.timeframe ?? selectedInterval,
    });
    setBacktestResult(named);
    onBacktestResult(named, {
      candles,
      mmDeckName: mmDeck?.name ?? "No MM deck",
      range: analysisRange,
      settings: analysisSettings,
      strategyDeckName: deck.name,
      timeframe: overrides.timeframe ?? selectedInterval,
    });
    return named;
  }

  function buildSweepCombinations({ baseDeck, baseMmDeck, form }) {
    const combinations = [];
    const manualMode = true;

    if (manualMode) {
      if (form.manualSymbol.trim().toUpperCase() !== "SOLUSDT") {
        throw new Error("Manual Sweep currently uses loaded SOLUSDT candles. Use SOLUSDT or load another symbol first.");
      }

      if (form.manualTimeframe !== selectedInterval) {
        throw new Error(`Manual Sweep uses currently loaded ${selectedInterval} candles. Change the chart timeframe to ${form.manualTimeframe} first, or choose ${selectedInterval}.`);
      }

      const failures = parseSweepNumberList(form.manualMaxSameSideFailures, "Max same-side failures", { integer: true, min: 0 });
      const atrLengths = parseSweepNumberList(form.manualAtrLengths, "ATR length values", { integer: true, positive: true });
      const atrMultipliers = parseSweepNumberList(form.manualAtrMultipliers, "ATR multiplier values", { positive: true });
      const envelopeMultipliers = parseSweepNumberList(form.manualEnvelopeMultipliers, "NWE multiplier values", { positive: true });
      const bandwidths = parseSweepNumberList(form.manualBandwidths, "Bandwidth values", { positive: true });
      const sizing = manualSweepSizeValues(form);

      failures.forEach((maxSameSideFailures) => {
        atrLengths.forEach((atrLength) => {
          atrMultipliers.forEach((atrMultiplier) => {
            envelopeMultipliers.forEach((envelopeMultiplier) => {
              bandwidths.forEach((bandwidth) => {
                sizing.values.forEach((sizeValue) => {
                  const strategyDeck = {
                    ...defaultStrategyDeck,
                    atrLength,
                    atrMultiplier,
                    atrPositionSizing: sizing.atrPositionSizing,
                    bandwidth,
                    envelopeMultiplier,
                    id: "manual-sweep-strategy",
                    maxSameSideFailures,
                    name: "Manual Sweep Strategy",
                    strategySource: form.manualStrategySource,
                    symbol: form.manualSymbol.trim().toUpperCase(),
                    timeframe: form.manualTimeframe,
                  };
                  const mmDeck = makeManualMmDeck(sizing.key, sizeValue);

                  combinations.push({
                    mmDeck,
                    params: {
                      atrLength,
                      atrMultiplier,
                      atrPositionSizing: sizing.atrPositionSizing,
                      bandwidth,
                      envelopeMultiplier,
                      maxSameSideFailures,
                      mode: "manual",
                      sizeKey: sizing.key,
                      sizeLabel: sweepSizeLabel(sizing.key),
                      sizeValue,
                      source: form.manualStrategySource,
                      symbol: form.manualSymbol.trim().toUpperCase(),
                      timeframe: form.manualTimeframe,
                    },
                    strategyDeck,
                  });
                });
              });
            });
          });
        });
      });

      return combinations;
    }

    const failures = parseOptionalSweepNumberList(
      form.maxSameSideFailures,
      [Number(baseDeck.maxSameSideFailures ?? defaultStrategyDeck.maxSameSideFailures)],
      "Max same-side failures",
      { integer: true, min: 0 },
    );
    const atrLengths = parseOptionalSweepNumberList(
      form.atrLengths,
      [Number(baseDeck.atrLength ?? defaultStrategyDeck.atrLength)],
      "ATR length values",
      { integer: true, positive: true },
    );
    const atrMultipliers = parseOptionalSweepNumberList(
      form.atrMultipliers,
      [Number(baseDeck.atrMultiplier ?? defaultStrategyDeck.atrMultiplier)],
      "ATR multiplier values",
      { positive: true },
    );
    const envelopeMultipliers = parseOptionalSweepNumberList(
      form.envelopeMultipliers,
      [Number(baseDeck.envelopeMultiplier ?? defaultStrategyDeck.envelopeMultiplier)],
      "NWE multiplier values",
      { positive: true },
    );
    const bandwidths = parseOptionalSweepNumberList(
      form.bandwidths,
      [Number(baseDeck.bandwidth ?? defaultStrategyDeck.bandwidth)],
      "Bandwidth values",
      { positive: true },
    );
    const atrSizingValues = sweepAtrSizingValues(form.atrPositionSizing, baseDeck.atrPositionSizing);

    failures.forEach((maxSameSideFailures) => {
      atrLengths.forEach((atrLength) => {
        atrMultipliers.forEach((atrMultiplier) => {
          envelopeMultipliers.forEach((envelopeMultiplier) => {
            bandwidths.forEach((bandwidth) => {
              atrSizingValues.forEach((atrPositionSizing) => {
                const sizeKey = sweepSizeKey(baseMmDeck, atrPositionSizing);
                const sizeValues = sweepSizeValuesForKey(form, baseMmDeck, sizeKey);

                sizeValues.forEach((sizeValue) => {
                  const strategyDeck = {
                    ...baseDeck,
                    atrLength,
                    atrMultiplier,
                    atrPositionSizing,
                    bandwidth,
                    envelopeMultiplier,
                    maxSameSideFailures,
                  };
                  const mmDeck = baseMmDeck
                    ? {
                        ...baseMmDeck,
                        ...(sizeKey ? { [sizeKey]: sizeValue } : {}),
                      }
                    : null;

                  combinations.push({
                    mmDeck,
                    params: {
                      atrLength,
                      atrMultiplier,
                      atrPositionSizing,
                      bandwidth,
                      envelopeMultiplier,
                      maxSameSideFailures,
                      mode: "base",
                      sizeKey,
                      sizeLabel: sweepSizeLabel(sizeKey),
                      sizeValue,
                      source: baseDeck.strategySource,
                      symbol: baseDeck.symbol ?? "SOLUSDT",
                      timeframe: selectedInterval,
                    },
                    strategyDeck,
                  });
                });
              });
            });
          });
        });
      });
    });

    return combinations;
  }

  async function runSweepBacktest() {
    const manualSweepForm = { ...sweepForm, mode: "manual" };
    const form = normalizeBacktestForm(sweepRangeForm(backtestForm, manualSweepForm));
    const candles = filterCandlesByBacktestForm(rawCandles, form);
    if (candles.length < 550) {
      throw new Error("Not enough candles are loaded for this sweep. Request more history days or use a larger timeframe.");
    }

    const combinations = buildSweepCombinations({ baseDeck: null, baseMmDeck: null, form: manualSweepForm });
    const cap = Math.min(
      SWEEP_MAX_COMBINATIONS,
      Math.max(1, Number(sweepForm.maxCombinations) || SWEEP_MAX_COMBINATIONS),
    );

    if (combinations.length > cap) {
      throw new Error(`${combinations.length} combinations requested. Narrow the ranges or keep the sweep at ${cap} combinations or fewer.`);
    }

    sweepCancelRef.current = false;
    setSweepResults([]);
    setSweepProgress({
      completed: 0,
      message: `Running 0 / ${combinations.length}`,
      running: true,
      total: combinations.length,
    });

    const rows = [];
    const analysisRange = rangeFromBacktestCandles(candles);

    for (let index = 0; index < combinations.length; index += 1) {
      if (sweepCancelRef.current) {
        break;
      }

      const combination = combinations[index];
      const result = runBacktest({
        backtestConfig: {
          commissionPercent: Number(form.commissionPercent),
          atrPositionSizing: combination.strategyDeck.atrPositionSizing,
          mmDeck: combination.mmDeck,
          slippagePercent: Number(form.slippagePercent),
          startingBalance: Number(form.startingBalance),
        },
        rawCandles: candles,
        settings: strategyToSettings(combination.strategyDeck, settings),
      });
      const metrics = result.metrics;
      const row = {
        ...combination,
        analysisRange,
        averageTrade: metrics.averageTrade,
        bestTrade: metrics.largestWin,
        id: `sweep-${Date.now()}-${index}`,
        longResult: sidePnl(result.trades, "LONG"),
        maxDrawdown: metrics.maxDrawdown,
        netProfit: metrics.netProfit,
        netProfitPercent: Number(form.startingBalance) > 0
          ? (metrics.netProfit / Number(form.startingBalance)) * 100
          : 0,
        profitFactor: metrics.profitFactor,
        rangeForm: form,
        score: sweepScore(metrics, Number(form.startingBalance)),
        shortResult: sidePnl(result.trades, "SHORT"),
        totalTrades: metrics.totalTrades,
        winRate: metrics.winRate,
        worstTrade: metrics.largestLoss,
        expectancy: metrics.expectancy,
      };
      rows.push(row);

      if ((index + 1) % 4 === 0 || index === combinations.length - 1) {
        setSweepResults(rankSweepRows(rows));
        setSweepProgress({
          completed: index + 1,
          message: `Running ${index + 1} / ${combinations.length}`,
          running: true,
          total: combinations.length,
        });
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    }

    const ranked = rankSweepRows(rows);
    setSweepResults(ranked);
    setSweepProgress({
      completed: rows.length,
      message: sweepCancelRef.current ? `Cancelled at ${rows.length} / ${combinations.length}` : `Completed ${rows.length} combinations`,
      running: false,
      total: combinations.length,
    });
    return ranked;
  }

  function cancelSweepBacktest() {
    sweepCancelRef.current = true;
    setSweepProgress((current) => ({
      ...current,
      message: "Cancelling sweep...",
    }));
  }

  function openSweepResult(row) {
    if (!row) throw new Error("Choose a sweep result first.");
    setBacktestForm((current) => ({
      ...current,
      mmDeckId: row.mmDeck?.id ?? "",
      name: `Sweep #${row.rank} ${row.strategyDeck.name}`,
      strategyDeckId: row.strategyDeck.id,
    }));
    return runBrowserBacktest({
      form: row.rangeForm,
      mmDeck: row.mmDeck,
      name: `Sweep #${row.rank} ${row.strategyDeck.name}`,
      strategyDeck: row.strategyDeck,
      sweepParams: row.params,
      timeframe: row.params?.timeframe,
    });
  }

  async function saveBacktest(result = backtestResult) {
    if (!result) throw new Error("Run a backtest first.");
    if (!result.name) throw new Error("Name this backtest before saving it.");
    const saved = await saveAndFavorite("backtests", "Backtests", compactBacktestResult(result));
    setBacktestResult(saved);
  }

  async function createBattleDeck() {
    if (!decision.battleName.trim()) throw new Error("Name this Battle Deck first.");
    if (!selectedStrategy) throw new Error("Choose a Strategy Deck first.");
    if (!selectedMm) throw new Error("Choose an MM Deck first.");
    const strategySnapshot = normalizeStrategyDeck(selectedStrategy);
    const mmSnapshot = normalizeMmDeck(selectedMm);
    const battleDeck = {
      accountLabel: decision.apiProfile === "main" ? "Main Account" : decision.apiProfile,
      accountType: decision.apiProfile === "main" ? "main" : "subaccount",
      apiProfile: decision.apiProfile,
      createdAt: new Date().toISOString(),
      estimate: decisionEstimate,
      mmDeckId: mmSnapshot.id,
      mmSnapshot,
      name: decision.battleName,
      readiness: decisionEstimate.ready ? "ready" : "needs attention",
      status: "inactive",
      strategyDeckId: strategySnapshot.id,
      strategySnapshot,
      symbol: decision.symbol,
      timeframe: decision.timeframe,
    };
    const saved = await saveAndFavorite("battleDecks", "Battle Decks", battleDeck);
    setExecutionDeckId(saved.id);
  }

  const panel = activePanel === "Indicators" ? "Indicator" : activePanel;

  return (
    <aside className="hubert-lab hubert-lab--wide" aria-label="Choromanski control center">
      <div className="hubert-lab__header">
        <div>
          <strong>Choromański Control Center</strong>
          <span>{BACKEND_URL} · {system?.state ? "backend online" : "syncing"}</span>
        </div>
        <button type="button" onClick={onClose}>Close</button>
      </div>

      <div className="hubert-control-tabs">
        {PANEL_TABS.map((tab) => (
          <button
            data-active={panel === tab}
            key={tab}
            onClick={() => setActivePanel(tab)}
            type="button"
          >
            {tab}
          </button>
        ))}
      </div>

      {action.message && (
        <MiniStatus tone={action.state === "error" ? "bad" : action.state === "success" ? "good" : "neutral"}>
          {action.message}
        </MiniStatus>
      )}

      {panel === "System" && (
        <SystemPanel
          accountProfiles={accountProfiles}
          backendUrl={BACKEND_URL}
          rawCandles={rawCandles}
          runAction={runAction}
          selectedInterval={selectedInterval}
          system={system}
          onRefresh={refreshAll}
        />
      )}

      {panel === "Livestream" && (
        <LivestreamPanel
          accountProfiles={accountProfiles}
          livestream={livestream}
          onRefresh={() => runAction("refresh-live", "Refresh live stream", refreshAll)}
          onPositionAction={prepareCrisisAction}
        />
      )}

      {panel === "Indicator" && (
        <IndicatorPanel
          loadedDays={loadedDays}
          rawCandles={rawCandles}
          selectedInterval={selectedInterval}
          settings={settings}
          updateSetting={updateSetting}
        />
      )}

      {panel === "Strategy Decks" && (
        <StrategyDecksPanel
          favorites={favorites}
          form={strategyForm}
          setForm={setStrategyForm}
          decks={strategyDecks}
          onApplyChart={applyDeckToChart}
          onDelete={(deck) => runAction(`delete-${deck.id}`, "Delete deck", () => deleteCollectionItem("strategyDecks", deck))}
          onDuplicate={(deck) => setStrategyForm({ ...deck, id: undefined, name: `${deck.name} Copy` })}
          onEdit={setStrategyForm}
          onFavorite={(deck) => runAction(`fav-${deck.id}`, "Add favorite", () => addFavorite("Strategy Decks", deck))}
          onSave={() => runAction("save-strategy", "Save Strategy Deck", () => saveAndFavorite("strategyDecks", "Strategy Decks", normalizeStrategyDeck(strategyForm)))}
        />
      )}

      {panel === "Backtests" && (
        <BacktestsPanel
          analysisActive={backtestAnalysisActive}
          analysisSession={activeBacktestSession}
          favorites={favorites}
          form={backtestForm}
          mmDecks={mmDecks}
          result={backtestResult}
          savedBacktests={savedBacktests}
          setForm={setBacktestForm}
          strategyDecks={strategyDecks}
          sweepForm={sweepForm}
          sweepPreview={sweepPreview}
          sweepProgress={sweepProgress}
          sweepResults={sweepResults}
          setSweepForm={setSweepForm}
          onCancelSweep={() => runAction("cancel-sweep", "Cancel sweep", async () => cancelSweepBacktest())}
          onDelete={(item) => runAction(`delete-backtest-${item.id}`, "Delete backtest", () => deleteCollectionItem("backtests", item))}
          onFavorite={(item) => runAction(`fav-backtest-${item.id}`, "Add favorite", () => addFavorite("Backtests", item))}
          onHide={(item) => runAction(`hide-backtest-${item.id}`, "Hide backtest", () => saveCollectionItem("backtests", { ...item, hidden: true }))}
          onAnalyze={() => runAction("analyze-backtest", "Analyze on Chart", onAnalyzeBacktest)}
          onClear={() => runAction("clear-backtest", "Clear result", async () => {
            setBacktestResult(null);
            onClearBacktest();
          })}
          onExitAnalysis={() => runAction("exit-backtest-analysis", "Exit analysis", async () => {
            setBacktestResult(null);
            onExitBacktestAnalysis();
          })}
          onOpenSweepResult={(row) => runAction(`open-sweep-${row.id}`, "Open sweep result", async () => openSweepResult(row))}
          onRun={() => runAction("run-backtest", "Run backtest", async () => runBrowserBacktest())}
          onRunSweep={() => runAction("run-sweep", "Run sweep", async () => runSweepBacktest())}
          onSave={() => runAction("save-backtest", "Save backtest", () => saveBacktest())}
        />
      )}

      {panel === "Compare" && (
        <BacktestComparePanel
          compareIds={compareIds}
          favorites={favorites}
          savedBacktests={savedBacktests}
          setCompareIds={setCompareIds}
        />
      )}

      {panel === "MM Decks" && (
        <MmDecksPanel
          decks={mmDecks}
          favorites={favorites}
          form={mmForm}
          setForm={setMmForm}
          onDelete={(deck) => runAction(`delete-mm-${deck.id}`, "Delete MM deck", () => deleteCollectionItem("mmDecks", deck))}
          onDuplicate={(deck) => setMmForm({ ...deck, id: undefined, name: `${deck.name} Copy` })}
          onEdit={setMmForm}
          onFavorite={(deck) => runAction(`fav-mm-${deck.id}`, "Add favorite", () => addFavorite("MM Decks", deck))}
          onSave={() => runAction("save-mm", "Save MM Deck", () => saveAndFavorite("mmDecks", "MM Decks", normalizeMmDeck(mmForm)))}
        />
      )}

      {panel === "Decision" && (
        <DecisionPanel
          accountProfiles={accountProfiles}
          decision={decision}
          estimate={decisionEstimate}
          mmDecks={mmDecks}
          setDecision={setDecision}
          strategyDecks={strategyDecks}
          onCreate={() => runAction("create-battle", "Create Battle Deck", createBattleDeck)}
        />
      )}

      {panel === "Battle Decks" && (
        <BattleDecksPanel
          decks={battleDecks}
          onDelete={(deck) => runAction(`delete-battle-${deck.id}`, "Delete Battle Deck", () => deleteCollectionItem("battleDecks", deck))}
          onDuplicate={(deck) => runAction(`dup-battle-${deck.id}`, "Duplicate Battle Deck", () => saveCollectionItem("battleDecks", { ...deck, id: undefined, name: `${deck.name} Copy`, status: "inactive" }))}
          onFavorite={(deck) => runAction(`fav-battle-${deck.id}`, "Add favorite", () => addFavorite("Battle Decks", deck))}
          onSend={(deck) => {
            setExecutionDeckId(deck.id);
            setActivePanel("Execution");
          }}
        />
      )}

      {panel === "Execution" && (
        <ExecutionPanel
          accountProfiles={accountProfiles}
          battleDecks={battleDecks}
          executionDeckId={executionDeckId}
          rawCandles={rawCandles}
          selectedBattleDeck={selectedBattleDeck}
          setExecutionDeckId={setExecutionDeckId}
          setActivePanel={setActivePanel}
          status={system}
          onAction={(path, label, body = {}) =>
            runAction(label, label, async () => {
              const result = await apiFetch(path, { body, method: "POST" });
              await refreshAll();
              return result;
            })
          }
        />
      )}

      {panel === "Crisis" && (
        <CrisisPanel
          form={manualForm}
          livestream={livestream}
          message={manualMessage}
          pendingAction={pendingManualAction}
          setForm={setManualForm}
          setMessage={setManualMessage}
          setPendingAction={setPendingManualAction}
          symbol={selectedBattleDeck?.symbol ?? decision.symbol}
          onCrisisOff={() => runAction("crisis-off", "Crisis OFF", () => apiFetch("/execution/crisis/off", { method: "POST" }).then(refreshAll))}
          onCrisisOn={() => runAction("crisis-on", "Crisis ON", () => apiFetch("/execution/crisis/on", { method: "POST" }).then(refreshAll))}
          onManualAction={(body) =>
            runAction(`manual-${body.action}`, "Send manual action", async () => {
              const result = await apiFetch("/manual/action", { body, method: "POST" });
              setManualMessage(result.message);
              setPendingManualAction(null);
              await refreshAll();
            })
          }
        />
      )}

      {panel === "Analytics" && <AnalyticsPanel analytics={analytics} />}

      {panel === "Communication" && (
        <CommunicationPanel
          communication={communication}
          setCommunication={setCommunication}
          onSave={() => runAction("save-communication", "Save alerts", async () => {
            const saved = await apiFetch("/communication/settings", { body: communication, method: "PUT" });
            setCommunication(saved);
          })}
          onTest={() => runAction("test-communication", "Send test alert", () => apiFetch("/communication/test", { method: "POST" }))}
        />
      )}

      {panel === "AI" && (
        <AiPanel
          aiStatus={aiStatus}
          aiContext={aiContext}
          messages={aiMessages}
          question={aiQuestion}
          setAiContext={setAiContext}
          setMessages={setAiMessages}
          setQuestion={setAiQuestion}
          onAsk={() =>
            runAction("ask-ai", "Ask AI", async () => {
              if (!aiQuestion.trim()) throw new Error("Ask a question first.");
              const userMessage = { role: "user", text: aiQuestion.trim(), time: new Date().toISOString() };
              setAiMessages((current) => [...current, userMessage]);
              setAiQuestion("");
              const result = await apiFetch("/ai/chat", {
                body: { context: aiContext, message: userMessage.text },
                method: "POST",
              });
              setAiMessages((current) => [
                ...current,
                {
                  role: "assistant",
                  text: result.message,
                  time: new Date().toISOString(),
                },
              ]);
            })
          }
        />
      )}

      {panel === "Favorites" && (
        <FavoritesPanel
          favorites={favorites}
          onDelete={(favorite) => runAction(`delete-fav-${favorite.id}`, "Remove favorite", () => deleteCollectionItem("favorites", favorite))}
          onOpen={openFavorite}
          onRename={(favorite) => runAction(`rename-fav-${favorite.id}`, "Rename favorite", () => renameFavorite(favorite))}
        />
      )}
    </aside>
  );
}

function estimateDecision({ balance, mmDeck, strategyDeck }) {
  if (!strategyDeck || !mmDeck) {
    return {
      lines: ["Choose one Strategy Deck and one MM Deck."],
      ready: false,
    };
  }

  const safeBalance = Number(balance || 0);
  const riskPercent = Number(mmDeck.oneSlPercent ?? 1);
  const positionPercent = Number(mmDeck.positionPercent ?? mmDeck.onePercentMovePercent ?? 10);
  const notional =
    mmDeck.mode === "constant"
      ? Number(mmDeck.fixedNotional ?? 0)
      : strategyDeck.atrPositionSizing
        ? safeBalance * riskPercent
        : safeBalance * (positionPercent / 100);
  const leverage = safeBalance > 0 && notional > 0 ? Math.max(1, Math.ceil(notional / safeBalance)) : 0;
  const margin = leverage > 0 ? notional / leverage : 0;
  const ready = safeBalance > 0 && notional > 0;
  const lossText = strategyDeck.atrPositionSizing
    ? `If the SL is 1% away, estimated loss at SL is ${fmt(safeBalance * riskPercent / 100)} USDT.`
    : `A 1% move against this position is about ${fmt(notional * 0.01)} USDT.`;

  return {
    leverage,
    lines: [
      `Estimated position: ${fmt(notional)} USDT.`,
      `Estimated margin: ${fmt(margin)} USDT.`,
      `Required leverage: about ${fmt(leverage, 1)}x.`,
      lossText,
      ready ? "Status: ready." : "Status: connect BingX futures balance before live execution.",
    ],
    margin,
    notional,
    ready,
  };
}

function SystemPanel({ accountProfiles, backendUrl, rawCandles, runAction, selectedInterval, system, onRefresh }) {
  const status = system?.state ?? {};
  const bingx = status.bingx ?? {};
  const hasSystemBalance = bingx.activeExecutionBalance !== null &&
    bingx.activeExecutionBalance !== undefined &&
    Number.isFinite(Number(bingx.activeExecutionBalance));
  const futuresBalance = hasKnownProfileBalance(accountProfiles)
    ? totalProfileBalance(accountProfiles)
    : Number(bingx.activeExecutionBalance ?? 0);
  const diagnostic = [
    "Choromanski Diagnostic Snapshot",
    `Frontend: online`,
    `Backend URL: ${backendUrl}`,
    `Backend: ${system ? "online" : "offline"}`,
    `Bot: ${displayBotStatus(status.botStatus)}`,
    `BingX keys: ${bingx.apiConfigured ? "configured" : "not configured"}`,
    `Futures balance: ${fmt(futuresBalance)} USDT`,
    `Chart interval: ${selectedInterval}`,
    `Loaded candles: ${rawCandles.length}`,
    `Last candle: ${dateText(rawCandles.at(-1)?.time)}`,
  ].join("\n");

  return (
    <section className="hubert-lab__section">
      <div className="hubert-lab__actions">
        <button type="button" onClick={() => runAction("refresh-system", "Refresh status", onRefresh)}>Refresh Status</button>
        <button
          type="button"
          onClick={() =>
            runAction("test-bingx", "Test BingX", async () => {
              await apiFetch("/bingx/test", { method: "POST" });
              await onRefresh();
            })
          }
        >
          Test BingX
        </button>
        <button
          type="button"
          onClick={() =>
            runAction("copy-diagnostic", "Copy diagnostic", () => navigator.clipboard?.writeText(diagnostic))
          }
        >
          Copy Diagnostic Snapshot
        </button>
      </div>

      <div className="hubert-lab__metrics">
        <Metric label="Frontend" value="Online" />
        <Metric label="Backend" value={system ? "Online" : "Syncing"} />
        <Metric label="Bot" value={displayBotStatus(status.botStatus)} />
        <Metric label="BingX" value={system ? (bingx.apiConfigured ? "Keys ready" : "No keys") : "Checking"} />
        <Metric label="Futures USDT" value={hasKnownProfileBalance(accountProfiles) || hasSystemBalance ? fmt(futuresBalance) : "Syncing"} />
        <Metric label="BingX sync" value={dateText(bingx.lastSyncAt)} />
        <Metric label="Backend uptime" value={system?.summary?.uptimeSeconds ? `${Math.floor(system.summary.uptimeSeconds / 60)} min` : "--"} />
        <Metric label="Open orders" value={system?.summary?.openOrdersCount ?? 0} />
        <Metric label="Active Battle Deck" value={system?.summary?.activeBattleDeck?.name ?? "None"} />
      </div>

      <div className="hubert-lab__subhead"><strong>API Profiles</strong><span>{accountProfiles.length}</span></div>
      <div className="hubert-lab__table">
        <table>
          <thead>
            <tr><th>Profile</th><th>Status</th><th>Futures USDT</th><th>Positions</th><th>Orders</th><th>Last sync</th></tr>
          </thead>
          <tbody>
            {accountProfiles.map((profile) => (
              <tr key={profile.id}>
                <td>{profile.label}</td>
                <td>{profile.status}</td>
                <td>{profileBalanceText(profile)}</td>
                <td>{profile.openPositions}</td>
                <td>{profile.openOrders}</td>
                <td>{dateText(profile.lastSyncAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="hubert-lab__table">
        <table>
          <thead>
            <tr><th>Timeframe</th><th>Candles</th><th>Days</th><th>First</th><th>Last</th></tr>
          </thead>
          <tbody>
            {(system?.dataAvailability ?? []).map((row) => (
              <tr key={row.interval}>
                <td>{row.label}</td>
                <td>{row.candles}</td>
                <td>{fmt(row.availableDays, 0)}</td>
                <td>{dateText(row.firstCandleTime)}</td>
                <td>{dateText(row.lastCandleTime)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <MiniStatus>
        Data availability uses the configured safe candle limits. If a timeframe reaches its limit, more history can be added by raising max candles or connecting an external data source.
      </MiniStatus>
    </section>
  );
}

function LivestreamPanel({ accountProfiles = [], livestream, onPositionAction, onRefresh }) {
  const summary = livestream?.accountSummary ?? {};
  const positions = livestream?.positions ?? [];
  const profileRows = accountProfiles.length ? accountProfiles : (summary.apiProfiles ?? []);
  const hasProfileBalance = hasKnownProfileBalance(profileRows);
  const combinedBalance = hasProfileBalance
    ? totalProfileBalance(profileRows)
    : Number(summary.totalCombinedFuturesBalance ?? 0);
  const hasSummaryBalance = summary.totalCombinedFuturesBalance !== null &&
    summary.totalCombinedFuturesBalance !== undefined &&
    Number.isFinite(Number(summary.totalCombinedFuturesBalance));

  return (
    <section className="hubert-lab__section">
      <div className="hubert-lab__actions">
        <button type="button" onClick={onRefresh}>Refresh Live</button>
      </div>
      <div className="hubert-lab__metrics">
        <Metric label="Futures balance" value={hasProfileBalance || hasSummaryBalance ? fmt(combinedBalance) : "Syncing"} />
        <Metric label="Unrealized PnL" value={fmt(summary.totalUnrealizedPnl ?? 0)} />
        <Metric label="Session PnL" value={fmt(summary.totalRealizedSessionPnl ?? 0)} />
        <Metric label="Margin used" value={fmt(summary.totalMarginUsed ?? 0)} />
        <Metric label="Open notional" value={fmt(summary.totalOpenNotional ?? 0)} />
        <Metric label="Open positions" value={summary.totalOpenPositions ?? 0} />
      </div>
      <MiniStatus>Last refresh: {dateText(summary.lastRefreshAt)}</MiniStatus>
      {profileRows.length > 0 && (
        <div className="hubert-lab__table">
          <table>
            <thead>
              <tr><th>Account</th><th>Status</th><th>Futures USDT</th><th>Positions</th><th>Orders</th></tr>
            </thead>
            <tbody>
              {profileRows.map((profile) => (
                <tr key={profile.id}>
                  <td>{profile.label}</td>
                  <td>{profile.status}</td>
                  <td>{profileBalanceText(profile)}</td>
                  <td>{profile.openPositions ?? 0}</td>
                  <td>{profile.openOrders ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {positions.length === 0 ? (
        <MiniStatus>No live positions are open right now.</MiniStatus>
      ) : (
        <div className="hubert-live-stack">
          {positions.map((position) => (
            <div className="hubert-live-card" key={`${position.symbol}-${position.side}-${position.apiProfile}`}>
              <div className="hubert-live-card__head">
                <strong>{position.symbol} {position.side}</strong>
                <span>{position.battleDeckName ?? "Manual"} · {position.timeframe ?? "--"} · {position.apiProfile}</span>
              </div>
              <div className="hubert-lab__metrics">
                <Metric label="Strategy" value={position.strategyDeckName ?? "--"} />
                <Metric label="MM" value={position.mmDeckName ?? "--"} />
                <Metric label="Entry" value={fmt(position.entryPrice)} />
                <Metric label="Mark" value={fmt(position.currentPrice)} />
                <Metric label="Quantity" value={fmt(position.quantity, 3)} />
                <Metric label="Notional" value={fmt(position.notionalSize)} />
                <Metric label="Margin" value={fmt(position.marginUsed)} />
                <Metric label="Leverage" value={position.leverage ? `${fmt(position.leverage, 1)}x` : "--"} />
                <Metric label="SL" value={fmt(position.stopLoss)} />
                <Metric label="TP" value={fmt(position.takeProfit)} />
                <Metric label="PnL" value={`${fmt(position.unrealizedPnl)} / ${fmt(position.pnlPercent)}%`} />
                <Metric label="Distance to SL" value={position.distanceToSl ? `${fmt(position.distanceToSl)} (${fmt(position.distanceToSlPercent)}%)` : "--"} />
                <Metric label="Distance to TP" value={position.distanceToTp ? `${fmt(position.distanceToTp)} (${fmt(position.distanceToTpPercent)}%)` : "--"} />
                <Metric label="Duration" value={position.durationSeconds ? `${Math.floor(position.durationSeconds / 60)} min` : "--"} />
                <Metric label="Priority" value={position.botPriority === "manual" ? "Manual" : "Bot"} />
                <Metric label="Last action" value={position.lastAction ?? "--"} />
              </div>
              <OrderTable orders={position.attachedOrders ?? []} />
              <div className="hubert-lab__actions">
                <button type="button" onClick={() => onPositionAction(position, "CLOSE_POSITION")}>Close Position</button>
                <button type="button" onClick={() => onPositionAction(position, "MOVE_SL")}>Move SL</button>
                <button type="button" onClick={() => onPositionAction(position, "MOVE_TP")}>Move TP</button>
                <button type="button" onClick={() => onPositionAction(position, "CANCEL_ATTACHED_ORDERS")}>Cancel Orders</button>
                <button type="button" onClick={() => onPositionAction(position, null)}>Crisis Control</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function IndicatorPanel({ loadedDays, rawCandles, selectedInterval, settings, updateSetting }) {
  const requestedDays = Number(settings.historyDays ?? loadedDays);
  const usedDays = Math.min(requestedDays, loadedDays);

  return (
    <section className="hubert-lab__section">
      <MiniStatus>
        Requested {fmt(requestedDays, 0)} days, available about {fmt(loadedDays, 0)} days. Using {fmt(usedDays, 0)} days.
      </MiniStatus>
      <div className="hubert-lab__grid">
        <NumberField commitEmpty={false} label="History days" value={settings.historyDays ?? 31} min="1" max="1000" onChange={(value) => updateSetting("historyDays", value)} help="Choose time in days. The platform converts it into candles for this timeframe." />
        <ReadOnly label="Loaded candles" value={`${rawCandles.length} on ${selectedInterval}`} />
        <NumberField commitEmpty={false} label="Bandwidth" value={settings.bandwidth} step="0.5" onChange={(value) => updateSetting("bandwidth", value)} />
        <NumberField commitEmpty={false} label="NWE multiplier" value={settings.envelopeMultiplier} step="0.1" onChange={(value) => updateSetting("envelopeMultiplier", value)} />
        <NumberField commitEmpty={false} label="ATR length" value={settings.atrLength} step="1" onChange={(value) => updateSetting("atrLength", value)} />
        <NumberField commitEmpty={false} label="ATR multiplier" value={settings.atrMultiplier} step="0.1" onChange={(value) => updateSetting("atrMultiplier", value)} />
        <NumberField commitEmpty={false} label="Max same-side failures" value={settings.maxSameSideFailures} step="1" onChange={(value) => updateSetting("maxSameSideFailures", value)} />
        <label>
          <span>Strategy source <Help text="Pine HA parity uses Heikin Ashi values like the TradingView reference." /></span>
          <select value={settings.strategySource} onChange={(event) => updateSetting("strategySource", event.target.value)}>
            <option value="pine-ha">Pine HA parity</option>
            <option value="raw-exchange">Raw exchange</option>
          </select>
        </label>
      </div>
      <ToggleGrid
        values={settings}
        onChange={updateSetting}
        items={[
          ["showBands", "Bands"],
          ["showEntries", "Confirmed entries"],
          ["showBenchmarks", "Diagnostic setups"],
          ["showNegated", "Negated setups"],
          ["showSl", "SL lines"],
          ["showTrigger", "Trigger lines"],
        ]}
      />
    </section>
  );
}

function StrategyDecksPanel({ decks, favorites, form, onApplyChart, onDelete, onDuplicate, onEdit, onFavorite, onSave, setForm }) {
  const favoriteDecks = favorites
    .filter((favorite) => favorite.category === "Strategy Decks")
    .map((favorite) => decks.find((deck) => deck.id === favorite.itemId))
    .filter(Boolean);

  return (
    <section className="hubert-lab__section">
      <div className="hubert-lab__subhead">
        <strong>Strategy Deck Builder</strong>
        <button type="button" disabled={decks.length >= 100} onClick={() => setForm(defaultStrategyDeck)}>
          Create New Strategy Deck
        </button>
      </div>
      {decks.length >= 100 && <MiniStatus tone="bad">You have 100 strategy decks. Delete or archive one before creating a new deck.</MiniStatus>}
      <MiniStatus>Saving a deck adds it to Favorites. Favorites is the main library.</MiniStatus>
      {favoriteDecks.length > 0 && (
        <CompactOpenRow
          items={favoriteDecks}
          label="Open favorite"
          onOpen={onEdit}
        />
      )}
      <DeckEditor title="Strategy Deck Editor" form={form} onSave={onSave}>
        <TextField label="Deck name" value={form.name} onChange={(value) => setForm({ ...form, name: value })} />
        <TextField label="Symbol" value={form.symbol} onChange={(value) => setForm({ ...form, symbol: value.toUpperCase() })} />
        <SelectField label="Timeframe" value={form.timeframe} onChange={(value) => setForm({ ...form, timeframe: value })} options={TIMEFRAMES.map((item) => [item.interval, item.label])} />
        <NumberField label="Bandwidth" value={form.bandwidth} step="0.5" onChange={(value) => setForm({ ...form, bandwidth: value })} />
        <NumberField label="NWE multiplier" value={form.envelopeMultiplier} step="0.1" onChange={(value) => setForm({ ...form, envelopeMultiplier: value })} />
        <NumberField label="ATR length" value={form.atrLength} step="1" onChange={(value) => setForm({ ...form, atrLength: value })} />
        <NumberField label="ATR multiplier" value={form.atrMultiplier} step="0.1" onChange={(value) => setForm({ ...form, atrMultiplier: value })} />
        <NumberField label="Max same-side failures" value={form.maxSameSideFailures} step="1" onChange={(value) => setForm({ ...form, maxSameSideFailures: value })} />
        <ToggleGrid
          values={form}
          onChange={(key, value) => setForm({ ...form, [key]: value })}
          items={[
            ["confirmedEntries", "Confirmed entries"],
            ["diagnosticSetups", "Diagnostic setups"],
            ["negatedSetups", "Negated setups"],
            ["triggerLines", "Trigger lines"],
            ["slLines", "SL lines"],
            ["allowLong", "Allow long"],
            ["allowShort", "Allow short"],
            ["atrPositionSizing", "ATR position sizing"],
          ]}
        />
        {form.id && (
          <div className="hubert-lab__actions">
            <button type="button" onClick={() => onApplyChart(form)}>Apply to Chart</button>
            <button type="button" onClick={() => onDuplicate(form)}>Duplicate</button>
            <button type="button" onClick={() => onFavorite(form)}>Favorite</button>
            <button type="button" onClick={() => onDelete(form)}>Delete</button>
          </div>
        )}
      </DeckEditor>
    </section>
  );
}

function BacktestsPanel({
  analysisActive,
  analysisSession,
  favorites,
  form,
  mmDecks,
  onAnalyze,
  onCancelSweep,
  onClear,
  onDelete,
  onExitAnalysis,
  onFavorite,
  onHide,
  onOpenSweepResult,
  onRun,
  onRunSweep,
  onSave,
  result,
  savedBacktests,
  setForm,
  setSweepForm,
  strategyDecks,
  sweepForm,
  sweepPreview,
  sweepProgress,
  sweepResults,
}) {
  const [mode, setMode] = useState("single");
  const favoriteBacktests = favorites
    .filter((favorite) => favorite.category === "Backtests")
    .map((favorite) => savedBacktests.find((item) => item.id === favorite.itemId))
    .filter(Boolean);
  const tableTradeCount = result?.trades?.length ?? 0;
  const renderedTrades = renderedBacktestTradeCount(result, analysisSession?.candles);
  const hasTradeRenderMismatch = result && renderedTrades !== tableTradeCount;

  return (
    <section className="hubert-lab__section">
      <MiniStatus>Saved backtests automatically go to Favorites. Use this panel for the current run.</MiniStatus>
      <div className="hubert-lab__actions">
        <button type="button" data-active={mode === "single"} onClick={() => setMode("single")}>Single Backtest</button>
        <button type="button" data-active={mode === "sweep"} onClick={() => setMode("sweep")}>Sweep</button>
      </div>
      {mode === "single" ? (
        <>
          <div className="hubert-lab__grid">
            <TextField label="Backtest name" value={form.name} onChange={(value) => setForm({ ...form, name: value })} />
            <SelectField label="Strategy Deck" value={form.strategyDeckId || strategyDecks[0]?.id || ""} onChange={(value) => setForm({ ...form, strategyDeckId: value })} options={strategyDecks.map((deck) => [deck.id, deck.name])} />
            <SelectField label="MM Deck" value={form.mmDeckId} onChange={(value) => setForm({ ...form, mmDeckId: value })} options={mmDecks.map((deck) => [deck.id, deck.name])} />
            <NumberField label="Last X days" value={form.lastDays} min="1" onChange={(value) => setForm({ ...form, lastDays: value })} />
            <NumberField label="Starting balance" value={form.startingBalance} onChange={(value) => setForm({ ...form, startingBalance: value })} />
            <NumberField label="Commission %" value={form.commissionPercent} step="0.01" onChange={(value) => setForm({ ...form, commissionPercent: value })} />
            <NumberField label="Slippage %" value={form.slippagePercent} step="0.01" onChange={(value) => setForm({ ...form, slippagePercent: value })} />
          </div>
          <div className="hubert-lab__actions">
            <button type="button" onClick={onRun}>Run Backtest</button>
            <button type="button" onClick={onSave}>Name & Save</button>
          </div>
          {result && (
            <div className="hubert-analysis-card">
              <div>
                <strong>{analysisActive ? "Backtest Analysis Mode is active" : "Backtest result is ready"}</strong>
                <span>
                  {analysisSession?.strategyDeckName ?? result.strategyDeckName ?? "Strategy Deck"} · {analysisSession?.timeframe ?? result.timeframe ?? "--"} · {dateText((analysisSession?.range ?? result.analysisRange)?.from)} → {dateText((analysisSession?.range ?? result.analysisRange)?.to)}
                </span>
                <span>
                  Trades in table: {tableTradeCount} · rendered on chart: {renderedTrades}
                </span>
                {hasTradeRenderMismatch && (
                  <span className="hubert-analysis-card__warning">
                    Chart markers are capped for speed; use the table for the full record.
                  </span>
                )}
              </div>
              <div className="hubert-lab__actions">
                <button type="button" onClick={onAnalyze}>Analyze on Chart</button>
                <button type="button" onClick={onExitAnalysis}>Exit Analysis</button>
                <button type="button" onClick={onClear}>Clear Result</button>
              </div>
            </div>
          )}
          <BacktestResult result={result} />
        </>
      ) : (
        <BacktestSweepPanel
          progress={sweepProgress}
          preview={sweepPreview}
          results={sweepResults}
          form={sweepForm}
          setForm={setSweepForm}
          onCancel={onCancelSweep}
          onOpenResult={(row) => {
            const result = onOpenSweepResult(row);
            setMode("single");
            return result;
          }}
          onRun={onRunSweep}
        />
      )}
      {favoriteBacktests.length > 0 && (
        <>
          <div className="hubert-lab__subhead"><strong>Favorite Backtests</strong><span>{favoriteBacktests.length}</span></div>
          <DeckList
            decks={favoriteBacktests.slice(0, 4)}
            extra={(item) => <button type="button" onClick={() => onHide(item)}>Hide</button>}
            onDelete={onDelete}
            onFavorite={onFavorite}
          />
        </>
      )}
    </section>
  );
}

function BacktestSweepPanel({
  form,
  onCancel,
  onOpenResult,
  onRun,
  preview,
  progress,
  results,
  setForm,
}) {
  const previewTone = preview?.error || preview?.tooMany ? "bad" : "neutral";

  return (
    <section className="hubert-lab__section">
      <MiniStatus>
        Manual Sweep runs many explicit parameter sets without drawing chart overlays. Score = net profit % - max drawdown + trade-count bonus + profit-factor bonus.
      </MiniStatus>
      <MiniStatus>Manual Sweep ignores saved Strategy/MM Deck values. It uses the currently loaded chart candles and the explicit fields below.</MiniStatus>
      <div className="hubert-lab__subhead"><strong>Market</strong><span>loaded data</span></div>
      <div className="hubert-lab__grid">
        <TextField label="Symbol" value={form.manualSymbol} onChange={(value) => setForm({ ...form, manualSymbol: value })} />
        <SelectField label="Timeframe" value={form.manualTimeframe} onChange={(value) => setForm({ ...form, manualTimeframe: value })} options={TIMEFRAMES.map((item) => [item.interval, item.label])} />
        <NumberField label="Last X days" min="1" value={form.manualLastDays} onChange={(value) => setForm({ ...form, manualLastDays: value })} />
        <NumberField label="Starting balance" min="1" value={form.manualStartingBalance} onChange={(value) => setForm({ ...form, manualStartingBalance: value })} />
        <TextField label="From date/time" value={form.manualFrom} onChange={(value) => setForm({ ...form, manualFrom: value })} />
        <TextField label="To date/time" value={form.manualTo} onChange={(value) => setForm({ ...form, manualTo: value })} />
      </div>
      <div className="hubert-lab__subhead"><strong>Strategy Parameters</strong><span>all explicit</span></div>
      <div className="hubert-lab__grid">
        <TextField label="Bandwidth values" value={form.manualBandwidths} onChange={(value) => setForm({ ...form, manualBandwidths: value })} />
        <TextField label="NWE multiplier values" value={form.manualEnvelopeMultipliers} onChange={(value) => setForm({ ...form, manualEnvelopeMultipliers: value })} />
        <TextField label="ATR length values" value={form.manualAtrLengths} onChange={(value) => setForm({ ...form, manualAtrLengths: value })} />
        <TextField label="ATR multiplier values" value={form.manualAtrMultipliers} onChange={(value) => setForm({ ...form, manualAtrMultipliers: value })} />
        <TextField label="Max failures values" value={form.manualMaxSameSideFailures} onChange={(value) => setForm({ ...form, manualMaxSameSideFailures: value })} />
        <SelectField
          label="Strategy source"
          value={form.manualStrategySource}
          onChange={(value) => setForm({ ...form, manualStrategySource: value })}
          options={[
            ["pine-ha", "Pine HA parity"],
            ["raw-exchange", "Raw exchange"],
          ]}
        />
      </div>
      <MiniStatus>Confirmed entries is visual only, so it is not part of sweep math.</MiniStatus>
      <div className="hubert-lab__subhead"><strong>Money Management</strong><span>one sizing mode</span></div>
      <div className="hubert-lab__grid">
        <SelectField
          label="Sizing mode"
          value={form.manualSizingMode}
          onChange={(value) => setForm({ ...form, manualSizingMode: value })}
          options={[
            ["run-risk", "RUN risk per SL"],
            ["run-position", "RUN position % equity"],
            ["constant", "CONSTANT fixed USDT"],
          ]}
        />
        {form.manualSizingMode === "run-risk" && (
          <TextField label="Risk per SL hit values (%)" value={form.manualRiskValues} onChange={(value) => setForm({ ...form, manualRiskValues: value })} />
        )}
        {form.manualSizingMode === "run-position" && (
          <TextField label="Position size values (% equity)" value={form.manualPositionValues} onChange={(value) => setForm({ ...form, manualPositionValues: value })} />
        )}
        {form.manualSizingMode === "constant" && (
          <TextField label="Fixed notional values (USDT)" value={form.manualFixedNotionalValues} onChange={(value) => setForm({ ...form, manualFixedNotionalValues: value })} />
        )}
      </div>
      <MiniStatus>{manualSweepSizingText(form.manualSizingMode)}</MiniStatus>
      <div className="hubert-lab__grid">
        <NumberField label="Max combinations" max={String(SWEEP_MAX_COMBINATIONS)} min="1" value={form.maxCombinations} onChange={(value) => setForm({ ...form, maxCombinations: value })} />
      </div>
      <MiniStatus tone={previewTone}>
        {preview?.error
          ? preview.error
          : `Combinations ready: ${preview?.count ?? 0} / ${preview?.cap ?? SWEEP_MAX_COMBINATIONS}${preview?.tooMany ? ". Narrow ranges before running." : "."}`}
      </MiniStatus>
      <div className="hubert-lab__actions">
        <button disabled={progress.running || preview?.tooMany || Boolean(preview?.error)} type="button" onClick={onRun}>Run Sweep</button>
        <button disabled={!progress.running} type="button" onClick={onCancel}>Cancel</button>
        <span>{progress.message || "Ready"} {progress.total ? `· ${progress.completed}/${progress.total}` : ""}</span>
      </div>
      <SweepResultTable onOpenResult={onOpenResult} results={results} />
    </section>
  );
}

function manualSweepSizingText(mode) {
  if (mode === "run-risk") {
    return "RUN risk per SL sizes each position so an SL hit targets the selected % of current equity.";
  }

  if (mode === "run-position") {
    return "RUN position % equity uses the selected % of current equity as position notional.";
  }

  return "CONSTANT fixed USDT uses the same notional size for every trade.";
}

function sweepSizingShortText(row) {
  const params = row.params ?? {};
  const value = params.sizeValue === null || params.sizeValue === undefined
    ? ""
    : ` ${fmt(params.sizeValue, 2)}`;

  if (params.sizeKey === "oneSlPercent") return `Risk${value}%`;
  if (params.sizeKey === "positionPercent") return `Pos${value}%`;
  if (params.sizeKey === "fixedNotional") return `Fixed${value}`;
  return "Default";
}

function sweepParamDetails(row) {
  const params = row.params ?? {};
  const symbol = `${params.symbol ?? "SOLUSDT"} ${params.timeframe ?? ""}`.trim();
  return `${symbol} · source ${params.source ?? "default"} · ATR length ${params.atrLength ?? "--"} · ${params.sizeLabel ?? "Sizing"} ${params.sizeValue ?? "--"}`;
}

function SweepResultTable({ onOpenResult, results }) {
  if (!results?.length) {
    return <MiniStatus>No sweep results yet. Run a sweep to rank parameter sets.</MiniStatus>;
  }

  return (
    <div className="hubert-lab__table hubert-lab__table--sweep">
      <table>
        <thead>
          <tr>
            <th>Rank</th>
            <th>Score</th>
            <th>Net profit</th>
            <th>Max DD</th>
            <th>PF</th>
            <th>Win rate</th>
            <th>Trades</th>
            <th>Max failures</th>
            <th>ATR mult</th>
            <th>NWE</th>
            <th>BW</th>
            <th>Sizing</th>
            <th>Open</th>
          </tr>
        </thead>
        <tbody>
          {results.slice(0, 30).map((row) => (
            <tr key={row.id}>
              <td>{row.rank}</td>
              <td>{fmt(row.score)}</td>
              <td>{fmt(row.netProfit)}</td>
              <td>{fmt(row.maxDrawdown)}%</td>
              <td>{fmt(row.profitFactor)}</td>
              <td>{fmt(row.winRate)}%</td>
              <td>{row.totalTrades}</td>
              <td>{row.params?.maxSameSideFailures ?? "--"}</td>
              <td>{fmt(row.params?.atrMultiplier, 2)}</td>
              <td>{fmt(row.params?.envelopeMultiplier, 2)}</td>
              <td>{fmt(row.params?.bandwidth, 2)}</td>
              <td className="hubert-sweep-params" title={sweepParamDetails(row)}>{sweepSizingShortText(row)}</td>
              <td><button className="hubert-sweep-open" type="button" onClick={() => onOpenResult(row)}>Open</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {results.length > 30 && (
        <MiniStatus>Showing top 30 of {results.length} combinations. Narrow the range if you want a smaller comparison.</MiniStatus>
      )}
    </div>
  );
}

function BacktestComparePanel({ compareIds, favorites, savedBacktests, setCompareIds }) {
  const favoriteBacktests = favorites
    .filter((favorite) => favorite.category === "Backtests")
    .map((favorite) => savedBacktests.find((item) => item.id === favorite.itemId))
    .filter(Boolean);
  const selected = compareIds
    .map((id) => savedBacktests.find((item) => item.id === id))
    .filter(Boolean)
    .slice(0, 4);
  const explanation = compareExplanation(selected);

  function toggle(id) {
    setCompareIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : current.length >= 4
          ? current
          : [...current, id],
    );
  }

  return (
    <section className="hubert-lab__section">
      <MiniStatus>Select 2-4 favorite backtests.</MiniStatus>
      <div className="hubert-lab__toggles">
        {favoriteBacktests.map((test) => (
          <label key={test.id}>
            <input checked={compareIds.includes(test.id)} type="checkbox" onChange={() => toggle(test.id)} />
            <span>{test.name}</span>
          </label>
        ))}
      </div>
      {selected.length < 2 ? (
        <MiniStatus>Choose at least two saved favorite backtests to compare.</MiniStatus>
      ) : (
        <>
          <MiniStatus>{explanation}</MiniStatus>
          <MultiCurveChart title="Equity Curves" results={selected} curveKey="equity" />
          <MultiCurveChart title="Drawdown Curves" results={selected} curveKey="drawdown" />
          <div className="hubert-lab__table">
            <table>
              <thead>
                <tr><th>Backtest</th><th>Net</th><th>Net %</th><th>DD</th><th>PF</th><th>Win</th><th>Trades</th><th>Avg</th><th>Best</th><th>Worst</th></tr>
              </thead>
              <tbody>
                {selected.map((test) => {
                  const metrics = test.metrics ?? {};
                  const netPercent = metrics.startingBalance ? metrics.netProfit / metrics.startingBalance * 100 : (metrics.netProfit / (test.config?.startingBalance ?? 10000)) * 100;
                  return (
                    <tr key={test.id}>
                      <td>{test.name}</td>
                      <td>{fmt(metrics.netProfit)}</td>
                      <td>{fmt(netPercent)}%</td>
                      <td>{fmt(metrics.maxDrawdown)}%</td>
                      <td>{fmt(metrics.profitFactor)}</td>
                      <td>{fmt(metrics.winRate)}%</td>
                      <td>{metrics.totalTrades ?? 0}</td>
                      <td>{fmt(metrics.averageTrade)}</td>
                      <td>{fmt(metrics.largestWin)}</td>
                      <td>{fmt(metrics.largestLoss)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function compareExplanation(results) {
  if (results.length < 2) return "Select backtests to compare.";
  const byProfit = [...results].sort((a, b) => Number(b.metrics?.netProfit ?? 0) - Number(a.metrics?.netProfit ?? 0));
  const byDrawdown = [...results].sort((a, b) => Number(a.metrics?.maxDrawdown ?? Infinity) - Number(b.metrics?.maxDrawdown ?? Infinity));
  return `${byProfit[0].name} earns more, while ${byDrawdown[0].name} has the lower drawdown. Use both numbers together, not one alone.`;
}

function MultiCurveChart({ curveKey, results, title }) {
  const colors = ["#050505", "#5c5c5c", "#ffffff", "rgba(120,24,24,0.82)"];
  const polylines = useMemo(
    () =>
      results.map((result, index) => ({
        color: colors[index % colors.length],
        id: result.id,
        name: result.name,
        points: curveKey === "drawdown" ? drawdownPolyline(result.equityCurve) : equityPolyline(result.equityCurve),
      })),
    [curveKey, results],
  );

  return (
    <div className="hubert-chart-box">
      <strong>{title}</strong>
      <span>{curveKey === "drawdown" ? "Higher line means deeper drawdown." : "Higher line means higher equity."}</span>
      <svg className="hubert-lab__equity" viewBox="0 0 100 100" preserveAspectRatio="none">
        {polylines.map((line) => (
          <polyline
            key={line.id}
            points={line.points}
            stroke={line.color}
            style={{ stroke: line.color }}
          />
        ))}
      </svg>
      <div className="hubert-chart-legend">
        {polylines.map((line) => (
          <span key={line.id}><b style={{ background: line.color }} />{line.name}</span>
        ))}
      </div>
    </div>
  );
}

function MmDecksPanel({ decks, favorites, form, onDelete, onDuplicate, onEdit, onFavorite, onSave, setForm }) {
  const favoriteDecks = favorites
    .filter((favorite) => favorite.category === "MM Decks")
    .map((favorite) => decks.find((deck) => deck.id === favorite.itemId))
    .filter(Boolean);

  return (
    <section className="hubert-lab__section">
      <div className="hubert-lab__subhead">
        <strong>MM Deck Builder</strong>
        <button type="button" disabled={decks.length >= 100} onClick={() => setForm(defaultMmDeck)}>Create New MM Deck</button>
      </div>
      {decks.length >= 100 && <MiniStatus tone="bad">You have 100 MM decks. Delete or archive one before creating a new deck.</MiniStatus>}
      <MiniStatus>Saving an MM deck adds it to Favorites. Keep this panel focused on editing.</MiniStatus>
      {favoriteDecks.length > 0 && (
        <CompactOpenRow items={favoriteDecks} label="Open favorite" onOpen={onEdit} />
      )}
      <DeckEditor title="MM Deck Editor" form={form} onSave={onSave}>
        <TextField label="MM deck name" value={form.name} onChange={(value) => setForm({ ...form, name: value })} />
        <SelectField label="Mode" value={form.mode} onChange={(value) => setForm({ ...form, mode: value })} options={[["run", "Run"], ["constant", "Constant"]]} />
        {form.mode === "run" ? (
          <>
            <NumberField label="Risk per SL hit = % equity" value={form.oneSlPercent} step="0.1" onChange={(value) => setForm({ ...form, oneSlPercent: value })} help="Used when the Strategy Deck has ATR position sizing ON." />
            <NumberField label="Position size = % equity" value={form.positionPercent ?? 10} step="1" onChange={(value) => setForm({ ...form, positionPercent: value })} help="Used when the Strategy Deck has ATR position sizing OFF." />
          </>
        ) : (
          <NumberField label="Every trade = USDT" value={form.fixedNotional} step="10" onChange={(value) => setForm({ ...form, fixedNotional: value })} />
        )}
        {form.id && (
          <div className="hubert-lab__actions">
            <button type="button" onClick={() => onDuplicate(form)}>Duplicate</button>
            <button type="button" onClick={() => onFavorite(form)}>Favorite</button>
            <button type="button" onClick={() => onDelete(form)}>Delete</button>
          </div>
        )}
      </DeckEditor>
    </section>
  );
}

function DecisionPanel({ accountProfiles, decision, estimate, mmDecks, onCreate, setDecision, strategyDecks }) {
  const strategy = strategyDecks.find((deck) => deck.id === decision.strategyDeckId);
  const mm = mmDecks.find((deck) => deck.id === decision.mmDeckId);
  const selectedProfile = accountProfiles.find((profile) => profile.id === decision.apiProfile);

  return (
    <section className="hubert-lab__section">
      <div className="hubert-lab__grid">
        <TextField label="Battle Deck name" value={decision.battleName} onChange={(value) => setDecision({ ...decision, battleName: value })} />
        <SelectField label="Strategy Deck" value={decision.strategyDeckId} onChange={(value) => setDecision({ ...decision, strategyDeckId: value })} options={strategyDecks.map((deck) => [deck.id, deck.name])} />
        <SelectField label="MM Deck" value={decision.mmDeckId} onChange={(value) => setDecision({ ...decision, mmDeckId: value })} options={mmDecks.map((deck) => [deck.id, deck.name])} />
        <TextField label="Symbol" value={decision.symbol} onChange={(value) => setDecision({ ...decision, symbol: value.toUpperCase() })} />
        <SelectField label="Timeframe" value={decision.timeframe} onChange={(value) => setDecision({ ...decision, timeframe: value })} options={TIMEFRAMES.map((item) => [item.interval, item.label])} />
        <SelectField label="API profile" value={decision.apiProfile} onChange={(value) => setDecision({ ...decision, apiProfile: value })} options={(accountProfiles.length ? accountProfiles : [{ id: "main", label: "Main Account" }]).map((profile) => [profile.id, profile.label])} />
      </div>
      <MiniStatus tone={estimate.ready ? "good" : "bad"}>
        You selected {strategy?.name ?? "no Strategy Deck"} and {mm?.name ?? "no MM Deck"} for {decision.symbol} {decision.timeframe}.
      </MiniStatus>
      <div className="hubert-decision-lines">
        {estimate.lines.map((line) => <span key={line}>{line}</span>)}
      </div>
      <MiniStatus>
        {(selectedProfile?.status ?? "Profile status unknown")} · Balance {selectedProfile ? profileBalanceText(selectedProfile) : "Syncing"} USDT.
      </MiniStatus>
      <MiniStatus>Recommended: use separate subaccount/API for each active interval on the same symbol to avoid position conflicts.</MiniStatus>
      <div className="hubert-lab__actions">
        <button type="button" onClick={onCreate}>Create Battle Deck</button>
      </div>
    </section>
  );
}

function BattleDecksPanel({ decks, onDelete, onDuplicate, onFavorite, onSend }) {
  return (
    <section className="hubert-lab__section">
      <div className="hubert-lab__subhead"><strong>Battle Decks</strong><span>{decks.length}/100</span></div>
      <DeckList
        decks={decks}
        onDelete={onDelete}
        onDuplicate={onDuplicate}
        onFavorite={onFavorite}
        extra={(deck) => <button type="button" onClick={() => onSend(deck)}>Send to Execution</button>}
      />
    </section>
  );
}

function ExecutionPanel({ accountProfiles, battleDecks, executionDeckId, onAction, rawCandles, selectedBattleDeck, setActivePanel, setExecutionDeckId, status }) {
  const state = status?.state ?? {};
  const bingx = state.bingx ?? {};
  const selectedProfile =
    accountProfiles.find((profile) => profile.id === (selectedBattleDeck?.apiProfile ?? "main")) ??
    accountProfiles[0];
  const executionBalance = Number(selectedProfile?.futuresBalance ?? bingx.activeExecutionBalance ?? 0);
  const ready = Boolean(selectedBattleDeck && bingx.apiConfigured && executionBalance > 0 && status);
  const exchangePosition = status?.summary?.openPosition ?? bingx.openPositions?.[0] ?? null;
  const openOrders = bingx.openOrders ?? [];
  const currentPrice = rawCandles.at(-1)?.close;

  return (
    <section className="hubert-lab__section">
      <div className="hubert-lab__grid">
        <SelectField label="Battle Deck" value={executionDeckId || selectedBattleDeck?.id || ""} onChange={setExecutionDeckId} options={battleDecks.map((deck) => [deck.id, deck.name])} />
        <ReadOnly label="Readiness" value={ready ? "Ready" : "Needs attention"} />
      </div>
      <MiniStatus tone={ready ? "good" : "bad"}>
        {ready ? `Ready to run ${selectedBattleDeck.name} on BingX.` : "Choose a Battle Deck, confirm BingX balance, and keep backend online before starting."}
      </MiniStatus>
      <div className="hubert-lab__metrics">
        <Metric label="Bot status" value={displayBotStatus(state.botStatus)} />
        <Metric label="Active deck" value={selectedBattleDeck?.name ?? "--"} />
        <Metric label="API profile" value={selectedBattleDeck?.apiProfile ?? "--"} />
        <Metric label="Current price" value={fmt(currentPrice)} />
        <Metric label="Futures balance" value={fmt(executionBalance)} />
        <Metric label="Position" value={exchangePosition ? `${exchangePosition.symbol ?? selectedBattleDeck?.symbol} ${exchangePosition.positionSide ?? exchangePosition.side ?? ""}` : "None"} />
        <Metric label="Open orders" value={openOrders.length} />
        <Metric label="Last signal" value={state.lastStrategySignal?.direction ?? "--"} />
        <Metric label="Last action" value={state.lastExecutionDecision ?? "--"} />
      </div>
      <div className="hubert-lab__actions hubert-lab__actions--sticky">
        <button disabled={!ready} type="button" onClick={() => onAction("/execution/start", "Start Bot", { battleDeckId: selectedBattleDeck?.id, confirm: "START_LIVE" })}>Start Bot</button>
        <button type="button" onClick={() => setActivePanel("Livestream")}>Open Livestream</button>
        <button type="button" onClick={() => onAction("/execution/pause", "Pause Bot")}>Pause Bot</button>
        <button type="button" onClick={() => onAction("/execution/resume", "Resume Bot")}>Resume Bot</button>
        <button type="button" onClick={() => onAction("/execution/stop", "Stop Bot")}>Stop Bot</button>
        <button type="button" onClick={() => onAction("/execution/emergency-stop", "Emergency Stop")}>Emergency Stop</button>
        <button type="button" onClick={() => onAction(state.crisisMode ? "/execution/crisis/off" : "/execution/crisis/on", state.crisisMode ? "Crisis OFF" : "Crisis ON")}>Crisis {state.crisisMode ? "OFF" : "ON"}</button>
      </div>
      <OrderTable orders={openOrders} />
      <LogList logs={status?.logs ?? []} />
    </section>
  );
}

function CrisisPanel({
  form,
  livestream,
  message,
  onCrisisOff,
  onCrisisOn,
  onManualAction,
  pendingAction,
  setForm,
  setMessage,
  setPendingAction,
  symbol,
}) {
  const positions = livestream?.positions ?? [];
  const activePosition = positions.find((position) => compact(position.symbol) === compact(form.symbol || symbol)) ?? positions[0];
  const actions = [
    ["MARKET_LONG", "Market Long", "Sends a real market long with the quantity below."],
    ["MARKET_SHORT", "Market Short", "Sends a real market short with the quantity below."],
    ["MOVE_SL", "Move SL", "Places a new stop-loss order for the open BingX position."],
    ["MOVE_TP", "Move TP", "Places a new take-profit order for the open BingX position."],
    ["CLOSE_POSITION", "Close Position", "Requests BingX to close the full symbol position."],
    ["CLOSE_PARTIAL", "Close Partial", "Sends a reduce-only market order for the quantity below."],
    ["CANCEL_ALL", "Cancel All Orders", "Cancels open orders for this symbol."],
  ];

  function chooseAction(action) {
    setMessage("");
    setPendingAction(action);
    setForm((current) => ({ ...current, symbol: current.symbol || symbol || "SOLUSDT" }));
  }

  function confirmAction() {
    if (!pendingAction) return;
    onManualAction({
      action: pendingAction,
      apiProfile: form.apiProfile ?? activePosition?.apiProfile ?? "main",
      quantity: Number(form.quantity),
      stopPrice: Number(form.stopPrice),
      symbol: form.symbol || symbol || "SOLUSDT",
      takeProfitPrice: Number(form.takeProfitPrice),
    });
  }

  return (
    <section className="hubert-lab__section">
      <MiniStatus>Crisis Management ON gives manual control priority. New bot entries stay blocked while you act.</MiniStatus>
      {activePosition ? (
        <div className="hubert-live-card">
          <div className="hubert-live-card__head">
            <strong>{activePosition.symbol} {activePosition.side}</strong>
            <span>{activePosition.battleDeckName ?? "Exchange position"} · {activePosition.apiProfile}</span>
          </div>
          <div className="hubert-lab__metrics">
            <Metric label="Entry" value={fmt(activePosition.entryPrice)} />
            <Metric label="Mark" value={fmt(activePosition.currentPrice)} />
            <Metric label="Quantity" value={fmt(activePosition.quantity, 3)} />
            <Metric label="PnL" value={fmt(activePosition.unrealizedPnl)} />
            <Metric label="SL" value={fmt(activePosition.stopLoss)} />
            <Metric label="TP" value={fmt(activePosition.takeProfit)} />
          </div>
          <OrderTable orders={activePosition.attachedOrders ?? []} />
        </div>
      ) : (
        <MiniStatus>No live position is currently reported. Manual open actions still require a symbol and quantity.</MiniStatus>
      )}
      <div className="hubert-lab__actions">
        <button type="button" onClick={onCrisisOn}>Crisis Management ON</button>
        <button type="button" onClick={onCrisisOff}>Crisis Management OFF</button>
      </div>
      <div className="hubert-lab__grid">
        <TextField label="Symbol" value={form.symbol || symbol || "SOLUSDT"} onChange={(value) => setForm({ ...form, symbol: value.toUpperCase() })} />
        <NumberField label="Quantity" value={form.quantity} step="0.001" onChange={(value) => setForm({ ...form, quantity: value })} />
        <NumberField label="New SL price" value={form.stopPrice} step="0.01" onChange={(value) => setForm({ ...form, stopPrice: value })} />
        <NumberField label="New TP price" value={form.takeProfitPrice} step="0.01" onChange={(value) => setForm({ ...form, takeProfitPrice: value })} />
      </div>
      <div className="hubert-manual-grid">
        {actions.map(([action, label, help]) => (
          <button
            data-active={pendingAction === action}
            key={action}
            title={help}
            type="button"
            onClick={() => chooseAction(action)}
          >
            {label}
          </button>
        ))}
      </div>
      {pendingAction && (
        <div className="hubert-confirm-strip">
          <span>{actions.find(([action]) => action === pendingAction)?.[2]}</span>
          <button type="button" onClick={confirmAction}>Confirm Send</button>
          <button type="button" onClick={() => setPendingAction(null)}>Cancel</button>
        </div>
      )}
      {message && <MiniStatus>{message}</MiniStatus>}
    </section>
  );
}

function AnalyticsPanel({ analytics }) {
  const summary = analytics?.summary ?? {};

  return (
    <section className="hubert-lab__section">
      <div className="hubert-lab__metrics">
        <Metric label="Total PnL" value={fmt(summary.totalPnl ?? 0)} />
        <Metric label="Win rate" value={`${fmt(summary.winRate ?? 0)}%`} />
        <Metric label="Profit factor" value={fmt(summary.profitFactor ?? 0)} />
        <Metric label="Total trades" value={summary.totalTrades ?? 0} />
        <Metric label="Best trade" value={fmt(summary.bestTrade ?? 0)} />
        <Metric label="Worst trade" value={fmt(summary.worstTrade ?? 0)} />
      </div>
      <MiniStatus>{summary.narrative ?? "Analytics will explain real bot performance after trades close."}</MiniStatus>
      <TradeTable trades={analytics?.trades ?? []} />
    </section>
  );
}

function CommunicationPanel({ communication, onSave, onTest, setCommunication }) {
  const alertTypes = communication.alertTypes ?? {};

  return (
    <section className="hubert-lab__section">
      <div className="hubert-lab__grid">
        <label>
          <span>Telegram alerts</span>
          <select value={communication.enabled ? "on" : "off"} onChange={(event) => setCommunication({ ...communication, enabled: event.target.value === "on" })}>
            <option value="off">Off</option>
            <option value="on">On</option>
          </select>
        </label>
        <TextField label="Telegram chat id" value={communication.telegramChatId ?? ""} onChange={(value) => setCommunication({ ...communication, telegramChatId: value })} />
        <ReadOnly label="Token state" value={communication.telegramBotTokenConfigured ? "Configured" : "Not configured"} />
        <ReadOnly label="Chat id state" value={communication.telegramChatId ? "Configured" : "Missing"} />
      </div>
      <ToggleGrid
        values={alertTypes}
        onChange={(key, value) => setCommunication({ ...communication, alertTypes: { ...alertTypes, [key]: value } })}
        items={[
          ["botStarted", "Bot started"],
          ["botStopped", "Bot stopped"],
          ["positionOpened", "Position opened"],
          ["positionClosed", "Position closed"],
          ["slMoved", "SL moved"],
          ["tpMoved", "TP moved"],
          ["orderRejected", "Error"],
          ["dailySummary", "Daily summary"],
        ]}
      />
      <div className="hubert-lab__actions">
        <button type="button" onClick={onSave}>Save Alerts</button>
        <button type="button" onClick={onTest}>Test Alert</button>
      </div>
    </section>
  );
}

function AiPanel({ aiContext, aiStatus, messages, onAsk, question, setAiContext, setMessages, setQuestion }) {
  const examples = [
    "Explain why Backtest 1 made more than Backtest 2.",
    "Is this drawdown dangerous?",
    "Why can't I move SL?",
    "Which deck is currently strongest?",
    "Explain this platform error like I am a beginner.",
  ];

  return (
    <section className="hubert-lab__section">
      <MiniStatus tone={aiStatus?.configured ? "good" : "neutral"}>
        {aiStatus?.message ?? "AI runs through the backend. If no key is configured, this panel will tell you cleanly."}
      </MiniStatus>
      <ToggleGrid
        values={aiContext}
        onChange={(key, value) => setAiContext({ ...aiContext, [key]: value })}
        items={[
          ["includeDecks", "Decks"],
          ["includeBacktests", "Backtests"],
          ["includeLivePositions", "Live positions"],
          ["includeAnalytics", "Analytics"],
          ["includeSystemStatus", "System status"],
          ["includeErrors", "Recent errors"],
        ]}
      />
      <div className="hubert-ai-examples">
        {examples.map((example) => (
          <button key={example} type="button" onClick={() => setQuestion(example)}>{example}</button>
        ))}
      </div>
      <label>
        <span>Ask AI</span>
        <textarea value={question} onChange={(event) => setQuestion(event.target.value)} />
      </label>
      <div className="hubert-lab__actions">
        <button type="button" onClick={onAsk}>Send</button>
        <button type="button" onClick={() => setMessages([])}>Clear</button>
      </div>
      <div className="hubert-chat-log">
        {messages.length === 0 ? (
          <MiniStatus>No AI messages yet.</MiniStatus>
        ) : (
          messages.map((message, index) => (
            <div className="hubert-chat-message" data-role={message.role} key={`${message.time}-${index}`}>
              <strong>{message.role === "user" ? "You" : "AI"}</strong>
              <span>{message.text}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function FavoritesPanel({ favorites, onDelete, onOpen, onRename }) {
  const groups = ["Strategy Decks", "MM Decks", "Battle Decks", "Backtests", "Analytics Reports"];

  return (
    <section className="hubert-lab__section">
      {groups.map((group) => (
        <div className="hubert-lab__section" key={group}>
          <div className="hubert-lab__subhead"><strong>{group}</strong><span>{favorites.filter((item) => item.category === group).length}</span></div>
          <DeckList
            decks={favorites.filter((item) => item.category === group)}
            extra={(favorite) => (
              <>
                <button type="button" onClick={() => onOpen(favorite)}>Open</button>
                <button type="button" onClick={() => onRename(favorite)}>Rename</button>
              </>
            )}
            onDelete={onDelete}
          />
        </div>
      ))}
    </section>
  );
}

function DeckEditor({ children, form, onSave, title }) {
  return (
    <div className="hubert-deck-editor">
      <div className="hubert-lab__subhead">
        <strong>{title}</strong>
        <span>{form.id ? "editing saved deck" : "new deck"}</span>
      </div>
      <div className="hubert-lab__grid">{children}</div>
      <div className="hubert-lab__actions">
        <button type="button" onClick={onSave}>Save</button>
      </div>
    </div>
  );
}

function CompactOpenRow({ items, label, onOpen }) {
  return (
    <label>
      <span>{label}</span>
      <select
        value=""
        onChange={(event) => {
          const item = items.find((entry) => entry.id === event.target.value);
          if (item) onOpen(item);
        }}
      >
        <option value="">Choose</option>
        {items.map((item) => (
          <option key={item.id} value={item.id}>{item.name}</option>
        ))}
      </select>
    </label>
  );
}

function DeckList({ decks, extra, onDelete, onDuplicate, onEdit, onFavorite }) {
  if (!decks?.length) {
    return <MiniStatus>No saved items here yet.</MiniStatus>;
  }

  return (
    <div className="hubert-deck-list">
      {decks.map((deck) => (
        <div className="hubert-deck-card" key={deck.id}>
          <div>
            <strong>{deck.name}</strong>
            <span>{deck.symbol ?? deck.category ?? "Saved item"} {deck.timeframe ?? ""}</span>
          </div>
          <div className="hubert-deck-card__actions">
            {onEdit && <button type="button" onClick={() => onEdit(deck)}>Edit</button>}
            {onDuplicate && <button type="button" onClick={() => onDuplicate(deck)}>Duplicate</button>}
            {onFavorite && <button type="button" onClick={() => onFavorite(deck)}>Favorite</button>}
            {extra?.(deck)}
            {onDelete && <button type="button" onClick={() => onDelete(deck)}>Delete</button>}
          </div>
        </div>
      ))}
    </div>
  );
}

function BacktestResult({ result }) {
  const audit = useMemo(() => sizingAudit(result?.trades ?? []), [result?.trades]);
  const equityPoints = useMemo(() => equityPolyline(result?.equityCurve), [result?.equityCurve]);
  const drawdownPoints = useMemo(() => drawdownPolyline(result?.equityCurve), [result?.equityCurve]);

  if (!result) return <MiniStatus>Run a backtest to see equity, trades, and analysis.</MiniStatus>;
  const metrics = result.metrics;

  return (
    <>
      <div className="hubert-lab__metrics">
        <Metric label="Net profit" value={fmt(metrics.netProfit)} />
        <Metric label="Profit factor" value={fmt(metrics.profitFactor)} />
        <Metric label="Win rate" value={`${fmt(metrics.winRate)}%`} />
        <Metric label="Max drawdown" value={`${fmt(metrics.maxDrawdown)}%`} />
        <Metric label="Total trades" value={metrics.totalTrades} />
        <Metric label="Expectancy" value={fmt(metrics.expectancy)} />
        <Metric label="Average trade" value={fmt(metrics.averageTrade)} />
        <Metric label="Best trade" value={fmt(metrics.largestWin)} />
        <Metric label="Worst trade" value={fmt(metrics.largestLoss)} />
      </div>
      <SingleCurveChart title="Equity Curve" caption="Higher line means higher account equity. Preview capped for speed." points={equityPoints} />
      <SingleCurveChart title="Drawdown Curve" caption="Higher red line means deeper drawdown from the last equity peak. Preview capped for speed." points={drawdownPoints} drawdown />
      <MiniStatus>{analyzeBacktest(result)}</MiniStatus>
      <div className="hubert-lab__subhead"><strong>Position Sizing Audit</strong><span>transparent sizing</span></div>
      <div className="hubert-lab__metrics">
        <Metric label="Average size" value={fmt(audit.averageSize)} />
        <Metric label="Min size" value={fmt(audit.minSize)} />
        <Metric label="Max size" value={fmt(audit.maxSize)} />
        <Metric label="Average leverage" value={`${fmt(audit.averageLeverage, 1)}x`} />
        <Metric label="Average risk" value={fmt(audit.averageRisk)} />
        <Metric label="Biggest exposure" value={fmt(audit.biggestExposure)} />
      </div>
      <MiniStatus>{audit.note}</MiniStatus>
      <div className="hubert-lab__actions">
        <button type="button" onClick={() => exportJson(`${result.name ?? "backtest"}.json`, result)}>Export JSON</button>
        <button type="button" onClick={() => exportCsv(`${result.name ?? "backtest"}-trades.csv`, result.trades)}>Export CSV</button>
      </div>
      <SideBreakdown trades={result.trades} />
      <TradeTable trades={result.trades} />
      <BacktestDebugSection result={result} />
    </>
  );
}

function BacktestDebugSection({ result }) {
  const [showDebug, setShowDebug] = useState(false);
  const summary = result?.diagnosticSummary ?? {};
  const rows = useMemo(
    () => (result?.diagnosticEvents ?? []).slice(-50).reverse(),
    [result?.diagnosticEvents],
  );

  return (
    <section className="hubert-lab__section">
      <div className="hubert-lab__subhead">
        <strong>Backtest Debug</strong>
        <label className="hubert-inline-toggle">
          <input
            checked={showDebug}
            type="checkbox"
            onChange={(event) => setShowDebug(event.target.checked)}
          />
          <span>Show debug events</span>
        </label>
      </div>
      {!showDebug ? (
        <MiniStatus>Debug events are hidden. Turn them on when you want to audit setup decisions.</MiniStatus>
      ) : (
        <>
          <div className="hubert-lab__metrics">
            <Metric label="Evaluated candles" value={summary.totalEvaluatedCandles ?? 0} />
            <Metric label="Valid LONG setups" value={summary.validLongSetups ?? 0} />
            <Metric label="Valid SHORT setups" value={summary.validShortSetups ?? 0} />
            <Metric label="Opened LONG" value={summary.openedLongTrades ?? 0} />
            <Metric label="Opened SHORT" value={summary.openedShortTrades ?? 0} />
            <Metric label="LONG limiter skips" value={summary.skippedLongByLimiter ?? 0} />
            <Metric label="SHORT limiter skips" value={summary.skippedShortByLimiter ?? 0} />
            <Metric label="HA missing" value={summary.skippedByHaMissing ?? 0} />
            <Metric label="Band missing" value={summary.skippedByBandMissing ?? 0} />
            <Metric label="Already in position" value={summary.skippedByAlreadyInPosition ?? 0} />
            <Metric label="Sizing/MM" value={summary.skippedBySizingMm ?? 0} />
            <Metric label="Other filters" value={summary.skippedByFilters ?? 0} />
          </div>
          {rows.length === 0 ? (
            <MiniStatus>No setup debug events were produced for this run.</MiniStatus>
          ) : (
            <div className="hubert-lab__table hubert-lab__table--audit">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Side</th>
                    <th>Band</th>
                    <th>HA</th>
                    <th>Valid</th>
                    <th>Opened</th>
                    <th>Reason</th>
                    <th>L SL</th>
                    <th>S SL</th>
                    <th>Block L</th>
                    <th>Block S</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((event, index) => (
                    <tr key={`${event.setupId || event.side}-${event.candleTime}-${index}`}>
                      <td>{dateText(event.candleTime)}</td>
                      <td>{event.side}</td>
                      <td>{event.bandTouchCondition ? "yes" : "no"}</td>
                      <td>{event.haConfirmationCondition ? "yes" : "no"}</td>
                      <td>{event.setupValid ? "yes" : "no"}</td>
                      <td>{event.tradeOpened ? "yes" : "no"}</td>
                      <td>{event.reason || "--"}</td>
                      <td>{event.currentLongSlStreak ?? "--"}</td>
                      <td>{event.currentShortSlStreak ?? "--"}</td>
                      <td>{event.limiterBlockingLong === null ? "--" : event.limiterBlockingLong ? "yes" : "no"}</td>
                      <td>{event.limiterBlockingShort === null ? "--" : event.limiterBlockingShort ? "yes" : "no"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function SingleCurveChart({ caption, drawdown = false, points, title }) {
  return (
    <div className="hubert-chart-box">
      <strong>{title}</strong>
      <span>{caption}</span>
      <svg className={`hubert-lab__equity${drawdown ? " hubert-lab__equity--drawdown" : ""}`} viewBox="0 0 100 100" preserveAspectRatio="none">
        <polyline points={points} />
      </svg>
    </div>
  );
}

function SideBreakdown({ trades }) {
  return (
    <div className="hubert-lab__table">
      <table>
        <thead>
          <tr><th>Side</th><th>Trades</th><th>Win rate</th><th>PnL</th></tr>
        </thead>
        <tbody>
          {sideBreakdown(trades).map((row) => (
            <tr key={row.side}>
              <td>{row.side}</td>
              <td>{row.total}</td>
              <td>{fmt(row.winRate)}%</td>
              <td>{fmt(row.pnl)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TradeTable({ trades }) {
  const [page, setPage] = useState(0);
  const orderedTrades = useMemo(() => (trades ?? []).slice().reverse(), [trades]);
  const totalPages = Math.max(1, Math.ceil(orderedTrades.length / TRADE_TABLE_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const visibleTrades = orderedTrades.slice(
    safePage * TRADE_TABLE_PAGE_SIZE,
    safePage * TRADE_TABLE_PAGE_SIZE + TRADE_TABLE_PAGE_SIZE,
  );

  useEffect(() => {
    setPage(0);
  }, [trades]);

  return (
    <>
      <div className="hubert-lab__actions">
        <button disabled={safePage === 0} type="button" onClick={() => setPage((current) => Math.max(0, current - 1))}>Newer</button>
        <span>Trades page {safePage + 1} / {totalPages} · {orderedTrades.length} trades</span>
        <button disabled={safePage >= totalPages - 1} type="button" onClick={() => setPage((current) => Math.min(totalPages - 1, current + 1))}>Older</button>
      </div>
      <div className="hubert-lab__table">
        <table>
          <thead>
            <tr><th>Time</th><th>Side</th><th>Size</th><th>Lev</th><th>Margin</th><th>SL dist</th><th>Risk</th><th>PnL</th><th>Reason</th></tr>
          </thead>
          <tbody>
            {visibleTrades.map((trade, index) => (
              <tr key={trade.id ?? `${trade.entryTime}-${safePage}-${index}`}>
                <td>{dateText(trade.entryTime)}</td>
                <td>{trade.direction ?? trade.side}</td>
                <td>{fmt(trade.size)}</td>
                <td>{trade.assumedLeverage ? `${fmt(trade.assumedLeverage, 1)}x` : "--"}</td>
                <td>{fmt(trade.marginRequired)}</td>
                <td>{trade.slDistancePercent ? `${fmt(trade.slDistancePercent * 100)}%` : "--"}</td>
                <td>{fmt(trade.riskAmount)}</td>
                <td>{fmt(trade.netPnl ?? trade.pnl)}</td>
                <td>{trade.exitReason ?? trade.reason ?? "--"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function OrderTable({ orders }) {
  if (!orders?.length) {
    return <MiniStatus>No open exchange orders reported.</MiniStatus>;
  }

  return (
    <div className="hubert-lab__table">
      <table>
        <thead>
          <tr><th>Symbol</th><th>Type</th><th>Side</th><th>Price</th><th>Status</th></tr>
        </thead>
        <tbody>
          {orders.slice(-20).map((order, index) => (
            <tr key={`${order.orderId ?? order.id ?? "order"}-${order.type ?? order.orderType ?? "type"}-${order.stopPrice ?? order.price ?? index}-${index}`}>
              <td>{order.symbol ?? "--"}</td>
              <td>{order.type ?? order.orderType ?? "--"}</td>
              <td>{order.side ?? order.positionSide ?? "--"}</td>
              <td>{fmt(order.price ?? order.stopPrice ?? order.avgPrice)}</td>
              <td>{order.status ?? order.orderStatus ?? "--"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LogList({ logs }) {
  const visibleLogs = logs.filter((log) => !JSON.stringify(log).toLowerCase().includes("paper"));

  return (
    <div className="hubert-lab__table">
      <table>
        <thead><tr><th>Time</th><th>Latest bot messages</th></tr></thead>
        <tbody>
          {visibleLogs.slice(-12).reverse().map((log) => (
            <tr key={log.id}><td>{dateText(log.time)}</td><td>{log.message}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ToggleGrid({ items, onChange, values }) {
  return (
    <div className="hubert-lab__toggles">
      {items.map(([key, label]) => (
        <label key={key}>
          <input checked={Boolean(values[key])} type="checkbox" onChange={(event) => onChange(key, event.target.checked)} />
          <span>{label}</span>
        </label>
      ))}
    </div>
  );
}

function NumberField({ commitEmpty = true, help, label, max, min, onChange, step = "1", value }) {
  const [draft, setDraft] = useState(value ?? "");

  useEffect(() => {
    setDraft(value ?? "");
  }, [value]);

  return (
    <label>
      <span>{label} {help && <Help text={help} />}</span>
      <input
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        type="text"
        value={draft}
        onBlur={() => {
          if (draft === "" && !commitEmpty) {
            setDraft(value ?? "");
          }
        }}
        onChange={(event) => {
          const nextValue = event.target.value;
          setDraft(nextValue);

          if (nextValue !== "" || commitEmpty) {
            onChange(nextValue);
          }
        }}
      />
    </label>
  );
}

function TextField({ label, onChange, value }) {
  return (
    <label>
      <span>{label}</span>
      <input value={value ?? ""} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function SelectField({ label, onChange, options, value }) {
  return (
    <label>
      <span>{label}</span>
      <select value={value ?? ""} onChange={(event) => onChange(event.target.value)}>
        <option value="">Choose</option>
        {options.map(([key, labelText]) => <option key={key} value={key}>{labelText}</option>)}
      </select>
    </label>
  );
}

function ReadOnly({ label, value }) {
  return (
    <label>
      <span>{label}</span>
      <input readOnly value={value ?? "--"} />
    </label>
  );
}

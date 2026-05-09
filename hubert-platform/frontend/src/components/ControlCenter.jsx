import { useEffect, useMemo, useState } from "react";
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

function equityPolyline(equityCurve) {
  if (!equityCurve?.length) return "";
  const values = equityCurve.map((point) => point.equity);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return equityCurve
    .map((point, index) => {
      const x = equityCurve.length === 1 ? 0 : (index / (equityCurve.length - 1)) * 100;
      const y = 100 - ((point.equity - min) / span) * 100;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

function drawdownPolyline(equityCurve) {
  if (!equityCurve?.length) return "";
  let peak = equityCurve[0]?.equity ?? 0;
  const values = equityCurve.map((point) => {
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
  onApplyChart,
  onBacktestResult,
  onClose,
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
  const [savedBacktests, setSavedBacktests] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [communication, setCommunication] = useState({ alertTypes: {}, enabled: false, telegramChatId: "" });
  const [aiContext, setAiContext] = useState({
    includeAnalytics: true,
    includeBacktests: true,
    includeDecks: true,
    includeLivePositions: true,
    includeSystemStatus: true,
  });
  const [aiMessages, setAiMessages] = useState([]);
  const [aiQuestion, setAiQuestion] = useState("");
  const [compareIds, setCompareIds] = useState([]);
  const [strategyForm, setStrategyForm] = useState({ ...defaultStrategyDeck, ...settings, name: "" });
  const [mmForm, setMmForm] = useState(defaultMmDeck);
  const [backtestForm, setBacktestForm] = useState(defaultBacktestForm);
  const [backtestResult, setBacktestResult] = useState(null);
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
      ]);
    setSystem(nextSystem);
    setLivestream(nextLivestream);
    setAccountProfiles(nextAccounts);
    setStrategyDecks(nextStrategy);
    setMmDecks(nextMm);
    setBattleDecks(nextBattle);
    setFavorites(nextFavorites);
    setSavedBacktests(nextBacktests);
    setAnalytics(nextAnalytics);
    setCommunication(nextCommunication);
    if (!executionDeckId && nextBattle[0]) setExecutionDeckId(nextBattle[0].id);
  }

  useEffect(() => {
    runAction("initial-load", "Sync platform", refreshAll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveCollectionItem(collection, item) {
    const route = collectionRoutes[collection];
    const hasId = Boolean(item.id);
    const saved = await apiFetch(hasId ? `${route}/${encodeURIComponent(item.id)}` : route, {
      body: item,
      method: hasId ? "PUT" : "POST",
    });
    await refreshAll();
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
    const saved = await saveCollectionItem("favorites", favorite);
    return saved;
  }

  async function saveAndFavorite(collection, category, item) {
    const saved = await saveCollectionItem(collection, item);
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

  function runBrowserBacktest() {
    const deck = strategyDecks.find((item) => item.id === backtestForm.strategyDeckId) ?? strategyDecks[0];
    const mmDeck = mmDecks.find((item) => item.id === backtestForm.mmDeckId);
    if (!deck) throw new Error("Create or choose a Strategy Deck first.");
    const candles = filterCandlesByBacktestForm(rawCandles, backtestForm);
    if (candles.length < 550) {
      throw new Error("Not enough candles are loaded for this backtest. Request more history days or use a larger timeframe.");
    }
    const result = runBacktest({
      backtestConfig: {
        commissionPercent: Number(backtestForm.commissionPercent),
        atrPositionSizing: deck.atrPositionSizing,
        mmDeck,
        slippagePercent: Number(backtestForm.slippagePercent),
        startingBalance: Number(backtestForm.startingBalance),
      },
      rawCandles: candles,
      settings: strategyToSettings(deck, settings),
    });
    const named = {
      ...result,
      createdAt: new Date().toISOString(),
      id: `backtest-${Date.now()}`,
      name: backtestForm.name || `${deck.name} ${new Date().toLocaleDateString()}`,
      strategyDeckId: deck.id,
      strategyDeckName: deck.name,
    };
    setBacktestResult(named);
    onBacktestResult(named);
    return named;
  }

  async function saveBacktest(result = backtestResult) {
    if (!result) throw new Error("Run a backtest first.");
    if (!result.name) throw new Error("Name this backtest before saving it.");
    const saved = await saveAndFavorite("backtests", "Backtests", result);
    setBacktestResult(saved);
  }

  async function createBattleDeck() {
    if (!decision.battleName.trim()) throw new Error("Name this Battle Deck first.");
    if (!selectedStrategy) throw new Error("Choose a Strategy Deck first.");
    if (!selectedMm) throw new Error("Choose an MM Deck first.");
    const battleDeck = {
      accountLabel: decision.apiProfile === "main" ? "Main Account" : decision.apiProfile,
      accountType: decision.apiProfile === "main" ? "main" : "subaccount",
      apiProfile: decision.apiProfile,
      createdAt: new Date().toISOString(),
      estimate: decisionEstimate,
      mmDeckId: selectedMm.id,
      mmSnapshot: { ...selectedMm },
      name: decision.battleName,
      readiness: decisionEstimate.ready ? "ready" : "needs attention",
      status: "inactive",
      strategyDeckId: selectedStrategy.id,
      strategySnapshot: { ...selectedStrategy },
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
          onSave={() => runAction("save-strategy", "Save Strategy Deck", () => saveAndFavorite("strategyDecks", "Strategy Decks", strategyForm))}
        />
      )}

      {panel === "Backtests" && (
        <BacktestsPanel
          favorites={favorites}
          form={backtestForm}
          mmDecks={mmDecks}
          result={backtestResult}
          savedBacktests={savedBacktests}
          setForm={setBacktestForm}
          strategyDecks={strategyDecks}
          onDelete={(item) => runAction(`delete-backtest-${item.id}`, "Delete backtest", () => deleteCollectionItem("backtests", item))}
          onFavorite={(item) => runAction(`fav-backtest-${item.id}`, "Add favorite", () => addFavorite("Backtests", item))}
          onHide={(item) => runAction(`hide-backtest-${item.id}`, "Hide backtest", () => saveCollectionItem("backtests", { ...item, hidden: true }))}
          onRun={() => runAction("run-backtest", "Run backtest", async () => runBrowserBacktest())}
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
          onSave={() => runAction("save-mm", "Save MM Deck", () => saveAndFavorite("mmDecks", "MM Decks", mmForm))}
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
        <NumberField label="History days" value={settings.historyDays ?? 31} min="1" max="1000" onChange={(value) => updateSetting("historyDays", value)} help="Choose time in days. The platform converts it into candles for this timeframe." />
        <ReadOnly label="Loaded candles" value={`${rawCandles.length} on ${selectedInterval}`} />
        <NumberField label="Bandwidth" value={settings.bandwidth} step="0.5" onChange={(value) => updateSetting("bandwidth", value)} />
        <NumberField label="NWE multiplier" value={settings.envelopeMultiplier} step="0.1" onChange={(value) => updateSetting("envelopeMultiplier", value)} />
        <NumberField label="ATR length" value={settings.atrLength} step="1" onChange={(value) => updateSetting("atrLength", value)} />
        <NumberField label="ATR multiplier" value={settings.atrMultiplier} step="0.1" onChange={(value) => updateSetting("atrMultiplier", value)} />
        <NumberField label="Max same-side failures" value={settings.maxSameSideFailures} step="1" onChange={(value) => updateSetting("maxSameSideFailures", value)} />
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

function BacktestsPanel({ favorites, form, mmDecks, onDelete, onFavorite, onHide, onRun, onSave, result, savedBacktests, setForm, strategyDecks }) {
  const favoriteBacktests = favorites
    .filter((favorite) => favorite.category === "Backtests")
    .map((favorite) => savedBacktests.find((item) => item.id === favorite.itemId))
    .filter(Boolean);

  return (
    <section className="hubert-lab__section">
      <MiniStatus>Saved backtests automatically go to Favorites. Use this panel for the current run.</MiniStatus>
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
      <BacktestResult result={result} />
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

  return (
    <div className="hubert-chart-box">
      <strong>{title}</strong>
      <span>{curveKey === "drawdown" ? "Higher line means deeper drawdown." : "Higher line means higher equity."}</span>
      <svg className="hubert-lab__equity" viewBox="0 0 100 100" preserveAspectRatio="none">
        {results.map((result, index) => (
          <polyline
            key={result.id}
            points={curveKey === "drawdown" ? drawdownPolyline(result.equityCurve) : equityPolyline(result.equityCurve)}
            stroke={colors[index % colors.length]}
            style={{ stroke: colors[index % colors.length] }}
          />
        ))}
      </svg>
      <div className="hubert-chart-legend">
        {results.map((result, index) => (
          <span key={result.id}><b style={{ background: colors[index % colors.length] }} />{result.name}</span>
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

function AiPanel({ aiContext, messages, onAsk, question, setAiContext, setMessages, setQuestion }) {
  const examples = [
    "Explain why Backtest 1 made more than Backtest 2.",
    "Is this drawdown dangerous?",
    "Why can't I move SL?",
    "Which deck is currently strongest?",
    "Explain this platform error like I am a beginner.",
  ];

  return (
    <section className="hubert-lab__section">
      <MiniStatus>AI runs through the backend. If no key is configured, this panel will tell you cleanly.</MiniStatus>
      <ToggleGrid
        values={aiContext}
        onChange={(key, value) => setAiContext({ ...aiContext, [key]: value })}
        items={[
          ["includeDecks", "Decks"],
          ["includeBacktests", "Backtests"],
          ["includeLivePositions", "Live positions"],
          ["includeAnalytics", "Analytics"],
          ["includeSystemStatus", "System status"],
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
  if (!result) return <MiniStatus>Run a backtest to see equity, trades, and analysis.</MiniStatus>;
  const metrics = result.metrics;
  const audit = sizingAudit(result.trades);

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
      <SingleCurveChart title="Equity Curve" caption="Higher line means higher account equity." points={equityPolyline(result.equityCurve)} />
      <SingleCurveChart title="Drawdown Curve" caption="Higher red line means deeper drawdown from the last equity peak." points={drawdownPolyline(result.equityCurve)} drawdown />
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
    </>
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
  return (
    <div className="hubert-lab__table">
      <table>
        <thead>
          <tr><th>Time</th><th>Side</th><th>Size</th><th>Lev</th><th>Margin</th><th>SL dist</th><th>Risk</th><th>PnL</th><th>Reason</th></tr>
        </thead>
        <tbody>
          {(trades ?? []).slice(-80).map((trade, index) => (
            <tr key={trade.id ?? `${trade.entryTime}-${index}`}>
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
            <tr key={order.orderId ?? order.id ?? index}>
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

function NumberField({ help, label, max, min, onChange, step = "1", value }) {
  return (
    <label>
      <span>{label} {help && <Help text={help} />}</span>
      <input min={min} max={max} step={step} type="number" value={value ?? ""} onChange={(event) => onChange(Number(event.target.value))} />
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

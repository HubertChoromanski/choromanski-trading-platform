import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  CrosshairMode,
  LineSeries,
  createChart,
  createSeriesMarkers,
} from "lightweight-charts";
import { backendApiUrl, dashboardAuthHeaders } from "../api/backend";
import { createSolKlineSocket, fetchHistoricalCandles } from "../api/binance";
import {
  STRATEGY_EVENT_TYPES,
  evaluateChoromanskiStrategy,
  toStrategyMarkers,
} from "../engine/strategyEngine";
import { toHeikenAshi } from "../indicators/heikenAshi";
import { calculateNadarayaEnvelope, toLineData } from "../indicators/nadaraya";
import ControlCenter from "./ControlCenter";
import {
  PLATFORM_STORAGE_KEY,
  readPlatformState,
  writeStoredJson,
} from "../utils/persistence";
import "../styles/chart.css";

const DISPLAY_TIME_ZONE = import.meta.env.VITE_DISPLAY_TIME_ZONE || "Europe/Warsaw";
const DISPLAY_LOCALE = import.meta.env.VITE_DISPLAY_LOCALE || "pl-PL";
const FULL_TIME_FORMATTER = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  month: "2-digit",
  second: "2-digit",
  timeZone: DISPLAY_TIME_ZONE,
  year: "numeric",
});
const AXIS_TIME_FORMATTER = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  month: "2-digit",
  timeZone: DISPLAY_TIME_ZONE,
});

const timeframes = [
  { label: "10m", interval: "10m" },
  { label: "15m", interval: "15m" },
  { label: "20m", interval: "20m" },
  { label: "30m", interval: "30m" },
  { label: "1H", interval: "1h" },
  { label: "4H", interval: "4h" },
];
const toolGroups = [
  {
    label: "Decks",
    items: ["Indicator", "Strategy Decks", "MM Decks", "Battle Decks", "Favorites"],
  },
  {
    label: "Centrum Decyzyjne",
    items: ["Livestream", "Execution", "Decision", "Crisis"],
  },
  {
    label: "Backtest",
    items: ["Backtests", "Compare"],
  },
  {
    label: "System",
    items: ["System", "Analytics", "Communication"],
  },
];
const defaultSettings = {
  strategySource: "pine-ha",
  bandwidth: 8,
  envelopeMultiplier: 3,
  atrLength: 14,
  atrMultiplier: 1.2,
  maxSameSideFailures: 2,
  historyDays: 1000,
  historyLimit: 10000,
  showBands: true,
  showEntries: true,
  showBenchmarks: false,
  showNegated: false,
  showSl: true,
  showTrigger: false,
};
const indicatorSettingKeys = [
  "atrLength",
  "atrMultiplier",
  "bandwidth",
  "envelopeMultiplier",
  "historyDays",
  "historyLimit",
  "maxSameSideFailures",
  "showBands",
  "showBenchmarks",
  "showEntries",
  "showNegated",
  "showSl",
  "showTrigger",
  "strategySource",
];
const DEFAULT_CHART_RENDER_CAP = 1500;
const ABSOLUTE_CHART_RENDER_CAP = 3000;
const MAX_BACKTEST_CHART_MARKERS = 100;
const MAX_BACKTEST_DEBUG_MARKERS = 40;
const MAX_STRATEGY_LINE_EVENTS = 100;
const DEFAULT_CHART_WINDOW_DAYS = 50;
const MAX_CANDLES_BY_INTERVAL = {
  "10m": 10000,
  "15m": 10000,
  "20m": 10000,
  "30m": 10000,
  "1h": 10000,
  "4h": 5000,
};
const defaultBacktestOverlaySettings = {
  showDebug: false,
  showExits: true,
  showPnlLabels: true,
  showSelectedTradeSlTp: true,
  showSlTp: false,
  showTrades: true,
  showVisibleTradeSlTp: false,
};
const overlayModes = [
  {
    id: "live",
    label: "LIVE ONLY",
    note: "Tylko pozycja live, SL/TP live, trigger live i aktualny setup.",
  },
  {
    id: "operational",
    label: "OPERACYJNY",
    note: "Live plus bieżący setup oczekujący, zablokowany lub zastąpiony.",
  },
  {
    id: "history",
    label: "HISTORIA",
    note: "Ostatnie historyczne/symulowane setupy jako kontekst.",
  },
  {
    id: "debug",
    label: "DEBUG",
    note: "Pełne markery i linie diagnostyczne.",
  },
];
const overlayModeIds = new Set(overlayModes.map((mode) => mode.id));

function formatMeasurementValue(value) {
  const prefix = value > 0 ? "+" : "";

  return `${prefix}${value.toFixed(2)}`;
}

function getBarIndex(time, candles) {
  if (time === null) {
    return null;
  }

  return candles.findIndex((candle) => candle.time === time);
}

function formatChartPrice(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : "--";
}

function formatChartPnl(value) {
  if (!Number.isFinite(Number(value))) return "";
  const prefix = Number(value) > 0 ? "+" : "";

  return `${prefix}${Number(value).toFixed(2)}`;
}

function normalizeOverlayMode(value) {
  return overlayModeIds.has(value) ? value : "live";
}

function overlayModeDefinition(value) {
  return overlayModes.find((mode) => mode.id === normalizeOverlayMode(value)) ?? overlayModes[0];
}

function takNie(value) {
  return value ? "tak" : "nie";
}

function polishSide(value = "") {
  const side = String(value || "").toUpperCase();
  if (side.includes("LONG") || side === "BUY") return "LONG";
  if (side.includes("SHORT") || side === "SELL") return "SHORT";
  return side || "--";
}

function canonicalDirection(...values) {
  for (const value of values) {
    const side = polishSide(value);
    if (side === "LONG" || side === "SHORT") return side;
  }
  return "";
}

function polishStatus(value = "") {
  const normalized = String(value || "").toLowerCase();
  const map = {
    accepted: "zaakceptowane przez BingX",
    canceled: "anulowane",
    cancelled: "anulowane",
    cancel_failed: "nie udało się anulować",
    expired: "wygasło",
    filled_but_position_missing: "fill zgłoszony, ale brak pozycji live",
    filled_protected: "pozycja wykryta, ochrona założona",
    filled_sl_failed: "pozycja wykryta, SL niepotwierdzony",
    invalidated_before_fill: "setup anulowany przed triggerem",
    missing: "brak zlecenia na BingX",
    new: "nowe",
    partially_filled: "częściowo wykonane",
    pending_sync: "czeka na potwierdzenie BingX",
    platform_armed: "platforma pilnuje triggera",
    platform_blocked_existing_position: "pozycja live już istnieje",
    platform_market_order_rejected: "MARKET odrzucony przez BingX",
    placed: "wystawione",
    rejected: "odrzucone",
    reversal_close_failed: "odwrócenie przerwane: nie zamknięto starej pozycji",
    reversal_close_succeeded_entry_failed: "stara pozycja zamknięta, nowe wejście nieudane",
    risk_blocked: "zablokowane przez ryzyko",
    setup_invalidated_before_platform_trigger: "setup anulowany przed lokalnym triggerem",
    terminal_failed: "zakończone błędem na BingX",
    trigger_crossed_but_price_too_far: "trigger przebity, cena za daleko",
    trigger_order_rejected: "trigger odrzucony przez BingX",
    healthy: "zdrowy",
    idle: "bezczynny",
    interrupted: "przerwany",
    recovering: "odzyskiwanie stanu",
    running: "działa",
    stopped: "zatrzymany",
  };
  return map[normalized] ?? (value || "--");
}

function polishProtectionSource(value = "") {
  const normalized = String(value || "").toLowerCase();
  const map = {
    bingx_order: "zlecenie ochronne BingX",
    bingx_position: "pole pozycji BingX",
    local_planned: "lokalny plan po fillu triggera",
    none: "brak",
    simulated: "symulacja",
    stale_local: "stary lokalny scenariusz",
    "open orders": "otwarte zlecenia BingX",
    "position fields": "pole pozycji BingX",
  };
  return map[normalized] ?? (value || "--");
}

function polishReason(value = "") {
  const normalized = String(value || "").toLowerCase();
  if (!normalized) return "--";
  if (normalized.includes("filled_but_position_missing")) return "BingX nie potwierdza pozycji live dla tego scenariusza.";
  if (normalized.includes("setup_invalidated_before_fill") || normalized.includes("invalidated_before_fill")) return "Cena dotknęła poziomu negacji przed wykonaniem triggera.";
  if (normalized.includes("missing")) return "Zlecenie nie istnieje już na BingX.";
  if (normalized.includes("expired")) return "Zlecenie trigger wygasło na BingX.";
  if (normalized.includes("rejected")) return "BingX odrzucił zlecenie trigger.";
  if (normalized.includes("trigger_order_failed_exchange") || normalized === "terminal_failed") return "Trigger zakończył się na BingX: FAILED.";
  if (normalized.includes("margin_unavailable")) return "Najbardziej prawdopodobne: brak wolnego marginu przy aktywacji triggera.";
  if (normalized.includes("market_moved_too_far")) return "Najbardziej prawdopodobne: rynek odjechał za daleko od triggera przy aktywacji.";
  if (normalized.includes("trigger_price_invalid_or_crossed")) return "Najbardziej prawdopodobne: trigger był już przekroczony albo niepoprawny przy wysyłce.";
  if (normalized.includes("precision_or_min_qty")) return "Najbardziej prawdopodobne: precyzja albo minimalna ilość zlecenia.";
  if (normalized.includes("unknown_exchange_failed")) return "BingX zwrócił FAILED bez jednoznacznego powodu w dostępnych danych.";
  if (normalized.includes("canceled") || normalized.includes("cancelled")) return "Zlecenie zostało anulowane.";
  if (normalized.includes("risk")) return "Setup został zablokowany przez warstwę ryzyka.";
  if (normalized.includes("reversal_close_failed")) return "Przeciwny trigger został przebity, ale zamknięcie starej pozycji nie powiodło się.";
  if (normalized.includes("reversal_close_succeeded_entry_failed")) return "Stara pozycja została zamknięta, ale nie udało się otworzyć nowej pozycji.";
  if (normalized.includes("blocked")) return "Setup został zablokowany przed wysłaniem zlecenia.";
  return value;
}

function resolvedTriggerFailureCandidate(runtime = {}, pending = {}) {
  const diagnostics = runtime.lastTriggerFailureDiagnostics ?? pending?.failureDiagnostics ?? {};
  if (diagnostics.triggerAlreadyCrossed) return "trigger_price_invalid_or_crossed";
  return runtime.lastTriggerFailureCandidate || pending?.failureCandidate || "";
}

function polishLifecycleText(item = {}) {
  const message = String(item.message ?? item.status ?? "");
  const normalized = message.toLowerCase();
  if (!message) return "Aktualizacja zlecenia trigger.";
  if (normalized.includes("exchange accepted trigger-market")) return "BingX zaakceptował zlecenie trigger-market.";
  if (normalized.includes("invalidated before fill")) return "Cena dotknęła poziomu negacji przed wykonaniem triggera. Zlecenie trigger zostało anulowane.";
  if (normalized.includes("still pending")) return `Trigger nadal czeka na BingX (${polishStatus(item.status)}).`;
  if (normalized.includes("terminal on exchange")) return `Trigger zakończył się na BingX: ${polishReason(message)}`;
  if (normalized.includes("reported filled") && normalized.includes("no matching live position")) {
    return "BingX zgłosił fill, ale świeży sync nie znalazł pozycji live.";
  }
  if (normalized.includes("sl placement failed")) return "Pozycja została wykryta, ale SL nie został potwierdzony.";
  if (normalized.includes("sl protection placement requested")) return "Pozycja została wykryta; system wysłał zlecenie ochronne SL.";
  if (normalized.includes("pending trigger order cancelled")) return "Poprzedni trigger został anulowany.";
  if (normalized.includes("risk blocked")) return `Ryzyko zablokowało setup: ${message.replace(/^risk blocked:\s*/i, "")}`;
  return message;
}

function compactId(value = "") {
  const text = String(value || "");
  return text.length > 10 ? `${text.slice(0, 6)}…${text.slice(-3)}` : text;
}

function formatExitReason(reason) {
  if (reason === "END") return "END / open until test end";
  return reason ?? "EXIT";
}

function formatChartTime(value) {
  if (!value) return "--";

  const date = dateFromChartTime(value);
  return date ? FULL_TIME_FORMATTER.format(date) : "--";
}

function secondsSince(value) {
  const date = dateFromChartTime(value);
  if (!date) return null;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
}

function ageText(value) {
  const seconds = secondsSince(value);
  if (seconds === null) return "--";
  if (seconds < 60) return `${seconds}s temu`;
  return `${Math.floor(seconds / 60)}m temu`;
}

function formatChartAxisTime(value) {
  const date = dateFromChartTime(value);
  return date ? AXIS_TIME_FORMATTER.format(date) : "";
}

function dateFromChartTime(value) {
  if (typeof value === "object" && value !== null && "year" in value) {
    return new Date(Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day)));
  }
  if (typeof value === "string" && Number.isNaN(Number(value))) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1000;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date : null;
}

function localDateInputToSeconds(value) {
  const match = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return NaN;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

function normalizeProfileId(value = "") {
  return String(value || "").toLowerCase();
}

function compactSymbol(value = "") {
  return String(value || "").replace("-", "").toUpperCase();
}

function displayInterval(value = "") {
  return String(value).toLowerCase() === "1h" ? "1H" : value;
}

function positionSide(position = {}) {
  const raw = String(position.positionSide ?? position.side ?? position.direction ?? "").toUpperCase();
  if (raw.includes("LONG")) return "LONG";
  if (raw.includes("SHORT")) return "SHORT";
  if (raw === "BUY") return "LONG";
  if (raw === "SELL") return "SHORT";
  const amount = Number(position.positionAmt ?? position.positionAmount ?? position.quantity ?? 0);
  if (amount < 0) return "SHORT";
  if (amount > 0) return "LONG";
  return "";
}

function positionAmount(position = {}) {
  return Math.abs(Number(position.positionAmt ?? position.positionAmount ?? position.quantity ?? position.availableAmt ?? 0));
}

function positionEntry(position = {}) {
  return Number(position.entryPrice ?? position.avgPrice ?? position.averagePrice ?? position.positionAvgPrice ?? 0);
}

function positionPnl(position = {}) {
  return Number(position.unrealizedPnl ?? position.unrealizedProfit ?? position.pnl ?? 0);
}

function orderIdentifier(order = {}) {
  return order.orderId ?? order.orderID ?? order.id ?? order.clientOrderId ?? order.clientOrderID ?? null;
}

function orderType(order = {}) {
  return String(order.type ?? order.orderType ?? order.origType ?? order.planType ?? order.stopOrderType ?? "").toUpperCase();
}

function stopProtectionOrder(position = {}) {
  return (position.attachedOrders ?? []).find((order) => {
    const type = orderType(order);
    return type.includes("STOP") && !type.includes("TAKE");
  }) ?? null;
}

function takeProfitProtectionOrder(position = {}) {
  return (position.attachedOrders ?? []).find((order) => {
    const type = orderType(order);
    return type.includes("TAKE") || type.includes("PROFIT");
  }) ?? null;
}

function pendingTriggerStartTime(pending = {}, firstTime) {
  return Math.max(
    firstTime,
    Number(pending.entryEvent?.benchmarkTime ?? pending.entryEvent?.time ?? firstTime),
  );
}

function liveProtectionState({ livePosition = null, pending = null, runtime = {} }) {
  const pendingStatus = String(pending?.status ?? runtime.triggerOrderState ?? "").toLowerCase();
  const stopOrder = livePosition ? stopProtectionOrder(livePosition) : null;
  const stopLoss = Number(livePosition?.stopLoss ?? 0);
  const positionSource = String(livePosition?.stopLossSource ?? livePosition?.protectionSource ?? "").toLowerCase();
  const hasBingxProtection = Boolean(livePosition && (stopOrder || stopLoss > 0) && positionSource !== "none");

  if (livePosition && hasBingxProtection) {
    return {
      activeScenarioCanBlockNewSetup: true,
      confirmed: true,
      label: "LIVE SL — POTWIERDZONY NA BINGX",
      note: "Istnieje realna pozycja na BingX i aktywny SL widoczny w świeżym syncu pozycji albo zleceń.",
      orderId: orderIdentifier(stopOrder),
      price: stopLoss || Number(pending?.stopLoss ?? 0),
      source: stopOrder ? "bingx_order" : "bingx_position",
      tone: "live",
    };
  }

  if (livePosition) {
    return {
      activeScenarioCanBlockNewSetup: true,
      confirmed: false,
      label: "LIVE POZYCJA — BRAK POTWIERDZONEGO SL",
      note: "Pozycja istnieje na BingX, ale świeży sync nie pokazuje aktywnego SL.",
      orderId: null,
      price: Number(pending?.stopLoss ?? livePosition?.stopLoss ?? 0),
      source: "none",
      tone: "critical",
    };
  }

  if (["filled_protected", "filled_sl_failed", "filled_but_position_missing"].includes(pendingStatus)) {
    const staleLabel = pendingStatus === "filled_sl_failed"
      ? "PLANOWANY SL — NIEPOTWIERDZONY"
      : "HISTORYCZNY SL";
    return {
      activeScenarioCanBlockNewSetup: false,
      confirmed: false,
      label: staleLabel,
      note: "Ten poziom pochodzi ze starego/lokalnego scenariusza. BingX nie potwierdza aktualnej pozycji live z tym SL.",
      orderId: orderIdentifier(pending?.stopOrder),
      price: Number(pending?.stopLoss ?? 0),
      source: "stale_local",
      tone: pendingStatus === "filled_sl_failed" ? "critical" : "stale",
    };
  }

  if (pending?.stopLoss) {
    return {
      activeScenarioCanBlockNewSetup: false,
      confirmed: false,
      label: "PLANOWANY SL — NIEPOTWIERDZONY",
      note: "SL zostanie użyty dopiero po fillu triggera. Teraz nie jest aktywną ochroną na BingX.",
      orderId: null,
      price: Number(pending.stopLoss),
      source: "local_planned",
      tone: "pending",
    };
  }

  return {
    activeScenarioCanBlockNewSetup: false,
    confirmed: false,
    label: "SYMULOWANY SL",
    note: "Brak live pozycji i brak potwierdzonego SL na BingX.",
    orderId: null,
    price: null,
    source: "simulated",
    tone: "simulated",
  };
}

function positionsForOperationalState(livestream, config = {}) {
  const positions = livestream?.positions ?? [];
  return positions.filter((position) => {
    const profile = normalizeProfileId(position.apiProfile ?? position.__apiProfileId ?? position.sourceProfileId ?? "");
    const configured = normalizeProfileId(config.apiProfile ?? "");
    return (!configured || profile === configured) &&
      compactSymbol(position.symbol ?? config.symbol) === compactSymbol(config.symbol ?? "SOLUSDT") &&
      positionAmount(position) > 0;
  });
}

function isActivePendingStatus(status) {
  return ["accepted", "placed", "new", "partially_filled", "pending_sync", "platform_armed"].includes(String(status ?? "").toLowerCase());
}

function isTerminalExchangeStatus(status) {
  return [
    "terminal_failed",
    "canceled",
    "cancelled",
    "expired",
    "rejected",
    "missing",
    "filled_but_position_missing",
    "invalidated_before_fill",
    "market_sent_position_missing",
    "platform_blocked_existing_position",
    "platform_market_order_rejected",
    "reversal_close_failed",
    "reversal_close_succeeded_entry_failed",
    "setup_invalidated_before_platform_trigger",
    "trigger_crossed_but_price_too_far",
    "cancel_failed",
  ].includes(String(status ?? "").toLowerCase());
}

function semanticOverlayLabel(line = {}) {
  const direction = canonicalDirection(line.direction);
  const side = direction ? ` — ${direction}` : "";
  if (line.type === "trigger") {
    if (line.state === "active_live") return `TRIGGER LIVE — ZLECENIE NA BINGX${side}`;
    if (line.state === "invalidated") return `SETUP ANULOWANY — NEGACJA PRZED TRIGGEREM${side}`;
    if (line.state === "failed") return `NIEUDANY TRIGGER ${direction || ""} — BingX nie wykonał zlecenia`.trim();
    if (line.state === "current_setup") return `SETUP W STRATEGII — BRAK AKTYWNEGO ZLECENIA BINGX${side}`;
    if (line.state === "historical") return `HISTORYCZNY TRIGGER — BRAK AKTYWNEGO ZLECENIA${side}`;
    return `SYMULOWANY TRIGGER${side}`;
  }
  if (line.type === "sl") {
    if (line.state === "live_confirmed") return "LIVE SL — POTWIERDZONY NA BINGX";
    if (line.state === "planned") return "POZIOM NEGACJI / SL SETUPU — NIEPOTWIERDZONY NA BINGX";
    return "HISTORYCZNY SL";
  }
  if (line.type === "tp") {
    if (line.state === "live_confirmed") return "TP WYKRYTY NA BINGX";
    if (line.state === "setup_target") return "SYMULOWANY TP — HISTORIA/DEBUG";
    return "SYMULOWANY TP";
  }
  if (line.type === "entry") {
    if (line.state === "live_confirmed") return `LIVE ENTRY${side}`;
    return `SYMULOWANY ENTRY${side}`;
  }
  return line.label ?? "";
}

function semanticOverlayStyle(line = {}) {
  const direction = canonicalDirection(line.direction);
  const sideColor = direction === "SHORT" ? "rgba(182, 50, 66, 0.95)" : "rgba(21, 152, 112, 0.95)";
  if (line.type === "entry") {
    return {
      color: direction === "SHORT" ? "rgba(239, 68, 68, 0.95)" : "rgba(34, 197, 94, 0.95)",
      lineStyle: 0,
      lineWidth: 2,
    };
  }
  if (line.type === "trigger") {
    return {
      color: line.state === "active_live" ? sideColor : "rgba(148, 163, 184, 0.55)",
      lineStyle: line.state === "active_live" ? 0 : 2,
      lineWidth: line.state === "active_live" ? 2 : 1,
    };
  }
  if (line.type === "sl") {
    return {
      color: line.state === "live_confirmed" ? "rgba(34, 197, 94, 0.95)" : line.state === "planned" ? "rgba(255, 152, 67, 0.7)" : "rgba(148, 163, 184, 0.42)",
      lineStyle: 2,
      lineWidth: line.state === "live_confirmed" ? 2 : 1,
    };
  }
  if (line.type === "tp") {
    return {
      color: line.state === "live_confirmed" ? "rgba(89, 168, 255, 0.95)" : line.state === "setup_target" ? "rgba(89, 168, 255, 0.62)" : "rgba(89, 168, 255, 0.36)",
      lineStyle: line.state === "live_confirmed" ? 2 : 1,
      lineWidth: line.state === "live_confirmed" ? 2 : 1,
    };
  }
  return { color: "rgba(148, 163, 184, 0.5)", lineStyle: 2, lineWidth: 1 };
}

function warnDirectionLabelMismatch(line = {}, label = "") {
  const direction = canonicalDirection(line.direction);
  if (!direction) return;
  const text = String(label).toUpperCase();
  const opposite = direction === "LONG" ? "SHORT" : "LONG";
  if (text.includes(opposite) && !text.includes(direction)) {
    console.warn("Choromanski chart direction mismatch", {
      direction,
      label,
      sourceField: line.sourceField,
      type: line.type,
      value: line.value,
    });
  }
}

function shouldRenderSemanticOverlay(line = {}, mode = "live") {
  const normalizedMode = normalizeOverlayMode(mode);
  if (line.state === "live_confirmed" || line.state === "active_live") return true;
  if (normalizedMode === "live") return false;
  if (normalizedMode === "operational") {
    return line.state === "current_setup" || (line.type === "sl" && line.state === "planned");
  }
  return normalizedMode === "history" || normalizedMode === "debug";
}

function buildSemanticLiveOverlays({
  firstTime,
  interval,
  lastTime,
  livePosition = null,
  mode = "live",
  pending = null,
  protection = null,
  setup = null,
}) {
  const pendingStatus = String(pending?.status ?? "").toLowerCase();
  const activePending = pending && isActivePendingStatus(pendingStatus);
  const staleProtectionPending = pending && !livePosition && ["filled_protected", "filled_sl_failed", "filled_but_position_missing"].includes(pendingStatus);
  const terminalPending = pending && !livePosition && (isTerminalExchangeStatus(pendingStatus) || pending.terminal || staleProtectionPending);
  const pendingDirection = canonicalDirection(pending?.direction, pending?.positionSide, pending?.side);
  const lines = [];
  const addLine = (line) => {
    if (!Number.isFinite(Number(line.value)) || Number(line.value) <= 0) return;
    const label = semanticOverlayLabel(line);
    warnDirectionLabelMismatch(line, label);
    const key = [
      interval,
      line.setupFingerprint ?? line.setupId ?? line.orderId ?? "overlay",
      line.type,
      Number(line.value).toFixed(4),
      line.sourceTime ?? line.startTime ?? firstTime,
    ].join(":");
    const nextLine = {
      endTime: lastTime,
      interval,
      key,
      label,
      lineStyle: semanticOverlayStyle(line).lineStyle,
      lineWidth: semanticOverlayStyle(line).lineWidth,
      startTime: firstTime,
      ...semanticOverlayStyle(line),
      ...line,
      value: Number(line.value),
    };
    if (shouldRenderSemanticOverlay(nextLine, mode)) {
      lines.push(nextLine);
    }
  };

  if (livePosition) {
    const direction = canonicalDirection(positionSide(livePosition), livePosition?.positionSide, livePosition?.side);
    const tpOrder = takeProfitProtectionOrder(livePosition) ?? pending?.takeProfitOrder ?? null;
    addLine({
      direction,
      sourceField: "entryPrice",
      state: "live_confirmed",
      type: "entry",
      value: positionEntry(livePosition),
    });
    if (protection?.confirmed) {
      addLine({
        direction,
        orderId: protection.orderId,
        sourceField: "stopLoss",
        state: "live_confirmed",
        type: "sl",
        value: protection.price,
      });
    }
    if (tpOrder) {
      addLine({
        direction,
        orderId: orderIdentifier(tpOrder),
        sourceField: "takeProfit",
        state: "live_confirmed",
        type: "tp",
        value: livePosition.takeProfit,
      });
    }
  }

  if (pending) {
    const startTime = pendingTriggerStartTime(pending, firstTime);
    if (activePending) {
      addLine({
        direction: pendingDirection,
        orderId: pending.orderId,
        setupFingerprint: pending.setupFingerprint,
        setupId: pending.setupId,
        sourceField: "triggerPrice",
        startTime,
        state: "active_live",
        type: "trigger",
        value: pending.triggerPrice,
      });
      addLine({
        direction: pendingDirection,
        setupFingerprint: pending.setupFingerprint,
        setupId: pending.setupId,
        sourceField: "stopLoss",
        startTime,
        state: "planned",
        type: "sl",
        value: pending.stopLoss,
      });
    } else if (terminalPending) {
      const failedTrigger = pending.terminalReason || pending.failureClassification || pending.lastExchangeStatus;
      const invalidatedBeforeFill = pendingStatus === "invalidated_before_fill" || String(failedTrigger ?? "").includes("invalidated_before_fill");
      addLine({
        direction: pendingDirection,
        orderId: pending.orderId,
        setupFingerprint: pending.setupFingerprint,
        setupId: pending.setupId,
        sourceField: "triggerPrice",
        startTime,
        state: invalidatedBeforeFill ? "invalidated" : failedTrigger ? "failed" : "historical",
        terminalReason: failedTrigger || "",
        type: "trigger",
        value: pending.triggerPrice,
      });
      addLine({
        direction: pendingDirection,
        setupFingerprint: pending.setupFingerprint,
        setupId: pending.setupId,
        sourceField: "stopLoss",
        startTime,
        state: "historical",
        type: "sl",
        value: pending.stopLoss,
      });
    }
  }

  const setupDirection = canonicalDirection(setup?.direction);
  const setupTrigger = Number(setup?.trigger);
  const setupIsActive = setup?.type === STRATEGY_EVENT_TYPES.SETUP_ACTIVE || String(setup?.status ?? "").toUpperCase() === "PENDING";
  const pendingSetupStillCurrent = pending && activePending && canonicalDirection(pendingDirection) === setupDirection && (
    (pending.setupFingerprint && setup?.setupFingerprint && pending.setupFingerprint === setup.setupFingerprint) ||
    (!pending.setupFingerprint && !setup?.setupFingerprint && setup?.setupId && pending.setupId === setup.setupId)
  );
  if (setupIsActive && setup?.setupId && setupDirection && Number.isFinite(setupTrigger) && !livePosition && !pendingSetupStillCurrent) {
    const startTime = Number(setup.benchmarkTime ?? setup.time ?? firstTime);
    addLine({
      direction: setupDirection,
      setupFingerprint: setup.setupFingerprint,
      setupId: setup.setupId,
      sourceField: "trigger",
      sourceInterval: interval,
      sourceTime: setup.time,
      startTime: Math.max(firstTime, startTime),
      state: "current_setup",
      type: "trigger",
      value: setupTrigger,
    });
    addLine({
      direction: setupDirection,
      setupFingerprint: setup.setupFingerprint,
      setupId: setup.setupId,
      sourceField: "stopLoss",
      sourceInterval: interval,
      sourceTime: setup.time,
      startTime: Math.max(firstTime, startTime),
      state: "planned",
      type: "sl",
      value: setup.stopLoss ?? setup.invalidationPrice,
    });
  }

  return lines;
}

function classifyMarkerReality({ activeAnalysisSession, markerSource, selectedHistoricalWindow }) {
  if (activeAnalysisSession) {
    return {
      label: "SYMULOWANA TRANSAKCJA Z BACKTESTU",
      note: "Marker pochodzi z backtestu. Nie oznacza pozycji ani zlecenia na BingX.",
      tone: "simulated",
    };
  }
  if (selectedHistoricalWindow?.mode === "historical" || String(markerSource ?? "").includes("historical")) {
    return {
      label: "HISTORYCZNY SETUP",
      note: "Sygnał istnieje w historii wykresu. Bot mógł wtedy nie działać live albo nie mieć uzbrojonego triggera.",
      tone: "stale",
    };
  }
  return {
    label: "SYMULOWANY ENTRY",
    note: "Marker pokazuje obliczony sygnał strategii na wykresie. Live wejście wymaga aktywnego Sztabu i zlecenia na BingX.",
    tone: "simulated",
  };
}

function timelineFromRuntime(runtime = {}) {
  const journal = (runtime.setupOrderJournal ?? []).slice(-8).map((item) => ({
    time: item.timestamp,
    text: readableJournalText(item),
  }));
  const lifecycle = (runtime.pendingTriggerOrder?.orderLifecycle ?? []).slice(-5).map((item) => ({
    time: item.time,
    text: polishLifecycleText(item),
  }));
  const setup = runtime.latestSetupEvent
    ? [{
        time: runtime.latestSetupEvent.time,
        text: `Strategia zobaczyła setup ${polishSide(runtime.latestSetupEvent.direction)} (${runtime.latestSetupEvent.setupId ?? "bez id"}${runtime.latestSetupEvent.setupFingerprintShort ? ` · ${runtime.latestSetupEvent.setupFingerprintShort}` : ""}).`,
      }]
    : [];
  return [...setup, ...journal, ...lifecycle]
    .filter((item) => item.text)
    .sort((left, right) => {
      const leftTime = typeof left.time === "number" ? left.time * 1000 : new Date(left.time ?? 0).getTime();
      const rightTime = typeof right.time === "number" ? right.time * 1000 : new Date(right.time ?? 0).getTime();
      return rightTime - leftTime;
    })
    .slice(0, 7);
}

function readableJournalText(item = {}) {
  const setup = item.setupId ? ` ${compactId(item.setupId)}` : "";
  const trigger = Number.isFinite(Number(item.triggerPrice)) ? ` @ ${formatChartPrice(item.triggerPrice)}` : "";
  const side = item.side ? ` ${polishSide(item.side)}` : "";
  switch (item.event) {
    case "order_accepted":
      return `BingX zaakceptował trigger${side}${setup}${trigger}.`;
    case "order_terminal":
      return `Zlecenie trigger zakończyło się na BingX: ${polishStatus(item.status ?? "terminal")}. ${polishReason(item.failureCandidate ?? item.reason ?? item.status ?? "terminal")}`;
    case "setup_invalidated_before_fill":
      return `Cena dotknęła poziomu negacji${Number.isFinite(Number(item.invalidationPrice)) ? ` ${formatChartPrice(item.invalidationPrice)}` : ""} przed wykonaniem triggera${setup}. Zlecenie trigger zostało anulowane.`;
    case "order_missing":
      return `Zlecenie trigger${setup} nie istnieje już na BingX.`;
    case "order_canceled":
      return `Oczekujący trigger${setup} został anulowany: ${polishReason(item.reason ?? "operator/replacement")}`;
    case "fill_detected_sl_placed":
      return `Wykryto fill pozycji${setup}; system wysłał ochronę SL.`;
    case "fill_detected_sl_failed":
      return `Wykryto fill pozycji${setup}, ale SL nie został potwierdzony.`;
    case "filled_but_position_missing":
      return `BingX zgłosił fill${setup}, ale świeży sync nie znalazł pozycji live.`;
    case "risk_blocked":
      return `Ryzyko zablokowało setup${setup}: ${polishReason(item.reason ?? "risk manager")}`;
    case "order_rejected":
      return `BingX odrzucił trigger${setup}: ${polishReason(item.reason ?? "exchange rejection")}`;
    case "platform_reversal_trigger_armed":
      return `Pozycja live jest aktywna. Bot czeka na przeciwny trigger${side}${trigger}, żeby odwrócić pozycję.`;
    case "live_reversal_trigger_crossed":
      return `Przeciwny trigger${side}${trigger} został przebity. Bot zamknął starą pozycję i przygotowuje nowe wejście.`;
    case "live_reversal_completed":
      return `Reversal wykonany${side}: stara pozycja zamknięta, nowa pozycja otwarta, SL wysłany.`;
    case "live_reversal_sl_failed":
      return `Reversal otworzył nową pozycję${side}, ale SL nie został potwierdzony. Wymagana kontrola ręczna.`;
    case "reversal_close_failed":
      return `Przeciwny trigger${side}${trigger} został przebity, ale zamknięcie starej pozycji nie powiodło się.`;
    case "reversal_close_succeeded_entry_failed":
      return `Stara pozycja została zamknięta, ale nowe wejście${side} nie powiodło się.`;
    case "cancel_failed":
      return `Nie udało się anulować triggera${setup}; sprawdź status BingX.`;
    default:
      return `Aktualizacja scenariusza${setup}${trigger}: ${polishStatus(item.event ?? item.status ?? "runtime")}`;
  }
}

function runningIntervalSet(status = {}) {
  return new Set(
    (status?.runner?.runningIntervals ?? status?.runningIntervals ?? [])
      .map((item) => String(item).toLowerCase()),
  );
}

function normalizeSztabRuntimeForPanel(status = {}, interval) {
  const key = String(interval ?? "").toLowerCase();
  const intervalsRunning = [...runningIntervalSet(status)];
  const statusInterval = status?.intervals?.[interval] ?? status?.intervals?.[key] ?? {};
  const configInterval = status?.config?.intervals?.[interval] ?? status?.config?.intervals?.[key] ?? {};
  const runtime = {
    ...(configInterval.runtime ?? {}),
    ...(statusInterval.runtime ?? {}),
  };
  runtime.setupOrderJournal =
    statusInterval.runtime?.setupOrderJournal ??
    statusInterval.setupOrderJournal ??
    configInterval.runtime?.setupOrderJournal ??
    configInterval.setupOrderJournal ??
    runtime.setupOrderJournal ??
    [];
  runtime.pendingTriggerOrder =
    statusInterval.runtime?.pendingTriggerOrder ??
    statusInterval.pendingTriggerOrder ??
    configInterval.runtime?.pendingTriggerOrder ??
    configInterval.pendingTriggerOrder ??
    runtime.pendingTriggerOrder ??
    null;
  const runningFromRunner = runningIntervalSet(status).has(key);
  const rawStatus = String(runtime.status ?? "").toLowerCase();
  const operationalStatus = runningFromRunner && !["running", "degraded", "recovering", "error", "interrupted"].includes(rawStatus)
    ? "running"
    : rawStatus || (runningFromRunner ? "running" : "stopped");
  const frontendFetchedAt = status?.__frontendFetchedAt ?? null;
  const backendUpdatedAt = status?.updatedAt ?? status?.config?.updatedAt ?? null;
  const heartbeatAge = runtime.heartbeatAgeSeconds ?? secondsSince(runtime.heartbeatAt ?? runtime.lastTickAt);
  const fetchAge = secondsSince(frontendFetchedAt);
  const staleReasons = [
    status?.__frontendFetchError ? `błąd pobrania: ${status.__frontendFetchError}` : "",
    fetchAge !== null && fetchAge > 20 ? `frontend fetch ${fetchAge}s temu` : "",
    runningFromRunner && heartbeatAge !== null && heartbeatAge > 120 ? `heartbeat ${heartbeatAge}s temu` : "",
  ].filter(Boolean);
  const uiDataStale = staleReasons.length > 0;
  const sharedRuntime = {
    backendUpdatedAt,
    frontendStatusFetchAgeSeconds: fetchAge,
    frontendStatusFetchedAt: frontendFetchedAt,
    frontendStatusFetchError: status?.__frontendFetchError ?? "",
    heartbeatAgeSeconds: heartbeatAge,
    runnerRunningFromStatus: runningFromRunner,
    runningIntervalsText: intervalsRunning.length ? intervalsRunning.join(", ") : "--",
    staleDetection: staleReasons.length ? staleReasons.join("; ") : "świeże",
    status: operationalStatus,
    statusSource: runningFromRunner && rawStatus !== operationalStatus
      ? "runner.runningIntervals"
      : "runtime.status",
    uiDataStale,
  };

  return {
    config: {
      ...configInterval,
      ...statusInterval,
      runtime: {
        ...runtime,
        ...sharedRuntime,
      },
    },
    runtime: {
      ...runtime,
      ...sharedRuntime,
    },
  };
}

function runtimeDiagnostics(runtime = {}) {
  return [
    ["Status z", runtime.statusSource ?? "--"],
    ["Frontend fetch", runtime.frontendStatusFetchedAt ? `${formatChartTime(runtime.frontendStatusFetchedAt)} (${ageText(runtime.frontendStatusFetchedAt)})` : "--"],
    ["Backend updatedAt", runtime.backendUpdatedAt ? `${formatChartTime(runtime.backendUpdatedAt)} (${ageText(runtime.backendUpdatedAt)})` : "--"],
    ["runningIntervals", runtime.runningIntervalsText ?? "--"],
    ["Stale detection", runtime.staleDetection ?? "--"],
    ["Heartbeat", runtime.heartbeatAt ? `${formatChartTime(runtime.heartbeatAt)} (${ageText(runtime.heartbeatAt)})` : runtime.heartbeatAgeSeconds !== null && runtime.heartbeatAgeSeconds !== undefined ? `${runtime.heartbeatAgeSeconds}s temu` : "--"],
    ["Fetch error", runtime.frontendStatusFetchError || "--"],
  ];
}

function deriveOperationalState({
  activeAnalysisSession,
  config = {},
  currentPrice,
  interval,
  livestream,
  markerSource,
  runtime = {},
  selectedHistoricalWindow,
}) {
  const positions = positionsForOperationalState(livestream, config);
  const livePosition = positions[0] ?? null;
  const pending = runtime.pendingTriggerOrder ?? null;
  const status = String(runtime.status ?? "stopped").toLowerCase();
  const pendingStatus = String(pending?.status ?? runtime.triggerOrderState ?? "").toLowerCase();
  const markerReality = classifyMarkerReality({ activeAnalysisSession, markerSource, selectedHistoricalWindow });
  const setup = runtime.latestSetupEvent ?? null;
  const setupIsActive = setup?.type === STRATEGY_EVENT_TYPES.SETUP_ACTIVE || String(setup?.status ?? "").toUpperCase() === "PENDING";
  const intervalName = displayInterval(interval);
  const triggerPrice = Number(pending?.triggerPrice ?? setup?.trigger);
  const side = canonicalDirection(pending?.direction, pending?.positionSide, pending?.side, setup?.direction, positionSide(livePosition ?? {}));
  const blockedReason = runtime.lastBlockedReason || pending?.terminalReason || pending?.failureClassification || runtime.lastDecisionReason || "";
  const sideText = polishSide(side);
  const base = {
    detail: markerReality.note,
    diagnostics: runtimeDiagnostics(runtime),
    interval,
    markerReality,
    pending,
    rows: [],
    tags: [],
    timeline: timelineFromRuntime(runtime),
    tone: "neutral",
    visualObjects: [markerReality],
  };

  if (livePosition) {
    const protection = liveProtectionState({ livePosition, pending, runtime });
    return {
      ...base,
      detail: protection.note,
      headline: `${intervalName}: pozycja ${polishSide(positionSide(livePosition))} aktywna`,
      rows: [
        ["Wejście", formatChartPrice(positionEntry(livePosition))],
        ["SL", formatChartPrice(livePosition.stopLoss)],
        ["PnL", formatChartPnl(positionPnl(livePosition))],
        ["Ilość", formatChartPrice(positionAmount(livePosition))],
        ["Pozycja live", "tak"],
        ["SL potwierdzony", takNie(protection.confirmed)],
        ["Źródło ochrony", polishProtectionSource(protection.source)],
        ["Order ochrony", protection.orderId ? compactId(protection.orderId) : "--"],
      ],
      tags: [
        { label: "LIVE ENTRY — POZYCJA NA BINGX", tone: "live" },
        { label: protection.label, tone: protection.tone },
      ],
      tone: protection.confirmed ? "live" : "critical",
      visualObjects: [
        { label: "LIVE ENTRY — POZYCJA NA BINGX", note: "Pozycja pochodzi z live stanu BingX.", tone: "live" },
        { label: protection.label, note: protection.note, tone: protection.tone },
      ],
    };
  }

  if (status === "interrupted" || status === "error" || status === "recovering") {
    const programError = runtime.error || runtime.lastError || "";
    const interruptedByCode = Boolean(programError);
    return {
      ...base,
      headline: status === "recovering"
        ? `${intervalName}: runner odzyskuje stan`
        : interruptedByCode
          ? `${intervalName}: runner przerwany przez błąd programu`
          : `${intervalName}: runner przerwany, brak live egzekucji`,
      detail: interruptedByCode
        ? `Runner przerwany przez błąd programu: ${programError}`
        : "Sztab nie może teraz wysłać live zlecenia z tego interwału.",
      rows: [
        ["Stan", polishStatus(runtime.watchdogStatus ?? status)],
        ["Błąd", programError || "--"],
      ],
      tags: [
        { label: interruptedByCode ? "BŁĄD PROGRAMU RUNNERA" : status === "error" ? "BŁĄD RUNNERA / GIEŁDY" : "BOT BYŁ OFFLINE PRZY SYGNALE", tone: "critical" },
        { label: markerReality.label, tone: markerReality.tone },
      ],
      tone: "critical",
    };
  }

  if (runtime.uiDataStale) {
    return {
      ...base,
      headline: `${intervalName}: dane panelu są nieświeże`,
      detail: runtime.frontendStatusFetchError
        ? `Panel nie pobrał świeżego /api/sztab/status: ${runtime.frontendStatusFetchError}`
        : "Backend runner może działać, ale panel nie ma wystarczająco świeżego statusu. To nie oznacza automatycznie, że bot jest offline.",
      rows: [
        ["Stan z backendu", polishStatus(status || "unknown")],
        ["Runner aktywny wg statusu", takNie(runtime.runnerRunningFromStatus)],
        ["Heartbeat", runtime.heartbeatAgeSeconds !== null && runtime.heartbeatAgeSeconds !== undefined ? `${runtime.heartbeatAgeSeconds}s` : "--"],
        ["Ostatni fetch UI", runtime.frontendStatusFetchedAt ? formatChartTime(runtime.frontendStatusFetchedAt) : "--"],
      ],
      tags: [
        { label: "DANE PANELU NIEŚWIEŻE", tone: "stale" },
        { label: runtime.runnerRunningFromStatus ? "RUNNER WIDOCZNY W runningIntervals" : markerReality.label, tone: runtime.runnerRunningFromStatus ? "pending" : markerReality.tone },
      ],
      tone: "stale",
    };
  }

  if (!["running", "degraded"].includes(status)) {
    return {
      ...base,
      headline: `${intervalName}: bot offline dla tego interwału`,
      detail: "Sztab nie działa na tym interwale, więc sygnały na wykresie są historyczne albo symulowane.",
      rows: [
        ["Stan", polishStatus(status || "stopped")],
        ["Ostatni sygnał", setup?.setupId ? `${polishSide(setup.direction)} ${compactId(setup.setupId)}` : "--"],
      ],
      tags: [
        { label: "BOT BYŁ OFFLINE PRZY SYGNALE", tone: "stale" },
        { label: markerReality.label, tone: markerReality.tone },
      ],
      tone: "stale",
    };
  }

  if (isActivePendingStatus(pendingStatus)) {
    const protection = liveProtectionState({ livePosition, pending, runtime });
    return {
      ...base,
      headline: `${intervalName}: bot oczekuje na trigger ${sideText}`,
      detail: `Trigger live jest wystawiony/uzbrojony. Bot czeka, aż cena dotknie poziomu ${formatChartPrice(triggerPrice)} i BingX potwierdzi fill.`,
      rows: [
        ["Trigger", formatChartPrice(triggerPrice)],
        ["Cena teraz", formatChartPrice(currentPrice)],
        ["Zlecenie", pending?.orderId ? compactId(pending.orderId) : "--"],
        ["Status BingX", polishStatus(runtime.lastExchangeStatus || pendingStatus)],
        ["Pozycja live", "nie"],
        ["Stan SL", protection.label],
      ],
      tags: [
        { label: "LIVE TRIGGER NA BINGX", tone: "pending" },
        { label: "CZEKA NA DOTKNIĘCIE TRIGGERA", tone: "pending" },
        { label: protection.label, tone: protection.tone },
      ],
      tone: "pending",
      visualObjects: [{ label: "LIVE TRIGGER NA BINGX", note: "To live zlecenie trigger/stop-market powiązane ze Sztabem i statusem BingX.", tone: "pending" }],
    };
  }

  if (pending && isTerminalExchangeStatus(pendingStatus) && !setupIsActive) {
    const superseded = Boolean(runtime.supersededBySetupId ?? pending.supersededBySetupId);
    const invalidatedBeforeFill = pendingStatus === "invalidated_before_fill" || String(pending.terminalReason ?? pending.failureClassification ?? "").includes("invalidated_before_fill");
    const failureCandidate = resolvedTriggerFailureCandidate(runtime, pending);
    const terminalReasonText = polishReason(failureCandidate || pending.terminalReason || pending.failureClassification || pendingStatus);
    const failedTriggerLabel = superseded
      ? "SETUP ZASTĄPIONY PRZEZ NOWY"
      : invalidatedBeforeFill
        ? "SETUP ANULOWANY — CENA DOTKNĘŁA POZIOMU NEGACJI PRZED TRIGGEREM"
        : `NIEUDANY TRIGGER ${sideText}`;
    return {
      ...base,
      headline: superseded
        ? `${intervalName}: poprzedni setup został zastąpiony`
        : invalidatedBeforeFill
        ? `${intervalName}: setup martwy, bot czeka na nowy sygnał`
        : pendingStatus === "filled_but_position_missing"
        ? `${intervalName}: fill zgłoszony, ale brak pozycji live`
        : `${intervalName}: trigger zakończył się bez pozycji`,
      detail: superseded
        ? "Pojawił się nowy setup, więc poprzedni scenariusz i jego trigger zostały anulowane. To nie jest aktywna pozycja live."
        : invalidatedBeforeFill
        ? "Cena dotknęła poziomu negacji przed wykonaniem triggera. Pending trigger został anulowany, więc setup nie powinien wejść później."
        : pendingStatus === "filled_but_position_missing"
        ? "BingX zgłosił wykonanie, ale świeży sync nie znalazł odpowiadającej pozycji live. Ten scenariusz nie powinien blokować nowego setupu."
        : `Zlecenie trigger zakończyło się na BingX statusem ${polishStatus(runtime.lastExchangeStatus || pending.exchangeTerminalStatus || pendingStatus)}. ${terminalReasonText}`,
      rows: [
        ["Ostatni trigger", formatChartPrice(pending.triggerPrice)],
        ["Poziom negacji", formatChartPrice(pending.invalidationPrice ?? pending.stopLoss)],
        ["Zlecenie", pending.orderId ? compactId(pending.orderId) : "--"],
        ["Status BingX", polishStatus(runtime.lastExchangeStatus || pending.exchangeTerminalStatus || pendingStatus)],
        ["Wykonana ilość", pending.executedQty ?? runtime.triggerOrderExecutedQty ?? "--"],
        ["Kandydat przyczyny", failureCandidate || "--"],
        ["Dystans przy awarii", runtime.triggerDistanceAtFailurePct !== null && runtime.triggerDistanceAtFailurePct !== undefined ? `${Number(runtime.triggerDistanceAtFailurePct).toFixed(4)}%` : "--"],
        ["Blokuje nowy setup", takNie(runtime.activeScenarioCanBlockNewSetup)],
        ["Powód zakończenia", polishReason(runtime.scenarioTerminalReason || pending.terminalReason || pending.failureClassification || pendingStatus)],
        ["Zastąpiony przez", runtime.supersededBySetupId ? compactId(runtime.supersededBySetupId) : "--"],
        ["Pozycja live", "nie"],
      ],
      tags: [
        { label: superseded ? "SETUP ZASTĄPIONY PRZEZ NOWY" : pendingStatus === "filled_but_position_missing" ? "BRAK POTWIERDZONEJ LIVE POZYCJI" : failedTriggerLabel, tone: superseded ? "stale" : "critical" },
        { label: runtime.canArmNextSetup ? "NOWY SETUP MOŻE SIĘ UZBROIĆ" : "SCENARIUSZ NADAL BLOKUJE", tone: runtime.canArmNextSetup ? "live" : "critical" },
      ],
      tone: superseded ? "stale" : "critical",
      visualObjects: [{
        label: failedTriggerLabel,
        note: superseded
          ? "Stary scenariusz został anulowany, bo strategia wskazała nowszy setup."
          : "BingX zwrócił terminalny status zlecenia trigger. To nie jest aktywna pozycja live.",
        tone: superseded ? "stale" : "critical",
      }],
    };
  }

  if (blockedReason.includes("risk") || blockedReason.includes("blocked") || pendingStatus === "risk_blocked") {
    return {
      ...base,
      headline: `${intervalName}: setup ${sideText} zablokowany`,
      detail: polishReason(blockedReason) || "Runner odrzucił setup przed wysłaniem zlecenia.",
      rows: [
        ["Trigger", formatChartPrice(triggerPrice)],
        ["Cena teraz", formatChartPrice(currentPrice)],
        ["Powód", polishReason(blockedReason)],
      ],
      tags: [{ label: "SETUP ZABLOKOWANY", tone: "blocked" }],
      tone: "blocked",
      visualObjects: [{ label: "SETUP ZABLOKOWANY", note: "Setup nie przeszedł do live zlecenia na BingX.", tone: "blocked" }],
    };
  }

  if (setup?.setupId) {
    return {
      ...base,
      headline: `${intervalName}: widać setup ${polishSide(setup.direction)}, ale brak live triggera`,
      detail: "Setup jest widoczny w stanie strategii, ale nie ma aktywnego zlecenia trigger na BingX.",
      rows: [
        ["Setup", compactId(setup.setupId)],
        ["Trigger", formatChartPrice(setup.trigger)],
        ["Cena teraz", formatChartPrice(currentPrice)],
      ],
      tags: [
        { label: "SETUP STRATEGII", tone: "simulated" },
        { label: "BRAK LIVE TRIGGERA", tone: "stale" },
      ],
      tone: "neutral",
    };
  }

  return {
    ...base,
    headline: `${intervalName}: brak aktywnego setupu`,
    detail: "Runner czeka na kolejną świecę benchmarkową albo nowy setup strategii.",
    rows: [
      ["Stan", polishStatus(runtime.watchdogStatus ?? "healthy")],
      ["Ostatnia świeca", runtime.lastClosedCandleTime ? formatChartTime(runtime.lastClosedCandleTime) : "--"],
      ["Cena teraz", formatChartPrice(currentPrice)],
    ],
    tags: [{ label: "CZEKA NA ŚWIECĘ BENCHMARKOWĄ", tone: "neutral" }],
    tone: "neutral",
  };
}

function OperationalTelemetryPanel({
  compact = false,
  dock = "left",
  onDock,
  onSelectInterval,
  onToggleCompact,
  selectedInterval,
  states = {},
}) {
  const selected = states[selectedInterval] ?? deriveOperationalState({ interval: selectedInterval });
  const intervals = timeframes.filter((item) => item.interval !== "4h");

  return (
    <section
      className="hubert-operational-panel"
      data-compact={compact ? "true" : "false"}
      data-dock={dock}
      data-tone={selected.tone}
      aria-label="Stan operacyjny live"
    >
      <div className="hubert-operational-panel__head">
        <div>
          <strong>Stan operacyjny</strong>
          <span>Co realnie dzieje się na interwałach Sztabu</span>
        </div>
        <div>
          <button type="button" onClick={() => onToggleCompact?.()}>{compact ? "Rozwiń" : "Kompakt"}</button>
          <button type="button" onClick={() => onDock?.(dock === "left" ? "right" : "left")}>{dock === "left" ? "Na prawo" : "Na lewo"}</button>
        </div>
      </div>

      <div className="hubert-operational-intervals">
        {intervals.map((item) => {
          const state = states[item.interval] ?? deriveOperationalState({ interval: item.interval });
          return (
            <button
              data-active={selectedInterval === item.interval}
              data-tone={state.tone}
              key={item.interval}
              type="button"
              onClick={() => onSelectInterval?.(item.interval)}
            >
              <b>{item.label}</b>
              <span>{state.headline}</span>
            </button>
          );
        })}
      </div>

      {!compact && (
        <>
          <div className="hubert-operational-card" data-tone={selected.tone}>
            <strong>{selected.headline}</strong>
            <p>{selected.detail}</p>
            <div className="hubert-operational-tags">
              {(selected.tags ?? []).map((tag, index) => (
                <em data-tone={tag.tone} key={`${tag.label}-${index}`}>{tag.label}</em>
              ))}
            </div>
            <div className="hubert-operational-grid">
              {(selected.rows ?? []).map(([label, value]) => (
                <span key={label}><b>{label}</b><i>{value ?? "--"}</i></span>
              ))}
            </div>
          </div>

          <div className="hubert-operational-section">
            <strong>Znaczenie linii i markerów</strong>
            {(selected.visualObjects ?? []).map((item, index) => (
              <span data-tone={item.tone} key={`${item.label}-${index}`}>
                <b>{item.label}</b>
                <i>{item.note}</i>
              </span>
            ))}
          </div>

          <div className="hubert-operational-section">
            <strong>Oś zdarzeń</strong>
            {(selected.timeline ?? []).length ? (selected.timeline ?? []).map((item, index) => (
              <span key={`${item.time ?? index}-${index}`}>
                <b>{formatChartTime(item.time)}</b>
                <i>{item.text}</i>
              </span>
            )) : (
              <span>
                <b>Teraz</b>
                <i>Nie zapisano jeszcze zdarzeń setupu ani zleceń dla tego interwału.</i>
              </span>
            )}
          </div>

          <div className="hubert-operational-section">
            <strong>Diagnostyka statusu</strong>
            {(selected.diagnostics ?? []).map(([label, value]) => (
              <span key={label}>
                <b>{label}</b>
                <i>{value ?? "--"}</i>
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function chartTimeValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

async function apiFetch(path) {
  const response = await fetch(backendApiUrl(path), {
    cache: "no-store",
    headers: dashboardAuthHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Backend request failed: ${response.status}`);
  }

  return response.json();
}

function normalizeIndicatorSettings(value = {}) {
  return {
    ...defaultSettings,
    ...Object.fromEntries(indicatorSettingKeys.map((key) => [key, value[key] ?? defaultSettings[key]])),
  };
}

function initialIndicatorSettingsByInterval(persisted = {}) {
  const legacy = persisted.indicatorSettings ?? {};
  const byInterval = persisted.indicatorSettingsByInterval ?? {};

  return Object.fromEntries(
    timeframes.map((timeframe) => [
      timeframe.interval,
      normalizeIndicatorSettings({
        ...legacy,
        ...(byInterval[timeframe.interval] ?? {}),
      }),
    ]),
  );
}

function warnSanitizedChartData(label, details) {
  const totalIssues = Object.values(details).reduce((sum, value) => sum + Number(value || 0), 0);

  if (totalIssues > 0) {
    console.warn(`Choromanski chart sanitized ${label}`, details);
  }
}

function sanitizeChartSeriesData(data = [], label = "series") {
  const byTime = new Map();
  let duplicates = 0;
  let invalid = 0;
  let nonAscending = 0;
  let previousTime = -Infinity;

  data.forEach((point) => {
    const time = chartTimeValue(point?.time);

    if (time === null) {
      invalid += 1;
      return;
    }

    if (time <= previousTime) {
      nonAscending += 1;
    }

    previousTime = time;

    if (byTime.has(time)) {
      duplicates += 1;
    }

    byTime.set(time, { ...point, time });
  });

  const sanitized = [...byTime.values()].sort((left, right) => left.time - right.time);
  warnSanitizedChartData(label, { duplicates, invalid, nonAscending });

  return sanitized;
}

function markerSortPriority(marker) {
  const id = String(marker?.id ?? "");

  if (id.includes("debug")) return 0;
  if (id.includes("benchmark")) return 1;
  if (id.includes("entry")) return 2;
  if (id.includes("exit")) return 3;

  return 4;
}

function sanitizeMarkers(markers = [], label = "markers") {
  const byId = new Map();
  const noId = [];
  let duplicateIds = 0;
  let invalid = 0;
  let nonAscending = 0;
  let previousTime = -Infinity;

  markers.forEach((marker, index) => {
    const time = chartTimeValue(marker?.time);

    if (time === null) {
      invalid += 1;
      return;
    }

    if (time < previousTime) {
      nonAscending += 1;
    }

    previousTime = time;

    const nextMarker = {
      ...marker,
      __index: index,
      time,
    };

    if (marker.id) {
      if (byId.has(marker.id)) {
        duplicateIds += 1;
      }
      byId.set(marker.id, nextMarker);
    } else {
      noId.push(nextMarker);
    }
  });

  const sanitized = [...byId.values(), ...noId]
    .sort((left, right) => {
      const timeDiff = left.time - right.time;
      if (timeDiff !== 0) return timeDiff;

      const priorityDiff = markerSortPriority(left) - markerSortPriority(right);
      if (priorityDiff !== 0) return priorityDiff;

      return left.__index - right.__index;
    })
    .map(({ __index, ...marker }) => marker);

  warnSanitizedChartData(label, { duplicateIds, invalid, nonAscending });

  return sanitized;
}

function labelMarkers(markers = [], prefix = "") {
  if (!prefix) return markers;
  return markers.map((marker) => ({
    ...marker,
    text: `${prefix} ${marker.text ?? ""}`.trim(),
  }));
}

function canonicalStrategyOverlayEvents(events = []) {
  return events.filter((event) =>
    event.type === STRATEGY_EVENT_TYPES.ENTRY_TRIGGERED ||
    event.type === STRATEGY_EVENT_TYPES.SETUP_ACTIVE ||
    event.type === STRATEGY_EVENT_TYPES.SETUP_INVALIDATED ||
    event.type === STRATEGY_EVENT_TYPES.SETUP_BLOCKED ||
    event.type === STRATEGY_EVENT_TYPES.BENCHMARK_CONFIRMED
  );
}

function overlayModeStrategyEvents(events = [], mode = "live") {
  const normalized = normalizeOverlayMode(mode);
  const relevant = canonicalStrategyOverlayEvents(events).filter((event) =>
    event.type === STRATEGY_EVENT_TYPES.ENTRY_TRIGGERED ||
    event.type === STRATEGY_EVENT_TYPES.SETUP_ACTIVE ||
    event.type === STRATEGY_EVENT_TYPES.SETUP_INVALIDATED
  );

  if (normalized === "live") return [];
  if (normalized === "operational") return relevant.slice(-1);
  if (normalized === "history") return relevant.slice(-12);
  return relevant.slice(-MAX_STRATEGY_LINE_EVENTS);
}

function overlayModeMarkerEvents(events = [], mode = "live") {
  const normalized = normalizeOverlayMode(mode);
  const relevant = canonicalStrategyOverlayEvents(events);

  if (normalized === "live") return [];
  if (normalized === "operational") return relevant.slice(-1);
  if (normalized === "history") return relevant.slice(-18);
  return relevant.slice(-MAX_BACKTEST_CHART_MARKERS);
}

function overlayBacktestSettings(settings = defaultBacktestOverlaySettings, mode = "live") {
  const normalized = normalizeOverlayMode(mode);

  if (normalized === "debug") {
    return {
      ...settings,
      showDebug: Boolean(settings.showDebug),
    };
  }

  if (normalized === "history") {
    return {
      ...settings,
      showDebug: false,
      showExits: Boolean(settings.showExits),
      showPnlLabels: false,
    };
  }

  return {
    ...settings,
    showDebug: false,
    showExits: false,
    showPnlLabels: false,
    showSelectedTradeSlTp: false,
    showSlTp: false,
    showTrades: false,
    showVisibleTradeSlTp: false,
  };
}

function sanitizeOverlayEvents(points = [], label = "overlay") {
  const valid = points
    .map((point) => {
      const time = chartTimeValue(point?.time);
      const value = Number(point?.value);

      if (time === null || !Number.isFinite(value)) {
        return null;
      }

      return { ...point, time, value };
    })
    .filter(Boolean)
    .sort((left, right) => left.time - right.time);

  if (valid.length < 2) {
    warnSanitizedChartData(label, { invalid: points.length - valid.length, zeroDuration: 0 });
    return [];
  }

  const first = valid[0];
  const last = valid.at(-1);

  if (last.time <= first.time) {
    warnSanitizedChartData(label, { invalid: points.length - valid.length, zeroDuration: 1 });
    return [
      first,
      {
        ...last,
        time: first.time + 1,
      },
    ];
  }

  return sanitizeChartSeriesData([first, last], label);
}

function compactReason(reason = "") {
  const normalized = String(reason).toLowerCase();

  if (normalized.includes("limiter")) return "SL limiter";
  if (normalized.includes("ha")) return "HA missing";
  if (normalized.includes("position")) return "In position";
  if (normalized.includes("sizing") || normalized.includes("mm")) return "MM invalid";
  if (normalized.includes("history")) return "Missing data";
  if (normalized.includes("band")) return "Band missing";

  return "Candidate";
}

function rangeFromCandles(candles = []) {
  return {
    from: candles[0]?.time ?? null,
    to: candles.at(-1)?.time ?? null,
  };
}

function intervalMinutes(interval) {
  const minutesByInterval = {
    "10m": 10,
    "15m": 15,
    "20m": 20,
    "30m": 30,
    "1h": 60,
    "4h": 240,
  };

  return minutesByInterval[interval] ?? 15;
}

function chartWindowLimit(interval, days = DEFAULT_CHART_WINDOW_DAYS) {
  return Math.max(100, Math.min(DEFAULT_CHART_RENDER_CAP, Math.ceil(days * 1440 / intervalMinutes(interval))));
}

function chartWindowAround(candles = [], interval = "15m", centerTime = null, days = DEFAULT_CHART_WINDOW_DAYS) {
  if (!candles.length) return [];
  const limit = chartWindowLimit(interval, days);

  if (!centerTime) {
    return candles.slice(-limit);
  }

  const target = Number(centerTime);
  let centerIndex = candles.findIndex((candle) => candle.time >= target);

  if (centerIndex < 0) {
    centerIndex = candles.length - 1;
  }

  const half = Math.floor(limit / 2);
  const start = Math.max(0, Math.min(centerIndex - half, candles.length - limit));

  return candles.slice(start, start + limit);
}

function filterCandlesByRange(candles = [], range = {}) {
  if (!range.from && !range.to) return candles;

  return candles.filter((candle) => {
    const afterStart = !range.from || candle.time >= range.from;
    const beforeEnd = !range.to || candle.time <= range.to;

    return afterStart && beforeEnd;
  });
}

function candleTimeSet(candles = []) {
  return new Set(candles.map((candle) => candle.time));
}

function isRenderableTrade(trade, times) {
  return Boolean(trade?.entryTime && (!times || times.has(trade.entryTime)));
}

function tradeKey(trade, index = 0) {
  return String(trade?.id ?? trade?.setupId ?? `${trade?.entryTime ?? "entry"}-${trade?.direction ?? "trade"}-${index}`);
}

function visibleBacktestTrades(result, candles = []) {
  const times = candles.length ? candleTimeSet(candles) : null;

  return (result?.trades ?? [])
    .filter((trade) => isRenderableTrade(trade, times))
    .slice(-MAX_BACKTEST_CHART_MARKERS);
}

function renderedTradeCount(result, candles = [], overlaySettings = defaultBacktestOverlaySettings) {
  if (!result || !overlaySettings.showTrades) return 0;
  const times = candles.length ? candleTimeSet(candles) : null;

  return visibleBacktestTrades(result, candles).length;
}

function toBacktestAnalysisMarkers(result, overlaySettings = defaultBacktestOverlaySettings, candles = []) {
  if (!result) return [];

  const tradeMarkers = overlaySettings.showTrades
    ? visibleBacktestTrades(result, candles)
      .flatMap((trade, index) => {
        const side = trade.direction === "LONG" ? "LONG" : "SHORT";
        const entryText = overlaySettings.showPnlLabels
          ? `${side} ${formatChartPrice(trade.entryPrice)}`
          : side;
        const exitReason = formatExitReason(trade.exitReason);
        const exitTime = trade.exitReason === "END"
          ? result.analysisRange?.to ?? trade.exitTime
          : trade.exitTime;
        const exitText = overlaySettings.showPnlLabels
          ? `${exitReason} ${formatChartPnl(trade.netPnl)}`
          : exitReason;
        const markers = [
          {
            color: trade.direction === "LONG" ? "#f5f5f5" : "#050505",
            id: `analysis-entry-${tradeKey(trade, index)}`,
            position: trade.direction === "LONG" ? "belowBar" : "aboveBar",
            shape: trade.direction === "LONG" ? "arrowUp" : "arrowDown",
            size: 1.12,
            text: entryText,
            time: trade.entryTime,
          },
        ];

        if (overlaySettings.showExits) {
          markers.push({
            color: "rgba(110, 20, 20, 0.78)",
            id: `analysis-exit-${tradeKey(trade, index)}`,
            position: trade.direction === "LONG" ? "aboveBar" : "belowBar",
            shape: "square",
            size: 0.72,
            text: exitText,
            time: exitTime,
          });
        }

        return markers;
      })
    : [];

  if (!overlaySettings.showDebug) {
    return tradeMarkers;
  }

  const times = candles.length ? candleTimeSet(candles) : null;
  const debugMarkers = (result.diagnosticEvents ?? [])
    .filter((event) => !event.tradeOpened && event.reason && (event.bandTouchCondition || event.setupId))
    .filter((event) => !times || times.has(event.candleTime))
    .slice(-MAX_BACKTEST_DEBUG_MARKERS)
    .map((event, index) => ({
      color: "rgba(44, 44, 44, 0.5)",
      id: `analysis-debug-${event.setupId ?? event.index}-${index}`,
      position: "inBar",
      shape: "circle",
      size: 0.36,
      text: compactReason(event.reason),
      time: event.candleTime,
    }));

  return [...debugMarkers, ...tradeMarkers];
}

function historyDaysToLimit(interval, days) {
  const requested = Math.ceil(Number(days || 31) * 1440 / intervalMinutes(interval));
  const maxLimit = MAX_CANDLES_BY_INTERVAL[interval] ?? 10000;
  const minimumReliableHistory = maxLimit;

  return Math.max(100, Math.min(maxLimit, Math.max(requested, minimumReliableHistory)));
}

function toIncrementalHeikenAshi(rawCandle, previousHa) {
  const close = (rawCandle.open + rawCandle.high + rawCandle.low + rawCandle.close) / 4;
  const open = previousHa
    ? (previousHa.open + previousHa.close) / 2
    : (rawCandle.open + rawCandle.close) / 2;

  return {
    close,
    high: Math.max(rawCandle.high, open, close),
    low: Math.min(rawCandle.low, open, close),
    open,
    time: rawCandle.time,
  };
}

export default function TradingViewChart() {
  const [persistedState] = useState(readPlatformState);
  const initialIndicatorSettings = useMemo(
    () => initialIndicatorSettingsByInterval(persistedState),
    [persistedState],
  );
  const chartContainerRef = useRef(null);
  const importInputRef = useRef(null);
  const chartRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const upperSeriesRef = useRef(null);
  const lowerSeriesRef = useRef(null);
  const realPriceSeriesRef = useRef(null);
  const strategyMarkersRef = useRef(null);
  const strategyLineSeriesRef = useRef([]);
  const liveOrderLineSeriesRef = useRef([]);
  const strategyCacheRef = useRef({ key: "", events: [] });
  const heikenAshiCacheRef = useRef([]);
  const pendingLiveCandlesRef = useRef(null);
  const liveRenderFrameRef = useRef(0);
  const analysisModeRef = useRef(false);
  const fullHistoryDatasetRef = useRef([]);
  const dataDiagnosticsRef = useRef({});
  const rawCandlesRef = useRef([]);
  const selectedHistoricalWindowRef = useRef({ mode: "latest" });
  const jumpRequestIdRef = useRef(0);
  const fitAfterRenderRef = useRef(false);
  const requestIdRef = useRef(0);
  const [selectedInterval, setSelectedInterval] = useState(
    persistedState.chartTimeframe ?? "15m",
  );
  const [indicatorSettingsByInterval, setIndicatorSettingsByInterval] = useState(initialIndicatorSettings);
  const [fullHistoryDataset, setFullHistoryDataset] = useState([]);
  const [rawCandles, setRawCandlesState] = useState([]);
  const [selectedHistoricalWindow, setSelectedHistoricalWindow] = useState({
    centerTime: null,
    from: null,
    mode: "latest",
    to: null,
  });
  const [dataDiagnostics, setDataDiagnostics] = useState({
    fullCandles: 0,
    provider: "binance-futures",
    renderedCandles: 0,
    source: "binance-futures",
  });
  const [chartRenderStats, setChartRenderStats] = useState({
    cappedMarkers: 0,
    debugMarkers: 0,
    durationMs: 0,
    hiddenInModeReason: "",
    markerSource: "Brak markerów na wykresie",
    markers: 0,
    markerNote: "",
    renderedCandles: 0,
    skippedMarkers: 0,
    slTpLines: 0,
  });
  const [jumpDate, setJumpDate] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [settings, setSettings] = useState(
    initialIndicatorSettings[persistedState.chartTimeframe ?? "15m"] ?? normalizeIndicatorSettings(persistedState.indicatorSettings),
  );
  const [overlayMode, setOverlayMode] = useState(normalizeOverlayMode(persistedState.chartOverlayMode));
  const [sztabTelemetry, setSztabTelemetry] = useState(null);
  const [livestreamTelemetry, setLivestreamTelemetry] = useState(null);
  const [telemetryDock, setTelemetryDock] = useState("left");
  const [telemetryCompact, setTelemetryCompact] = useState(false);
  const [settingsPanel, setSettingsPanel] = useState(null);
  const [activeBacktestSession, setActiveBacktestSession] = useState(null);
  const [backtestAnalysisActive, setBacktestAnalysisActive] = useState(false);
  const [backtestOverlaySettings, setBacktestOverlaySettings] = useState(defaultBacktestOverlaySettings);
  const [saveStatus, setSaveStatus] = useState({
    state: "Saved",
    lastSavedAt: persistedState.lastSavedAt ?? null,
  });
  const [measurementActive, setMeasurementActive] = useState(false);
  const [measurement, setMeasurement] = useState({
    start: null,
    end: null,
  });
  const [measurementView, setMeasurementView] = useState(null);
  const historyLimit = useMemo(
    () => historyDaysToLimit(selectedInterval, settings.historyDays ?? settings.historyLimit),
    [selectedInterval, settings.historyDays, settings.historyLimit],
  );
  const currentChartPrice = rawCandles.at(-1)?.close ?? null;
  const activeAnalysisSession = backtestAnalysisActive ? activeBacktestSession : null;
  const operationalStates = useMemo(() => {
    return Object.fromEntries(
      timeframes
        .filter((item) => item.interval !== "4h")
        .map((item) => {
          const normalized = normalizeSztabRuntimeForPanel(sztabTelemetry, item.interval);
          return [
            item.interval,
            deriveOperationalState({
              activeAnalysisSession,
              config: normalized.config,
              currentPrice: currentChartPrice,
              interval: item.interval,
              livestream: livestreamTelemetry,
              markerSource: chartRenderStats.markerSource,
              runtime: normalized.runtime,
              selectedHistoricalWindow,
            }),
          ];
        }),
    );
  }, [activeAnalysisSession, chartRenderStats.markerSource, currentChartPrice, livestreamTelemetry, selectedHistoricalWindow, sztabTelemetry]);

  useEffect(() => {
    analysisModeRef.current = Boolean(activeAnalysisSession);
  }, [activeAnalysisSession]);

  useEffect(() => {
    selectedHistoricalWindowRef.current = selectedHistoricalWindow;
  }, [selectedHistoricalWindow]);

  useEffect(() => {
    dataDiagnosticsRef.current = dataDiagnostics;
  }, [dataDiagnostics]);

  const projectMeasurementPoint = useCallback((point) => {
    if (!point || !chartRef.current || !realPriceSeriesRef.current) {
      return null;
    }

    const x = chartRef.current.timeScale().timeToCoordinate(point.time);
    const y = realPriceSeriesRef.current.priceToCoordinate(point.price);

    if (x === null || y === null) {
      return null;
    }

    return {
      ...point,
      x,
      y,
    };
  }, []);

  const refreshMeasurementView = useCallback(
    (nextMeasurement = measurement) => {
      const start = projectMeasurementPoint(nextMeasurement.start);
      const end = projectMeasurementPoint(nextMeasurement.end);

      if (!start) {
        setMeasurementView(null);
        return;
      }

      setMeasurementView({
        start,
        end,
      });
    },
    [measurement, projectMeasurementPoint],
  );

  function resetMeasurement() {
    setMeasurement({
      start: null,
      end: null,
    });
    setMeasurementView(null);
  }

  function toggleMeasurementTool(event) {
    event.stopPropagation();
    setMeasurementActive((currentValue) => {
      if (currentValue) {
        resetMeasurement();
        return false;
      }

      resetMeasurement();
      return true;
    });
  }

  function handleChartClick(event) {
    if (!measurementActive || !chartRef.current || !realPriceSeriesRef.current) {
      return;
    }

    const bounds = chartContainerRef.current?.getBoundingClientRect();

    if (!bounds) {
      return;
    }

    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const price = realPriceSeriesRef.current.coordinateToPrice(y);
    const time = chartRef.current.timeScale().coordinateToTime(x);

    if (price === null || time === null) {
      return;
    }

    const point = {
      price: Number(price),
      time,
      index: getBarIndex(time, rawCandlesRef.current),
    };

    setMeasurement((currentMeasurement) => {
      const nextMeasurement =
        !currentMeasurement.start || currentMeasurement.end
          ? { start: point, end: null }
          : { start: currentMeasurement.start, end: point };

      refreshMeasurementView(nextMeasurement);
      return nextMeasurement;
    });
  }

  function updateSetting(key, value) {
    setSaveStatus((currentStatus) => ({
      ...currentStatus,
      state: "Unsaved changes",
    }));
    setSettings((currentSettings) => {
      const nextSettings = {
        ...currentSettings,
        [key]: value,
      };
      setIndicatorSettingsByInterval((currentByInterval) => ({
        ...currentByInterval,
        [selectedInterval]: nextSettings,
      }));
      return nextSettings;
    });
  }

  function updateSelectedInterval(interval) {
    setSaveStatus((currentStatus) => ({
      ...currentStatus,
      state: "Unsaved changes",
    }));
    clearStrategyLines();
    clearLiveOrderLines();
    strategyMarkersRef.current?.setMarkers([]);
    strategyCacheRef.current = { key: "", events: [] };
    setSelectedHistoricalWindow({
      centerTime: null,
      from: null,
      mode: "latest",
      to: null,
    });
    setIndicatorSettingsByInterval((currentByInterval) => ({
      ...currentByInterval,
      [selectedInterval]: settings,
    }));
    setSettings(indicatorSettingsByInterval[interval] ?? normalizeIndicatorSettings());
    setSelectedInterval(interval);
  }

  function setChartVisibleDataset(candles, shouldFitContent = false, windowMode = {}) {
    const safeCandles = sanitizeChartSeriesData(candles, "chart visible dataset");
    rawCandlesRef.current = safeCandles;
    fitAfterRenderRef.current = shouldFitContent;
    setRawCandlesState(safeCandles);
    setSelectedHistoricalWindow({
      centerTime: windowMode.centerTime ?? null,
      from: safeCandles[0]?.time ?? null,
      mode: windowMode.mode ?? "latest",
      to: safeCandles.at(-1)?.time ?? null,
    });
    setDataDiagnostics((current) => ({
      ...current,
      renderedCandles: safeCandles.length,
      selectedHistoricalWindow: {
        from: safeCandles[0]?.time ?? null,
        mode: windowMode.mode ?? "latest",
        to: safeCandles.at(-1)?.time ?? null,
      },
    }));
  }

  function setFullHistoryDatasetState(candles, diagnostics = {}) {
    const safeCandles = sanitizeChartSeriesData(candles, "full history dataset");
    fullHistoryDatasetRef.current = safeCandles;
    setFullHistoryDataset(safeCandles);
    setDataDiagnostics((current) => ({
      ...current,
      ...diagnostics,
      fullCandles: safeCandles.length,
      provider: diagnostics.provider ?? diagnostics.source ?? current.provider ?? "binance-futures",
      source: diagnostics.source ?? diagnostics.provider ?? current.source ?? "binance-futures",
    }));
  }

  function handleBacktestResult(result, context = {}) {
    if (!result) {
      setActiveBacktestSession(null);
      setBacktestAnalysisActive(false);
      fitAfterRenderRef.current = true;
      return;
    }

    const backtestCandles = context.candles?.length
      ? context.candles
      : filterCandlesByRange(rawCandlesRef.current, result.analysisRange);
    const fullRange = context.range ?? result.analysisRange ?? rangeFromCandles(backtestCandles);
    const focusTime =
      context.focusTime ??
      result.trades?.at(-1)?.entryTime ??
      fullRange.to ??
      backtestCandles.at(-1)?.time;
    const selectedTradeId = context.focusTrade ? tradeKey(context.focusTrade) : null;
    const analysisCandles = chartWindowAround(
      backtestCandles,
      context.timeframe ?? result.timeframe ?? selectedInterval,
      focusTime,
    );
    const session = {
      candles: analysisCandles,
      backtestCandles,
      createdAt: new Date().toISOString(),
      diagnostics: context.diagnostics ?? result.dataDiagnostics ?? null,
      id: result.id ?? `analysis-${Date.now()}`,
      mmDeckName: context.mmDeckName ?? result.mmDeckName ?? "No MM deck",
      range: rangeFromCandles(analysisCandles),
      fullRange,
      result,
      settings: context.settings ?? result.analysisSettings ?? settings,
      strategyDeckName: context.strategyDeckName ?? result.strategyDeckName ?? "Strategy Deck",
      timeframe: context.timeframe ?? result.timeframe ?? selectedInterval,
      viewedTradeId: selectedTradeId,
    };

    setActiveBacktestSession(session);
    setBacktestOverlaySettings((current) => ({
      ...current,
      selectedTradeId,
      showSelectedTradeSlTp: selectedTradeId ? true : current.showSelectedTradeSlTp,
    }));
    setBacktestAnalysisActive(true);
    fitAfterRenderRef.current = true;
  }

  function analyzeBacktestOnChart() {
    if (!activeBacktestSession) return;
    setBacktestAnalysisActive(true);
    fitAfterRenderRef.current = true;
  }

  function viewBacktestTradeOnChart(trade) {
    if (!activeBacktestSession) return;
    const focusTime = trade?.entryTime ?? trade?.exitTime ?? activeBacktestSession.fullRange?.to;
    const selectedTradeId = tradeKey(trade);
    const sourceCandles = activeBacktestSession.backtestCandles?.length
      ? activeBacktestSession.backtestCandles
      : activeBacktestSession.candles;
    const nextCandles = chartWindowAround(sourceCandles, activeBacktestSession.timeframe, focusTime);

    setActiveBacktestSession((currentSession) => currentSession
      ? {
          ...currentSession,
          candles: nextCandles,
          range: rangeFromCandles(nextCandles),
          viewedTradeId: selectedTradeId,
        }
      : currentSession);
    setBacktestOverlaySettings((current) => ({
      ...current,
      selectedTradeId,
      showSelectedTradeSlTp: true,
    }));
    setBacktestAnalysisActive(true);
    fitAfterRenderRef.current = true;
  }

  function exitBacktestAnalysis() {
    setActiveBacktestSession(null);
    setBacktestAnalysisActive(false);
    fitAfterRenderRef.current = true;
    clearStrategyLines();
  }

  function buildExportState() {
    return {
      chartTimeframe: selectedInterval,
      exportedAt: new Date().toISOString(),
      indicatorSettings: settings,
      indicatorSettingsByInterval: {
        ...indicatorSettingsByInterval,
        [selectedInterval]: settings,
      },
      lastSavedAt: saveStatus.lastSavedAt,
      version: 1,
    };
  }

  function exportConfig() {
    const blob = new Blob([JSON.stringify(buildExportState(), null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `choromanski-config-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function importConfig(event) {
    const [file] = event.target.files ?? [];

    if (!file) {
      return;
    }

    const imported = JSON.parse(await file.text());

    if (imported.chartTimeframe) setSelectedInterval(imported.chartTimeframe);
    if (imported.indicatorSettingsByInterval) {
      const nextByInterval = initialIndicatorSettingsByInterval(imported);
      setIndicatorSettingsByInterval(nextByInterval);
      setSettings(nextByInterval[imported.chartTimeframe ?? selectedInterval] ?? normalizeIndicatorSettings(imported.indicatorSettings));
    }
    if (!imported.indicatorSettingsByInterval && imported.indicatorSettings) {
      setSettings({ ...defaultSettings, ...imported.indicatorSettings });
    }
    setSaveStatus({ state: "Unsaved changes", lastSavedAt: saveStatus.lastSavedAt });
    event.target.value = "";
  }

  function applyStrategyConfigToChart(config) {
    setSettings((currentSettings) => {
      const nextSettings = {
        ...currentSettings,
        atrLength: config.atrLength ?? currentSettings.atrLength,
        atrMultiplier: config.atrMultiplier ?? currentSettings.atrMultiplier,
        bandwidth: config.bandwidth ?? currentSettings.bandwidth,
        envelopeMultiplier: config.envelopeMultiplier ?? currentSettings.envelopeMultiplier,
        maxSameSideFailures: config.maxSameSideFailures ?? currentSettings.maxSameSideFailures,
        strategySource: config.strategySource ?? currentSettings.strategySource,
      };
      setIndicatorSettingsByInterval((currentByInterval) => ({
        ...currentByInterval,
        [selectedInterval]: nextSettings,
      }));
      return nextSettings;
    });
  }

  function syncChartFromSztab(interval, strategy = {}) {
    const base = indicatorSettingsByInterval[interval] ?? normalizeIndicatorSettings();
    const nextSettings = normalizeIndicatorSettings({
      ...base,
      atrLength: strategy.atrLength ?? base.atrLength,
      atrMultiplier: strategy.atrMultiplier ?? base.atrMultiplier,
      bandwidth: strategy.bandwidth ?? base.bandwidth,
      envelopeMultiplier: strategy.envelopeMultiplier ?? base.envelopeMultiplier,
      maxSameSideFailures: strategy.maxSameSideFailures ?? base.maxSameSideFailures,
      strategySource: strategy.strategySource ?? base.strategySource,
    });

    setIndicatorSettingsByInterval((currentByInterval) => ({
      ...currentByInterval,
      [interval]: nextSettings,
    }));
    setSettings(nextSettings);
    if (interval !== selectedInterval) {
      clearStrategyLines();
      clearLiveOrderLines();
      strategyMarkersRef.current?.setMarkers([]);
      strategyCacheRef.current = { key: "", events: [] };
      setSelectedHistoricalWindow({
        centerTime: null,
        from: null,
        mode: "latest",
        to: null,
      });
      setSelectedInterval(interval);
    }
    setSaveStatus((currentStatus) => ({
      ...currentStatus,
      state: "Unsaved changes",
    }));
  }

  function resetChartView() {
    chartRef.current?.priceScale("right").applyOptions({
      scaleMargins: {
        top: 0.08,
        bottom: 0.08,
      },
    });
    chartRef.current?.timeScale().scrollToRealTime();
    chartRef.current?.timeScale().fitContent();
    resetMeasurement();
  }

  async function jumpToHistoricalDate() {
    const jumpRequestId = jumpRequestIdRef.current + 1;
    jumpRequestIdRef.current = jumpRequestId;
    const targetSeconds = localDateInputToSeconds(jumpDate);

    if (!Number.isFinite(targetSeconds)) {
      setError("Choose a valid jump date.");
      return;
    }

    if (activeBacktestSession?.backtestCandles?.length) {
      viewBacktestTradeOnChart({ entryTime: targetSeconds, id: `jump-${targetSeconds}` });
      return;
    }

    const halfWindowSeconds = Math.floor(DEFAULT_CHART_WINDOW_DAYS * 86400 / 2);
    clearStrategyLines();
    strategyMarkersRef.current?.setMarkers([]);
    setIsLoading(true);
    setError("");

    try {
      const payload = await fetchHistoricalCandles({
        from: new Date((targetSeconds - halfWindowSeconds) * 1000).toISOString(),
        maxCandles: ABSOLUTE_CHART_RENDER_CAP,
        provider: "binance-futures",
        symbol: "SOLUSDT",
        timeframe: selectedInterval,
        to: new Date((targetSeconds + halfWindowSeconds) * 1000).toISOString(),
      });

      if (jumpRequestIdRef.current !== jumpRequestId) {
        return;
      }

      const visibleCandles = chartWindowAround(payload.candles, selectedInterval, targetSeconds);

      setFullHistoryDatasetState(payload.candles, payload.diagnostics);
      setChartVisibleDataset(visibleCandles, true, {
        centerTime: targetSeconds,
        mode: "historical",
      });
    } catch (jumpError) {
      setError(jumpError instanceof Error ? jumpError.message : "Unable to load that historical chart window.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const lastSavedAt = new Date().toISOString();
      writeStoredJson(PLATFORM_STORAGE_KEY, {
        chartTimeframe: selectedInterval,
        chartOverlayMode: overlayMode,
        indicatorSettings: settings,
        indicatorSettingsByInterval: {
          ...indicatorSettingsByInterval,
          [selectedInterval]: settings,
        },
        lastSavedAt,
        version: 1,
      });
      setSaveStatus({ state: "Saved", lastSavedAt });
    }, 350);

    return () => window.clearTimeout(timeoutId);
  }, [indicatorSettingsByInterval, overlayMode, selectedInterval, settings]);

  const clearStrategyLines = useCallback(() => {
    if (!chartRef.current) {
      strategyLineSeriesRef.current = [];
      return;
    }

    strategyLineSeriesRef.current.forEach((series) => {
      try {
        chartRef.current?.removeSeries(series);
      } catch {
        // lightweight-charts can throw during HMR/reload if a series has already been detached.
      }
    });
    strategyLineSeriesRef.current = [];
  }, []);

  const addStrategySegment = useCallback(({ color, lineStyle = 0, lineWidth = 1, title = "", value, startTime, endTime, showLabel }) => {
    if (!chartRef.current) {
      return false;
    }

    const data = sanitizeOverlayEvents([
      { time: startTime, value },
      { time: endTime, value },
    ], "strategy segment");

    if (data.length < 2) {
      return false;
    }

    const lineSeries = chartRef.current.addSeries(LineSeries, {
      color,
      lineWidth,
      lineStyle,
      title,
      priceLineVisible: false,
      lastValueVisible: showLabel,
      crosshairMarkerVisible: false,
      priceFormat: {
        type: "price",
        precision: 2,
        minMove: 0.01,
      },
    });

    lineSeries.setData(data);
    strategyLineSeriesRef.current.push(lineSeries);
    return true;
  }, []);

  const clearLiveOrderLines = useCallback(() => {
    if (!chartRef.current) {
      liveOrderLineSeriesRef.current = [];
      return;
    }

    liveOrderLineSeriesRef.current.forEach((series) => {
      try {
        chartRef.current?.removeSeries(series);
      } catch {
        // lightweight-charts can throw during HMR/reload if a series has already been detached.
      }
    });
    liveOrderLineSeriesRef.current = [];
  }, []);

  const addLiveOrderSegment = useCallback(({ color, lineStyle = 0, lineWidth = 2, title = "", value, startTime, endTime }) => {
    if (!chartRef.current || !Number.isFinite(Number(value))) {
      return false;
    }

    const data = sanitizeOverlayEvents([
      { time: startTime, value: Number(value) },
      { time: endTime, value: Number(value) },
    ], "live trigger segment");

    if (data.length < 2) return false;

    const lineSeries = chartRef.current.addSeries(LineSeries, {
      color,
      lineWidth,
      lineStyle,
      title,
      priceLineVisible: true,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
      priceFormat: {
        type: "price",
        precision: 2,
        minMove: 0.01,
      },
    });

    lineSeries.setData(data);
    liveOrderLineSeriesRef.current.push(lineSeries);
    return true;
  }, []);

  useEffect(() => {
    clearStrategyLines();
    clearLiveOrderLines();
    strategyMarkersRef.current?.setMarkers([]);
    strategyCacheRef.current = { key: "", events: [] };
    setChartRenderStats((current) => ({
      ...current,
      hiddenInModeReason: "",
      markerSource: `Ładowanie nakładek dla ${displayInterval(selectedInterval)}`,
      markers: 0,
      skippedMarkers: 0,
      slTpLines: 0,
    }));
  }, [clearLiveOrderLines, clearStrategyLines, selectedInterval]);

  const renderStrategyLines = useCallback(
    (events, candles, currentOverlayMode = "live") => {
      clearStrategyLines();

      const normalizedMode = normalizeOverlayMode(currentOverlayMode);
      const operationalMode = normalizedMode === "operational";
      if (normalizedMode === "live" || (!operationalMode && !settings.showSl && !settings.showTrigger)) {
        return;
      }

      overlayModeStrategyEvents(events, normalizedMode)
        .filter((event) => {
          if (event.type === STRATEGY_EVENT_TYPES.SETUP_ACTIVE) return normalizedMode === "operational" || settings.showBenchmarks || normalizedMode === "debug";
          if (event.type === STRATEGY_EVENT_TYPES.SETUP_INVALIDATED) return normalizedMode === "operational" || settings.showNegated || normalizedMode === "debug";
          return true;
        })
        .forEach((event) => {
          if (!Number.isFinite(event.trigger) || !Number.isFinite(event.stopLoss)) {
            return;
          }

          const startIndex = event.benchmarkIndex ?? event.index;
          const triggerEndIndex = Math.min(startIndex + 6, candles.length - 1);
          const stopEndIndex = Math.min(startIndex + 8, candles.length - 1);
	          const triggerEndTime = candles[triggerEndIndex]?.time ?? event.time;
	          const stopEndTime = candles[stopEndIndex]?.time ?? event.time;
	          const historyMode = normalizedMode === "history";
            const direction = canonicalDirection(event.direction);
	          const triggerColor = direction === "LONG"
	            ? operationalMode ? "rgba(34, 197, 94, 0.72)" : "rgba(245, 245, 245, 0.24)"
	            : operationalMode ? "rgba(239, 68, 68, 0.72)" : "rgba(5, 5, 5, 0.28)";
          const stopColor = operationalMode ? "rgba(245, 125, 52, 0.6)" : "rgba(120, 24, 24, 0.18)";
          const startTime = event.benchmarkTime ?? event.time;
          const historical = selectedHistoricalWindowRef.current?.mode === "historical";
          const setupState = event.type === STRATEGY_EVENT_TYPES.SETUP_INVALIDATED
            ? "ANULOWANY SETUP"
            : event.type === STRATEGY_EVENT_TYPES.SETUP_ACTIVE
              ? "ACTIVE SETUP TARGET"
              : "SYMULOWANY ENTRY";
	          const triggerTitle = historical
	            ? `HISTORYCZNY TRIGGER ${direction}`.trim()
	            : `${setupState} — TRIGGER ${direction}`.trim();
	          const slTitle = historical
	            ? "HISTORYCZNY SL SYMULACJI"
	            : event.type === STRATEGY_EVENT_TYPES.SETUP_ACTIVE
	              ? `AKTYWNY POZIOM SL SETUPU ${direction}`.trim()
	              : "SYMULOWANY SL";
	
	          if (settings.showTrigger || operationalMode) {
	            addStrategySegment({
              color: triggerColor,
              lineStyle: historyMode ? 2 : 0,
              lineWidth: operationalMode ? 2 : 1,
              title: triggerTitle,
              value: event.trigger,
              startTime,
              endTime: triggerEndTime,
              showLabel: normalizedMode === "debug",
            });
          }

	          if (settings.showSl && !operationalMode) {
            addStrategySegment({
              color: stopColor,
              lineStyle: 2,
              lineWidth: operationalMode ? 2 : 1,
              title: slTitle,
              value: event.stopLoss,
              startTime,
              endTime: stopEndTime,
              showLabel: false,
            });
          }
        });
    },
    [
      addStrategySegment,
      clearStrategyLines,
      settings.showSl,
      settings.showBenchmarks,
      settings.showNegated,
      settings.showTrigger,
    ],
  );

  const renderBacktestLines = useCallback(
    (result, overlaySettings, candles = [], currentOverlayMode = "live") => {
      clearStrategyLines();

      const normalizedMode = normalizeOverlayMode(currentOverlayMode);
      if (!["history", "debug"].includes(normalizedMode)) {
        return 0;
      }

      const selectedTradeId = overlaySettings.selectedTradeId;
      const showSelected = overlaySettings.showSelectedTradeSlTp && selectedTradeId;
      const showVisible = overlaySettings.showVisibleTradeSlTp || overlaySettings.showSlTp;

      if (!showSelected && !showVisible) {
        return 0;
      }

      const times = candles.length ? candleTimeSet(candles) : null;
      let linesRendered = 0;
      visibleBacktestTrades(result, candles)
        .filter((trade) => !times || times.has(trade.entryTime) || times.has(trade.exitTime))
        .filter((trade, index) => showVisible || tradeKey(trade, index) === selectedTradeId)
        .filter((trade) => Number.isFinite(Number(trade.stopLoss)) || Number.isFinite(Number(trade.takeProfit)))
        .slice(-MAX_STRATEGY_LINE_EVENTS / 2)
        .forEach((trade) => {
          const startTime = trade.entryTime;
          const endTime = trade.exitReason === "END"
            ? result.analysisRange?.to ?? trade.exitTime ?? trade.entryTime
            : trade.exitTime ?? trade.entryTime;

	          if (Number.isFinite(Number(trade.stopLoss))) {
		            const rendered = addStrategySegment({
		              color: "rgba(120, 24, 24, 0.72)",
		              endTime,
	              lineStyle: 2,
	              lineWidth: 1,
	              showLabel: normalizedMode === "debug",
	              title: "SYMULOWANY SL — BACKTEST",
		              startTime,
		              value: Number(trade.stopLoss),
		            });
	            if (rendered) linesRendered += 1;
	          }
	
	          if (Number.isFinite(Number(trade.takeProfit))) {
		            const rendered = addStrategySegment({
		              color: "rgba(89, 168, 255, 0.86)",
		              endTime,
	              lineStyle: 2,
	              lineWidth: 1,
	              showLabel: normalizedMode === "debug",
	              title: "SYMULOWANY TP — BACKTEST",
		              startTime,
		              value: Number(trade.takeProfit),
		            });
	            if (rendered) linesRendered += 1;
	          }
        });

      return linesRendered;
    },
    [addStrategySegment, clearStrategyLines],
  );

  const renderMarket = useCallback(
    (candles, shouldFitContent = false, mode = {}) => {
      if (!candleSeriesRef.current || !realPriceSeriesRef.current) {
        return;
      }

      const renderStartedAt = performance.now();
      const renderSettings = mode.settings ?? settings;
      const chartCandles = sanitizeChartSeriesData(candles, "raw candles");
      const heikenAshiCandles = sanitizeChartSeriesData(toHeikenAshi(chartCandles), "heiken ashi candles");
      const indicatorCandles =
        renderSettings.strategySource === "raw-exchange" ? chartCandles : heikenAshiCandles;
      const envelope = calculateNadarayaEnvelope(indicatorCandles, {
        bandwidth: renderSettings.bandwidth,
        multiplier: renderSettings.envelopeMultiplier,
      });
      const realPriceLine = sanitizeChartSeriesData(chartCandles.map((candle) => ({
        time: candle.time,
        value: candle.close,
      })), "real price line");
      const upperLine = renderSettings.showBands
        ? sanitizeChartSeriesData(toLineData(envelope, "upper"), "upper band")
        : [];
      const lowerLine = renderSettings.showBands
        ? sanitizeChartSeriesData(toLineData(envelope, "lower"), "lower band")
        : [];

      heikenAshiCacheRef.current = heikenAshiCandles;
      candleSeriesRef.current.setData(heikenAshiCandles);
      upperSeriesRef.current?.setData(upperLine);
      lowerSeriesRef.current?.setData(lowerLine);
      realPriceSeriesRef.current.setData(realPriceLine);

      const currentOverlayMode = normalizeOverlayMode(overlayMode);
      const overlayModeText = overlayModeDefinition(currentOverlayMode).label;

      if (mode.analysisResult) {
        const effectiveOverlaySettings = overlayBacktestSettings(mode.overlaySettings, currentOverlayMode);
        const markers = sanitizeMarkers(
          labelMarkers(toBacktestAnalysisMarkers(mode.analysisResult, effectiveOverlaySettings, chartCandles), "BACKTEST"),
          "backtest analysis markers",
        );
        strategyMarkersRef.current?.setMarkers(markers);
        const slTpLines = renderBacktestLines(mode.analysisResult, effectiveOverlaySettings, chartCandles, currentOverlayMode);
        const visibleTrades = renderedTradeCount(mode.analysisResult, chartCandles, effectiveOverlaySettings);
        const debugMarkers = effectiveOverlaySettings?.showDebug
          ? markers.filter((marker) => String(marker.id ?? "").startsWith("analysis-debug")).length
          : 0;
        const totalTrades = mode.analysisResult?.trades?.length ?? 0;
		        setChartRenderStats({
		          cappedMarkers: Math.max(0, totalTrades - visibleTrades),
		          debugMarkers,
		          durationMs: Math.round(performance.now() - renderStartedAt),
              hiddenInModeReason: currentOverlayMode === "live" && totalTrades > 0
                ? "Markery backtestu są ukryte w LIVE ONLY, bo ten tryb pokazuje tylko realny stan live."
                : currentOverlayMode === "operational" && totalTrades > markers.length
                ? "Tryb OPERACYJNY nie pokazuje pełnej historii backtestu; przełącz HISTORIA/DEBUG."
                : "",
              markerNote: currentOverlayMode === "live"
                ? "Tryb LIVE ONLY ukrywa markery backtestu, aby live stan był czytelny."
                : "Markery backtestu są symulacją/analityką. Nie są live zleceniami ani pozycjami BingX.",
	              markerSource: `${overlayModeText} · ${displayInterval(selectedInterval)} · markery analizy backtestu`,
		          markers: markers.length,
		          renderedCandles: chartCandles.length,
		          skippedMarkers: Math.max(0, totalTrades - visibleTrades),
		          slTpLines,
	        });
	      } else {
	        const closedCandles = chartCandles.filter((candle) => candle.isClosed !== false);
	        const closedHeikenAshiCandles = sanitizeChartSeriesData(toHeikenAshi(closedCandles), "closed heiken ashi candles");
	        const strategyCandles =
	          renderSettings.strategySource === "raw-exchange" ? closedCandles : closedHeikenAshiCandles;
        const closedEnvelope = calculateNadarayaEnvelope(strategyCandles, {
          bandwidth: renderSettings.bandwidth,
          multiplier: renderSettings.envelopeMultiplier,
        });
        const lastClosedCandle = closedCandles[closedCandles.length - 1];
	        const strategyKey = [
            selectedInterval,
	          closedCandles.length,
	          lastClosedCandle?.time ?? 0,
          renderSettings.bandwidth,
          renderSettings.envelopeMultiplier,
          renderSettings.atrLength,
          renderSettings.atrMultiplier,
          renderSettings.maxSameSideFailures,
          renderSettings.strategySource,
        ].join(":");
        let strategyEvents = strategyCacheRef.current.events;

        if (strategyCacheRef.current.key !== strategyKey) {
          const strategyResult = evaluateChoromanskiStrategy({
            sourceCandles: strategyCandles,
            envelope: closedEnvelope,
            inputs: {
              atrLength: renderSettings.atrLength,
              atrMultiplier: renderSettings.atrMultiplier,
              maxSameSideFailures: renderSettings.maxSameSideFailures,
            },
          });
          strategyCacheRef.current = {
            key: strategyKey,
            events: strategyResult.events,
          };
          strategyEvents = strategyResult.events;
          globalThis.__CHOROMANSKI_DEBUG_EXPORT__ = strategyResult.debugRows;
          globalThis.__CHOROMANSKI_SETUP_AUDIT__ = strategyResult.setupAudits;
          console.debug("Choromanski debug export available at window.__CHOROMANSKI_DEBUG_EXPORT__");
          console.debug("Choromanski setup audit available at window.__CHOROMANSKI_SETUP_AUDIT__");
        }

		        const markerEvents = canonicalStrategyOverlayEvents(strategyEvents);
		        const cappedMarkerEvents = overlayModeMarkerEvents(markerEvents, currentOverlayMode);
        const markerLabelPrefix = selectedHistoricalWindowRef.current?.mode === "historical" ? "HISTORIA" : "SYMULACJA";
	        const strategyMarkers = sanitizeMarkers(labelMarkers(toStrategyMarkers(cappedMarkerEvents), markerLabelPrefix), "strategy markers");

	        strategyMarkersRef.current?.setMarkers(strategyMarkers);
		        renderStrategyLines(strategyEvents, closedCandles, currentOverlayMode);
		        setChartRenderStats({
		          cappedMarkers: Math.max(0, markerEvents.length - cappedMarkerEvents.length),
		          debugMarkers: 0,
		          durationMs: Math.round(performance.now() - renderStartedAt),
              hiddenInModeReason: currentOverlayMode === "live" && markerEvents.length > 0
                ? "Sygnały strategii są ukryte w LIVE ONLY, bo ten tryb pokazuje tylko realny stan live."
                : currentOverlayMode === "operational" && markerEvents.length > cappedMarkerEvents.length
                ? "Tryb OPERACYJNY pokazuje tylko najnowszy istotny sygnał; starsze są w HISTORIA/DEBUG."
                : "",
              markerNote: currentOverlayMode === "live"
                ? "Tryb LIVE ONLY ukrywa historyczne/symulowane markery strategii. Zmień tryb na OPERACYJNY, HISTORIA albo DEBUG, żeby je zobaczyć."
                : selectedHistoricalWindowRef.current?.mode === "historical"
                ? "Historyczne sygnały na wykresie nie oznaczają, że bot był wtedy online."
                : "Najnowsze markery są live-egzekwowalne tylko wtedy, gdy runner Sztabu widzi je w swoim aktualnym oknie decyzyjnym.",
              markerSource: selectedHistoricalWindowRef.current?.mode === "historical"
                ? `${overlayModeText} · ${displayInterval(selectedInterval)} · historyczne sygnały wykresu`
                : `${overlayModeText} · ${displayInterval(selectedInterval)} · okno live/najnowszych sygnałów`,
		          markers: strategyMarkers.length,
		          renderedCandles: chartCandles.length,
		          skippedMarkers: Math.max(0, markerEvents.length - cappedMarkerEvents.length),
		          slTpLines: strategyLineSeriesRef.current.length,
	        });
      }

      if (shouldFitContent) {
        chartRef.current?.timeScale().fitContent();
      }
    },
    [overlayMode, renderBacktestLines, renderStrategyLines, selectedInterval, settings],
  );

  const scheduleLiveCandleUpdate = useCallback((candles) => {
    if (analysisModeRef.current) {
      return;
    }

    pendingLiveCandlesRef.current = candles;

    if (liveRenderFrameRef.current) {
      return;
    }

    liveRenderFrameRef.current = window.requestAnimationFrame(() => {
      liveRenderFrameRef.current = 0;
      const nextCandles = pendingLiveCandlesRef.current;
	      const latestRaw = nextCandles?.[nextCandles.length - 1];
	
	      if (!latestRaw || !candleSeriesRef.current || !realPriceSeriesRef.current) {
	        return;
	      }
	
	      const latestTime = chartTimeValue(latestRaw.time);
	      const lastCachedTime = chartTimeValue(heikenAshiCacheRef.current.at(-1)?.time);
	
	      if (latestTime === null || (lastCachedTime !== null && latestTime < lastCachedTime)) {
	        warnSanitizedChartData("live candle update", {
	          staleUpdate: lastCachedTime !== null && latestTime !== null && latestTime < lastCachedTime ? 1 : 0,
	          invalid: latestTime === null ? 1 : 0,
	        });
	        return;
	      }
	
	      const haCache = heikenAshiCacheRef.current;
	      const previousHa = haCache[haCache.length - 2];
      const latestHa = toIncrementalHeikenAshi(latestRaw, previousHa);

      if (haCache.length === nextCandles.length) {
        haCache[haCache.length - 1] = latestHa;
      }

      candleSeriesRef.current.update(latestHa);
      realPriceSeriesRef.current.update({
        time: latestRaw.time,
        value: latestRaw.close,
      });
    });
  }, []);

  useEffect(() => {
    const container = chartContainerRef.current;

    if (!container) {
      return undefined;
    }

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { color: "#bdbdbd" },
        textColor: "#151515",
        fontFamily:
          "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        fontSize: 12,
      },
      grid: {
        vertLines: { color: "rgba(0, 0, 0, 0.08)" },
        horzLines: { color: "rgba(0, 0, 0, 0.075)" },
      },
      localization: {
        priceFormatter: (price) => price.toFixed(2),
        timeFormatter: formatChartTime,
      },
      rightPriceScale: {
        visible: true,
        borderVisible: true,
        borderColor: "rgba(0, 0, 0, 0.28)",
        entireTextOnly: true,
        scaleMargins: {
          top: 0.08,
          bottom: 0.08,
        },
      },
      leftPriceScale: {
        visible: false,
      },
      timeScale: {
        borderVisible: true,
        borderColor: "rgba(0, 0, 0, 0.28)",
        rightOffset: 8,
        barSpacing: 8.5,
        minBarSpacing: 2,
        timeVisible: true,
        secondsVisible: false,
        shiftVisibleRangeOnNewBar: false,
        tickMarkFormatter: formatChartAxisTime,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: "rgba(0, 0, 0, 0.42)",
          labelBackgroundColor: "#111111",
          style: 3,
          width: 1,
        },
        horzLine: {
          color: "rgba(0, 0, 0, 0.42)",
          labelBackgroundColor: "#111111",
          style: 3,
          width: 1,
        },
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: {
          time: true,
          price: true,
        },
        axisDoubleClickReset: {
          time: true,
          price: true,
        },
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#f4f4f4",
      downColor: "#050505",
      borderUpColor: "#f4f4f4",
      borderDownColor: "#050505",
      wickUpColor: "#f4f4f4",
      wickDownColor: "#050505",
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: {
        type: "price",
        precision: 2,
        minMove: 0.01,
      },
    });

    const upperSeries = chart.addSeries(LineSeries, {
      color: "#f5f5f5",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const lowerSeries = chart.addSeries(LineSeries, {
      color: "#080808",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const realPriceSeries = chart.addSeries(LineSeries, {
      color: "rgba(0, 0, 0, 0)",
      lineWidth: 1,
      priceLineVisible: true,
      priceLineColor: "rgba(0, 0, 0, 0.68)",
      priceLineWidth: 1,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
      priceFormat: {
        type: "price",
        precision: 2,
        minMove: 0.01,
      },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    upperSeriesRef.current = upperSeries;
    lowerSeriesRef.current = lowerSeries;
    realPriceSeriesRef.current = realPriceSeries;
    strategyMarkersRef.current = createSeriesMarkers(candleSeries, [], {
      zOrder: "top",
    });

    return () => {
      if (liveRenderFrameRef.current) {
        window.cancelAnimationFrame(liveRenderFrameRef.current);
        liveRenderFrameRef.current = 0;
      }
      clearStrategyLines();
      chartRef.current = null;
      candleSeriesRef.current = null;
      upperSeriesRef.current = null;
      lowerSeriesRef.current = null;
      realPriceSeriesRef.current = null;
      strategyMarkersRef.current = null;
      chart.remove();
    };
  }, [clearStrategyLines]);

  useEffect(() => {
    if (!chartRef.current) {
      return undefined;
    }

    const handleVisibleRangeChange = () => {
      refreshMeasurementView();
    };

    chartRef.current.timeScale().subscribeVisibleTimeRangeChange(handleVisibleRangeChange);

    return () => {
      chartRef.current?.timeScale().unsubscribeVisibleTimeRangeChange(handleVisibleRangeChange);
    };
  }, [refreshMeasurementView]);

  useEffect(() => {
    if (!measurement.start) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      refreshMeasurementView();
    }, 250);

    return () => window.clearInterval(intervalId);
  }, [measurement, refreshMeasurementView]);

  useEffect(() => {
    let ignore = false;
    let closeSocket = null;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    function updateRawCandle(nextCandle) {
      const currentFullCandles = fullHistoryDatasetRef.current;
      const lastCandle = currentFullCandles[currentFullCandles.length - 1];
      let updatedFullCandles = currentFullCandles;

      if (!lastCandle || nextCandle.time > lastCandle.time) {
        updatedFullCandles = [...currentFullCandles, nextCandle].slice(-historyLimit);
      } else if (nextCandle.time === lastCandle.time) {
        updatedFullCandles = [...currentFullCandles.slice(0, -1), nextCandle];
      }

      if (updatedFullCandles === currentFullCandles) {
        return;
      }

      fullHistoryDatasetRef.current = updatedFullCandles;

      if (selectedHistoricalWindowRef.current.mode !== "latest") {
        setFullHistoryDatasetState(updatedFullCandles, {
          fullCandles: updatedFullCandles.length,
          provider: dataDiagnosticsRef.current.provider,
          source: dataDiagnosticsRef.current.source,
        });
        return;
      }

      const visibleCandles = chartWindowAround(updatedFullCandles, selectedInterval);

      if (nextCandle.isClosed || nextCandle.time > lastCandle?.time) {
        setFullHistoryDatasetState(updatedFullCandles, {
          fullCandles: updatedFullCandles.length,
          provider: dataDiagnosticsRef.current.provider,
          source: dataDiagnosticsRef.current.source,
        });
        setChartVisibleDataset(visibleCandles, false, { mode: "latest" });
        return;
      }

      rawCandlesRef.current = visibleCandles;
      setDataDiagnostics((current) => ({
        ...current,
        renderedCandles: visibleCandles.length,
      }));
      scheduleLiveCandleUpdate(visibleCandles);
    }

    async function loadMarketData() {
      setIsLoading(true);
      setError("");
      clearStrategyLines();
      clearLiveOrderLines();
      strategyMarkersRef.current?.setMarkers([]);

      try {
        const payload = await fetchHistoricalCandles({
          maxCandles: historyLimit,
          provider: "binance-futures",
          symbol: "SOLUSDT",
          timeframe: selectedInterval,
        });
        const candles = payload.candles;

        if (ignore || requestIdRef.current !== requestId) {
          return;
        }

        setFullHistoryDatasetState(candles, payload.diagnostics);
        setChartVisibleDataset(chartWindowAround(candles, selectedInterval), true, { mode: "latest" });
        closeSocket = createSolKlineSocket(selectedInterval, {
          onCandle: (candle) => {
            if (ignore || requestIdRef.current !== requestId) {
              return;
            }

            updateRawCandle(candle);
          },
          onError: (socketError) => {
            if (!ignore) {
              setError(
                socketError instanceof Error
                  ? socketError.message
                  : "Binance websocket connection error.",
              );
            }
          },
        });
      } catch (loadError) {
        if (!ignore) {
          setError(loadError instanceof Error ? loadError.message : "Unable to load SOLUSDT data.");
        }
      } finally {
        if (!ignore) {
          setIsLoading(false);
        }
      }
    }

    loadMarketData();

    return () => {
      ignore = true;
      closeSocket?.();
    };
  }, [clearStrategyLines, historyLimit, scheduleLiveCandleUpdate, selectedInterval]);

  useEffect(() => {
    if (activeAnalysisSession) {
      const analysisCandles = activeAnalysisSession.candles?.length
        ? activeAnalysisSession.candles
        : filterCandlesByRange(rawCandles, activeAnalysisSession.range);

      if (analysisCandles.length > 0) {
        renderMarket(analysisCandles, fitAfterRenderRef.current, {
          analysisResult: activeAnalysisSession.result,
          overlaySettings: backtestOverlaySettings,
          settings: activeAnalysisSession.settings,
        });
        fitAfterRenderRef.current = false;
      }
      return;
    }

    if (rawCandles.length > 0) {
      renderMarket(rawCandles, fitAfterRenderRef.current);
      fitAfterRenderRef.current = false;
    }
  }, [activeAnalysisSession, backtestOverlaySettings, rawCandles, renderMarket]);

  useEffect(() => {
    let ignore = false;

    async function refreshSztabTelemetry() {
      const fetchedAt = new Date().toISOString();
      try {
        const [status, livestream] = await Promise.all([
          apiFetch("/sztab/status"),
          apiFetch("/livestream?fresh=1").catch(() => null),
        ]);
        if (!ignore) {
          setSztabTelemetry({
            ...status,
            __frontendFetchedAt: fetchedAt,
            __frontendFetchError: "",
          });
          if (livestream) setLivestreamTelemetry(livestream);
        }
      } catch (error) {
        if (!ignore) {
          const message = error instanceof Error ? error.message : String(error);
          setSztabTelemetry((current) => ({
            ...(current ?? {}),
            __frontendFetchError: message,
            __frontendFetchFailedAt: fetchedAt,
          }));
        }
      }
    }

    refreshSztabTelemetry();
    const intervalId = window.setInterval(refreshSztabTelemetry, 5_000);
    return () => {
      ignore = true;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    clearLiveOrderLines();
    const normalized = normalizeSztabRuntimeForPanel(sztabTelemetry, selectedInterval);
    const runtime = normalized.runtime;
    const selectedConfig = normalized.config ?? {};
    const pending = runtime?.pendingTriggerOrder;
    const setup = runtime?.latestSetupEvent;
    const livePosition = positionsForOperationalState(livestreamTelemetry, selectedConfig)[0] ?? null;
    const protection = liveProtectionState({ livePosition, pending, runtime });
    const firstTime = rawCandles[0]?.time;
    const lastTime = rawCandles.at(-1)?.time;

    if (!runtime || !firstTime || !lastTime) return;

    buildSemanticLiveOverlays({
      firstTime,
      interval: selectedInterval,
      lastTime,
      livePosition,
      mode: overlayMode,
      pending,
      protection,
      setup,
    }).filter((line) => line.interval === selectedInterval).forEach((line) => {
      const auditEntry = {
        interval: selectedInterval,
        label: line.label,
        labelDirection: canonicalDirection(line.direction),
        mode: overlayMode,
        price: line.value,
        semanticType: line.type,
        setupFingerprint: line.setupFingerprint ?? pending?.setupFingerprint ?? setup?.setupFingerprint ?? "",
        setupId: line.setupId ?? pending?.setupId ?? setup?.setupId ?? "",
        sourceDirection: canonicalDirection(line.direction),
        sourceEventTimestamp: line.sourceTime ?? setup?.time ?? pending?.entryEvent?.time ?? null,
        sourceField: line.sourceField,
        sourceInterval: line.sourceInterval ?? selectedInterval,
      };
      globalThis.__CHOROMANSKI_OVERLAY_AUDIT__ = [
        ...(globalThis.__CHOROMANSKI_OVERLAY_AUDIT__ ?? []).slice(-30),
        auditEntry,
      ];
      addLiveOrderSegment({
        color: line.color,
        endTime: line.endTime,
        lineStyle: line.lineStyle,
        lineWidth: line.lineWidth,
        startTime: line.startTime,
        title: line.label,
        value: line.value,
      });
    });
  }, [addLiveOrderSegment, clearLiveOrderLines, livestreamTelemetry, overlayMode, rawCandles, selectedInterval, sztabTelemetry]);

  return (
    <main className="hubert-dashboard">
      <header className="hubert-toolbar" aria-label="Trading controls">
        <div className="hubert-toolbar__group">
          <button className="hubert-button hubert-button--symbol" type="button">
            SOLUSDT
          </button>

          {timeframes.map((timeframe) => (
            <button
              aria-pressed={selectedInterval === timeframe.interval}
              className="hubert-button"
              data-active={selectedInterval === timeframe.interval}
              key={timeframe.interval}
              onClick={() => updateSelectedInterval(timeframe.interval)}
              type="button"
            >
              {timeframe.label}
            </button>
          ))}
        </div>

        <div className="hubert-toolbar__group hubert-toolbar__group--tools">
          <button
            className="hubert-button hubert-button--sztab"
            data-active={settingsPanel === "Sztab Generalny"}
            onClick={() => {
              setSettingsPanel((currentPanel) => (currentPanel === "Sztab Generalny" ? null : "Sztab Generalny"));
            }}
            type="button"
          >
            Sztab Generalny
          </button>
          {toolGroups.map((group) => {
            const groupActive = group.items.includes(settingsPanel);
            return (
              <details className="hubert-toolbar-menu" data-active={groupActive} key={group.label} open={groupActive}>
                <summary>{group.label}</summary>
                <div>
                  {group.items.map((label) => (
                    <button
                      className="hubert-button"
                      data-active={settingsPanel === label}
                      key={label}
                      onClick={() => {
                        setSettingsPanel((currentPanel) => (currentPanel === label ? null : label));
                      }}
                      type="button"
                    >
                      {label}
                    </button>
                  ))}
                  {group.label === "System" && (
                    <>
                      <button className="hubert-button" onClick={exportConfig} type="button">
                        Export
                      </button>
                      <button className="hubert-button" onClick={() => importInputRef.current?.click()} type="button">
                        Import
                      </button>
                    </>
                  )}
                </div>
              </details>
            );
          })}
          <button
            className="hubert-button"
            data-active={settingsPanel === "AI"}
            onClick={() => {
              setSettingsPanel((currentPanel) => (currentPanel === "AI" ? null : "AI"));
            }}
            type="button"
          >
            AI
          </button>
          <input
            accept="application/json"
            className="hubert-hidden-input"
            onChange={importConfig}
            ref={importInputRef}
            type="file"
          />
        </div>
      </header>

      <div className="hubert-save-status">
        <strong>{saveStatus.state}</strong>
        <span>{saveStatus.lastSavedAt ? `Last saved at ${formatChartTime(Math.floor(new Date(saveStatus.lastSavedAt).getTime() / 1000))}` : "Autosave ready"}</span>
      </div>

      {settingsPanel && (
        <ControlCenter
          activePanel={settingsPanel}
          activeBacktestSession={activeBacktestSession}
          backtestAnalysisActive={backtestAnalysisActive}
          onApplyChart={applyStrategyConfigToChart}
          onAnalyzeBacktest={analyzeBacktestOnChart}
          onBacktestResult={handleBacktestResult}
          onClearBacktest={exitBacktestAnalysis}
          onClose={() => setSettingsPanel(null)}
          onExitBacktestAnalysis={exitBacktestAnalysis}
          onResetChartView={resetChartView}
          onViewBacktestTrade={viewBacktestTradeOnChart}
          chartDiagnostics={dataDiagnostics}
          fullHistoryDataset={fullHistoryDataset}
          rawCandles={rawCandles}
          selectedHistoricalWindow={selectedHistoricalWindow}
          selectedInterval={selectedInterval}
          setActivePanel={setSettingsPanel}
          setSelectedInterval={updateSelectedInterval}
          settings={settings}
          indicatorSettingsByInterval={indicatorSettingsByInterval}
          onSyncChartFromSztab={syncChartFromSztab}
          updateSetting={updateSetting}
        />
      )}

      <section className="hubert-brand" aria-label="Choromanski Trading Platform">
        <h1>Choromański</h1>
        <p>TRADING PLATFORM</p>
      </section>

      {activeAnalysisSession && (
        <BacktestAnalysisBanner
          renderStats={chartRenderStats}
          overlaySettings={backtestOverlaySettings}
          session={activeAnalysisSession}
          onAnalyze={analyzeBacktestOnChart}
          onExit={exitBacktestAnalysis}
          onToggle={(key, value) =>
            setBacktestOverlaySettings((current) => ({
              ...current,
              [key]: value,
            }))
          }
        />
      )}

      <div
        className="hubert-chart"
        onClick={handleChartClick}
        onDoubleClick={resetChartView}
        ref={chartContainerRef}
        title="Kliknij dwukrotnie, aby wyśrodkować wykres na aktualnym zakresie"
      />

      <div className="hubert-window-panel" aria-label="Kontrola okna wykresu">
        <strong>{dataDiagnostics.provider ?? "binance-futures"}</strong>
        <span>{rawCandles.length} świec na wykresie / {fullHistoryDataset.length || dataDiagnostics.fullCandles || 0} w pamięci</span>
        <span>{chartRenderStats.markers} markerów · {chartRenderStats.slTpLines} linii · {chartRenderStats.durationMs}ms render</span>
        <span title={chartRenderStats.markerNote}>{chartRenderStats.markerSource}</span>
        {chartRenderStats.hiddenInModeReason && <span>{chartRenderStats.hiddenInModeReason}</span>}
        <span>{selectedHistoricalWindow.mode === "historical" ? "Okno historyczne" : "Okno live/najnowsze"}</span>
        <span>Czas: {DISPLAY_TIME_ZONE}</span>
        <div className="hubert-overlay-mode" aria-label="Tryb nakładek wykresu">
          {overlayModes.map((mode) => (
            <button
              data-active={overlayMode === mode.id}
              key={mode.id}
              onClick={() => setOverlayMode(mode.id)}
              title={mode.note}
              type="button"
            >
              {mode.label}
            </button>
          ))}
        </div>
        <div>
          <input
            aria-label="Skocz do daty"
            type="date"
            value={jumpDate}
            onChange={(event) => setJumpDate(event.target.value)}
          />
          <button type="button" onClick={jumpToHistoricalDate}>Skocz</button>
        </div>
      </div>

      <OperationalTelemetryPanel
        compact={telemetryCompact}
        dock={telemetryDock}
        selectedInterval={selectedInterval}
        states={operationalStates}
        onDock={setTelemetryDock}
        onSelectInterval={updateSelectedInterval}
        onToggleCompact={() => setTelemetryCompact((value) => !value)}
      />

      {measurementView?.start && (
        <MeasurementOverlay measurementView={measurementView} />
      )}

      <button
        aria-pressed={measurementActive}
        className="hubert-ruler-tool"
        data-active={measurementActive}
        onClick={toggleMeasurementTool}
        type="button"
        aria-label="Narzędzie pomiaru procentowego"
      >
        %
      </button>

      <button
        className="hubert-reset-tool"
        onClick={resetChartView}
        type="button"
        aria-label="Wyśrodkuj wykres"
        title="Wyśrodkuj wykres na aktualnym zakresie i przywróć domyślny zoom."
      >
        Wyśrodkuj
      </button>

      {(isLoading || error) && (
        <div className="hubert-chart-state" role="status">
          {error || "Ładowanie danych SOLUSDT z Binance"}
        </div>
      )}
    </main>
  );
}

function BacktestAnalysisBanner({ overlaySettings, renderStats, session, onAnalyze, onExit, onToggle }) {
  const range = session.range ?? rangeFromCandles(session.candles);
  const fullRange = session.fullRange ?? range;
  const tradeCount = session.result?.trades?.length ?? 0;
  const renderedCount = renderedTradeCount(session.result, session.candles, overlaySettings);
  const hasMismatch = overlaySettings.showTrades && renderedCount !== tradeCount;
  const hasEndTrade = Boolean(session.result?.trades?.some((trade) => trade.exitReason === "END"));

  return (
    <aside className="hubert-backtest-banner" aria-label="Tryb analizy backtestu">
      <div className="hubert-backtest-banner__head">
        <div>
          <strong>Tryb analizy backtestu</strong>
          <span>
            {session.strategyDeckName} · {session.mmDeckName} · {session.timeframe} · {tradeCount} transakcji
          </span>
          <span>Okno historyczne z backtestu: {formatChartTime(range.from)} → {formatChartTime(range.to)}</span>
          <span>Pełny zakres testu: {formatChartTime(fullRange.from)} → {formatChartTime(fullRange.to)}</span>
          <span>{session.candles?.length ?? 0} świec na wykresie · {session.backtestCandles?.length ?? session.result?.candlesUsed ?? "--"} świec backtestu</span>
          <span className={hasMismatch ? "hubert-backtest-banner__warning" : ""}>
            Transakcje w tabeli: {tradeCount} · pokazane na wykresie: {renderedCount}
          </span>
        </div>
        <div className="hubert-backtest-banner__actions">
          <button type="button" onClick={onAnalyze}>Pokaż na wykresie</button>
          <button type="button" onClick={onExit}>Wyjdź z analizy</button>
        </div>
      </div>
      <div className="hubert-backtest-banner__toggles">
        {[
          ["showTrades", "Transakcje"],
          ["showSelectedTradeSlTp", "SL/TP wybranej transakcji"],
          ["showPnlLabels", "Etykiety PnL"],
        ].map(([key, label]) => (
          <label key={key}>
            <input
              checked={Boolean(overlaySettings[key])}
              type="checkbox"
              onChange={(event) => onToggle(key, event.target.checked)}
            />
            <span>{label}</span>
          </label>
        ))}
        <details className="hubert-backtest-advanced">
          <summary>Szczegóły techniczne</summary>
          <label>
            <input checked={Boolean(overlaySettings.showExits)} type="checkbox" onChange={(event) => onToggle("showExits", event.target.checked)} />
            <span>Markery wyjścia</span>
          </label>
          <label>
            <input checked={Boolean(overlaySettings.showVisibleTradeSlTp || overlaySettings.showSlTp)} type="checkbox" onChange={(event) => onToggle("showVisibleTradeSlTp", event.target.checked)} />
            <span>SL/TP widocznych transakcji</span>
          </label>
          <label>
            <input checked={Boolean(overlaySettings.showDebug)} type="checkbox" onChange={(event) => onToggle("showDebug", event.target.checked)} />
            <span>Pominięte markery diagnostyczne</span>
          </label>
          <span>
            Render: {renderStats?.renderedCandles ?? 0} świec · {renderStats?.markers ?? 0} markerów · {renderStats?.slTpLines ?? 0} linii · {renderStats?.durationMs ?? 0}ms
          </span>
        </details>
      </div>
      {hasMismatch && (
        <div className="hubert-backtest-banner__warning">
          Markery na wykresie są ograniczone dla płynnego zoomu i przesuwania. Tabela nadal zawiera pełny zapis.
        </div>
      )}
      {hasEndTrade && (
        <div className="hubert-backtest-banner__warning">
          END oznacza, że symulowana transakcja była nadal otwarta na końcu zakresu testu. To nie jest live pozycja.
        </div>
      )}
      {overlaySettings.showDebug && (
        <div className="hubert-backtest-legend">
          <span><b />Brak HA = brak potwierdzenia Heikin Ashi</span>
          <span><b />Kandydat = sprawdzony kandydat setupu</span>
          <span><b />W pozycji = strategia była już w setupie/transakcji</span>
          <span><b />Limiter SL = blokada po serii SL po tej samej stronie</span>
          <span><b />MM nieważny = błędny sizing / money management</span>
        </div>
      )}
    </aside>
  );
}

function MeasurementOverlay({ measurementView }) {
  const { start, end } = measurementView;
  const activeEnd = end ?? start;
  const delta = activeEnd.price - start.price;
  const percent = start.price === 0 ? 0 : (delta / start.price) * 100;
  const bars =
    start.index !== null && activeEnd.index !== null
      ? Math.abs(activeEnd.index - start.index)
      : null;
  const isRaise = delta >= 0;
  const color = isRaise ? "#f5f5f5" : "#050505";
  const labelX = Math.min(Math.max(activeEnd.x + 12, 12), window.innerWidth - 170);
  const labelY = Math.min(Math.max(activeEnd.y - 44, 12), window.innerHeight - 72);

  return (
    <svg className="hubert-measurement-overlay" aria-hidden="true">
      <line
        className="hubert-measurement-guide"
        x1={start.x}
        y1={start.y}
        x2={activeEnd.x}
        y2={start.y}
      />
      <line
        className="hubert-measurement-guide"
        x1={activeEnd.x}
        y1={start.y}
        x2={activeEnd.x}
        y2={activeEnd.y}
      />
      {end && (
        <line
          className="hubert-measurement-line"
          stroke={color}
          x1={start.x}
          y1={start.y}
          x2={end.x}
          y2={end.y}
        />
      )}
      <circle className="hubert-measurement-point" cx={start.x} cy={start.y} r="4" />
      {end && (
        <circle
          className="hubert-measurement-point"
          cx={end.x}
          cy={end.y}
          r="4"
          fill={color}
        />
      )}
      {end && (
        <foreignObject x={labelX} y={labelY} width="158" height="62">
          <div className="hubert-measurement-label">
            <strong>{formatMeasurementValue(delta)}</strong>
            <span>{formatMeasurementValue(percent)}%</span>
            <span>{bars === null ? "--" : `${bars} bars`}</span>
          </div>
        </foreignObject>
      )}
    </svg>
  );
}

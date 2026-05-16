import { useEffect, useMemo, useRef, useState } from "react";
import { runBacktest } from "../backtest/backtestEngine";
import { BACKEND_URL, backendApiUrl, dashboardAuthHeaders } from "../api/backend";
import { fetchHistoricalCandles } from "../api/binance";
import {
  isRecord,
  safeObjectRows,
  safeOrderId,
  safeStringRows,
  setupFingerprintShort,
} from "../utils/sztabRuntimeGuards";

const PANEL_GROUPS = [
  {
    label: "Decks",
    tabs: ["Indicator", "Strategy Decks", "MM Decks", "Battle Decks", "Favorites"],
  },
  {
    label: "Centrum Decyzyjne",
    tabs: ["Livestream", "Execution", "Decision", "Crisis"],
  },
  {
    label: "Backtest",
    tabs: ["Backtests", "Compare"],
  },
  {
    label: "System",
    tabs: ["System", "Analytics", "Communication"],
  },
];

const DISPLAY_TIME_ZONE = import.meta.env.VITE_DISPLAY_TIME_ZONE || "Europe/Warsaw";
const DISPLAY_LOCALE = import.meta.env.VITE_DISPLAY_LOCALE || "pl-PL";
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  month: "2-digit",
  second: "2-digit",
  timeZone: DISPLAY_TIME_ZONE,
  year: "numeric",
});
const TIMEFRAMES = [
  { label: "10m", interval: "10m", minutes: 10 },
  { label: "15m", interval: "15m", minutes: 15 },
  { label: "20m", interval: "20m", minutes: 20 },
  { label: "30m", interval: "30m", minutes: 30 },
  { label: "1H", interval: "1h", minutes: 60 },
  { label: "4H", interval: "4h", minutes: 240 },
];
const SZTAB_TIMEFRAMES = TIMEFRAMES.filter((item) => item.interval !== "4h");
const PREVIEW_CURVE_POINTS = 420;
const BACKTEST_CHART_TRADE_LIMIT = 500;
const TRADE_TABLE_PAGE_SIZE = 50;
const STORED_BACKTEST_EVENT_LIMIT = 1000;
const SWEEP_DEFAULT_COMBINATIONS = 200;
const SWEEP_MAX_COMBINATIONS = 1000;
const SWEEP_RETAINED_LIMIT = 100;
const ACTIVE_SWEEP_STORAGE_KEY = "hubert.activeSweepId.v1";
const RECENT_SWEEPS_STORAGE_KEY = "hubert.recentSweeps.v1";
const RECENT_SWEEP_LIMIT = 8;
const SZTAB_STORAGE_KEY = "hubert.sztabGeneralny.v1";
const SWEEP_RANKING_OBJECTIVES = [
  ["overall", "Overall score"],
  ["net", "Net profit"],
  ["pf", "Profit factor"],
  ["win", "Win %"],
  ["rrr", "RRR"],
  ["streak", "Max wins streak"],
  ["dd", "Lowest DD"],
  ["trades", "Trade count"],
];

const defaultStrategyDeck = {
  allowLong: true,
  allowShort: true,
  atrLength: 14,
  atrMultiplier: 1.2,
  atrPositionSizing: false,
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
  sizingMode: "position-percent",
  strategySource: "pine-ha",
  symbol: "SOLUSDT",
  timeframe: "15m",
  triggerLines: false,
};

const defaultMmDeck = {
  fixedNotional: 100,
  maxExposurePercent: 100000,
  maxLeverage: 1000,
  mode: "run",
  name: "",
  oneSlPercent: 1,
  positionPercent: 10,
};

function createDefaultSztabIntervalConfig(timeframe) {
  return {
    apiProfile: "",
    botStatus: "stopped",
    lastAppliedAt: "",
    lastAppliedBy: "",
    locked: false,
    mm: {
      riskPerSlPercent: 1,
    },
    mmDirty: false,
    mmLocked: false,
    mmSavedAt: null,
    strategy: {
      ...defaultStrategyDeck,
      timeframe: timeframe.interval,
    },
    strategyDirty: false,
    strategyLocked: false,
    strategySavedAt: null,
    symbol: "SOLUSDT",
    runtime: {
      candlesLoaded: 0,
      candlesRequested: 0,
      closedCandlesUsed: 0,
      crisisModeOn: false,
      crisisManualLock: false,
      dataAgeSeconds: null,
      error: "",
      executionAllowed: true,
      globalBlockers: [],
      globalExecutionState: "enabled",
      heartbeatAt: null,
      intervalBlockers: [],
      lastCandle: null,
      lastClosedCandleTime: null,
      lastDecision: "",
      lastDecisionReason: "",
      lastOrderAttempt: null,
      lastBlockedReason: "",
      lastError: "",
      lastExchangeResponse: null,
      lastLoopDurationMs: null,
      lastTickAt: null,
      latestEntryEvent: null,
      latestSetupEvent: null,
      lastSignal: null,
      lastSyncAt: null,
      profileConnected: false,
      startedAt: null,
      status: "stopped",
      stoppedAt: null,
      tickCount: 0,
      tradingEnabled: true,
      tradingBlockedForAI: false,
      legacySafetyAgeSeconds: null,
      legacySafetyStale: false,
      legacySafetyStatus: "NOT_CHECKED",
      legacySafetyWarnings: [],
      validNweBandCount: 0,
    },
    validation: {
      checkedAt: "",
      errors: [],
      message: "Not validated yet.",
      ok: false,
      warnings: [],
    },
  };
}

function createDefaultSztabState() {
  return {
    activeTab: "general",
    expanded: false,
    intervals: Object.fromEntries(
      SZTAB_TIMEFRAMES.map((timeframe) => [timeframe.interval, createDefaultSztabIntervalConfig(timeframe)]),
    ),
    updatedAt: "",
    version: 1,
  };
}

function mergeSztabState(stored) {
  const defaults = createDefaultSztabState();
  const storedIntervals = stored?.intervals && typeof stored.intervals === "object" ? stored.intervals : {};

  return {
    ...defaults,
    ...stored,
    activeTab: stored?.activeTab && ["general", ...SZTAB_TIMEFRAMES.map((item) => item.interval)].includes(stored.activeTab)
      ? stored.activeTab
      : defaults.activeTab,
    intervals: Object.fromEntries(
      SZTAB_TIMEFRAMES.map((timeframe) => {
        const current = storedIntervals[timeframe.interval] ?? {};
        const base = createDefaultSztabIntervalConfig(timeframe);
        return [
          timeframe.interval,
          {
            ...base,
            ...current,
            mm: {
              ...base.mm,
              ...(current.mm ?? {}),
            },
            runtime: {
              ...base.runtime,
              ...(current.runtime ?? {}),
            },
            strategy: {
              ...base.strategy,
              ...(current.strategy ?? {}),
              timeframe: timeframe.interval,
            },
            validation: {
              ...base.validation,
              ...(current.validation ?? {}),
            },
          },
        ];
      }),
    ),
  };
}

function readSztabState() {
  if (typeof window === "undefined") return createDefaultSztabState();

  try {
    return mergeSztabState(JSON.parse(window.localStorage.getItem(SZTAB_STORAGE_KEY) ?? "null"));
  } catch {
    return createDefaultSztabState();
  }
}

function writeSztabState(value) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(SZTAB_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Sztab persistence is operational convenience only; never block the dashboard.
  }
}

const defaultBacktestForm = {
  commissionPercent: 0.04,
  fillMode: "legacy",
  from: "",
  lastDays: 31,
  mmDeckId: "",
  name: "",
  provider: "binance-futures",
  slippagePercent: 0,
  startingBalance: 10000,
  strategyDeckId: "",
  timeframe: "15m",
  to: "",
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
  manualFillMode: "legacy",
  manualFixedNotionalValues: "100",
  manualFrom: "",
  manualLastDays: 31,
  manualMaxSameSideFailures: "2",
  manualPositionValues: "10",
  manualPrimaryObjective: "overall",
  manualRangeMode: "rolling",
  manualRiskValues: "1",
  manualSizingMode: "run-position",
  manualStartingBalance: 10000,
  manualStrategySource: "pine-ha",
  manualSymbol: "SOLUSDT",
  manualTimeframe: "15m",
  manualTo: "",
  maxCombinations: SWEEP_DEFAULT_COMBINATIONS,
  sweepAdvancedCapacity: false,
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

function readRecentSweeps() {
  if (typeof window === "undefined") return [];

  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_SWEEPS_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.slice(0, RECENT_SWEEP_LIMIT) : [];
  } catch {
    return [];
  }
}

function writeRecentSweeps(sweeps = []) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(RECENT_SWEEPS_STORAGE_KEY, JSON.stringify(sweeps.slice(0, RECENT_SWEEP_LIMIT)));
  } catch {
    // Sweep persistence is a UX convenience; never fail a research run because local storage is full.
  }
}

function readActiveSweepId() {
  if (typeof window === "undefined") return "";

  try {
    return window.localStorage.getItem(ACTIVE_SWEEP_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeActiveSweepId(id) {
  if (typeof window === "undefined") return;

  try {
    if (id) {
      window.localStorage.setItem(ACTIVE_SWEEP_STORAGE_KEY, id);
    } else {
      window.localStorage.removeItem(ACTIVE_SWEEP_STORAGE_KEY);
    }
  } catch {
    // Sweep persistence is a UX convenience; never fail a research run because local storage is full.
  }
}

function apiUrl(path) {
  return backendApiUrl(path);
}

async function apiFetch(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...dashboardAuthHeaders(options.headers ?? {}),
  };
  const response = await fetch(apiUrl(path), {
    ...options,
    cache: options.cache ?? "no-store",
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

async function apiFetchDetailed(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...dashboardAuthHeaders(options.headers ?? {}),
  };
  const response = await fetch(apiUrl(path), {
    ...options,
    cache: options.cache ?? "no-store",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));

  return {
    ok: response.ok,
    payload,
    status: response.status,
  };
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
  const sizingMode = deck.sizingMode ?? (deck.atrPositionSizing ? "fixed-risk" : "position-percent");

  return {
    ...deck,
    atrLength: requireNumber(deck.atrLength, "ATR length", { positive: true }),
    atrMultiplier: requireNumber(deck.atrMultiplier, "ATR multiplier", { positive: true }),
    atrPositionSizing: sizingMode === "fixed-risk",
    bandwidth: requireNumber(deck.bandwidth, "Bandwidth", { positive: true }),
    envelopeMultiplier: requireNumber(deck.envelopeMultiplier, "NWE multiplier", { positive: true }),
    maxSameSideFailures: requireNumber(deck.maxSameSideFailures, "Max same-side failures", { min: 0 }),
    sizingMode,
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
    maxExposurePercent: isBlank(deck.maxExposurePercent) ? 100000 : requireNumber(deck.maxExposurePercent, "Max exposure cap", { positive: true }),
    maxLeverage: isBlank(deck.maxLeverage) ? 1000 : requireNumber(deck.maxLeverage, "Max leverage cap", { positive: true }),
  };
}

function normalizeBacktestForm(form) {
  const hasExplicitRange = !isBlank(form.from) || !isBlank(form.to);

  return {
    ...form,
    commissionPercent: requireNumber(form.commissionPercent, "Commission", { min: 0 }),
    lastDays: hasExplicitRange && isBlank(form.lastDays)
      ? ""
      : requireNumber(form.lastDays, "Last X days", { positive: true }),
    slippagePercent: requireNumber(form.slippagePercent, "Slippage", { min: 0 }),
    startingBalance: requireNumber(form.startingBalance, "Starting balance", { positive: true }),
  };
}

function dateText(time) {
  if (!time) return "--";
  const value = typeof time === "number"
    ? time > 10_000_000_000 ? time : time * 1000
    : time;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? DATE_TIME_FORMATTER.format(date) : "--";
}

function compactDateText(time) {
  if (!time) return "Unavailable";
  return dateText(time);
}

function secondsSince(time) {
  if (!time) return null;
  const value = typeof time === "number" ? time * 1000 : new Date(time).getTime();
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.floor((Date.now() - value) / 1000));
}

function ageText(time) {
  const seconds = secondsSince(time);
  if (seconds === null) return "Unavailable";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function eventText(event) {
  if (!isRecord(event)) return "--";
  const side = event.direction ? `${event.direction} ` : "";
  const type = event.type ?? "event";
  const id = event.setupId ? ` ${event.setupId}` : "";
  const fingerprint = event.setupFingerprintShort ? ` · ${event.setupFingerprintShort}` : "";
  const time = event.time ? ` @ ${dateText(event.time)}` : "";
  return `${side}${type}${id}${fingerprint}${time}`;
}

function triggerFailureCandidateText(runtime = {}) {
  const safeRuntime = isRecord(runtime) ? runtime : {};
  const pending = isRecord(safeRuntime.pendingTriggerOrder) ? safeRuntime.pendingTriggerOrder : {};
  const diagnostics = safeRuntime.lastTriggerFailureDiagnostics ?? pending.failureDiagnostics ?? {};
  if (diagnostics.triggerAlreadyCrossed) return "trigger_price_invalid_or_crossed";
  return safeRuntime.lastTriggerFailureCandidate || pending.failureCandidate || "--";
}

function triggerMarginDiagnostics(runtime = {}) {
  const safeRuntime = isRecord(runtime) ? runtime : {};
  const pending = isRecord(safeRuntime.pendingTriggerOrder) ? safeRuntime.pendingTriggerOrder : {};
  const diagnostics = safeRuntime.triggerMarginDiagnostics ??
    safeRuntime.lastTriggerFailureDiagnostics ??
    pending.failureDiagnostics ??
    pending.placementDiagnostics ??
    {};
  const marginSafety = diagnostics.marginSafety ?? pending.marginSafety ?? {};
  const available = diagnostics.available ?? {};
  const availableMargin = Number(available.availableMargin);
  const marginRequired = Number(diagnostics.marginRequired);
  const marginHeadroom = Number.isFinite(Number(diagnostics.marginHeadroom))
    ? Number(diagnostics.marginHeadroom)
    : Number.isFinite(availableMargin) && Number.isFinite(marginRequired)
      ? availableMargin - marginRequired
      : null;
  const marginHeadroomPct = Number.isFinite(Number(diagnostics.marginHeadroomPct))
    ? Number(diagnostics.marginHeadroomPct)
    : Number.isFinite(availableMargin) && availableMargin > 0 && Number.isFinite(marginHeadroom)
      ? (marginHeadroom / availableMargin) * 100
      : null;
  const warnings = new Set([...(diagnostics.warnings ?? [])]);
  if (Number.isFinite(availableMargin) && Number.isFinite(marginRequired) && marginRequired > availableMargin) {
    warnings.add("order_too_large_for_available_margin");
  }
  if (marginSafety.capApplied) warnings.add("margin_safety_cap_applied");
  if (marginSafety.reason === "margin_safety_cap_below_min_order_size") warnings.add("margin_safety_cap_below_min_order_size");
  const riskBasis = Number(marginSafety.riskBasis ?? available.equity ?? availableMargin);
  const requestedRiskUsdt = Number(marginSafety.requestedRiskAmount);
  const actualRiskUsdt = Number(marginSafety.riskAmountAfterCap);
  const requestedRiskPercent = Number.isFinite(Number(marginSafety.requestedRiskPercent))
    ? Number(marginSafety.requestedRiskPercent)
    : Number.isFinite(riskBasis) && riskBasis > 0 && Number.isFinite(requestedRiskUsdt)
      ? (requestedRiskUsdt / riskBasis) * 100
      : null;
  const actualRiskPercent = Number.isFinite(Number(marginSafety.riskPercentAfterCap))
    ? Number(marginSafety.riskPercentAfterCap)
    : Number.isFinite(riskBasis) && riskBasis > 0 && Number.isFinite(actualRiskUsdt)
      ? (actualRiskUsdt / riskBasis) * 100
      : null;
  return {
    accountBalanceUsed: Number(marginSafety.accountBalanceUsed ?? marginSafety.riskBasis ?? available.equity ?? available.balance),
    accountRiskAmount: Number(marginSafety.accountRiskAmount ?? marginSafety.requestedRiskAmount),
    actualRiskPercent,
    actualRiskUsdt,
    availableMargin,
    balance: Number(available.balance),
    capApplied: Boolean(marginSafety.capApplied),
    desiredEstimatedRequiredMargin: Number(marginSafety.desiredEstimatedRequiredMargin),
    desiredMarginRequired: Number(marginSafety.desiredMarginRequired),
    desiredQuantity: Number(marginSafety.desiredQuantity),
    equity: Number(available.equity),
    estimatedRequiredMarginWithBuffer: Number(marginSafety.estimatedRequiredMarginAfterCap ?? diagnostics.estimatedRequiredMarginWithBuffer),
    finalQuantity: Number(marginSafety.finalQuantity ?? diagnostics.quantity),
    finalRiskAtSL: Number(marginSafety.finalRiskAtSL ?? marginSafety.riskAmountAfterCap),
    finalRiskAtSLPercentOfAccount: Number(marginSafety.finalRiskAtSLPercentOfAccount ?? marginSafety.riskPercentAfterCap),
    leverage: diagnostics.leverage,
    marginHeadroom: Number.isFinite(Number(marginSafety.marginHeadroomAfterCap)) ? Number(marginSafety.marginHeadroomAfterCap) : marginHeadroom,
    marginHeadroomPct: Number.isFinite(Number(marginSafety.marginHeadroomAfterCap)) && Number.isFinite(availableMargin) && availableMargin > 0
      ? (Number(marginSafety.marginHeadroomAfterCap) / availableMargin) * 100
      : marginHeadroomPct,
    marginMode: diagnostics.marginMode,
    marginRequired,
    marginSafetyReason: marginSafety.reason ?? "",
    marginUsageCap: Number(marginSafety.marginUsageCap),
    maxAllowedRequiredMargin: Number(marginSafety.maxAllowedRequiredMargin),
    notional: Number(diagnostics.notional),
    requestedRiskPercent,
    requestedRiskUsdt,
    riskBasis,
    rawQtyFromAccountRisk: Number(marginSafety.rawQtyFromAccountRisk ?? marginSafety.desiredQuantity),
    slDistance: Number(marginSafety.slDistance),
    cappedQtyReason: marginSafety.cappedQtyReason ?? marginSafety.reason ?? "",
    usedMargin: Number(available.usedMargin ?? available.raw?.usedMargin ?? available.raw?.used ?? available.raw?.freezedMargin),
    warnings: [...warnings],
  };
}

function dataFreshnessTone(time) {
  const seconds = secondsSince(time);
  if (seconds === null) return "bad";
  if (seconds > 120) return "bad";
  if (seconds > 45) return "neutral";
  return "good";
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

function positionIdentifier(position) {
  return (
    position?.positionId ??
    position?.positionID ??
    position?.id ??
    position?.position_id ??
    null
  );
}

function positionCardKey(position) {
  return [
    compact(position?.apiProfile ?? "main"),
    compact(position?.symbol ?? "symbol"),
    compact(position?.positionSide ?? position?.side ?? "side"),
    positionIdentifier(position) ?? compact(position?.quantity ?? "no-id"),
  ].join(":");
}

function manualActionLabel(action) {
  return {
    CANCEL_ATTACHED_ORDERS: "Cancel Protection/Orders",
    CLOSE_POSITION: "Close Position",
    MOVE_SL: "Move SL",
    MOVE_TP: "Move TP",
  }[action] ?? "Send manual action";
}

function protectionOrder(position, kind) {
  const orders = safeObjectRows(position?.attachedOrders);
  const wantsTp = kind === "TP";

  return orders.find((order) => {
    const type = String(order.type ?? order.orderType ?? order.origType ?? "").toUpperCase();
    const purpose = String(order.protectionType ?? order.protectionKind ?? order.tpslType ?? "").toUpperCase();
    const hasTpText = type.includes("TAKE") || purpose.includes("TAKE") || purpose.includes("TP");
    const hasSlText = type.includes("STOP") || purpose.includes("STOP") || purpose.includes("SL");

    if (wantsTp) return hasTpText;
    return hasSlText && !hasTpText;
  });
}

function takeProfitOrderLike(order = {}) {
  if (!isRecord(order)) return false;
  const type = String(order.type ?? order.orderType ?? order.origType ?? order.planType ?? "").toUpperCase();
  const purpose = String(order.protectionType ?? order.protectionKind ?? order.tpslType ?? "").toUpperCase();
  return type.includes("TAKE") || purpose.includes("TAKE") || purpose.includes("TP");
}

function protectionSourceText(position, kind) {
  const order = protectionOrder(position, kind);
  const source = kind === "TP"
    ? position?.takeProfitSource
    : position?.stopLossSource;
  const price = kind === "TP" ? position?.takeProfit : position?.stopLoss;
  const orderId = safeOrderId(order);
  const orderPrice = order?.stopPrice ?? order?.price ?? order?.triggerPrice;

  if (source || order) {
    return `${source ?? "open order"}${orderId ? ` · order ${orderId}` : ""}${orderPrice ? ` · ${fmt(orderPrice)}` : ""}`;
  }

  if (Number(price) > 0) return `position field · ${fmt(price)}`;
  return "not found";
}

function humanProfileStatus(profile = {}) {
  const status = String(profile.status ?? "").toLowerCase();
  if (profile.configured === false || status.includes("missing")) return "Missing";
  if (status.includes("connected")) return "Connected";
  if (status.includes("sync")) return "Stale";
  if (profile.configured) return "Configured";
  return "Unavailable";
}

function profileStatusTitle(profile = {}) {
  if (humanProfileStatus(profile) === "Stale") {
    return "Backend could not refresh this profile recently. Try Refresh Status.";
  }

  return humanProfileStatus(profile);
}

function displayExitReason(reason) {
  if (reason === "END") return "END / open until test end";
  return reason ?? "--";
}

function fillModeLabel(mode) {
  return mode === "conservative" ? "Conservative" : "Current / Legacy";
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

async function loadHistoricalBacktestDataset(form, fallbackCandles = []) {
  const timeframe = form.timeframe ?? form.manualTimeframe ?? "15m";
  const provider = form.provider ?? "binance-futures";
  const symbol = (form.symbol ?? form.manualSymbol ?? "SOLUSDT").trim().toUpperCase();
  const fallbackLast = fallbackCandles.at(-1)?.time;
  const to = form.to
    ? new Date(form.to).toISOString()
    : fallbackLast
      ? new Date(fallbackLast * 1000).toISOString()
      : new Date().toISOString();
  const toSeconds = Math.floor(new Date(to).getTime() / 1000);
  const from = form.from
    ? new Date(form.from).toISOString()
    : new Date((toSeconds - Number(form.lastDays || 31) * 86400) * 1000).toISOString();

  return fetchHistoricalCandles({
    from,
    maxCandles: 90000,
    provider,
    symbol,
    timeframe,
    to,
  });
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

function strategyDraftFromAiRow(row, run) {
  const params = row?.params ?? {};
  const snapshot = row?.settings ?? row?.provenance?.strategySettings ?? {};
  return {
    ...defaultStrategyDeck,
    allowLong: snapshot.allowLong ?? defaultStrategyDeck.allowLong,
    allowShort: snapshot.allowShort ?? defaultStrategyDeck.allowShort,
    atrLength: params.atrLength ?? 14,
    atrMultiplier: params.atrMultiplier ?? 1.2,
    atrPositionSizing: params.sizingMode === "fixed-risk",
    bandwidth: params.bandwidth ?? 8,
    confirmedEntries: snapshot.confirmedEntries ?? defaultStrategyDeck.confirmedEntries,
    diagnosticSetups: snapshot.diagnosticSetups ?? defaultStrategyDeck.diagnosticSetups,
    envelopeMultiplier: params.envelopeMultiplier ?? 3,
    maxSameSideFailures: params.maxSameSideFailures ?? 2,
    name: `AI Config ${row?.rank ? `#${row.rank}` : ""}`.trim(),
    negatedSetups: snapshot.negatedSetups ?? defaultStrategyDeck.negatedSetups,
    showSl: snapshot.showSl ?? defaultStrategyDeck.showSl,
    showTrigger: snapshot.showTrigger ?? defaultStrategyDeck.showTrigger,
    sizingMode: params.sizingMode ?? run?.plan?.sizingMode ?? "position-percent",
    slLines: snapshot.slLines ?? defaultStrategyDeck.slLines,
    strategySource: snapshot.strategySource ?? defaultStrategyDeck.strategySource,
    symbol: row?.symbol ?? snapshot.symbol ?? run?.plan?.symbol ?? "SOLUSDT",
    timeframe: row?.timeframe ?? snapshot.timeframe ?? run?.plan?.timeframe ?? "15m",
    triggerLines: snapshot.triggerLines ?? defaultStrategyDeck.triggerLines,
  };
}

function mmDeckFromAiRow(row) {
  const params = row?.params ?? {};
  const sizingMode = params.sizingMode ?? "position-percent";
  const sizeValue = Number(params.sizingValue);

  return {
    ...defaultMmDeck,
    name: `AI MM ${row?.rank ? `#${row.rank}` : ""}`.trim(),
    oneSlPercent: sizingMode === "fixed-risk" && Number.isFinite(sizeValue) ? sizeValue : defaultMmDeck.oneSlPercent,
    positionPercent: sizingMode === "position-percent" && Number.isFinite(sizeValue) ? sizeValue : defaultMmDeck.positionPercent,
  };
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

function equityCurveForResult(result) {
  if (result?.equityCurve?.length) return result.equityCurve;
  const startingBalance = Number(result?.config?.startingBalance ?? result?.metrics?.endingBalance ?? 10000) - Number(result?.metrics?.netProfit ?? 0);
  let equity = Number.isFinite(startingBalance) ? startingBalance : 10000;
  const trades = result?.trades ?? [];
  const curve = [{
    equity,
    time: result?.analysisRange?.from ?? trades[0]?.entryTime ?? 0,
  }];

  trades.forEach((trade) => {
    equity += Number(trade.netPnl ?? trade.pnl ?? 0);
    curve.push({
      equity,
      time: trade.exitTime ?? trade.entryTime ?? curve.at(-1)?.time ?? 0,
    });
  });

  if (curve.length === 1 && result?.analysisRange?.to) {
    curve.push({ equity, time: result.analysisRange.to });
  }

  return curve;
}

function equityStats(equityCurve = []) {
  if (!equityCurve.length) {
    return {
      end: 0,
      from: null,
      highWater: 0,
      maxDrawdownPercent: 0,
      min: 0,
      start: 0,
      to: null,
    };
  }

  let peak = Number(equityCurve[0]?.equity ?? 0);
  let maxDrawdownPercent = 0;
  const values = equityCurve.map((point) => Number(point.equity ?? 0));

  equityCurve.forEach((point) => {
    const equity = Number(point.equity ?? 0);
    peak = Math.max(peak, equity);
    const drawdown = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    maxDrawdownPercent = Math.max(maxDrawdownPercent, drawdown);
  });

  return {
    end: values.at(-1) ?? 0,
    from: equityCurve[0]?.time ?? null,
    highWater: Math.max(...values),
    maxDrawdownPercent,
    min: Math.min(...values),
    start: values[0] ?? 0,
    to: equityCurve.at(-1)?.time ?? null,
  };
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
  if (key === "oneSlPercent") return "Fixed Risk Per Trade";
  if (key === "positionPercent") return "Position Percent";
  return "Default size";
}

function sweepSizingModeForKey(key) {
  if (key === "oneSlPercent") return "fixed-risk";
  if (key === "fixedNotional") return "constant";
  return "position-percent";
}

function engineSizingModeForKey(key) {
  return key === "oneSlPercent" ? "fixed-risk" : "position-percent";
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
      values: parseSweepNumberList(form.manualPositionValues, "Position Percent values", { positive: true }),
    };
  }

  return {
    atrPositionSizing: true,
    key: "oneSlPercent",
    values: parseSweepNumberList(form.manualRiskValues, "Fixed Risk target values", { positive: true }),
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
  const explicitRange = form.manualRangeMode === "explicit";

  return {
    ...backtestForm,
    fillMode: form.manualFillMode ?? backtestForm.fillMode ?? "legacy",
    from: explicitRange ? form.manualFrom : "",
    lastDays: explicitRange ? "" : form.manualLastDays,
    startingBalance: form.manualStartingBalance,
    to: explicitRange ? form.manualTo : "",
  };
}

function sweepRankingObjectiveLabel(value) {
  return SWEEP_RANKING_OBJECTIVES.find(([key]) => key === value)?.[1] ?? "Overall score";
}

function sweepObjectiveValue(row = {}, objective = "overall") {
  if (objective === "net") return Number(row.netProfit ?? -Infinity);
  if (objective === "pf") return Number(row.profitFactor ?? -Infinity);
  if (objective === "win") return Number(row.winRate ?? -Infinity);
  if (objective === "rrr") return Number(row.rrr ?? -Infinity);
  if (objective === "streak") return Number(sweepMaxWins(row) ?? -Infinity);
  if (objective === "trades") return Number(row.totalTrades ?? -Infinity);
  if (objective === "dd") {
    const drawdown = Number(row.maxDrawdown);
    return Number.isFinite(drawdown) ? -drawdown : -Infinity;
  }
  return Number(row.score ?? -Infinity);
}

function rankSweepRows(rows, objective = "overall") {
  const normalizedObjective = SWEEP_RANKING_OBJECTIVES.some(([key]) => key === objective) ? objective : "overall";
  return rows
    .slice()
    .sort((left, right) => {
      const delta = sweepObjectiveValue(right, normalizedObjective) - sweepObjectiveValue(left, normalizedObjective);
      if (delta !== 0) return delta;
      return Number(right.score ?? -Infinity) - Number(left.score ?? -Infinity);
    })
    .map((row, index) => ({
      ...row,
      primaryRankingObjective: normalizedObjective,
      primaryRankingObjectiveLabel: sweepRankingObjectiveLabel(normalizedObjective),
      rank: index + 1,
      retainedRank: index + 1,
    }));
}

function retainedSweepRows(rows, objective = "overall") {
  return rankSweepRows(rows, objective).slice(0, SWEEP_RETAINED_LIMIT);
}

function sizingAudit(trades = []) {
  const sizes = trades.map((trade) => Number(trade.size ?? 0)).filter((value) => value > 0);
  const leverages = trades.map((trade) => Number(trade.assumedLeverage ?? 0)).filter((value) => value > 0);
  const risks = trades.map((trade) => Number(trade.riskAmount ?? 0)).filter((value) => value > 0);
  const capitalRiskPercents = trades
    .map((trade) => {
      const capital = Number(trade.accountCapitalAtEntry ?? 0);
      const risk = Number(trade.expectedSlLossAmount ?? trade.riskAmount ?? 0);
      return capital > 0 ? risk / capital * 100 : null;
    })
    .filter((value) => Number.isFinite(value));
  const clamped = trades.filter((trade) => trade.sizingClampReason).length;

  return {
    averageLeverage: average(leverages),
    averageCapitalRiskPercent: average(capitalRiskPercents),
    averageRisk: average(risks),
    averageSize: average(sizes),
    biggestExposure: sizes.length ? Math.max(...sizes) : 0,
    clamped,
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

function median(values = []) {
  const numbers = values.filter((value) => Number.isFinite(Number(value))).map(Number).sort((left, right) => left - right);
  if (!numbers.length) return null;
  const midpoint = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[midpoint] : (numbers[midpoint - 1] + numbers[midpoint]) / 2;
}

function tradeNetPnl(trade = {}) {
  const value = Number(trade.netPnl ?? trade.pnl ?? trade.profit ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function tradeRiskAmount(trade = {}) {
  const value = Number(trade.expectedSlLossAmount ?? trade.riskAmount ?? trade.initialRiskAmount ?? 0);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function rMultipleForTrade(trade = {}) {
  const risk = tradeRiskAmount(trade);
  if (!risk) return null;
  return tradeNetPnl(trade) / risk;
}

function avgRFromTrades(trades = []) {
  const rMultiples = trades.map(rMultipleForTrade).filter((value) => Number.isFinite(value));
  return rMultiples.length
    ? { source: "average R multiple", value: average(rMultiples) }
    : { source: "unavailable", value: null };
}

function trueRrrFromTrades(trades = []) {
  const wins = trades.map(tradeNetPnl).filter((value) => value > 0);
  const losses = trades.map(tradeNetPnl).filter((value) => value < 0);

  if (wins.length && losses.length) {
    return {
      source: "avg win / avg loss",
      value: average(wins) / Math.abs(average(losses)),
    };
  }

  return {
    source: "unavailable",
    value: null,
  };
}

function trueRrrFromMetrics(metrics = {}) {
  const averageWin = Number(metrics.averageWin);
  const averageLoss = Number(metrics.averageLoss);
  if (averageWin > 0 && averageLoss < 0) {
    return { source: "avg win / avg loss", value: averageWin / Math.abs(averageLoss) };
  }
  return { source: "unavailable", value: null };
}

function avgRFromMetrics(metrics = {}) {
  const direct = Number(metrics.averageR ?? metrics.avgRPerTrade ?? metrics.averageRMultiple);
  return Number.isFinite(direct)
    ? { source: "stored average R multiple", value: direct }
    : { source: "unavailable", value: null };
}

function resultRrr(result = {}) {
  const metricsRrr = trueRrrFromMetrics(result.metrics ?? result);
  if (Number.isFinite(metricsRrr.value)) return metricsRrr;
  if (result.trades?.length) return trueRrrFromTrades(result.trades);
  const stored = Number(result.rrr ?? result.metrics?.rrr);
  const storedSource = String(result.rrrSource ?? result.metrics?.rrrSource ?? "");
  if (Number.isFinite(stored) && !storedSource.toLowerCase().includes("r multiple")) {
    return { source: storedSource || "stored RRR", value: stored };
  }
  return { source: "unavailable", value: null };
}

function resultAvgR(result = {}) {
  if (result.trades?.length) return avgRFromTrades(result.trades);
  return avgRFromMetrics(result.metrics ?? result);
}

function rrrText(result = {}, digits = 2) {
  const rrr = resultRrr(result);
  return Number.isFinite(rrr.value) ? fmt(rrr.value, digits) : "RRR unavailable";
}

function avgRText(result = {}, digits = 2) {
  const avgR = resultAvgR(result);
  return Number.isFinite(avgR.value) ? fmt(avgR.value, digits) : "Avg R unavailable";
}

function maxConsecutiveByPnl(trades = [], win = true) {
  let current = 0;
  let best = 0;
  trades.forEach((trade) => {
    const pnl = tradeNetPnl(trade);
    const matched = win ? pnl > 0 : pnl < 0;
    current = matched ? current + 1 : 0;
    best = Math.max(best, current);
  });
  return best;
}

function monthlyConsistency(trades = []) {
  const buckets = new Map();
  trades.forEach((trade) => {
    const time = trade.exitTime ?? trade.entryTime;
    if (!time) return;
    const date = new Date((typeof time === "number" ? time * 1000 : new Date(time).getTime()));
    if (!Number.isFinite(date.getTime())) return;
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    buckets.set(key, (buckets.get(key) ?? 0) + tradeNetPnl(trade));
  });
  const values = [...buckets.values()];
  const profitable = values.filter((value) => value > 0).length;
  return {
    profitable,
    text: values.length ? `${profitable}/${values.length} profitable months` : "Monthly consistency unavailable",
    total: values.length,
  };
}

function profitConcentration(trades = []) {
  const wins = trades.map(tradeNetPnl).filter((value) => value > 0).sort((left, right) => right - left);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  if (!wins.length || grossProfit <= 0) return null;
  const topCount = Math.max(1, Math.ceil(wins.length * 0.1));
  const topProfit = wins.slice(0, topCount).reduce((sum, value) => sum + value, 0);
  return topProfit / grossProfit * 100;
}

function longestDrawdownRecovery(equityCurve = []) {
  if (equityCurve.length < 2) return null;
  let peak = Number(equityCurve[0]?.equity ?? 0);
  let drawdownStart = null;
  let longestSeconds = 0;

  equityCurve.forEach((point) => {
    const equity = Number(point.equity ?? 0);
    const time = Number(point.time ?? 0);
    if (!Number.isFinite(equity) || !Number.isFinite(time)) return;

    if (equity >= peak) {
      if (drawdownStart !== null) {
        longestSeconds = Math.max(longestSeconds, time - drawdownStart);
        drawdownStart = null;
      }
      peak = equity;
      return;
    }

    if (drawdownStart === null) drawdownStart = time;
  });

  if (drawdownStart !== null) {
    const lastTime = Number(equityCurve.at(-1)?.time ?? drawdownStart);
    longestSeconds = Math.max(longestSeconds, lastTime - drawdownStart);
  }

  return longestSeconds > 0 ? longestSeconds : null;
}

function durationText(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return "Unavailable";
  const days = seconds / 86400;
  if (days >= 1) return `${fmt(days, 1)} days`;
  const hours = seconds / 3600;
  return `${fmt(hours, 1)} hours`;
}

function derivedBacktestAnalytics(result = {}, equityCurve = []) {
  const trades = result.trades ?? [];
  const pnl = trades.map(tradeNetPnl);
  const metrics = result.metrics ?? {};
  const rrr = resultRrr(result);
  const avgR = resultAvgR(result);
  const consistency = monthlyConsistency(trades);
  const concentration = profitConcentration(trades);
  const recovery = longestDrawdownRecovery(equityCurve);

  return {
    averageTrade: Number.isFinite(Number(metrics.averageTrade)) ? Number(metrics.averageTrade) : average(pnl),
    expectancy: Number.isFinite(Number(metrics.expectancy)) ? Number(metrics.expectancy) : average(pnl),
    maxConsecutiveLosses: metrics.consecutiveLosses ?? maxConsecutiveByPnl(trades, false),
    maxConsecutiveWins: metrics.consecutiveWins ?? maxConsecutiveByPnl(trades, true),
    medianTrade: median(pnl),
    monthlyConsistency: consistency.text,
    profitConcentration: concentration,
    recoverySeconds: recovery,
    rrr,
    avgR,
  };
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

function downloadPayload(fileName, content, type, encoding = "") {
  if (encoding === "base64") {
    const binary = atob(content ?? "");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const blob = new Blob([bytes], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName.replace(/[^\w.-]+/g, "-");
    anchor.click();
    URL.revokeObjectURL(url);
    return;
  }
  downloadText(fileName, content, type);
}

function exportJson(fileName, value) {
  downloadText(fileName, JSON.stringify(value, null, 2), "application/json");
}

function exportCsv(fileName, trades = []) {
  const headers = [
    "entryTime",
    "direction",
    "entryPrice",
    "exitTime",
    "exitPrice",
    "netPnl",
    "exitReason",
    "fillMode",
    "sameCandleSl",
    "ambiguityReason",
    "sizingMode",
    "slDistancePercent",
    "riskAmount",
    "expectedSlLossAmount",
    "rMultiple",
  ];
  const rows = trades.map((trade) =>
    headers
      .map((key) => JSON.stringify(key === "rMultiple"
        ? rMultipleForTrade(trade) ?? ""
        : trade[key] ?? trade[key === "netPnl" ? "pnl" : key] ?? ""))
      .join(","),
  );
  downloadText(fileName, [headers.join(","), ...rows].join("\n"), "text/csv");
}

function exportBacktestCsv(fileName, result = {}) {
  const rrr = resultRrr(result);
  const metadata = [
    ["field", "value"],
    ["name", result.name ?? ""],
    ["symbol", result.symbol ?? "SOLUSDT"],
    ["timeframe", result.timeframe ?? ""],
    ["provider", result.provider ?? result.dataDiagnostics?.provider ?? ""],
    ["rangeFrom", result.analysisRange?.from ? dateText(result.analysisRange.from) : ""],
    ["rangeTo", result.analysisRange?.to ? dateText(result.analysisRange.to) : ""],
    ["fillMode", result.fillMode ?? ""],
    ["sizingMode", result.sweepParams?.sizingMode ?? result.analysisSettings?.sizingMode ?? ""],
    ["atrLength", result.sweepParams?.atrLength ?? result.analysisSettings?.atrLength ?? ""],
    ["atrMultiplier", result.sweepParams?.atrMultiplier ?? result.analysisSettings?.atrMultiplier ?? ""],
    ["bandwidth", result.sweepParams?.bandwidth ?? result.analysisSettings?.bandwidth ?? ""],
    ["nweMultiplier", result.sweepParams?.envelopeMultiplier ?? result.analysisSettings?.envelopeMultiplier ?? ""],
    ["maxSameSideFailures", result.sweepParams?.maxSameSideFailures ?? result.analysisSettings?.maxSameSideFailures ?? ""],
    ["netProfit", result.metrics?.netProfit ?? ""],
    ["profitFactor", result.metrics?.profitFactor ?? ""],
    ["maxDrawdown", result.metrics?.maxDrawdown ?? ""],
    ["winRate", result.metrics?.winRate ?? ""],
    ["trades", result.metrics?.totalTrades ?? result.trades?.length ?? ""],
    ["rrr", Number.isFinite(rrr.value) ? rrr.value : "RRR unavailable"],
    ["rrrSource", rrr.source],
    ["avgRPerTrade", Number.isFinite(resultAvgR(result).value) ? resultAvgR(result).value : "Avg R unavailable"],
    ["avgRSource", resultAvgR(result).source],
  ];
  const tradeHeaders = ["entryTime", "direction", "entryPrice", "exitTime", "exitPrice", "netPnl", "exitReason", "fillMode", "sizingMode", "slDistancePercent", "riskAmount", "expectedSlLossAmount", "rMultiple"];
  const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const tradeRows = (result.trades ?? []).map((trade) =>
    tradeHeaders.map((key) => escape(key === "rMultiple" ? rMultipleForTrade(trade) ?? "" : trade[key] ?? trade[key === "netPnl" ? "pnl" : key] ?? "")).join(","),
  );

  downloadText(
    fileName,
    [
      ...metadata.map((row) => row.map(escape).join(",")),
      "",
      tradeHeaders.join(","),
      ...tradeRows,
    ].join("\n"),
    "text/csv",
  );
}

function exportableBacktestResult(result = {}) {
  const displayEquityCurve = equityCurveForResult(result);
  const analytics = derivedBacktestAnalytics(result, displayEquityCurve);

  return {
    ...result,
    presentationMetrics: {
      averageTrade: analytics.averageTrade,
      expectancy: analytics.expectancy,
      longestDrawdownRecovery: analytics.recoverySeconds,
      maxConsecutiveLosses: analytics.maxConsecutiveLosses,
      maxConsecutiveWins: analytics.maxConsecutiveWins,
      medianTrade: analytics.medianTrade,
      monthlyConsistency: analytics.monthlyConsistency,
      profitConcentrationPercent: analytics.profitConcentration,
      rrr: analytics.rrr.value,
      rrrSource: analytics.rrr.source,
      avgRPerTrade: analytics.avgR.value,
      avgRSource: analytics.avgR.source,
    },
  };
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
  chartDiagnostics,
  fullHistoryDataset,
  indicatorSettingsByInterval = {},
  onApplyChart,
  onAnalyzeBacktest,
  onBacktestResult,
  onClearBacktest,
  onClose,
  onExitBacktestAnalysis,
  onResetChartView,
  onSyncChartFromSztab,
  onViewBacktestTrade,
  rawCandles,
  selectedHistoricalWindow,
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
  const [backtestMode, setBacktestMode] = useState("single");
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
  const [recentSweeps, setRecentSweeps] = useState(readRecentSweeps);
  const [activeSweepId, setActiveSweepId] = useState(() => {
    const stored = readActiveSweepId();
    const recent = readRecentSweeps();
    return recent.some((item) => item.id === stored) ? stored : recent[0]?.id ?? "";
  });
  const restoredActiveSweepRef = useRef(false);
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
  const [manualActionResult, setManualActionResult] = useState(null);
  const [manualMessage, setManualMessage] = useState("");
  const [positionActionState, setPositionActionState] = useState({});
  const [manualForm, setManualForm] = useState({
    positionId: "",
    positionSide: "",
    quantity: "",
    stopPrice: "",
    symbol: "SOLUSDT",
    takeProfitPrice: "",
  });
  const [pendingManualAction, setPendingManualAction] = useState(null);
  const [sztabState, setSztabState] = useState(readSztabState);
  const [sztabStatus, setSztabStatus] = useState(null);

  const loadedDays = useMemo(
    () => daysFromCandles(rawCandles, selectedInterval),
    [rawCandles, selectedInterval],
  );
  const fullLoadedDays = useMemo(
    () => daysFromCandles(fullHistoryDataset ?? [], selectedInterval),
    [fullHistoryDataset, selectedInterval],
  );
  const selectedStrategy = strategyDecks.find((deck) => deck.id === decision.strategyDeckId);
  const selectedMm = mmDecks.find((deck) => deck.id === decision.mmDeckId);
  const selectedBattleDeck = battleDecks.find((deck) => deck.id === executionDeckId) ?? battleDecks[0];
  const aiWorkspaceContext = useMemo(() => ({
    activeBacktest: backtestResult
      ? {
          id: backtestResult.id,
          metrics: backtestResult.metrics,
          name: backtestResult.name,
          range: backtestResult.analysisRange ?? backtestResult.range,
          symbol: backtestResult.symbol,
          timeframe: backtestResult.timeframe,
          trades: backtestResult.trades?.length ?? backtestResult.metrics?.totalTrades ?? 0,
        }
      : null,
    activePanel,
    chart: {
      analysisMode: Boolean(backtestAnalysisActive),
      fullCandles: fullHistoryDataset?.length ?? 0,
      provider: chartDiagnostics?.provider ?? chartDiagnostics?.source ?? "unknown",
      renderedCandles: rawCandles?.length ?? 0,
      selectedHistoricalWindow,
      symbol: settings.symbol ?? selectedBattleDeck?.symbol ?? selectedStrategy?.symbol ?? "SOLUSDT",
      timeframe: selectedInterval,
    },
    execution: {
      activeBattleDeckId: executionDeckId,
      botStatus: system?.state?.botStatus,
      crisisMode: system?.state?.stopNewEntries,
    },
    live: {
      lastSyncAt: livestream?.accountSummary?.lastBingxSyncAt ?? livestream?.accountSummary?.lastRefreshAt,
      openPositions: livestream?.positions?.length ?? 0,
      positions: (livestream?.positions ?? []).slice(0, 5).map((position) => ({
        apiProfile: position.apiProfile,
        currentPrice: position.currentPrice,
        positionId: positionIdentifier(position),
        positionSide: position.positionSide ?? position.side,
        quantity: position.quantity,
        stopLoss: position.stopLoss,
        symbol: position.symbol,
        takeProfit: position.takeProfit,
        unrealizedPnl: position.unrealizedPnl,
      })),
      source: livestream?.accountSummary?.source ?? livestream?.source,
    },
    selectedDecks: {
      battleDeck: selectedBattleDeck ? { id: selectedBattleDeck.id, name: selectedBattleDeck.name, symbol: selectedBattleDeck.symbol, timeframe: selectedBattleDeck.timeframe } : null,
      mmDeck: selectedMm ? { id: selectedMm.id, mode: selectedMm.mode, name: selectedMm.name, oneSlPercent: selectedMm.oneSlPercent, positionPercent: selectedMm.positionPercent } : null,
      strategyDeck: selectedStrategy ? { id: selectedStrategy.id, name: selectedStrategy.name, symbol: selectedStrategy.symbol, timeframe: selectedStrategy.timeframe, sizingMode: selectedStrategy.sizingMode } : null,
    },
  }), [
    activeBacktestSession?.id,
    activePanel,
    backtestAnalysisActive,
    backtestResult,
    chartDiagnostics,
    executionDeckId,
    fullHistoryDataset?.length,
    livestream,
    rawCandles?.length,
    selectedBattleDeck,
    selectedHistoricalWindow,
    selectedInterval,
    selectedMm,
    selectedStrategy,
    settings.symbol,
    system?.state?.botStatus,
    system?.state?.stopNewEntries,
  ]);
  const futuresBalance = hasKnownProfileBalance(accountProfiles)
    ? totalProfileBalance(accountProfiles)
    : Number(system?.state?.bingx?.activeExecutionBalance ?? 0);
  const decisionEstimate = useMemo(
    () => estimateDecision({ balance: futuresBalance, mmDeck: selectedMm, strategyDeck: selectedStrategy }),
    [futuresBalance, selectedMm, selectedStrategy],
  );
  const sweepPreview = useMemo(() => {
    const hardCap = sweepForm.sweepAdvancedCapacity ? SWEEP_MAX_COMBINATIONS : SWEEP_DEFAULT_COMBINATIONS;
    const cap = Math.min(hardCap, Math.max(1, Number(sweepForm.maxCombinations) || SWEEP_DEFAULT_COMBINATIONS));

    try {
      const manualSweepForm = { ...sweepForm, mode: "manual" };
      const combinations = buildSweepCombinations({ baseDeck: null, baseMmDeck: null, form: manualSweepForm });
      const warning =
        combinations.length > 500
          ? "Heavy sweep, keep browser/backend active. Progress updates every few combinations."
          : combinations.length > SWEEP_DEFAULT_COMBINATIONS
            ? "Large sweep, may take longer. Advanced capacity is required above 200 combinations."
            : "";
      return {
        cap,
        count: combinations.length,
        error: "",
        hardCap,
        needsAdvanced: combinations.length > SWEEP_DEFAULT_COMBINATIONS && !sweepForm.sweepAdvancedCapacity,
        planned: Math.min(combinations.length, cap),
        warning,
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
      nextSztabStatus,
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
        apiFetch("/sztab/status"),
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
    setSztabStatus(nextSztabStatus);
    if (nextSztabStatus?.config) {
      setSztabState((current) => mergeSztabState({
        ...nextSztabStatus.config,
        activeTab: current.activeTab,
        expanded: current.expanded,
      }));
    }
    if (!executionDeckId && nextBattle[0]) setExecutionDeckId(nextBattle[0].id);
  }

  async function refreshLiveStatus({ fresh = false } = {}) {
    const suffix = fresh ? "?fresh=1" : "";
    const [nextLivestream, nextAccounts, nextSystem, nextSztabStatus] = await Promise.all([
      apiFetch(`/livestream${suffix}`),
      apiFetch(`/accounts/profiles${suffix}`),
      apiFetch("/system/status"),
      apiFetch("/sztab/status"),
    ]);
    setLivestream(nextLivestream);
    setAccountProfiles(nextAccounts);
    setSystem(nextSystem);
    setSztabStatus(nextSztabStatus);
    if (nextSztabStatus?.config) {
      setSztabState((current) => mergeSztabState({
        ...nextSztabStatus.config,
        activeTab: current.activeTab,
        expanded: current.expanded,
      }));
    }
  }

  async function refreshSztabStatus() {
    const nextSztabStatus = await apiFetch("/sztab/status");
    setSztabStatus(nextSztabStatus);
    if (nextSztabStatus?.config) {
      setSztabState((current) => mergeSztabState({
        ...nextSztabStatus.config,
        activeTab: current.activeTab,
        expanded: current.expanded,
      }));
    }
    return nextSztabStatus;
  }

  async function saveSztabIntervalConfig(interval, body) {
    const result = await apiFetch(`/sztab/config/${interval}`, { body, method: "POST" });
    await refreshSztabStatus();
    return result;
  }

  async function startSztabInterval(interval, body = {}) {
    let response = await apiFetchDetailed(`/sztab/start/${interval}`, { body, method: "POST" });

    if (!response.ok && response.payload?.needsConfirmation) {
      const confirmed = window.confirm(`${response.payload.message}\n\nStart ${intervalDisplayLabel(interval)} anyway?`);
      if (!confirmed) return response.payload;
      response = await apiFetchDetailed(`/sztab/start/${interval}`, {
        body: {
          ...body,
          confirmExistingExposure: true,
          confirmOpenOrders: true,
        },
        method: "POST",
      });
    }

    await refreshAll();

    if (!response.ok || response.payload?.ok === false) {
      throw new Error(response.payload?.message ?? "Sztab runner did not start.");
    }

    return response.payload;
  }

  async function restartSztabInterval(interval, body = {}) {
    let response = await apiFetchDetailed(`/sztab/restart/${interval}`, { body, method: "POST" });

    if (!response.ok && response.payload?.needsConfirmation) {
      const confirmed = window.confirm(`${response.payload.message}\n\nRestart ${intervalDisplayLabel(interval)} anyway?`);
      if (!confirmed) return response.payload;
      response = await apiFetchDetailed(`/sztab/start/${interval}`, {
        body: {
          ...body,
          confirmExistingExposure: true,
          confirmOpenOrders: true,
        },
        method: "POST",
      });
    }

    await refreshAll();

    if (!response.ok || response.payload?.ok === false) {
      throw new Error(response.payload?.message ?? "Sztab runner did not restart.");
    }

    return response.payload;
  }

  useEffect(() => {
    runAction("initial-load", "Sync platform", refreshAll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (activeBacktestSession?.result) {
      setBacktestResult(activeBacktestSession.result);
    }
  }, [activeBacktestSession?.id, activeBacktestSession?.result]);

  useEffect(() => {
    writeRecentSweeps(recentSweeps);
  }, [recentSweeps]);

  useEffect(() => {
    writeActiveSweepId(activeSweepId);
  }, [activeSweepId]);

  useEffect(() => {
    writeSztabState(sztabState);
  }, [sztabState]);

  useEffect(() => {
    if (restoredActiveSweepRef.current) return;
    restoredActiveSweepRef.current = true;

    const snapshot = recentSweeps.find((item) => item.id === activeSweepId) ?? recentSweeps[0];
    if (!snapshot?.results?.length) return;

    setSweepForm((current) => ({ ...current, ...(snapshot.form ?? {}) }));
    setSweepResults(snapshot.results ?? []);
    setSweepProgress({
      completed: snapshot.executedCombinations ?? snapshot.results?.length ?? 0,
      message: `Reopened ${snapshot.name ?? "recent sweep"}`,
      running: false,
      total: snapshot.plannedCombinations ?? snapshot.results?.length ?? 0,
    });
    setActiveSweepId(snapshot.id);
    setBacktestMode("sweep");
  }, [activeSweepId, recentSweeps]);

  useEffect(() => {
    if (activePanel !== "Livestream") return undefined;
    let ignore = false;

    async function refreshQuietly() {
      try {
        const [nextLivestream, nextAccounts] = await Promise.all([
          apiFetch("/livestream"),
          apiFetch("/accounts/profiles"),
        ]);
        if (!ignore) {
          setLivestream(nextLivestream);
          setAccountProfiles(nextAccounts);
        }
      } catch {
        // Keep the last successful live view visible; the panel shows its age.
      }
    }

    refreshQuietly();
    const timer = window.setInterval(refreshQuietly, 15000);
    return () => {
      ignore = true;
      window.clearInterval(timer);
    };
  }, [activePanel]);

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

  async function hideFavorite(favorite) {
    return saveCollectionItem("favorites", { ...favorite, hidden: true });
  }

  function prepareCrisisAction(position, action, values = {}) {
    const current = manualForm;
    const cardKey = positionCardKey(position);
    const nextForm = {
      ...current,
      apiProfile: position.apiProfile ?? "main",
      quantity: position.quantity ? Number(position.quantity).toFixed(3) : current.quantity,
      positionId: position.positionId ?? current.positionId,
      positionSide: position.positionSide ?? position.side ?? current.positionSide,
      stopPrice: values.stopPrice ?? position.stopLoss ?? current.stopPrice,
      symbol: position.symbol ?? current.symbol ?? "SOLUSDT",
      takeProfitPrice: values.takeProfitPrice ?? position.takeProfit ?? current.takeProfitPrice,
    };

    setManualForm(nextForm);

    if (values.direct && action) {
      const label = manualActionLabel(action);

      return runAction(`position-card-${cardKey}-${action}`, label, async () => {
        if (values.confirm && !window.confirm(values.confirmMessage ?? "Send this manual action for the displayed BingX position?")) {
          throw new Error("Manual action cancelled.");
        }

        try {
          setPositionActionState((state) => ({
            ...state,
            [cardKey]: {
              action,
              diagnostics: null,
              loading: true,
              message: "Request sent. Waiting for fresh BingX verification...",
              ok: null,
              result: null,
              updatedAt: new Date().toISOString(),
            },
          }));
          await apiFetch("/execution/crisis/on", { method: "POST" });
          setManualActionResult(null);
          setManualMessage("Request sent to BingX...");

          let response;
          response = await apiFetchDetailed("/manual/action", {
            body: {
              ...nextForm,
              action,
              stopPrice: values.stopPrice ?? nextForm.stopPrice,
              takeProfitPrice: values.takeProfitPrice ?? nextForm.takeProfitPrice,
            },
            method: "POST",
          });

          const { ok, payload, status } = response;
          const actionOk = ok && payload?.ok !== false;
          const message = payload?.message || (actionOk ? "Exchange accepted request. Fresh sync completed." : "BingX rejected the manual action.");

          setManualActionResult(payload);
          if (payload?.livestream) {
            setLivestream(payload.livestream);
          }
          setManualMessage(message);
          setPositionActionState((state) => ({
            ...state,
            [cardKey]: {
              action,
              diagnostics: payload?.diagnostics ?? null,
              loading: false,
              message,
              ok: actionOk,
              result: payload,
              updatedAt: new Date().toISOString(),
            },
          }));

          if (!actionOk) {
            const error = new Error(message);
            error.status = status;
            throw error;
          }

          setPendingManualAction(null);
          await refreshLiveStatus({ fresh: true });
          return payload;
        } catch (error) {
          const message = humanError(error);
          setManualMessage(message);
          setManualActionResult((currentResult) => currentResult ?? { ok: false, message });
          setPositionActionState((state) => ({
            ...state,
            [cardKey]: {
              ...(state[cardKey] ?? {}),
              action,
              loading: false,
              message,
              ok: false,
              updatedAt: new Date().toISOString(),
            },
          }));
          throw error;
        }
      });
    }

    setPendingManualAction(action);
    setActivePanel("Crisis");
    if (!action) {
      runAction("crisis-on-from-live", "Crisis ON", async () => {
        await apiFetch("/execution/crisis/on", { method: "POST" });
        await refreshAll();
      });
    }
  }

  async function refreshPositionCard(position) {
    const cardKey = positionCardKey(position);
    return runAction(`position-card-${cardKey}-sync`, "Force Sync", async () => {
      setPositionActionState((state) => ({
        ...state,
        [cardKey]: {
          ...(state[cardKey] ?? {}),
          action: "FORCE_SYNC",
          loading: true,
          message: "Refreshing this account from BingX...",
          ok: null,
          updatedAt: new Date().toISOString(),
        },
      }));

      try {
        await refreshLiveStatus({ fresh: true });
        setPositionActionState((state) => ({
          ...state,
          [cardKey]: {
            ...(state[cardKey] ?? {}),
            action: "FORCE_SYNC",
            loading: false,
            message: "Fresh BingX sync completed.",
            ok: true,
            updatedAt: new Date().toISOString(),
          },
        }));
      } catch (error) {
        const message = humanError(error);
        setPositionActionState((state) => ({
          ...state,
          [cardKey]: {
            ...(state[cardKey] ?? {}),
            action: "FORCE_SYNC",
            loading: false,
            message,
            ok: false,
            updatedAt: new Date().toISOString(),
          },
        }));
        throw error;
      }
    });
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
        onExitBacktestAnalysis();
      }
      setActivePanel("Backtests");
      setBacktestMode("single");
      return;
    }

    if (favorite.category === "Sweep Results") {
      openSweepSet(favorite.snapshot);
    }
  }

  async function analyzeCurrentBacktest(focusTrade = null) {
    if (!backtestResult) {
      throw new Error("Open or run a backtest first.");
    }

    const range = backtestResult.analysisRange;

    if (!range) {
      throw new Error("This saved backtest can be opened as a report, but it does not include enough chart range data. Rerun it to analyze on chart.");
    }

    const dataset = await loadHistoricalBacktestDataset({
      from: new Date(range.from * 1000).toISOString(),
      lastDays: backtestForm.lastDays,
      provider: backtestResult.provider ?? "binance-futures",
      symbol: backtestResult.symbol ?? "SOLUSDT",
      timeframe: backtestResult.timeframe ?? selectedInterval,
      to: new Date(range.to * 1000).toISOString(),
    }, rawCandles);
    const candles = dataset.candles ?? [];

    if (candles.length === 0) {
      throw new Error("This saved backtest opened as a report, but the provider returned no candles for its old range. Rerun it or choose a newer range.");
    }

    onBacktestResult(backtestResult, {
      candles,
      diagnostics: dataset.diagnostics ?? null,
      focusTrade,
      focusTime: focusTrade?.entryTime ?? focusTrade?.exitTime ?? null,
      mmDeckName: backtestResult.mmDeckName ?? "No MM deck",
      range,
      settings: backtestResult.analysisSettings ?? settings,
      strategyDeckName: backtestResult.strategyDeckName ?? "Strategy Deck",
      timeframe: backtestResult.timeframe ?? selectedInterval,
    });
    return backtestResult;
  }

  function applyDeckToChart(deck) {
    const next = strategyToSettings(deck, settings);
    Object.entries(next).forEach(([key, value]) => updateSetting(key, value));
    setSelectedInterval(deck.timeframe ?? selectedInterval);
    onApplyChart(next);
  }

  async function runBrowserBacktest(overrides = {}) {
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
    const timeframe = overrides.timeframe ?? form.timeframe ?? deck.timeframe ?? selectedInterval;
    const dataset = overrides.candles
      ? { candles: overrides.candles, diagnostics: overrides.diagnostics ?? null }
      : await loadHistoricalBacktestDataset({
          ...form,
          provider: form.provider ?? "binance-futures",
          symbol: deck.symbol ?? "SOLUSDT",
          timeframe,
        }, rawCandles);
    const candles = dataset.candles ?? [];
    if (candles.length < 550) {
      throw new Error(`Not enough ${timeframe} candles came back for this backtest. Provider returned ${candles.length}; widen the range or use a larger timeframe.`);
    }
    const result = runBacktest({
      backtestConfig: {
        commissionPercent: Number(form.commissionPercent),
        atrPositionSizing: deck.atrPositionSizing,
        fillMode: form.fillMode ?? "legacy",
        sizingMode: deck.sizingMode,
        mmDeck,
        slippagePercent: Number(form.slippagePercent),
        startingBalance: Number(form.startingBalance),
      },
      rawCandles: candles,
      settings: strategyToSettings(deck, settings),
    });
    const analysisRange = rangeFromBacktestCandles(candles);
    const analysisSettings = strategyToSettings(deck, settings);
    const rrr = resultRrr(result);
    const avgR = resultAvgR(result);
    const named = compactBacktestResult({
      ...result,
      analysisRange,
      analysisSettings,
      createdAt: new Date().toISOString(),
      id: `backtest-${Date.now()}`,
      mmDeckId: mmDeck?.id ?? "",
      mmDeckName: mmDeck?.name ?? "No MM deck",
      name: overrides.name ?? (form.name || `${deck.name} ${new Date().toLocaleDateString()}`),
      candlesUsed: candles.length,
      chartCandlesRendered: rawCandles.length,
      dataDiagnostics: dataset.diagnostics ?? null,
      provider: dataset.diagnostics?.provider ?? form.provider ?? "binance-futures",
      avgR: avgR.value,
      avgRSource: avgR.source,
      rrr: rrr.value,
      rrrSource: rrr.source,
      sweepParams: overrides.sweepParams ?? null,
      strategyDeckId: deck.id,
      strategyDeckName: deck.name,
      timeframe,
    });
    setBacktestResult(named);
    onBacktestResult(named, {
      candles,
      diagnostics: dataset.diagnostics ?? null,
      mmDeckName: mmDeck?.name ?? "No MM deck",
      range: analysisRange,
      settings: analysisSettings,
      strategyDeckName: deck.name,
      timeframe,
    });
    return named;
  }

  async function openAiBacktest(run, row) {
    if (!run || !row) throw new Error("Choose an AI result card first.");
    if (!row.params || Object.keys(row.params).length === 0) {
      throw new Error("Exact config missing. I cannot open this AI result as a backtest without stored parameters.");
    }
    const requiredParams = ["bandwidth", "envelopeMultiplier", "atrLength", "atrMultiplier", "maxSameSideFailures"];
    const missingParams = requiredParams.filter((key) => row.params?.[key] === undefined || row.params?.[key] === null || row.params?.[key] === "");
    if (missingParams.length) {
      throw new Error(`Exact config missing ${missingParams.join(", ")}. Open diagnostics instead of running defaults.`);
    }
    const provenance = row.provenance ?? {};
    const from = provenance.from ?? run.plan?.range?.from;
    const to = provenance.to ?? run.plan?.range?.to;
    if (!from || !to) {
      throw new Error("This AI result does not include an exact date range. Re-run the AI analysis with an explicit range.");
    }

    const exact = await runBrowserBacktest({
      form: {
        commissionPercent: provenance.commissionPercent ?? backtestForm.commissionPercent,
        fillMode: row.params?.fillMode ?? provenance.fillMode ?? run.plan?.fillMode ?? "legacy",
        from,
        lastDays: backtestForm.lastDays,
        provider: provenance.provider ?? run.plan?.provider ?? "binance-futures",
        slippagePercent: provenance.slippagePercent ?? backtestForm.slippagePercent,
        startingBalance: provenance.startingBalance ?? run.plan?.startingBalance ?? backtestForm.startingBalance,
        timeframe: row.timeframe ?? provenance.timeframe ?? run.plan?.timeframe ?? "15m",
        to,
      },
      mmDeck: mmDeckFromAiRow(row),
      name: `AI exact backtest ${row.rank ? `#${row.rank}` : ""}`.trim(),
      strategyDeck: strategyDraftFromAiRow(row, run),
      sweepParams: {
        aiMetrics: row.metrics ?? {},
        aiProvenance: provenance,
        aiRunId: run.id,
        exactParameters: row.params ?? {},
      },
      timeframe: row.timeframe ?? provenance.timeframe ?? run.plan?.timeframe ?? "15m",
    });
    const aiProfitFactor = Number(row.metrics?.profitFactor ?? NaN);
    const openedProfitFactor = Number(exact.metrics?.profitFactor ?? NaN);
    const aiNetProfit = Number(row.metrics?.netProfit ?? NaN);
    const openedNetProfit = Number(exact.metrics?.netProfit ?? NaN);

    return {
      exact,
      metricDiff: {
        aiNetProfit,
        aiProfitFactor,
        openedNetProfit,
        openedProfitFactor,
        profitFactorDelta: Number.isFinite(aiProfitFactor) && Number.isFinite(openedProfitFactor)
          ? openedProfitFactor - aiProfitFactor
          : null,
        netProfitDelta: Number.isFinite(aiNetProfit) && Number.isFinite(openedNetProfit)
          ? openedNetProfit - aiNetProfit
          : null,
      },
    };
  }

  function buildSweepCombinations({ baseDeck, baseMmDeck, form }) {
    const combinations = [];
    const manualMode = true;

    if (manualMode) {
      if (form.manualSymbol.trim().toUpperCase() !== "SOLUSDT") {
        throw new Error("Manual Sweep currently supports SOLUSDT historical candles.");
      }

      const primaryObjective = form.manualPrimaryObjective ?? "overall";
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
                  const displaySizingMode = sweepSizingModeForKey(sizing.key);
                  const engineSizingMode = engineSizingModeForKey(sizing.key);
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
                    sizingMode: engineSizingMode,
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
                      fillMode: form.manualFillMode ?? "legacy",
                      positionPercent: sizing.key === "positionPercent" ? sizeValue : null,
                      primaryRankingObjective: primaryObjective,
                      primaryRankingObjectiveLabel: sweepRankingObjectiveLabel(primaryObjective),
                      riskPercent: sizing.key === "oneSlPercent" ? sizeValue : null,
                      sizeKey: sizing.key,
                      sizeLabel: sweepSizeLabel(sizing.key),
                      sizingMode: displaySizingMode,
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
                    sizingMode: atrPositionSizing ? "fixed-risk" : "position-percent",
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

  function rememberSweep(snapshot) {
    if (!snapshot?.id) return snapshot;
    setRecentSweeps((current) => {
      const next = [snapshot, ...current.filter((item) => item.id !== snapshot.id)].slice(0, RECENT_SWEEP_LIMIT);
      return next;
    });
    setActiveSweepId(snapshot.id);
    return snapshot;
  }

  function makeSweepSnapshot({ executed = null, form, ranked, status = "completed", total = null }) {
    const first = ranked[0] ?? {};
    const primaryObjective = form.manualPrimaryObjective ?? first.primaryRankingObjective ?? "overall";
    return {
      analysisRange: first.analysisRange ?? null,
      createdAt: new Date().toISOString(),
      executedCombinations: executed ?? ranked.length,
      form,
      id: `sweep-set-${Date.now()}`,
      name: `Sweep ${form.manualSymbol ?? "SOLUSDT"} ${form.manualTimeframe ?? ""} ${new Date().toLocaleString()}`,
      plannedCombinations: total ?? ranked.length,
      primaryRankingObjective: primaryObjective,
      primaryRankingObjectiveLabel: sweepRankingObjectiveLabel(primaryObjective),
      provider: first.dataDiagnostics?.provider ?? "binance-futures",
      retainedLimit: SWEEP_RETAINED_LIMIT,
      results: ranked.slice(0, SWEEP_RETAINED_LIMIT),
      status,
      symbol: form.manualSymbol ?? "SOLUSDT",
      timeframe: form.manualTimeframe ?? "15m",
      updatedAt: new Date().toISOString(),
    };
  }

  function openSweepSet(snapshot) {
    if (!snapshot?.results?.length) {
      throw new Error("This sweep set does not include stored results.");
    }
    setSweepForm((current) => ({ ...current, ...(snapshot.form ?? {}) }));
    setSweepResults(snapshot.results ?? []);
    setSweepProgress({
      completed: snapshot.executedCombinations ?? snapshot.results?.length ?? 0,
      message: `Reopened ${snapshot.name ?? "saved sweep"} · retained ${snapshot.results?.length ?? 0} by ${snapshot.primaryRankingObjectiveLabel ?? sweepRankingObjectiveLabel(snapshot.form?.manualPrimaryObjective)}`,
      running: false,
      total: snapshot.plannedCombinations ?? snapshot.results?.length ?? 0,
    });
    setActiveSweepId(snapshot.id);
    setBacktestMode("sweep");
    setActivePanel("Backtests");
  }

  async function saveCurrentSweep() {
    if (!sweepResults.length) throw new Error("Run or reopen a sweep before saving it.");
    const existing = recentSweeps.find((item) => item.id === activeSweepId);
    const snapshot = existing ?? makeSweepSnapshot({ form: sweepForm, ranked: sweepResults, status: "saved" });
    const name = window.prompt("Sweep favorite name", snapshot.name ?? "Manual Sweep");
    if (!name?.trim()) return null;
    const favorite = {
      category: "Sweep Results",
      createdAt: new Date().toISOString(),
      id: `fav-sweep-${snapshot.id}`,
      itemId: snapshot.id,
      name: name.trim(),
      shortDescription: `${snapshot.symbol ?? "SOLUSDT"} ${snapshot.timeframe ?? ""} · ${snapshot.results?.length ?? 0} ranked`,
      snapshot: {
        ...snapshot,
        name: name.trim(),
        primaryRankingObjective: snapshot.primaryRankingObjective ?? snapshot.form?.manualPrimaryObjective ?? "overall",
        primaryRankingObjectiveLabel: snapshot.primaryRankingObjectiveLabel ?? sweepRankingObjectiveLabel(snapshot.form?.manualPrimaryObjective),
        status: "saved",
      },
    };
    const saved = await saveCollectionItem("favorites", favorite, false);
    rememberSweep(favorite.snapshot);
    await refreshAll();
    return saved;
  }

  function clearCurrentSweep() {
    setSweepResults([]);
    setSweepProgress({ completed: 0, message: "Sweep cleared", running: false, total: 0 });
    setRecentSweeps((current) => activeSweepId ? current.filter((item) => item.id !== activeSweepId) : current);
    setActiveSweepId("");
  }

  async function runSweepBacktest() {
    const manualSweepForm = { ...sweepForm, mode: "manual" };
    const primaryObjective = manualSweepForm.manualPrimaryObjective ?? "overall";
    const primaryObjectiveLabel = sweepRankingObjectiveLabel(primaryObjective);
    if (manualSweepForm.manualRangeMode === "explicit" && !String(manualSweepForm.manualFrom ?? "").trim()) {
      throw new Error("Explicit historical range needs a From date/time.");
    }
    const form = normalizeBacktestForm({
      ...sweepRangeForm(backtestForm, manualSweepForm),
      provider: "binance-futures",
      timeframe: manualSweepForm.manualTimeframe,
    });
    const dataset = await loadHistoricalBacktestDataset({
      ...form,
      symbol: manualSweepForm.manualSymbol,
      timeframe: manualSweepForm.manualTimeframe,
    }, rawCandles);
    const candles = dataset.candles ?? [];
    if (candles.length < 550) {
      throw new Error(`Not enough ${manualSweepForm.manualTimeframe} candles came back for this sweep. Provider returned ${candles.length}; widen the range or use a larger timeframe.`);
    }

    const combinations = buildSweepCombinations({ baseDeck: null, baseMmDeck: null, form: manualSweepForm });
    const hardCap = sweepForm.sweepAdvancedCapacity ? SWEEP_MAX_COMBINATIONS : SWEEP_DEFAULT_COMBINATIONS;
    const cap = Math.min(hardCap, Math.max(1, Number(sweepForm.maxCombinations) || SWEEP_DEFAULT_COMBINATIONS));

    if (combinations.length > cap) {
      throw new Error(`${combinations.length} combinations requested. Narrow the ranges or keep the sweep at ${cap} combinations or fewer${sweepForm.sweepAdvancedCapacity ? "." : ", or enable Advanced capacity."}`);
    }

    sweepCancelRef.current = false;
    setSweepResults([]);
    setSweepProgress({
      completed: 0,
      message: `Running 0 / ${combinations.length} · retaining top ${Math.min(SWEEP_RETAINED_LIMIT, combinations.length)} by ${primaryObjectiveLabel}`,
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
          fillMode: form.fillMode ?? "legacy",
          sizingMode: combination.strategyDeck.sizingMode,
          mmDeck: combination.mmDeck,
          slippagePercent: Number(form.slippagePercent),
          startingBalance: Number(form.startingBalance),
        },
        rawCandles: candles,
        settings: strategyToSettings(combination.strategyDeck, settings),
      });
      const metrics = result.metrics;
      const rrr = resultRrr(result);
      const avgR = resultAvgR(result);
      const row = {
        ...combination,
        analysisRange,
        averageTrade: metrics.averageTrade,
        bestTrade: metrics.largestWin,
        candlesUsed: candles.length,
        chartCandlesRendered: rawCandles.length,
        dataDiagnostics: dataset.diagnostics ?? null,
        fillMode: result.fillMode,
        ambiguity: result.ambiguity,
        ambiguousCandlesCount: result.ambiguousCandlesCount,
        conservativeAdjustedTrades: result.conservativeAdjustedTrades,
        conservativeSkippedEntries: result.conservativeSkippedEntries,
        id: `sweep-${Date.now()}-${index}`,
        longResult: sidePnl(result.trades, "LONG"),
        maxDrawdown: metrics.maxDrawdown,
        maxConsecutiveWins: metrics.consecutiveWins,
        netProfit: metrics.netProfit,
        netProfitPercent: Number(form.startingBalance) > 0
          ? (metrics.netProfit / Number(form.startingBalance)) * 100
          : 0,
        profitFactor: metrics.profitFactor,
        primaryRankingObjective: primaryObjective,
        primaryRankingObjectiveLabel: primaryObjectiveLabel,
        rangeForm: form,
        avgR: avgR.value,
        avgRSource: avgR.source,
        rrr: rrr.value,
        rrrSource: rrr.source,
        score: sweepScore(metrics, Number(form.startingBalance)),
        shortResult: sidePnl(result.trades, "SHORT"),
        totalTrades: metrics.totalTrades,
        winRate: metrics.winRate,
        worstTrade: metrics.largestLoss,
        expectancy: metrics.expectancy,
      };
      rows.push(row);

      if ((index + 1) % 4 === 0 || index === combinations.length - 1) {
        setSweepResults(retainedSweepRows(rows, primaryObjective));
        setSweepProgress({
          completed: index + 1,
          message: `Running ${index + 1} / ${combinations.length} · retained ${Math.min(SWEEP_RETAINED_LIMIT, rows.length)} by ${primaryObjectiveLabel}`,
          running: true,
          total: combinations.length,
        });
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    }

    const ranked = retainedSweepRows(rows, primaryObjective);
    setSweepResults(ranked);
    rememberSweep(makeSweepSnapshot({
      executed: rows.length,
      form: manualSweepForm,
      ranked,
      status: sweepCancelRef.current ? "cancelled" : "completed",
      total: combinations.length,
    }));
    setSweepProgress({
      completed: rows.length,
      message: sweepCancelRef.current
        ? `Cancelled at ${rows.length} / ${combinations.length} · retained ${ranked.length} by ${primaryObjectiveLabel}`
        : `Completed ${rows.length} combinations · retained ${ranked.length} by ${primaryObjectiveLabel}`,
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
        <button
          className="hubert-tab-main hubert-tab-main--sztab"
          data-active={panel === "Sztab Generalny"}
          onClick={() => setActivePanel("Sztab Generalny")}
          type="button"
        >
          Sztab Generalny
        </button>
        {PANEL_GROUPS.map((group) => {
          const groupActive = group.tabs.includes(panel);
          return (
            <details className="hubert-tab-group" data-active={groupActive} key={group.label} open={groupActive}>
              <summary>{group.label}</summary>
              <div>
                {group.tabs.map((tab) => (
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
            </details>
          );
        })}
        <button
          className="hubert-tab-main"
          data-active={panel === "AI"}
          onClick={() => setActivePanel("AI")}
          type="button"
        >
          AI
        </button>
      </div>

      {action.message && (
        <MiniStatus tone={action.state === "error" ? "bad" : action.state === "success" ? "good" : "neutral"}>
          {action.message}
        </MiniStatus>
      )}

      {panel === "Sztab Generalny" && (
        <SztabGeneralnyPanel
          accountProfiles={accountProfiles}
          backendStatus={sztabStatus}
          battleDecks={battleDecks}
          chartSettings={settings}
          indicatorSettingsByInterval={indicatorSettingsByInterval}
          livestream={livestream}
          mmDecks={mmDecks}
          positionActionState={positionActionState}
          rawCandles={rawCandles}
          selectedInterval={selectedInterval}
          strategyDecks={strategyDecks}
          system={system}
          value={sztabState}
          onAction={runAction}
          onEmergencyStop={(closePositions) =>
            runAction("sztab-emergency-stop", closePositions ? "Emergency stop and close positions" : "Stop all bots", async () => {
              await apiFetch("/sztab/stop-all", { method: "POST" }).catch(() => null);
              const result = closePositions
                ? await apiFetch("/execution/emergency-stop", { body: { closePositions: true }, method: "POST" })
                : await apiFetch("/execution/stop", { method: "POST" });
              await refreshAll();
              return result;
            })
          }
          onCancelAllOrders={() =>
            runAction("sztab-cancel-all-orders", "Cancel all visible orders", async () => {
              const targets = [
                ...new Map(
                  [
                    ...(livestream?.openOrders ?? []),
                    ...(livestream?.positions ?? []),
                  ]
                    .map((item) => ({
                      apiProfile: item.apiProfile ?? item.__apiProfileId ?? item.sourceProfileId ?? "main",
                      symbol: item.symbol ?? "SOLUSDT",
                    }))
                    .filter((item) => item.symbol)
                    .map((item) => [`${item.apiProfile}:${item.symbol}`, item]),
                ).values(),
              ];

              if (targets.length === 0) {
                throw new Error("No visible BingX orders or positions are available to target.");
              }

              await apiFetch("/execution/crisis/on", { method: "POST" });
              const responses = [];

              for (const target of targets) {
                responses.push(await apiFetchDetailed("/manual/action", {
                  body: {
                    action: "CANCEL_ALL",
                    apiProfile: target.apiProfile,
                    symbol: target.symbol,
                  },
                  method: "POST",
                }));
              }

              await refreshLiveStatus({ fresh: true });
              const failed = responses.filter((response) => !response.ok || response.payload?.ok === false);
              if (failed.length > 0) {
                throw new Error(`${failed.length} cancel request(s) were rejected. Check diagnostics in Crisis if orders remain.`);
              }
              return { ok: true, message: `Cancel requests sent for ${targets.length} visible symbol/profile pair(s).` };
            })
          }
          onCancelPendingTriggers={() => runAction("sztab-cancel-pending-triggers", "Cancel Sztab pending trigger orders", async () => {
            await apiFetch("/sztab/cancel-pending-triggers", { method: "POST" });
            await refreshSztabStatus();
            await refreshLiveStatus({ fresh: true });
            return { ok: true, message: "Sztab pending trigger cancel requested for all intervals." };
          })}
          onForceSync={() => runAction("sztab-force-sync", "Force sync all", async () => {
            await apiFetch("/sztab/sync-all", { method: "POST" });
            await refreshLiveStatus({ fresh: true });
          })}
          onOpenAdvanced={(nextPanel) => setActivePanel(nextPanel)}
          onSyncChartFromSztab={onSyncChartFromSztab}
          onPositionAction={prepareCrisisAction}
          onPositionRefresh={refreshPositionCard}
          onSaveConfig={saveSztabIntervalConfig}
          onStartInterval={(interval) => runAction(`sztab-start-${interval}`, `Start ${intervalDisplayLabel(interval)} runner`, () => startSztabInterval(interval))}
          onRestartInterval={(interval) => runAction(`sztab-restart-${interval}`, `Restart ${intervalDisplayLabel(interval)} runner`, () => restartSztabInterval(interval))}
          onCheckSignalParity={(interval) => runAction(`sztab-signal-parity-${interval}`, `Check ${intervalDisplayLabel(interval)} signal parity`, () => apiFetch(`/sztab/signal-parity/${interval}`, {
            body: {
              chart: {
                candles: rawCandles.slice(-3000),
                fullCandles: fullHistoryDataset?.length ?? chartDiagnostics?.fullCandles ?? 0,
                lastCandleTime: rawCandles.at(-1)?.time ?? null,
                markerSource: activeBacktestSession
                  ? "backtest analysis marker"
                  : selectedHistoricalWindow?.mode === "historical"
                    ? "historical chart signal"
                    : "live/latest chart signal window",
                provider: chartDiagnostics?.provider ?? "binance-futures",
                rawCandleCount: rawCandles.length,
                selectedInterval,
                settings,
                window: selectedHistoricalWindow,
              },
              latestBacktest: activeBacktestSession
                ? {
                    candlesUsed: activeBacktestSession.result?.candlesUsed ?? activeBacktestSession.backtestCandles?.length ?? null,
                    fillMode: activeBacktestSession.fillMode ?? activeBacktestSession.result?.fillMode ?? null,
                    provider: activeBacktestSession.provider ?? null,
                    range: activeBacktestSession.range ?? activeBacktestSession.result?.range ?? null,
                    trades: activeBacktestSession.result?.trades?.length ?? null,
                  }
                : null,
            },
            method: "POST",
          }))}
          onStopAll={() => runAction("sztab-stop-all", "Stop all Sztab runners", async () => {
            await apiFetch("/sztab/stop-all", { method: "POST" });
            await apiFetch("/execution/stop", { method: "POST" }).catch(() => null);
            await refreshSztabStatus();
            await refreshLiveStatus({ fresh: true });
          })}
          onStopInterval={(interval) => runAction(`sztab-stop-${interval}`, `Stop ${intervalDisplayLabel(interval)} runner`, async () => {
            await apiFetch(`/sztab/stop/${interval}`, { method: "POST" });
            await refreshSztabStatus();
          })}
          onSyncInterval={(interval) => runAction(`sztab-sync-${interval}`, `Sync ${intervalDisplayLabel(interval)}`, async () => {
            await apiFetch(`/sztab/sync/${interval}`, { method: "POST" });
            await refreshLiveStatus({ fresh: true });
          })}
          onUpdate={setSztabState}
        />
      )}

      {panel === "System" && (
        <SystemPanel
          accountProfiles={accountProfiles}
          backendUrl={BACKEND_URL}
          chartDiagnostics={chartDiagnostics}
          fullHistoryDataset={fullHistoryDataset}
          rawCandles={rawCandles}
          runAction={runAction}
          selectedHistoricalWindow={selectedHistoricalWindow}
          selectedInterval={selectedInterval}
          system={system}
          onRefresh={() => refreshAll()}
        />
      )}

      {panel === "Livestream" && (
        <LivestreamPanel
          accountProfiles={accountProfiles}
          livestream={livestream}
          manualMessage={manualMessage}
          manualResult={manualActionResult}
          positionActionState={positionActionState}
          onRefresh={() => runAction("refresh-live", "Refresh live stream", () => refreshLiveStatus({ fresh: true }))}
          onPositionRefresh={refreshPositionCard}
          onPositionAction={prepareCrisisAction}
        />
      )}

      {panel === "Indicator" && (
        <IndicatorPanel
          chartDiagnostics={chartDiagnostics}
          fullHistoryDataset={fullHistoryDataset}
          fullLoadedDays={fullLoadedDays}
          loadedDays={loadedDays}
          rawCandles={rawCandles}
          selectedHistoricalWindow={selectedHistoricalWindow}
          selectedInterval={selectedInterval}
          settings={settings}
          indicatorSettingsByInterval={indicatorSettingsByInterval}
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
          activeSweepId={activeSweepId}
          analysisActive={backtestAnalysisActive}
          analysisSession={activeBacktestSession}
          chartDiagnostics={chartDiagnostics}
          favorites={favorites}
          form={backtestForm}
          mmDecks={mmDecks}
          mode={backtestMode}
          result={backtestResult}
          savedBacktests={savedBacktests}
          setForm={setBacktestForm}
          setMode={setBacktestMode}
          strategyDecks={strategyDecks}
          sweepForm={sweepForm}
          sweepPreview={sweepPreview}
          sweepProgress={sweepProgress}
          sweepResults={sweepResults}
          setSweepForm={setSweepForm}
          onCancelSweep={() => runAction("cancel-sweep", "Cancel sweep", async () => cancelSweepBacktest())}
          onClearSweep={() => runAction("clear-sweep", "Clear sweep", async () => clearCurrentSweep())}
          onDelete={(item) => runAction(`delete-backtest-${item.id}`, "Delete backtest", () => deleteCollectionItem("backtests", item))}
          onFavorite={(item) => runAction(`fav-backtest-${item.id}`, "Add favorite", () => addFavorite("Backtests", item))}
          onHide={(item) => runAction(`hide-backtest-${item.id}`, "Hide backtest", () => saveCollectionItem("backtests", { ...item, hidden: true }))}
          onAnalyze={() => runAction("analyze-backtest", "Analyze on Chart", () => analyzeCurrentBacktest())}
          onClear={() => runAction("clear-backtest", "Clear result", async () => {
            setBacktestResult(null);
            onClearBacktest();
          })}
          onExitAnalysis={() => runAction("exit-backtest-analysis", "Exit analysis", async () => {
            onExitBacktestAnalysis();
          })}
          onResetChartView={onResetChartView}
          onViewTrade={(trade) => runAction("view-backtest-trade", "View trade on chart", () => analyzeCurrentBacktest(trade))}
          onOpenSweepResult={(row) => runAction(`open-sweep-${row.id}`, "Open sweep result", async () => openSweepResult(row))}
          onOpenSweepSet={(snapshot) => runAction(`open-sweep-set-${snapshot.id}`, "Open sweep", async () => openSweepSet(snapshot))}
          onRun={() => runAction("run-backtest", "Run backtest", async () => runBrowserBacktest())}
          onRunSweep={() => runAction("run-sweep", "Run sweep", async () => runSweepBacktest())}
          onSave={() => runAction("save-backtest", "Save backtest", () => saveBacktest())}
          onSaveSweep={() => runAction("save-sweep", "Save sweep", () => saveCurrentSweep())}
          recentSweeps={recentSweeps}
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
          livestream={livestream}
          rawCandles={rawCandles}
          selectedBattleDeck={selectedBattleDeck}
          setExecutionDeckId={setExecutionDeckId}
          setActivePanel={setActivePanel}
          status={system}
          onForceSync={() => runAction("force-sync-execution", "Force BingX sync", () => refreshLiveStatus({ fresh: true }))}
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
          result={manualActionResult}
          setForm={setManualForm}
          setMessage={setManualMessage}
          setPendingAction={setPendingManualAction}
          symbol={selectedBattleDeck?.symbol ?? decision.symbol}
          onCrisisOff={() => runAction("crisis-off", "Crisis OFF", () => apiFetch("/execution/crisis/off", { method: "POST" }).then(refreshAll))}
          onCrisisOn={() => runAction("crisis-on", "Crisis ON", () => apiFetch("/execution/crisis/on", { method: "POST" }).then(refreshAll))}
          onForceSync={() => runAction("force-sync-crisis", "Force BingX sync", () => refreshLiveStatus({ fresh: true }))}
          onManualAction={(body) =>
            runAction(`manual-${body.action}`, "Send manual action", async () => {
              setManualActionResult(null);
              setManualMessage("Request sent to BingX...");
              let response;

              try {
                response = await apiFetchDetailed("/manual/action", { body, method: "POST" });
              } catch (error) {
                setManualMessage(humanError(error));
                setManualActionResult({ ok: false, message: humanError(error) });
                throw error;
              }

              const { ok, payload, status } = response;
              setManualActionResult(payload);
              if (payload.livestream) {
                setLivestream(payload.livestream);
              }
              setManualMessage(payload.message || (ok ? "Exchange accepted request. Fresh sync completed." : "BingX rejected the manual action."));

              if (!ok || payload.ok === false) {
                const error = new Error(payload.message || "BingX rejected the manual action.");
                error.status = status;
                throw error;
              }

	              setPendingManualAction(null);
	              await refreshLiveStatus({ fresh: true });
	              return payload;
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
	        <AiAgentPanel
	          apiRequest={apiFetch}
	          aiStatus={aiStatus}
	          onBacktestResult={onBacktestResult}
	          onOpenAiBacktest={openAiBacktest}
	          runAction={runAction}
	          setActivePanel={setActivePanel}
	          setStrategyForm={setStrategyForm}
	          workspaceContext={aiWorkspaceContext}
	        />
	      )}

      {panel === "Favorites" && (
        <FavoritesPanel
          favorites={favorites}
          onDelete={(favorite) => runAction(`delete-fav-${favorite.id}`, "Remove favorite", () => deleteCollectionItem("favorites", favorite))}
          onHide={(favorite) => runAction(`hide-fav-${favorite.id}`, "Hide favorite", () => hideFavorite(favorite))}
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
  const sizingMode = strategyDeck.sizingMode ?? (strategyDeck.atrPositionSizing ? "fixed-risk" : "position-percent");
  const notional =
    mmDeck.mode === "constant"
      ? Number(mmDeck.fixedNotional ?? 0)
      : sizingMode === "fixed-risk"
        ? safeBalance * riskPercent
        : safeBalance * (positionPercent / 100);
  const leverage = safeBalance > 0 && notional > 0 ? Math.max(1, Math.ceil(notional / safeBalance)) : 0;
  const margin = leverage > 0 ? notional / leverage : 0;
  const ready = safeBalance > 0 && notional > 0;
  const lossText = sizingMode === "fixed-risk"
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

function executionReadinessIssues({ balance, profile, selectedBattleDeck, status }) {
  const issues = [];
  const bingx = status?.state?.bingx ?? {};

  if (!status) issues.push("Backend status is still syncing.");
  if (!selectedBattleDeck) issues.push("Choose a Battle Deck.");
  if (!bingx.apiConfigured) issues.push("BingX API keys are missing on the backend.");
  if (!profile) issues.push("Selected API profile is not reported by the backend.");
  if (profile && ["Missing", "Stale"].includes(humanProfileStatus(profile))) {
    issues.push(`API profile is ${humanProfileStatus(profile).toLowerCase()}.`);
  }
  if (!Number.isFinite(Number(balance)) || Number(balance) <= 0) issues.push("Futures balance is not available yet.");

  return issues;
}

function SystemPanel({
  accountProfiles,
  backendUrl,
  chartDiagnostics,
  fullHistoryDataset,
  rawCandles,
  runAction,
  selectedHistoricalWindow,
  selectedInterval,
  system,
  onRefresh,
}) {
  const status = system?.state ?? {};
  const bingx = status.bingx ?? {};
  const production = system?.production ?? {};
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
    `Chart candles rendered: ${rawCandles.length}`,
    `Full candles loaded: ${fullHistoryDataset?.length ?? chartDiagnostics?.fullCandles ?? 0}`,
    `Provider: ${chartDiagnostics?.provider ?? "binance-futures"}`,
    `Chart window: ${selectedHistoricalWindow?.mode ?? "latest"}`,
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
        <Metric label="BingX sync" value={compactDateText(bingx.lastSyncAt)} />
        <Metric label="Backend uptime" value={system?.summary?.uptimeSeconds ? `${Math.floor(system.summary.uptimeSeconds / 60)} min` : "Unavailable"} />
        <Metric label="Runtime mode" value={production.deploymentMode ?? "unknown"} />
        <Metric label="VPS/local mode" value={production.vpsMode ? "VPS/production-style" : "local/dev"} />
        <Metric label="Process manager" value={production.processManager ?? "unknown"} />
        <Metric label="Backend bind" value={production.backendBind ?? "--"} />
        <Metric label="PM2 restart count" value={production.pm2?.restartCount ?? "--"} />
        <Metric label="Memory RSS" value={production.memory?.rssMb !== undefined ? `${production.memory.rssMb} MB` : "--"} />
        <Metric label="Sztab runners" value={production.sztab ? `${production.sztab.runningIntervals}/${production.sztab.totalIntervals}` : "--"} />
        <Metric label="Stale runners" value={production.sztab?.staleIntervals ?? "--"} />
        <Metric label="Websocket" value={production.websocketStatus ?? "unknown"} />
        <Metric label="Auto recovery" value={production.restartRecovery?.sztabAutoResumeOnStart ? "enabled" : "disabled"} />
        <Metric label="Display time" value={DISPLAY_TIME_ZONE} />
        <Metric label="Open orders" value={system?.summary?.openOrdersCount ?? 0} />
        <Metric label="Active Battle Deck" value={system?.summary?.activeBattleDeck?.name ?? "None"} />
        <Metric label="Chart candles" value={`${rawCandles.length} / ${fullHistoryDataset?.length ?? chartDiagnostics?.fullCandles ?? 0}`} />
        <Metric label="Data provider" value={chartDiagnostics?.provider ?? "Binance Futures"} />
        <Metric label="Chart window" value={selectedHistoricalWindow?.mode === "historical" ? "Historical" : "Latest"} />
      </div>

      <div className="hubert-lab__subhead"><strong>API Profiles</strong><span>{accountProfiles.length}</span></div>
      {accountProfiles.length === 0 ? (
        <MiniStatus>No API profiles are reported by the backend yet.</MiniStatus>
      ) : (
        <div className="hubert-lab__table">
          <table>
            <thead>
              <tr><th>Profile</th><th>Status</th><th>Futures USDT</th><th>Positions</th><th>Orders</th><th>Last sync</th></tr>
            </thead>
            <tbody>
              {accountProfiles.map((profile) => (
                <tr key={profile.id}>
                  <td>{profile.label}</td>
                  <td title={profileStatusTitle(profile)}>{humanProfileStatus(profile)}</td>
                  <td>{profileBalanceText(profile)}</td>
                  <td>{profile.openPositions ?? 0}</td>
                  <td>{profile.openOrders ?? 0}</td>
                  <td>{compactDateText(profile.lastSyncAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(system?.dataAvailability ?? []).length > 0 ? (
        <>
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
                    <td>{compactDateText(row.firstCandleTime)}</td>
                    <td>{compactDateText(row.lastCandleTime)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <MiniStatus>
            {(system?.dataAvailability ?? []).find((row) => row.note)?.note ?? "Exchange API availability is measured from paginated Binance candle requests."}
          </MiniStatus>
        </>
      ) : (
        <MiniStatus>Historical availability is syncing.</MiniStatus>
      )}
    </section>
  );
}

function LivestreamPanel({
  accountProfiles = [],
  livestream,
  manualMessage,
  manualResult,
  onPositionAction,
  onPositionRefresh,
  onRefresh,
  positionActionState = {},
}) {
  const [positionControls, setPositionControls] = useState({});
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
  const lastSyncAt = summary.lastBingxSyncAt ?? summary.lastRefreshAt;
  const stale = secondsSince(lastSyncAt) !== null && secondsSince(lastSyncAt) > 120;
  const source = summary.source ?? (stale ? "backend cache" : "fresh BingX sync");
  const updatePositionControl = (key, field, value) => {
    setPositionControls((current) => ({
      ...current,
      [key]: {
        ...(current[key] ?? {}),
        [field]: value,
      },
    }));
  };

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
      <MiniStatus tone={dataFreshnessTone(lastSyncAt)}>
        Source: {source}. Last successful sync: {ageText(lastSyncAt)}. Last panel refresh: {compactDateText(summary.lastRefreshAt)}.
      </MiniStatus>
      {stale && (
        <MiniStatus tone="bad">
          Data may be stale. Last successful sync: {ageText(lastSyncAt)}.
        </MiniStatus>
      )}
      {manualMessage && positions.length === 0 && (
        <MiniStatus tone={manualResult?.ok === false ? "bad" : manualResult?.ok === true ? "good" : "neutral"}>
          {manualMessage}
        </MiniStatus>
      )}
      {manualResult && positions.length === 0 && (
        <details className="hubert-details">
          <summary>Last exchange response</summary>
          <pre>{JSON.stringify({
            diagnostics: manualResult.diagnostics,
            message: manualResult.message,
            ok: manualResult.ok,
            result: manualResult.result,
          }, null, 2)}</pre>
        </details>
      )}
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
                  <td title={profileStatusTitle(profile)}>{humanProfileStatus(profile)}</td>
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
          {positions.map((position) => {
            const key = positionCardKey(position);
            const controls = positionControls[key] ?? {};
            const cardState = positionActionState[key] ?? {};
            const cardBusy = Boolean(cardState.loading);
            const attachedOrders = position.attachedOrders ?? [];
            const hasProtection = attachedOrders.length > 0 || Number(position.stopLoss) > 0 || Number(position.takeProfit) > 0;
            const slValue = controls.stopPrice ?? (position.stopLoss ? String(position.stopLoss) : "");
            const tpValue = controls.takeProfitPrice ?? (position.takeProfit ? String(position.takeProfit) : "");

            return (
            <div className="hubert-live-card" key={key}>
              <div className="hubert-live-card__head">
                <strong>{position.symbol} {position.side}</strong>
                <span>{position.battleDeckName ?? "Manual"} · {position.timeframe ?? "--"} · {position.apiProfileLabel ?? position.apiProfile}</span>
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
                <Metric label="Protection source" value={position.protectionSource ?? "none"} />
                <Metric label="PnL" value={`${fmt(position.unrealizedPnl)} / ${fmt(position.pnlPercent)}%`} />
                <Metric label="Distance to SL" value={position.distanceToSl ? `${fmt(position.distanceToSl)} (${fmt(position.distanceToSlPercent)}%)` : "--"} />
                <Metric label="Distance to TP" value={position.distanceToTp ? `${fmt(position.distanceToTp)} (${fmt(position.distanceToTpPercent)}%)` : "--"} />
                <Metric label="Duration" value={position.durationSeconds ? `${Math.floor(position.durationSeconds / 60)} min` : "--"} />
                <Metric label="Priority" value={position.botPriority === "manual" ? "Manual" : "Bot"} />
                <Metric label="Last action" value={position.lastAction ?? "--"} />
              </div>
              <div className="hubert-position-sources">
                <span><strong>Active SL</strong>{fmt(position.stopLoss)} · {protectionSourceText(position, "SL")}</span>
                <span><strong>Active TP</strong>{fmt(position.takeProfit)} · {protectionSourceText(position, "TP")}</span>
              </div>
              <OrderTable orders={position.attachedOrders ?? []} />
              <div className="hubert-position-controls">
                <label>
                  <span>SL</span>
                  <input
                    inputMode="decimal"
                    placeholder="Stop price"
                    type="number"
                    value={slValue}
                    onChange={(event) => updatePositionControl(key, "stopPrice", event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  disabled={cardBusy || !Number.isFinite(Number(slValue)) || Number(slValue) <= 0}
                  onClick={() => onPositionAction(position, "MOVE_SL", { direct: true, stopPrice: slValue })}
                >
                  {cardBusy && cardState.action === "MOVE_SL" ? "Moving..." : "Move SL"}
                </button>
                <label>
                  <span>TP</span>
                  <input
                    inputMode="decimal"
                    placeholder="Take profit"
                    type="number"
                    value={tpValue}
                    onChange={(event) => updatePositionControl(key, "takeProfitPrice", event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  disabled={cardBusy || !Number.isFinite(Number(tpValue)) || Number(tpValue) <= 0}
                  onClick={() => onPositionAction(position, "MOVE_TP", { direct: true, takeProfitPrice: tpValue })}
                >
                  {cardBusy && cardState.action === "MOVE_TP" ? "Moving..." : "Move TP"}
                </button>
                <button
                  type="button"
                  disabled={cardBusy}
                  onClick={() => onPositionAction(position, "CLOSE_POSITION", {
                    confirm: true,
                    confirmMessage: `Close ${position.symbol} ${position.side} position ${positionIdentifier(position) ?? ""}?`,
                    direct: true,
                  })}
                >
                  {cardBusy && cardState.action === "CLOSE_POSITION" ? "Closing..." : "Close Position"}
                </button>
                <button
                  type="button"
                  disabled={cardBusy || !hasProtection}
                  title={!hasProtection ? "No attached protection/orders reported for this position." : "Cancel protection/orders attached to this exact position."}
                  onClick={() => onPositionAction(position, "CANCEL_ATTACHED_ORDERS", {
                    confirm: true,
                    confirmMessage: `Cancel attached protective/orders for ${position.symbol} ${position.side}?`,
                    direct: true,
                  })}
                >
                  {cardBusy && cardState.action === "CANCEL_ATTACHED_ORDERS" ? "Cancelling..." : "Cancel Protection/Orders"}
                </button>
                <button
                  type="button"
                  disabled={cardBusy}
                  onClick={() => onPositionRefresh?.(position) ?? onRefresh?.()}
                >
                  {cardBusy && cardState.action === "FORCE_SYNC" ? "Syncing..." : "Force Sync"}
                </button>
              </div>
              <div className="hubert-lab__actions">
                <button type="button" onClick={() => onPositionAction(position, null)}>Open Advanced Manual Action</button>
              </div>
              {cardState.message && (
                <MiniStatus tone={cardState.ok === false ? "bad" : cardState.ok === true ? "good" : "neutral"}>
                  {cardState.message} {cardState.updatedAt ? `· ${compactDateText(cardState.updatedAt)}` : ""}
                </MiniStatus>
              )}
              {cardState.result && (
                <details className="hubert-details">
                  <summary>Position action diagnostics</summary>
                  <pre>{JSON.stringify({
                    action: cardState.action,
                    diagnostics: cardState.result?.diagnostics ?? cardState.diagnostics ?? null,
                    message: cardState.result?.message ?? cardState.message,
                    ok: cardState.result?.ok ?? cardState.ok,
                    result: cardState.result?.result ?? null,
                  }, null, 2)}</pre>
                </details>
              )}
            </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function IndicatorPanel({
  chartDiagnostics,
  fullHistoryDataset,
  fullLoadedDays,
  indicatorSettingsByInterval = {},
  loadedDays,
  rawCandles,
  selectedHistoricalWindow,
  selectedInterval,
  settings,
  updateSetting,
}) {
  return (
    <section className="hubert-lab__section">
      <MiniStatus>
        Chart is rendering {rawCandles.length} candles, about {fmt(loadedDays, 0)} days. Full loaded context has {fullHistoryDataset?.length ?? 0} candles, about {fmt(fullLoadedDays, 0)} days.
        Backtests fetch their own historical range from {chartDiagnostics?.provider ?? "binance-futures"}.
      </MiniStatus>
      <MiniStatus>
        Indicator settings are stored per interval. Active panel: {selectedInterval.toUpperCase()} · saved interval sets: {Object.keys(indicatorSettingsByInterval).join(", ") || "none"}.
      </MiniStatus>
      <div className="hubert-lab__grid">
        <NumberField commitEmpty={false} label="History days" value={settings.historyDays ?? 31} min="1" max="1000" onChange={(value) => updateSetting("historyDays", value)} help="Choose time in days. The platform converts it into candles for this timeframe." />
        <ReadOnly label="Chart window" value={`${selectedHistoricalWindow?.mode === "historical" ? "Historical" : "Latest"} · ${rawCandles.length} on ${selectedInterval}`} />
        <ReadOnly label="Full loaded candles" value={`${fullHistoryDataset?.length ?? 0} on ${selectedInterval}`} />
        <ReadOnly label="Provider" value={chartDiagnostics?.provider ?? "Binance Futures"} />
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
        <SelectField
          label="Sizing mode"
          value={form.sizingMode ?? (form.atrPositionSizing ? "fixed-risk" : "position-percent")}
          onChange={(value) => setForm({
            ...form,
            atrPositionSizing: value === "fixed-risk",
            sizingMode: value,
          })}
          options={[
            ["position-percent", "Position Percent"],
            ["fixed-risk", "Fixed Risk Per Trade"],
          ]}
          help="Position Percent = fixed exposure. Fixed Risk = fixed capital risk at stop-loss."
        />
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
          ]}
        />
        <MiniStatus>
          Position Percent keeps exposure fixed. Fixed Risk Per Trade adjusts notional so the expected SL loss targets the risk % from the MM Deck.
        </MiniStatus>
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
  activeSweepId,
  analysisActive,
  analysisSession,
  favorites,
  form,
  mmDecks,
  mode,
  onAnalyze,
  onCancelSweep,
  onClearSweep,
  onClear,
  onDelete,
  onExitAnalysis,
  onFavorite,
  onHide,
  onOpenSweepResult,
  onOpenSweepSet,
  onRun,
  onRunSweep,
  onSave,
  onSaveSweep,
  onResetChartView,
  onViewTrade,
  recentSweeps,
  result,
  savedBacktests,
  setForm,
  setMode,
  setSweepForm,
  strategyDecks,
  sweepForm,
  sweepPreview,
  sweepProgress,
  sweepResults,
}) {
  const favoriteBacktests = favorites
    .filter((favorite) => favorite.category === "Backtests")
    .map((favorite) => savedBacktests.find((item) => item.id === favorite.itemId))
    .filter(Boolean);
  const tableTradeCount = result?.trades?.length ?? 0;
  const renderedTrades = renderedBacktestTradeCount(result, analysisSession?.candles);
  const hasTradeRenderMismatch = result && renderedTrades !== tableTradeCount;
  const selectedDeck = strategyDecks.find((deck) => deck.id === (form.strategyDeckId || strategyDecks[0]?.id));
  const selectedSizingMode = selectedDeck?.sizingMode ?? (selectedDeck?.atrPositionSizing ? "fixed-risk" : "position-percent");

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
            <SelectField label="Timeframe" value={form.timeframe ?? "15m"} onChange={(value) => setForm({ ...form, timeframe: value })} options={TIMEFRAMES.map((item) => [item.interval, item.label])} />
            <SelectField label="Provider" value={form.provider ?? "binance-futures"} onChange={(value) => setForm({ ...form, provider: value })} options={[
              ["binance-futures", "Binance Futures"],
              ["binance-spot", "Binance Spot"],
            ]} />
            <NumberField label="Last X days" value={form.lastDays} min="1" onChange={(value) => setForm({ ...form, lastDays: value })} />
            <TextField label="From date/time" value={form.from} onChange={(value) => setForm({ ...form, from: value })} />
            <TextField label="To date/time" value={form.to ?? ""} onChange={(value) => setForm({ ...form, to: value })} />
            <NumberField label="Starting balance" value={form.startingBalance} onChange={(value) => setForm({ ...form, startingBalance: value })} />
            <NumberField label="Commission %" value={form.commissionPercent} step="0.01" onChange={(value) => setForm({ ...form, commissionPercent: value })} />
            <NumberField label="Slippage %" value={form.slippagePercent} step="0.01" onChange={(value) => setForm({ ...form, slippagePercent: value })} />
            <SelectField label="Backtest Fill Mode" value={form.fillMode ?? "legacy"} onChange={(value) => setForm({ ...form, fillMode: value })} options={[
              ["legacy", "Current / Legacy"],
              ["conservative", "Conservative"],
            ]} />
          </div>
          <MiniStatus>
            Historical Range Backtest uses {form.provider === "binance-spot" ? "Binance Spot" : "Binance Futures"} public candles for the selected range. It does not depend on the candles currently rendered on the chart.
          </MiniStatus>
          <MiniStatus>
            Sizing mode: {selectedSizingMode === "fixed-risk" ? "Fixed Risk Per Trade" : "Position Percent"}. Position Percent keeps exposure fixed; Fixed Risk targets the configured SL loss.
          </MiniStatus>
          <MiniStatus>
            Fill mode: {fillModeLabel(form.fillMode)}. Legacy preserves existing results. Conservative assumes worst-case ordering when OHLC cannot prove intrabar sequence.
          </MiniStatus>
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
                <span>
                  Fill Mode: {fillModeLabel(result.fillMode)} · ambiguous candles: {result.ambiguousCandlesCount ?? result.ambiguity?.ambiguousCandlesCount ?? 0} · conservative-adjusted trades: {result.conservativeAdjustedTrades ?? result.ambiguity?.conservativeAdjustedTrades ?? 0} · skipped entries: {result.conservativeSkippedEntries ?? result.ambiguity?.conservativeSkippedEntries ?? 0}
                </span>
                {hasTradeRenderMismatch && (
                  <span className="hubert-analysis-card__warning">
                    Chart markers are capped for speed; use the table for the full record.
                  </span>
                )}
              </div>
              <div className="hubert-lab__actions">
                <button type="button" onClick={onAnalyze}>Analyze on Chart</button>
                <button title="Center chart on current backtest range and restore default zoom." type="button" onClick={onResetChartView}>Center Chart</button>
                <button type="button" onClick={onExitAnalysis}>Exit Analysis</button>
                <button type="button" onClick={onClear}>Clear Result</button>
              </div>
            </div>
          )}
          <BacktestResult result={result} onResetChartView={onResetChartView} onViewTrade={onViewTrade} />
        </>
      ) : (
        <BacktestSweepPanel
          activeSweepId={activeSweepId}
          progress={sweepProgress}
          preview={sweepPreview}
          recentSweeps={recentSweeps}
          results={sweepResults}
          form={sweepForm}
          setForm={setSweepForm}
          onCancel={onCancelSweep}
          onClear={onClearSweep}
          onOpenResult={(row) => {
            const result = onOpenSweepResult(row);
            setMode("single");
            return result;
          }}
          onOpenSweepSet={onOpenSweepSet}
          onRun={onRunSweep}
          onSaveSweep={onSaveSweep}
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
  activeSweepId,
  form,
  onCancel,
  onClear,
  onOpenResult,
  onOpenSweepSet,
  onRun,
  onSaveSweep,
  preview,
  progress,
  recentSweeps = [],
  results,
  setForm,
}) {
  const previewTone = preview?.error || preview?.tooMany ? "bad" : "neutral";
  const rangeMode = form.manualRangeMode ?? (form.manualFrom || form.manualTo ? "explicit" : "rolling");
  const explicitRange = rangeMode === "explicit";
  const primaryObjective = form.manualPrimaryObjective ?? "overall";
  const primaryObjectiveLabel = sweepRankingObjectiveLabel(primaryObjective);
  const retainedLabel = results.length
    ? `Generated ${preview?.count ?? progress.total ?? results.length} • Executed ${progress.completed || progress.total || results.length} • Retained ${results.length} by ${primaryObjectiveLabel}`
    : `Generated ${preview?.count ?? 0} • Executed ${progress.completed ?? 0} • Retained 0 by ${primaryObjectiveLabel}`;

  return (
    <section className="hubert-lab__section">
      <MiniStatus>
        Manual Sweep runs many explicit parameter sets without drawing chart overlays. Score = net profit % - max drawdown + trade-count bonus + profit-factor bonus.
      </MiniStatus>
      <MiniStatus>Manual Sweep ignores saved Strategy/MM Deck values. It fetches its own Binance Futures historical range and never draws chart overlays during the sweep.</MiniStatus>
      <MiniStatus tone="good">Active sizing source: Manual Sweep. Strategy/MM Decks do not override this sweep.</MiniStatus>
      <div className="hubert-lab__subhead"><strong>Historical Range Sweep</strong><span>independent data</span></div>
      <div className="hubert-range-mode">
        <button
          data-active={!explicitRange}
          type="button"
          onClick={() => setForm({ ...form, manualFrom: "", manualRangeMode: "rolling", manualTo: "" })}
        >
          Rolling range
        </button>
        <button
          data-active={explicitRange}
          type="button"
          onClick={() => setForm({ ...form, manualRangeMode: "explicit" })}
        >
          Explicit historical range
        </button>
        <span>
          Active mode: {explicitRange
            ? "From/To dates; Last X days disabled"
            : "Last X days; explicit dates ignored"}
        </span>
      </div>
      <div className="hubert-lab__grid">
        <TextField label="Symbol" value={form.manualSymbol} onChange={(value) => setForm({ ...form, manualSymbol: value })} />
        <SelectField label="Timeframe" value={form.manualTimeframe} onChange={(value) => setForm({ ...form, manualTimeframe: value })} options={TIMEFRAMES.map((item) => [item.interval, item.label])} />
        <NumberField
          disabled={explicitRange}
          label="Last X days"
          min="1"
          value={form.manualLastDays}
          onChange={(value) => setForm({ ...form, manualFrom: "", manualLastDays: value, manualRangeMode: "rolling", manualTo: "" })}
        />
        <NumberField label="Starting balance" min="1" value={form.manualStartingBalance} onChange={(value) => setForm({ ...form, manualStartingBalance: value })} />
        <SelectField label="Backtest Fill Mode" value={form.manualFillMode ?? "legacy"} onChange={(value) => setForm({ ...form, manualFillMode: value })} options={[
          ["legacy", "Current / Legacy"],
          ["conservative", "Conservative"],
        ]} />
        <SelectField
          label="Primary ranking objective"
          value={primaryObjective}
          onChange={(value) => setForm({ ...form, manualPrimaryObjective: value })}
          options={SWEEP_RANKING_OBJECTIVES}
        />
        <TextField
          disabled={!explicitRange}
          label="From date/time"
          value={form.manualFrom}
          onChange={(value) => setForm({ ...form, manualFrom: value, manualRangeMode: "explicit" })}
        />
        <TextField
          disabled={!explicitRange}
          label="To date/time"
          value={form.manualTo}
          onChange={(value) => setForm({ ...form, manualRangeMode: "explicit", manualTo: value })}
        />
      </div>
      <MiniStatus>
        {explicitRange
          ? "Explicit historical range is active. Rolling Last X days is ignored for this sweep."
          : "Rolling range is active. Filling Last X days clears explicit From/To dates."}
      </MiniStatus>
      <MiniStatus>
        Primary ranking objective: {primaryObjectiveLabel}. This decides which top {SWEEP_RETAINED_LIMIT} rows are retained before table sorting.
      </MiniStatus>
      <MiniStatus>
        Fill mode: {fillModeLabel(form.manualFillMode)}. Legacy preserves existing results. Conservative assumes worst-case ordering when OHLC cannot prove intrabar sequence.
      </MiniStatus>
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
            ["run-position", "Position Percent"],
            ["run-risk", "Fixed Risk Per Trade"],
            ["constant", "CONSTANT fixed USDT"],
          ]}
        />
        {form.manualSizingMode === "run-risk" && (
          <TextField label="Fixed Risk target % equity" value={form.manualRiskValues} onChange={(value) => setForm({ ...form, manualRiskValues: value })} />
        )}
        {form.manualSizingMode === "run-position" && (
          <TextField label="Position Percent % equity" value={form.manualPositionValues} onChange={(value) => setForm({ ...form, manualPositionValues: value })} />
        )}
        {form.manualSizingMode === "constant" && (
          <TextField label="Fixed notional values (USDT)" value={form.manualFixedNotionalValues} onChange={(value) => setForm({ ...form, manualFixedNotionalValues: value })} />
        )}
      </div>
      <MiniStatus>{manualSweepSizingText(form.manualSizingMode)}</MiniStatus>
      <details className="hubert-advanced">
        <summary>Advanced sweep capacity</summary>
        <div className="hubert-lab__grid">
          <label className="hubert-inline-toggle">
            <input
              checked={Boolean(form.sweepAdvancedCapacity)}
              type="checkbox"
              onChange={(event) => setForm({ ...form, maxCombinations: event.target.checked ? form.maxCombinations : Math.min(Number(form.maxCombinations) || SWEEP_DEFAULT_COMBINATIONS, SWEEP_DEFAULT_COMBINATIONS), sweepAdvancedCapacity: event.target.checked })}
            />
            <span>Allow up to {SWEEP_MAX_COMBINATIONS} combinations</span>
          </label>
          <NumberField
            label="Max combinations"
            max={String(form.sweepAdvancedCapacity ? SWEEP_MAX_COMBINATIONS : SWEEP_DEFAULT_COMBINATIONS)}
            min="1"
            value={form.maxCombinations}
            onChange={(value) => setForm({ ...form, maxCombinations: value })}
          />
        </div>
      </details>
      <MiniStatus tone={previewTone}>
        {preview?.error
          ? preview.error
          : `Generated combinations: ${preview?.count ?? 0}. Planned: ${preview?.tooMany ? 0 : preview?.count ?? 0}. Cap: ${preview?.cap ?? SWEEP_DEFAULT_COMBINATIONS}.${preview?.tooMany ? " Narrow ranges or raise the Advanced cap." : ""}`}
      </MiniStatus>
      <MiniStatus>{retainedLabel}</MiniStatus>
      {preview?.warning && <MiniStatus tone={preview?.tooMany ? "bad" : "neutral"}>{preview.warning}</MiniStatus>}
      <div className="hubert-lab__actions">
        <button disabled={progress.running || preview?.tooMany || Boolean(preview?.error)} type="button" onClick={onRun}>Run Sweep</button>
        <button disabled={!progress.running} type="button" onClick={onCancel}>Cancel</button>
        <button disabled={!results.length || progress.running} type="button" onClick={onSaveSweep}>Save Sweep</button>
        <button disabled={!results.length || progress.running} type="button" onClick={onClear}>Clear Sweep</button>
        <span>{progress.message || "Ready"} {progress.total ? `· executed ${progress.completed}/${progress.total}` : ""}</span>
      </div>
      <SweepResultTable onOpenResult={onOpenResult} results={results} />
      <RecentSweeps
        activeSweepId={activeSweepId}
        onOpenResult={onOpenResult}
        onOpenSweepSet={onOpenSweepSet}
        recentSweeps={recentSweeps}
      />
    </section>
  );
}

function RecentSweeps({ activeSweepId, onOpenResult, onOpenSweepSet, recentSweeps = [] }) {
  if (!recentSweeps.length) {
    return <MiniStatus>No recent sweeps yet. Completed sweeps stay here until you clear or overwrite local storage.</MiniStatus>;
  }

  return (
    <section className="hubert-lab__section">
      <div className="hubert-lab__subhead"><strong>Recent Sweeps</strong><span>{recentSweeps.length}</span></div>
      <div className="hubert-lab__table">
        <table>
          <thead>
            <tr><th>Name</th><th>Range</th><th>Objective</th><th>Ranked</th><th>Status</th><th>Updated</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {recentSweeps.map((sweep) => (
              <tr key={sweep.id} className={sweep.id === activeSweepId ? "hubert-sweep-row--top" : ""}>
                <td>{sweep.name ?? sweep.id}</td>
                <td>{sweep.analysisRange ? `${dateText(sweep.analysisRange.from)} → ${dateText(sweep.analysisRange.to)}` : `${sweep.symbol ?? "SOLUSDT"} ${sweep.timeframe ?? ""}`}</td>
                <td>{sweep.primaryRankingObjectiveLabel ?? sweepRankingObjectiveLabel(sweep.form?.manualPrimaryObjective)}</td>
                <td>{sweep.results?.length ?? 0} / {sweep.executedCombinations ?? "--"}</td>
                <td>{sweep.status ?? "completed"}</td>
                <td>{dateText(sweep.updatedAt ?? sweep.createdAt)}</td>
                <td>
                  <div className="hubert-lab__actions">
                    <button type="button" onClick={() => onOpenSweepSet(sweep)}>Reopen</button>
                    <button disabled={!sweep.results?.[0]} type="button" onClick={() => onOpenResult(sweep.results[0])}>Open top</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function manualSweepSizingText(mode) {
  if (mode === "run-risk") {
    return "Fixed Risk Per Trade sizes each position so an SL hit targets the selected % of current equity.";
  }

  if (mode === "run-position") {
    return "Position Percent uses the selected % of current equity as position notional.";
  }

  return "CONSTANT fixed USDT uses the same notional size for every trade.";
}

function sweepSizingShortText(row) {
  const params = row.params ?? {};
  const value = params.sizeValue === null || params.sizeValue === undefined
    ? ""
    : ` ${fmt(params.sizeValue, 2)}`;

  if (params.sizeKey === "oneSlPercent") return `Fixed Risk${value}%`;
  if (params.sizeKey === "positionPercent") return `Position${value}%`;
  if (params.sizeKey === "fixedNotional") return `Fixed ${value} USDT`;
  return "Default";
}

function sweepParamDetails(row) {
  const params = row.params ?? {};
  const symbol = `${params.symbol ?? "SOLUSDT"} ${params.timeframe ?? ""}`.trim();
  return `${symbol} · source ${params.source ?? "default"} · fill ${fillModeLabel(params.fillMode ?? row.fillMode)} · ATR length ${params.atrLength ?? "--"} · ATR multiplier ${params.atrMultiplier ?? "--"} · NWE ${params.envelopeMultiplier ?? "--"} · BW ${params.bandwidth ?? "--"} · max failures ${params.maxSameSideFailures ?? "--"} · ${params.sizeLabel ?? "Sizing"} ${params.sizeValue ?? "--"} · mode ${params.sizingMode ?? "--"}`;
}

function sweepHeaderSizingText(row) {
  const params = row?.params ?? {};
  const riskText = params.riskPercent === null || params.riskPercent === undefined ? "--" : `${fmt(params.riskPercent, 2)}%`;
  const positionText = params.positionPercent === null || params.positionPercent === undefined ? "--" : `${fmt(params.positionPercent, 2)}%`;
  return `Sizing: ${sweepSizingShortText(row)} · Fixed Risk target: ${riskText} · Position Percent: ${positionText}`;
}

function sweepCellText(value, digits = 2, options = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "unavailable";

  const text = number.toLocaleString("pl-PL", {
    maximumFractionDigits: digits,
    minimumFractionDigits: options.minimumFractionDigits ?? digits,
  });
  return text.replace(/\u00A0/g, " ");
}

function sweepExactTitle(label, value, suffix = "") {
  if (value === null || value === undefined || value === "") return `${label}: unavailable`;
  const number = Number(value);
  if (!Number.isFinite(number)) return `${label}: unavailable`;
  return `${label}: ${number.toLocaleString("pl-PL", { maximumFractionDigits: 8 })}${suffix}`;
}

function SweepMetricCell({ digits = 2, label, suffix = "", value }) {
  if (value === null || value === undefined || value === "") {
    return <td className="hubert-sweep-number" title={`${label}: unavailable`}>--</td>;
  }
  const number = Number(value);
  const text = Number.isFinite(number) ? `${sweepCellText(number, digits)}${suffix}` : "--";
  return <td className="hubert-sweep-number" title={sweepExactTitle(label, value, suffix)}>{text}</td>;
}

function SweepHeaderButton({ active, children, onClick, title }) {
  return (
    <button className="hubert-sweep-th-button" data-active={active} onClick={onClick} title={title} type="button">
      {children}
    </button>
  );
}

function sweepMaxWins(row = {}) {
  const direct = Number(row.maxConsecutiveWins ?? row.metrics?.maxConsecutiveWins ?? row.metrics?.consecutiveWins);
  if (Number.isFinite(direct)) return direct;
  if (Array.isArray(row.trades)) return maxConsecutiveByPnl(row.trades, true);
  return null;
}

function SweepResultTable({ onOpenResult, results }) {
  const [sortMode, setSortMode] = useState("overall");
  const sortedResults = useMemo(() => {
    const source = results ?? [];
    const sorters = {
      dd: (left, right) => Number(left.maxDrawdown ?? Infinity) - Number(right.maxDrawdown ?? Infinity),
      net: (left, right) => Number(right.netProfit ?? -Infinity) - Number(left.netProfit ?? -Infinity),
      overall: (left, right) => Number(left.rank ?? Infinity) - Number(right.rank ?? Infinity),
      pf: (left, right) => Number(right.profitFactor ?? -Infinity) - Number(left.profitFactor ?? -Infinity),
      rrr: (left, right) => Number(right.rrr ?? -Infinity) - Number(left.rrr ?? -Infinity),
      streak: (left, right) => Number(sweepMaxWins(right) ?? -Infinity) - Number(sweepMaxWins(left) ?? -Infinity),
      win: (left, right) => Number(right.winRate ?? -Infinity) - Number(left.winRate ?? -Infinity),
    };
    return source.slice().sort(sorters[sortMode] ?? sorters.overall);
  }, [results, sortMode]);

  if (!results?.length) {
    return <MiniStatus>No sweep results yet. Run a sweep to rank parameter sets.</MiniStatus>;
  }
  const firstResult = results[0];
  const leaders = {
    dd: results.slice().sort((left, right) => Number(left.maxDrawdown ?? Infinity) - Number(right.maxDrawdown ?? Infinity))[0]?.id,
    net: results.slice().sort((left, right) => Number(right.netProfit ?? -Infinity) - Number(left.netProfit ?? -Infinity))[0]?.id,
    pf: results.slice().sort((left, right) => Number(right.profitFactor ?? -Infinity) - Number(left.profitFactor ?? -Infinity))[0]?.id,
    win: results.slice().sort((left, right) => Number(right.winRate ?? -Infinity) - Number(left.winRate ?? -Infinity))[0]?.id,
  };

  return (
    <div className="hubert-lab__section">
      <MiniStatus>
        Sweep used {firstResult.candlesUsed ?? "--"} candles on {firstResult.params?.timeframe ?? "--"} from {firstResult.dataDiagnostics?.provider ?? "binance-futures"}.
        {firstResult.analysisRange ? ` Range: ${dateText(firstResult.analysisRange.from)} to ${dateText(firstResult.analysisRange.to)}.` : ""}
      </MiniStatus>
      <MiniStatus>
        Primary ranking objective used: {firstResult.primaryRankingObjectiveLabel ?? firstResult.params?.primaryRankingObjectiveLabel ?? sweepRankingObjectiveLabel(firstResult.primaryRankingObjective ?? firstResult.params?.primaryRankingObjective)}.
        Retained leaderboard rows: {results.length}.
      </MiniStatus>
      <MiniStatus>
        Fill Mode: {fillModeLabel(firstResult.fillMode ?? firstResult.params?.fillMode)} · ambiguous candles: {firstResult.ambiguousCandlesCount ?? firstResult.ambiguity?.ambiguousCandlesCount ?? 0} · conservative-adjusted trades: {firstResult.conservativeAdjustedTrades ?? firstResult.ambiguity?.conservativeAdjustedTrades ?? 0} · skipped entries: {firstResult.conservativeSkippedEntries ?? firstResult.ambiguity?.conservativeSkippedEntries ?? 0}
      </MiniStatus>
      <MiniStatus>{sweepHeaderSizingText(firstResult)}</MiniStatus>
      <div className="hubert-lab__actions hubert-sweep-filters">
        <button data-active={sortMode === "overall"} type="button" onClick={() => setSortMode("overall")}>Overall</button>
        <button data-active={sortMode === "pf"} type="button" onClick={() => setSortMode("pf")}>Best PF</button>
        <button data-active={sortMode === "rrr"} type="button" onClick={() => setSortMode("rrr")}>Best RRR</button>
        <button data-active={sortMode === "streak"} type="button" onClick={() => setSortMode("streak")}>Best streak</button>
        <button data-active={sortMode === "win"} type="button" onClick={() => setSortMode("win")}>Best win%</button>
        <button data-active={sortMode === "net"} type="button" onClick={() => setSortMode("net")}>Best net</button>
        <button data-active={sortMode === "dd"} type="button" onClick={() => setSortMode("dd")}>Best low DD</button>
      </div>
      <div className="hubert-lab__table hubert-lab__table--sweep">
        <table>
          <thead>
            <tr>
              <th>Rank</th>
              <th>Score</th>
              <th>Net</th>
              <th>DD</th>
              <th>PF</th>
              <th>Win %</th>
              <th>
                <SweepHeaderButton
                  active={sortMode === "rrr"}
                  onClick={() => setSortMode("rrr")}
                  title="Sort by highest true RRR"
                >
                  RRR
                </SweepHeaderButton>
              </th>
              <th>
                <SweepHeaderButton
                  active={sortMode === "streak"}
                  onClick={() => setSortMode("streak")}
                  title="Sort by highest max consecutive winning trades"
                >
                  Max wins
                </SweepHeaderButton>
              </th>
              <th>Trades</th>
              <th>ATR len</th>
              <th>ATR mult</th>
              <th>Max failures</th>
              <th>NWE</th>
              <th>BW</th>
              <th>Sizing</th>
              <th>Open</th>
            </tr>
          </thead>
          <tbody>
            {sortedResults.map((row, index) => {
              const badges = [
                leaders.pf === row.id ? "PF" : "",
                leaders.win === row.id ? "Win" : "",
                leaders.net === row.id ? "Net" : "",
                leaders.dd === row.id ? "DD" : "",
              ].filter(Boolean);
              return (
                <tr className={index < 3 ? "hubert-sweep-row--top" : ""} key={row.id}>
                  <td>{row.rank}</td>
                  <SweepMetricCell label={badges.length ? `Score · category leader: ${badges.join(", ")}` : "Score"} value={row.score} />
                  <SweepMetricCell digits={Math.abs(Number(row.netProfit)) >= 1000 ? 0 : 2} label="Net profit" value={row.netProfit} />
                  <SweepMetricCell label="Max drawdown" suffix="%" value={row.maxDrawdown} />
                  <SweepMetricCell label="Profit factor" value={row.profitFactor} />
                  <SweepMetricCell label="Win rate" suffix="%" value={row.winRate} />
                  <SweepMetricCell label="RRR = average winning trade divided by absolute average losing trade" value={row.rrr} />
                  <SweepMetricCell digits={0} label="Max consecutive winning trades" value={sweepMaxWins(row)} />
                  <SweepMetricCell digits={0} label="Trades" value={row.totalTrades} />
                  <SweepMetricCell digits={0} label="ATR length" value={row.params?.atrLength} />
                  <SweepMetricCell label="ATR multiplier" value={row.params?.atrMultiplier} />
                  <SweepMetricCell digits={0} label="Max same-side failures" value={row.params?.maxSameSideFailures} />
                  <SweepMetricCell label="NWE multiplier" value={row.params?.envelopeMultiplier} />
                  <SweepMetricCell label="Bandwidth" value={row.params?.bandwidth} />
                  <td className="hubert-sweep-params" title={sweepParamDetails(row)}>{sweepSizingShortText(row)}</td>
                  <td><button className="hubert-sweep-open" type="button" onClick={() => onOpenResult(row)}>Open</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
          <MiniStatus>
            Difference vs baseline ({selected[0]?.name}): net, PF, win rate, RRR, and DD are calculated against the first selected backtest.
          </MiniStatus>
          <div className="hubert-lab__metrics">
            <Metric label="Best net" value={[...selected].sort((a, b) => Number(b.metrics?.netProfit ?? 0) - Number(a.metrics?.netProfit ?? 0))[0]?.name ?? "--"} />
            <Metric label="Best PF" value={[...selected].sort((a, b) => Number(b.metrics?.profitFactor ?? 0) - Number(a.metrics?.profitFactor ?? 0))[0]?.name ?? "--"} />
            <Metric label="Best win%" value={[...selected].sort((a, b) => Number(b.metrics?.winRate ?? 0) - Number(a.metrics?.winRate ?? 0))[0]?.name ?? "--"} />
            <Metric label="Lowest DD" value={[...selected].sort((a, b) => Number(a.metrics?.maxDrawdown ?? Infinity) - Number(b.metrics?.maxDrawdown ?? Infinity))[0]?.name ?? "--"} />
          </div>
          <MultiCurveChart title="Equity Curves" results={selected} curveKey="equity" />
          <details className="hubert-advanced">
            <summary>Drawdown Curves</summary>
            <MultiCurveChart title="Drawdown Curves" results={selected} curveKey="drawdown" />
          </details>
          <div className="hubert-lab__table">
            <table>
              <thead>
                <tr><th>Backtest</th><th>Net</th><th>Δ Net</th><th>Net %</th><th>DD</th><th>PF</th><th>Win</th><th>RRR</th><th>Avg R</th><th>Trades</th><th>Avg</th><th>Best</th><th>Worst</th></tr>
              </thead>
              <tbody>
                {selected.map((test) => {
                  const metrics = test.metrics ?? {};
                  const baselineMetrics = selected[0]?.metrics ?? {};
                  const baselineNet = Number(baselineMetrics.netProfit ?? 0);
                  const net = Number(metrics.netProfit ?? 0);
                  const netPercent = metrics.startingBalance ? metrics.netProfit / metrics.startingBalance * 100 : (metrics.netProfit / (test.config?.startingBalance ?? 10000)) * 100;
                  return (
                    <tr key={test.id}>
                      <td>{test.name}</td>
                      <td>{fmt(net)}</td>
                      <td>{test.id === selected[0]?.id ? "baseline" : fmt(net - baselineNet)}</td>
                      <td>{fmt(netPercent)}%</td>
                      <td>{fmt(metrics.maxDrawdown)}%</td>
                      <td>{fmt(metrics.profitFactor)}</td>
                      <td>{fmt(metrics.winRate)}%</td>
                      <td title="RRR = average winner / absolute average loser">{Number.isFinite(resultRrr(test).value) ? fmt(resultRrr(test).value) : "unavailable"}</td>
                      <td title="Average trade result in risk units">{Number.isFinite(resultAvgR(test).value) ? fmt(resultAvgR(test).value) : "unavailable"}</td>
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
  const byPf = [...results].sort((a, b) => Number(b.metrics?.profitFactor ?? 0) - Number(a.metrics?.profitFactor ?? 0));
  const byWin = [...results].sort((a, b) => Number(b.metrics?.winRate ?? 0) - Number(a.metrics?.winRate ?? 0));
  return `${byProfit[0].name} leads net, ${byPf[0].name} leads PF, ${byWin[0].name} leads win rate, and ${byDrawdown[0].name} has the lower drawdown. Use the difference-vs-baseline row before trusting a single winner.`;
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
            <NumberField label="Fixed Risk target = % equity" value={form.oneSlPercent} step="0.1" onChange={(value) => setForm({ ...form, oneSlPercent: value })} help="Used by Fixed Risk Per Trade. Position size changes so SL loss targets this percent." />
            <NumberField label="Position Percent = % equity" value={form.positionPercent ?? 10} step="1" onChange={(value) => setForm({ ...form, positionPercent: value })} help="Used by Position Percent. Exposure is fixed and SL loss varies." />
            <details className="hubert-advanced">
              <summary>Advanced sizing caps</summary>
              <div className="hubert-lab__grid">
                <NumberField label="Max leverage cap" value={form.maxLeverage ?? 1000} step="1" onChange={(value) => setForm({ ...form, maxLeverage: value })} />
                <NumberField label="Max exposure % equity" value={form.maxExposurePercent ?? 100000} step="100" onChange={(value) => setForm({ ...form, maxExposurePercent: value })} />
              </div>
            </details>
          </>
        ) : (
          <NumberField label="Every trade = USDT" value={form.fixedNotional} step="10" onChange={(value) => setForm({ ...form, fixedNotional: value })} />
        )}
        <MiniStatus>Position Percent = fixed exposure. Fixed Risk = fixed capital risk at stop-loss.</MiniStatus>
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

function ExecutionPanel({ accountProfiles, battleDecks, executionDeckId, livestream, onAction, onForceSync, rawCandles, selectedBattleDeck, setActivePanel, setExecutionDeckId, status }) {
  const state = status?.state ?? {};
  const bingx = state.bingx ?? {};
  const selectedProfile =
    accountProfiles.find((profile) => profile.id === (selectedBattleDeck?.apiProfile ?? "main")) ??
    accountProfiles[0];
  const executionBalance = Number(selectedProfile?.futuresBalance ?? bingx.activeExecutionBalance ?? 0);
  const readinessIssues = executionReadinessIssues({
    balance: executionBalance,
    profile: selectedProfile,
    selectedBattleDeck,
    status,
  });
  const ready = readinessIssues.length === 0;
  const exchangePosition = livestream?.positions?.[0] ?? null;
  const openOrders = livestream?.openOrders ?? [];
  const currentPrice = rawCandles.at(-1)?.close;
  const liveSummary = livestream?.accountSummary ?? {};

  return (
    <section className="hubert-lab__section">
      <div className="hubert-lab__grid">
        <SelectField label="Battle Deck" value={executionDeckId || selectedBattleDeck?.id || ""} onChange={setExecutionDeckId} options={battleDecks.map((deck) => [deck.id, deck.name])} />
        <ReadOnly label="Readiness" value={ready ? "Ready" : "Needs attention"} />
      </div>
      <MiniStatus tone={ready ? "good" : "bad"}>
        {ready ? `Ready to run ${selectedBattleDeck.name} on ${selectedProfile?.label ?? "selected account"}.` : readinessIssues.join(" ")}
      </MiniStatus>
      <div className="hubert-lab__metrics">
        <Metric label="Bot status" value={displayBotStatus(state.botStatus)} />
        <Metric label="Active deck" value={selectedBattleDeck?.name ?? "--"} />
        <Metric label="API profile" value={selectedProfile?.label ?? selectedBattleDeck?.apiProfile ?? "--"} />
        <Metric label="Profile health" value={selectedProfile ? humanProfileStatus(selectedProfile) : "Unavailable"} />
        <Metric label="Current price" value={fmt(currentPrice)} />
        <Metric label="Futures balance" value={fmt(executionBalance)} />
        <Metric label="Position" value={exchangePosition ? `${exchangePosition.symbol ?? selectedBattleDeck?.symbol} ${exchangePosition.positionSide ?? exchangePosition.side ?? ""}` : "None"} />
        <Metric label="Open orders" value={openOrders.length} />
        <Metric label="Live sync" value={liveSummary.lastBingxSyncAt ? `${ageText(liveSummary.lastBingxSyncAt)} · ${liveSummary.source ?? "BingX"}` : "Syncing"} />
        <Metric label="Last signal" value={state.lastStrategySignal?.direction ?? "--"} />
        <Metric label="Last action" value={state.lastExecutionDecision ?? "--"} />
      </div>
      <div className="hubert-lab__actions hubert-lab__actions--sticky">
        <button disabled={!ready} type="button" onClick={() => onAction("/execution/start", "Start Bot", { battleDeckId: selectedBattleDeck?.id, confirm: "START_LIVE" })}>Start Bot</button>
        <button type="button" onClick={() => setActivePanel("Livestream")}>Open Livestream</button>
        <button type="button" onClick={onForceSync}>Force Sync</button>
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
  onForceSync,
  onManualAction,
  pendingAction,
  result,
  setForm,
  setMessage,
  setPendingAction,
  symbol,
}) {
  const [positionControls, setPositionControls] = useState({});
  const [positionCardActions, setPositionCardActions] = useState({});
  const positions = livestream?.positions ?? [];
  const summary = livestream?.accountSummary ?? {};
  const activePosition = positions.find((position) => compact(position.symbol) === compact(form.symbol || symbol)) ?? positions[0];
  const actions = [
    ["MARKET_LONG", "Market Long", "Sends a real market long with the quantity below."],
    ["MARKET_SHORT", "Market Short", "Sends a real market short with the quantity below."],
    ["MOVE_SL", "Move SL", "Cancels the current hedge-side SL if present, then places the replacement."],
    ["MOVE_TP", "Move TP", "Cancels the current hedge-side TP if present, then places the replacement."],
    ["CLOSE_POSITION", "Close Position", "Closes the selected BingX hedge-side position."],
    ["CLOSE_PARTIAL", "Close Partial", "Sends a hedge-side market close for the quantity below."],
    ["CANCEL_ALL", "Cancel All Orders", "Cancels open orders for this symbol."],
  ];
  const positionOnlyActions = new Set(["MOVE_SL", "MOVE_TP", "CLOSE_POSITION", "CLOSE_PARTIAL", "CANCEL_ALL"]);

  function updatePositionControl(key, field, value) {
    setPositionControls((current) => ({
      ...current,
      [key]: {
        ...(current[key] ?? {}),
        [field]: value,
      },
    }));
  }

  function chooseAction(action) {
    setMessage("");
    setPendingAction(action);
    setForm((current) => ({
      ...current,
      positionId: positionIdentifier(activePosition) ?? current.positionId ?? "",
      positionSide: activePosition?.positionSide ?? activePosition?.side ?? current.positionSide ?? "",
      symbol: current.symbol || activePosition?.symbol || symbol || "SOLUSDT",
    }));
  }

  function confirmAction() {
    if (!pendingAction) return;
    onManualAction({
      action: pendingAction,
      apiProfile: form.apiProfile ?? activePosition?.apiProfile ?? "main",
      positionId: form.positionId || positionIdentifier(activePosition) || undefined,
      positionSide: form.positionSide || activePosition?.positionSide || activePosition?.side || undefined,
      quantity: Number(form.quantity),
      stopPrice: Number(form.stopPrice),
      symbol: form.symbol || symbol || "SOLUSDT",
      takeProfitPrice: Number(form.takeProfitPrice),
    });
  }

  function cardPayload(position, action, values = {}) {
    return {
      action,
      apiProfile: position.apiProfile ?? form.apiProfile ?? "main",
      positionId: positionIdentifier(position) || undefined,
      positionSide: position.positionSide || position.side || undefined,
      quantity: Number(values.quantity ?? position.quantity),
      stopPrice: Number(values.stopPrice ?? position.stopLoss),
      symbol: position.symbol || form.symbol || symbol || "SOLUSDT",
      takeProfitPrice: Number(values.takeProfitPrice ?? position.takeProfit),
    };
  }

  async function runPositionCardAction(position, action, values = {}, options = {}) {
    const key = positionCardKey(position);
    if (options.confirm && !window.confirm(options.confirmMessage ?? "Send this action for this exact position?")) return;

    setPositionCardActions((current) => ({
      ...current,
      [key]: {
        action,
        loading: true,
        message: `${manualActionLabel(action)} sent for this card...`,
        ok: null,
        result: null,
        updatedAt: new Date().toISOString(),
      },
    }));

    const payload = await onManualAction(cardPayload(position, action, values));
    const ok = Boolean(payload && payload.ok !== false);
    setPositionCardActions((current) => ({
      ...current,
      [key]: {
        action,
        loading: false,
        message: payload?.message ?? (ok ? `${manualActionLabel(action)} completed.` : `${manualActionLabel(action)} failed. Check exchange response.`),
        ok,
        result: payload ?? null,
        updatedAt: new Date().toISOString(),
      },
    }));
  }

  async function runPositionForceSync(position) {
    const key = positionCardKey(position);
    setPositionCardActions((current) => ({
      ...current,
      [key]: {
        action: "FORCE_SYNC",
        loading: true,
        message: "Refreshing this position from BingX...",
        ok: null,
        result: null,
        updatedAt: new Date().toISOString(),
      },
    }));
    const payload = await onForceSync();
    const ok = payload !== null;
    setPositionCardActions((current) => ({
      ...current,
      [key]: {
        action: "FORCE_SYNC",
        loading: false,
        message: ok ? "Fresh BingX sync completed." : "Fresh sync failed. Check the top action message.",
        ok,
        result: null,
        updatedAt: new Date().toISOString(),
      },
    }));
  }

  function renderPositionCard(position) {
    const key = positionCardKey(position);
    const controls = positionControls[key] ?? {};
    const cardAction = positionCardActions[key] ?? {};
    const cardBusy = Boolean(cardAction.loading);
    const attachedOrders = position.attachedOrders ?? [];
    const hasProtection = attachedOrders.length > 0 || Number(position.stopLoss) > 0 || Number(position.takeProfit) > 0;
    const slValue = controls.stopPrice ?? (position.stopLoss ? String(position.stopLoss) : "");
    const tpValue = controls.takeProfitPrice ?? (position.takeProfit ? String(position.takeProfit) : "");

    return (
      <div className="hubert-live-card" key={key}>
        <div className="hubert-live-card__head">
          <strong>{position.symbol} {position.side}</strong>
          <span>{position.battleDeckName ?? "Exchange position"} · {position.apiProfile}</span>
        </div>
        <MiniStatus tone="good">Position card controls v2</MiniStatus>
        <div className="hubert-lab__metrics">
          <Metric label="Entry" value={fmt(position.entryPrice)} />
          <Metric label="Mark" value={fmt(position.currentPrice)} />
          <Metric label="Quantity" value={fmt(position.quantity, 3)} />
          <Metric label="Position ID" value={positionIdentifier(position) ?? "BingX did not provide one"} />
          <Metric label="Position side" value={position.positionSide ?? position.side ?? "--"} />
          <Metric label="PnL" value={fmt(position.unrealizedPnl)} />
          <Metric label="SL" value={fmt(position.stopLoss)} />
          <Metric label="TP" value={fmt(position.takeProfit)} />
        </div>
        <div className="hubert-position-sources">
          <span><strong>Active SL</strong>{fmt(position.stopLoss)} · {protectionSourceText(position, "SL")}</span>
          <span><strong>Active TP</strong>{fmt(position.takeProfit)} · {protectionSourceText(position, "TP")}</span>
        </div>
        <OrderTable orders={attachedOrders} />
        <div className="hubert-position-controls">
          <label>
            <span>SL</span>
            <input
              inputMode="decimal"
              placeholder="Stop price"
              type="number"
              value={slValue}
              onChange={(event) => updatePositionControl(key, "stopPrice", event.target.value)}
            />
          </label>
          <button
            disabled={cardBusy || !Number.isFinite(Number(slValue)) || Number(slValue) <= 0}
            type="button"
            onClick={() => runPositionCardAction(position, "MOVE_SL", { stopPrice: slValue })}
          >
            {cardBusy && cardAction.action === "MOVE_SL" ? "Moving..." : "Move SL"}
          </button>
          <label>
            <span>TP</span>
            <input
              inputMode="decimal"
              placeholder="Take profit"
              type="number"
              value={tpValue}
              onChange={(event) => updatePositionControl(key, "takeProfitPrice", event.target.value)}
            />
          </label>
          <button
            disabled={cardBusy || !Number.isFinite(Number(tpValue)) || Number(tpValue) <= 0}
            type="button"
            onClick={() => runPositionCardAction(position, "MOVE_TP", { takeProfitPrice: tpValue })}
          >
            {cardBusy && cardAction.action === "MOVE_TP" ? "Moving..." : "Move TP"}
          </button>
          <button
            disabled={cardBusy}
            type="button"
            onClick={() => runPositionCardAction(position, "CLOSE_POSITION", {}, {
              confirm: true,
              confirmMessage: `Close ${position.symbol} ${position.side} position ${positionIdentifier(position) ?? ""}?`,
            })}
          >
            {cardBusy && cardAction.action === "CLOSE_POSITION" ? "Closing..." : "Close Position"}
          </button>
          <button
            disabled={cardBusy || !hasProtection}
            title={!hasProtection ? "No attached protection/orders reported for this position." : "Cancel protection/orders attached to this exact position."}
            type="button"
            onClick={() => runPositionCardAction(position, "CANCEL_ATTACHED_ORDERS", {}, {
              confirm: true,
              confirmMessage: `Cancel attached protective/orders for ${position.symbol} ${position.side}?`,
            })}
          >
            {cardBusy && cardAction.action === "CANCEL_ATTACHED_ORDERS" ? "Cancelling..." : "Cancel Protection/Orders"}
          </button>
          <button disabled={cardBusy} type="button" onClick={() => runPositionForceSync(position)}>
            {cardBusy && cardAction.action === "FORCE_SYNC" ? "Syncing..." : "Force Sync"}
          </button>
        </div>
        {cardAction.message && (
          <MiniStatus tone={cardAction.ok === false ? "bad" : cardAction.ok === true ? "good" : "neutral"}>
            {cardAction.message}
          </MiniStatus>
        )}
        {cardAction.result && (
          <details className="hubert-details">
            <summary>Position card diagnostics</summary>
            <pre>{JSON.stringify({
              action: cardAction.action,
              diagnostics: cardAction.result?.diagnostics ?? null,
              message: cardAction.result?.message ?? cardAction.message,
              ok: cardAction.result?.ok ?? cardAction.ok,
              result: cardAction.result?.result ?? null,
            }, null, 2)}</pre>
          </details>
        )}
      </div>
    );
  }

  return (
    <section className="hubert-lab__section">
      <MiniStatus>Crisis Management ON gives manual control priority. New bot entries stay blocked while you act.</MiniStatus>
      {positions.length ? (
        <div className="hubert-live-stack">
          {positions.map(renderPositionCard)}
        </div>
      ) : (
        <MiniStatus>No live position context is currently reported. Position actions stay disabled until the backend sees an open position. Market open actions still require symbol and quantity.</MiniStatus>
      )}
      <div className="hubert-lab__actions">
        <button type="button" onClick={onCrisisOn}>Crisis Management ON</button>
        <button type="button" onClick={onCrisisOff}>Crisis Management OFF</button>
        <button type="button" onClick={onForceSync}>Force Sync</button>
      </div>
      <MiniStatus tone={dataFreshnessTone(summary.lastBingxSyncAt)}>
        Source: {summary.source ?? "syncing"}. Last BingX sync: {ageText(summary.lastBingxSyncAt)}. Data age: {summary.dataAgeSeconds ?? "--"}s.
      </MiniStatus>
      <details className="hubert-advanced">
        <summary>Advanced manual action</summary>
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
              disabled={!activePosition && positionOnlyActions.has(action)}
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
            <span>
              {actions.find(([action]) => action === pendingAction)?.[2]}
              {activePosition ? ` Context: ${activePosition.symbol} ${activePosition.side}, SL ${fmt(activePosition.stopLoss)}, TP ${fmt(activePosition.takeProfit)}.` : " No open position context is attached."}
            </span>
            <button type="button" onClick={confirmAction}>Confirm Send</button>
            <button type="button" onClick={() => setPendingAction(null)}>Cancel</button>
          </div>
        )}
        {message && <MiniStatus>{message}</MiniStatus>}
        {result && (
          <details className="hubert-details">
            <summary>Exchange response and payload</summary>
            <pre>{JSON.stringify({
              diagnostics: result.diagnostics ?? null,
              rawExchangeResponse: result.rawExchangeResponse ?? null,
              result: result.result ?? null,
            }, null, 2)}</pre>
          </details>
        )}
      </details>
    </section>
  );
}

function SztabGeneralnyPanel({
  accountProfiles = [],
  backendStatus,
  battleDecks = [],
  chartSettings = {},
  indicatorSettingsByInterval = {},
  livestream,
  mmDecks = [],
  onAction,
  onCancelAllOrders,
  onCancelPendingTriggers,
  onEmergencyStop,
  onForceSync,
  onOpenAdvanced,
  onSyncChartFromSztab,
  onCheckSignalParity,
  onPositionAction,
  onPositionRefresh,
  onRestartInterval,
  onSaveConfig,
  onStartInterval,
  onStopAll,
  onStopInterval,
  onSyncInterval,
  onUpdate,
  positionActionState = {},
  rawCandles = [],
  selectedInterval,
  strategyDecks = [],
  system,
  value,
}) {
  const [localMessage, setLocalMessage] = useState("");
  const state = mergeSztabState(value);
  const activeTab = state.activeTab ?? "general";
  const botStatus = system?.state?.botStatus ?? "STOPPED";
  const intervalRuntimes = backendStatus?.intervals ?? {};
  const globalRunning = Object.values(intervalRuntimes).some((item) => item.runtime?.status === "running") ||
    botStatus === "LIVE_RUNNING" ||
    botStatus === "PAPER_RUNNING";
  const intervalRunnerWired = true;
  const summary = livestream?.accountSummary ?? {};
  const positions = livestream?.positions ?? [];
  const openOrders = livestream?.openOrders ?? [];
  const profileOptions = accountProfiles.map((profile) => [profile.id, `${profile.label ?? profile.id} (${profile.status ?? "unknown"})`]);

  function commit(nextState) {
    onUpdate({
      ...nextState,
      updatedAt: new Date().toISOString(),
    });
  }

  function setActiveTab(tab) {
    commit({ ...state, activeTab: tab });
  }

  function setExpanded(expanded) {
    commit({ ...state, expanded });
  }

  function patchInterval(interval, updater) {
    const current = state.intervals[interval] ?? createDefaultSztabIntervalConfig(SZTAB_TIMEFRAMES.find((item) => item.interval === interval) ?? SZTAB_TIMEFRAMES[0]);
    const next = typeof updater === "function" ? updater(current) : { ...current, ...updater };
    commit({
      ...state,
      intervals: {
        ...state.intervals,
        [interval]: next,
      },
    });
  }

  function updateStrategy(interval, key, nextValue) {
    patchInterval(interval, (current) => ({
      ...current,
      strategy: {
        ...current.strategy,
        [key]: nextValue,
      },
      strategyDirty: true,
      validation: {
        ...current.validation,
        message: "Settings changed. Validate before applying.",
        ok: false,
      },
    }));
  }

  function updateMm(interval, key, nextValue) {
    patchInterval(interval, (current) => ({
      ...current,
      mm: {
        ...current.mm,
        [key]: nextValue,
      },
      mmDirty: true,
      validation: {
        ...current.validation,
        message: "Risk settings changed. Validate before applying.",
        ok: false,
      },
    }));
  }

  function updateProfile(interval, apiProfile) {
    patchInterval(interval, (current) => ({
      ...current,
      apiProfile,
      validation: {
        ...current.validation,
        message: "Profile mapping changed. Validate before applying.",
        ok: false,
      },
    }));
  }

  async function validateInterval(interval) {
    const config = state.intervals[interval];
    await onSaveConfig(interval, {
      apiProfile: config.apiProfile,
      mm: config.mm,
      strategy: config.strategy,
      symbol: config.symbol ?? "SOLUSDT",
    });
    setLocalMessage(`Validation refreshed for ${intervalDisplayLabel(interval)}.`);
  }

  async function saveStrategy(interval) {
    const config = state.intervals[interval];
    await onSaveConfig(interval, {
      apiProfile: config.apiProfile,
      saveStrategy: true,
      strategy: config.strategy,
      symbol: config.symbol ?? "SOLUSDT",
      strategyLocked: config.strategyLocked,
    });
    patchInterval(interval, (current) => ({ ...current, strategyDirty: false }));
    setLocalMessage(`Strategy saved for ${intervalDisplayLabel(interval)}.`);
  }

  async function saveMm(interval) {
    const config = state.intervals[interval];
    await onSaveConfig(interval, {
      apiProfile: config.apiProfile,
      mm: config.mm,
      mmLocked: config.mmLocked,
      saveMm: true,
    });
    patchInterval(interval, (current) => ({ ...current, mmDirty: false }));
    setLocalMessage(`MM saved for ${intervalDisplayLabel(interval)}.`);
  }

  async function applyInterval(interval) {
    const config = state.intervals[interval];
    if (config.strategyDirty || config.mmDirty) {
      setLocalMessage("Save Strategy and Save MM before applying to the bot.");
      return;
    }
    await onSaveConfig(interval, {
      apiProfile: config.apiProfile,
      locked: config.strategyLocked && config.mmLocked,
      mmLocked: config.mmLocked,
      strategyLocked: config.strategyLocked,
      symbol: config.symbol ?? "SOLUSDT",
    });
    setLocalMessage("Saved Sztab config is applied to backend. Start uses these direct settings.");
  }

  function startInterval(interval) {
    onStartInterval(interval);
  }

  function stopInterval(interval) {
    onStopInterval(interval);
  }

  async function checkSignalParity(interval) {
    if (!onCheckSignalParity) return;
    const result = await onCheckSignalParity(interval);
    if (result?.summary || result?.explanation) {
      setLocalMessage(result.summary ?? result.explanation);
    }
  }

  const warnings = sztabWarnings({
    accountProfiles,
    botStatus,
    intervals: state.intervals,
    positions,
    summary,
  });

  return (
    <section className="hubert-sztab" data-expanded={state.expanded ? "true" : "false"}>
      <div className="hubert-sztab__header">
        <div>
          <strong>Sztab Generalny</strong>
          <span>Main operational command center · {intervalRunnerWired ? "interval runner wired" : "backend interval runner not wired yet"}</span>
        </div>
        <div>
          <button type="button" onClick={() => setExpanded(!state.expanded)}>
            {state.expanded ? "Compact" : "Expand fullscreen"}
          </button>
          <button type="button" onClick={() => onOpenAdvanced("Strategy Decks")}>Open Decks / Advanced configuration</button>
        </div>
      </div>

      <div className="hubert-sztab-tabs" role="tablist" aria-label="Sztab Generalny tabs">
        <button data-active={activeTab === "general"} type="button" onClick={() => setActiveTab("general")}>Ogólne</button>
        {SZTAB_TIMEFRAMES.map((timeframe) => (
          <button
            data-active={activeTab === timeframe.interval}
            key={timeframe.interval}
            type="button"
            onClick={() => setActiveTab(timeframe.interval)}
          >
            {timeframe.label}
          </button>
        ))}
      </div>

      {localMessage && <MiniStatus>{localMessage}</MiniStatus>}

      {activeTab === "general" ? (
        <SztabGeneralOverview
          accountProfiles={accountProfiles}
          botStatus={botStatus}
          intervals={state.intervals}
          onCancelAllOrders={onCancelAllOrders}
          onCancelPendingTriggers={onCancelPendingTriggers}
          onEmergencyStop={onEmergencyStop}
          onForceSync={onForceSync}
          onStopAll={onStopAll}
          openOrders={openOrders}
          positions={positions}
          summary={summary}
          warnings={warnings}
        />
      ) : (
        <SztabIntervalPanel
          accountProfiles={accountProfiles}
          battleDecks={battleDecks}
          config={state.intervals[activeTab]}
          chartSettings={chartSettings}
          globalRunning={globalRunning}
          indicatorSettingsByInterval={indicatorSettingsByInterval}
          interval={activeTab}
          livestream={livestream}
          mmDecks={mmDecks}
          onAction={onAction}
          onApply={() => applyInterval(activeTab)}
          onCheckSignalParity={() => checkSignalParity(activeTab)}
          onForceSync={onForceSync}
          onOpenAdvanced={onOpenAdvanced}
          onPositionAction={onPositionAction}
          onPositionRefresh={onPositionRefresh}
          onSaveMm={() => saveMm(activeTab)}
          onSaveStrategy={() => saveStrategy(activeTab)}
          onStart={() => startInterval(activeTab)}
          onStop={() => stopInterval(activeTab)}
          onRestart={() => onRestartInterval(activeTab)}
          onSyncInterval={onSyncInterval}
          onSyncChartFromSztab={() => {
            onSyncChartFromSztab?.(activeTab, state.intervals[activeTab]?.strategy ?? {});
            setLocalMessage(`Chart params synced from ${intervalDisplayLabel(activeTab)} Sztab settings.`);
          }}
          onPushChartToSztab={() => {
            const chartSource = selectedInterval === activeTab
              ? chartSettings
              : indicatorSettingsByInterval[activeTab] ?? chartSettings;
            patchInterval(activeTab, (current) => ({
              ...current,
              strategy: {
                ...current.strategy,
                atrLength: chartSource.atrLength,
                atrMultiplier: chartSource.atrMultiplier,
                bandwidth: chartSource.bandwidth,
                envelopeMultiplier: chartSource.envelopeMultiplier,
                maxSameSideFailures: chartSource.maxSameSideFailures,
                strategySource: chartSource.strategySource,
              },
              strategyDirty: true,
              validation: {
                ...current.validation,
                message: "Chart settings pushed into Sztab. Save Strategy before applying.",
                ok: false,
              },
            }));
            setLocalMessage(`Sztab ${intervalDisplayLabel(activeTab)} strategy updated from chart indicator settings. Save Strategy before start.`);
          }}
          onToggleLock={async (locked) => {
            patchInterval(activeTab, (current) => ({
              ...current,
              locked,
              mmLocked: locked,
              strategyLocked: locked,
            }));
            const config = state.intervals[activeTab];
            await onSaveConfig(activeTab, {
              apiProfile: config.apiProfile,
              locked,
              mmLocked: locked,
              strategyLocked: locked,
            });
          }}
          onUpdateMm={(key, nextValue) => updateMm(activeTab, key, nextValue)}
          onUpdateProfile={(nextValue) => updateProfile(activeTab, nextValue)}
          onUpdateStrategy={(key, nextValue) => updateStrategy(activeTab, key, nextValue)}
          onValidate={() => validateInterval(activeTab)}
          positionActionState={positionActionState}
          profileOptions={profileOptions}
          rawCandles={rawCandles}
          selectedInterval={selectedInterval}
          strategyDecks={strategyDecks}
          summary={summary}
          system={system}
        />
      )}
    </section>
  );
}

function SztabGeneralOverview({
  accountProfiles = [],
  botStatus,
  intervals,
  onCancelAllOrders,
  onCancelPendingTriggers,
  onEmergencyStop,
  onForceSync,
  onStopAll,
  openOrders = [],
  positions = [],
  summary = {},
  warnings = [],
}) {
  const mappedIntervals = Object.values(intervals).filter((config) => config.apiProfile).length;
  const totalBalance = hasKnownProfileBalance(accountProfiles)
    ? totalProfileBalance(accountProfiles)
    : Number(summary.totalCombinedFuturesBalance ?? 0);

  function confirmCancelAll() {
    if (!window.confirm("Cancel all visible BingX open orders for the synced profiles/symbols?")) return;
    onCancelAllOrders();
  }

  function confirmCloseAll() {
    const text = window.prompt("Type CLOSE ALL POSITIONS to emergency stop and request closing all backend-known live positions.");
    if (text !== "CLOSE ALL POSITIONS") return;
    onEmergencyStop(true);
  }

  return (
    <div className="hubert-sztab-layout hubert-sztab-layout--general">
      <section className="hubert-sztab-card">
        <div className="hubert-lab__subhead">
          <strong>Global overview</strong>
          <span>{displayBotStatus(botStatus)}</span>
        </div>
        <div className="hubert-lab__metrics">
          <Metric label="Bot global status" value={displayBotStatus(botStatus)} />
          <Metric label="Active intervals" value={`${mappedIntervals}/${SZTAB_TIMEFRAMES.length} mapped`} />
          <Metric label="Total futures balance" value={fmt(totalBalance)} />
          <Metric label="Open positions" value={summary.totalOpenPositions ?? positions.length} />
          <Metric label="Open orders" value={openOrders.length || accountProfiles.reduce((sum, profile) => sum + Number(profile.openOrders ?? 0), 0)} />
          <Metric label="Live data age" value={summary.dataAgeSeconds !== null && summary.dataAgeSeconds !== undefined ? `${summary.dataAgeSeconds}s` : ageText(summary.lastBingxSyncAt)} />
          <Metric label="Source" value={summary.source ?? "syncing"} />
          <Metric label="Last sync" value={compactDateText(summary.lastBingxSyncAt)} />
          <Metric label="Time" value={DISPLAY_TIME_ZONE} />
          <Metric label="Profiles" value={accountProfiles.length || "--"} />
        </div>
        <MiniStatus tone={dataFreshnessTone(summary.lastBingxSyncAt)}>
          Source: {summary.source ?? "syncing"}. Last successful sync: {ageText(summary.lastBingxSyncAt)}.
        </MiniStatus>
      </section>

      <section className="hubert-sztab-card">
        <div className="hubert-lab__subhead">
          <strong>Emergency controls</strong>
          <span>global runner</span>
        </div>
        <div className="hubert-sztab-emergency">
          <button type="button" onClick={onStopAll}>Stop all bots</button>
          <button type="button" onClick={onForceSync}>Force sync all</button>
          <button type="button" onClick={onCancelPendingTriggers}>Cancel Sztab triggers</button>
          <button type="button" onClick={confirmCancelAll}>Cancel all orders</button>
          <button className="hubert-danger-button" type="button" onClick={confirmCloseAll}>Close all positions</button>
        </div>
        <MiniStatus tone="neutral">
          Stop all stops Sztab interval runners and the existing global runner. Close all positions still uses the existing emergency-stop path.
        </MiniStatus>
      </section>

      <section className="hubert-sztab-card">
        <div className="hubert-lab__subhead">
          <strong>API profile mapping</strong>
          <span>no secrets shown</span>
        </div>
        <div className="hubert-lab__table">
          <table>
            <thead>
              <tr><th>Interval</th><th>Profile</th><th>Lock</th><th>Validated</th></tr>
            </thead>
            <tbody>
              {SZTAB_TIMEFRAMES.map((timeframe) => {
                const config = intervals[timeframe.interval];
                const profile = accountProfiles.find((item) => item.id === config.apiProfile);
                return (
                  <tr key={timeframe.interval}>
                    <td>{timeframe.label}</td>
                    <td>{profile?.label || config.apiProfile || "Missing"}</td>
                    <td>{config.locked ? "Locked" : "Editable"}</td>
                    <td>{config.validation?.ok ? "OK" : "Needs check"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="hubert-sztab-card">
        <div className="hubert-lab__subhead">
          <strong>System warnings</strong>
          <span>{warnings.length ? `${warnings.length} warning(s)` : "clear"}</span>
        </div>
        {warnings.length ? (
          <div className="hubert-sztab-warnings">
            {warnings.map((warning) => (
              <MiniStatus key={warning} tone="bad">{warning}</MiniStatus>
            ))}
          </div>
        ) : (
          <MiniStatus tone="good">No current Sztab-level warnings from the visible backend state.</MiniStatus>
        )}
      </section>
    </div>
  );
}

function SztabIntervalPanel({
  accountProfiles = [],
  battleDecks = [],
  chartSettings = {},
  config,
  globalRunning,
  indicatorSettingsByInterval = {},
  interval,
  livestream,
  mmDecks = [],
  onAction,
  onApply,
  onCheckSignalParity,
  onForceSync,
  onOpenAdvanced,
  onPositionAction,
  onPositionRefresh,
  onSaveMm,
  onSaveStrategy,
  onStart,
  onStop,
  onRestart,
  onSyncInterval,
  onSyncChartFromSztab,
  onToggleLock,
  onPushChartToSztab,
  onUpdateMm,
  onUpdateProfile,
  onUpdateStrategy,
  onValidate,
  positionActionState = {},
  profileOptions = [],
  rawCandles = [],
  selectedInterval,
  strategyDecks = [],
  summary = {},
  system,
}) {
  const runtime = isRecord(config.runtime) ? config.runtime : {};
  const isRunning = ["running", "degraded", "recovering"].includes(String(runtime.status ?? "").toLowerCase());
  const locked = isRunning || config.locked || (config.strategyLocked && config.mmLocked);
  const profile = accountProfiles.find((item) => item.id === config.apiProfile);
  const positions = positionsForInterval(livestream?.positions ?? [], config, interval);
  const orders = ordersForInterval(livestream?.openOrders ?? [], config);
  const globalBlockers = safeObjectRows(runtime.globalBlockers);
  const intervalBlockers = safeObjectRows(runtime.intervalBlockers);
  const latestCandle = selectedInterval === interval ? rawCandles.at(-1) : null;
  const logs = (system?.logs ?? []).filter((log) => {
    const haystack = JSON.stringify(log).toLowerCase();
    return haystack.includes(interval.toLowerCase()) || (config.apiProfile && haystack.includes(String(config.apiProfile).toLowerCase()));
  }).slice(-20);
  const validationTone = config.validation?.ok ? "good" : "neutral";
  const validationMessage = validationText(config.validation);
  const startReady = Boolean(config.apiProfile && config.strategySavedAt && config.mmSavedAt && config.strategyLocked && config.mmLocked && config.validation?.ok);
  const triggerOrderStatus = String(runtime.pendingTriggerOrder?.status ?? runtime.triggerOrderState ?? "").toLowerCase();
  const triggerOrderIsActive = ["accepted", "placed", "new", "partially_filled", "pending_sync", "platform_armed"].includes(triggerOrderStatus);
  const platformTriggerMode = (runtime.executionMode ?? runtime.pendingTriggerOrder?.executionMode) === "platform_market_trigger";
  const reversalTrigger = Boolean(runtime.reversalTrigger || runtime.pendingTriggerOrder?.isReversal);
  const cleanupFailureClassification = runtime.cleanupFailureClassification ?? "";
  const marginDiagnostics = triggerMarginDiagnostics(runtime);
  const marginWarnings = marginDiagnostics.warnings ?? [];
  const currentSetupOrderJournal = safeObjectRows(runtime.currentSetupOrderJournal);
  const historicalSetupOrderJournal = safeObjectRows(runtime.historicalSetupOrderJournal).length
    ? safeObjectRows(runtime.historicalSetupOrderJournal)
    : safeObjectRows(runtime.setupOrderJournal).filter((item) => item.historical);
  const currentDecisionTimeline = safeObjectRows(runtime.currentDecisionTimeline);
  const detectedTakeProfitOrders = [
    ...orders.filter(takeProfitOrderLike),
    ...positions
      .map((position) => protectionOrder(position, "TP"))
      .filter(Boolean),
    isRecord(runtime.pendingTriggerOrder) ? runtime.pendingTriggerOrder.takeProfitOrder : null,
  ].filter(isRecord);
  const detectedLegacyTakeProfitState = detectedTakeProfitOrders.length > 0 ||
    positions.some((position) => Number(position.takeProfit) > 0) ||
    Boolean(runtime.pendingTriggerOrder?.takeProfitOrder);
  const strategySaveStatus = config.strategyDirty
    ? "Unsaved changes"
    : config.strategySavedAt
      ? `Strategy saved ${compactDateText(config.strategySavedAt)}`
      : "Strategy not saved";
  const mmSaveStatus = config.mmDirty
    ? "Unsaved changes"
    : config.mmSavedAt
      ? `MM saved ${compactDateText(config.mmSavedAt)}`
      : "MM not saved";
  const intervalChartSettings = selectedInterval === interval
    ? chartSettings
    : indicatorSettingsByInterval[interval] ?? chartSettings;
  const chartSztabDiffs = strategyParamDiffs(config.strategy, intervalChartSettings);

  function lockedStart() {
    onStart();
  }

  return (
    <div className="hubert-sztab-layout">
      <section className="hubert-sztab-card hubert-sztab-card--span">
        <div className="hubert-sztab-interval-head">
          <div>
          <strong>{intervalDisplayLabel(interval)} interval command</strong>
          <span>
              Status: {runtime.status ?? "stopped"} · Source: {summary.source ?? "syncing"} · {ageText(summary.lastBingxSyncAt)}
          </span>
          </div>
          <div className="hubert-sztab-badges">
            <em>{profile?.label ?? "Missing profile"}</em>
            <em>{locked ? "🔒 Locked" : "🔓 Unlocked"}</em>
            <em>{dataFreshnessTone(summary.lastBingxSyncAt) === "bad" ? "Stale data" : "Fresh enough"}</em>
          </div>
        </div>
        <div className="hubert-lab__metrics">
          <Metric label="Bot status" value={runtime.status ?? "stopped"} />
          <Metric label="API profile" value={profile?.label || config.apiProfile || "Missing"} />
          <Metric label="Exchange source" value="BingX futures" />
          <Metric label="Live execution model" value={platformTriggerMode ? "Platform MARKET trigger watcher" : "Exchange stop-market trigger execution"} />
          <Metric label="Live sync" value={ageText(summary.lastBingxSyncAt)} />
          <Metric label="Lock state" value={locked ? "Locked" : "Unlocked"} />
          <Metric label="Started" value={compactDateText(runtime.startedAt)} />
          <Metric label="Last sync" value={compactDateText(runtime.lastSyncAt)} />
          <Metric label="Last order attempt" value={runtime.lastOrderAttempt ? compactDateText(runtime.lastOrderAttempt.time) : "--"} />
          <Metric label="Last error" value={runtime.error || "--"} />
        </div>
        <MiniStatus tone={validationTone}>
          {validationMessage}
        </MiniStatus>
      </section>

      <section className="hubert-sztab-card">
        <div className="hubert-lab__subhead">
          <strong>Strategy settings</strong>
          <button type="button" onClick={() => onOpenAdvanced("Strategy Decks")}>Advanced Decks</button>
        </div>
        <MiniStatus tone={config.strategyDirty ? "bad" : config.strategySavedAt ? "good" : "neutral"}>
          {strategySaveStatus}
        </MiniStatus>
        <MiniStatus tone={chartSztabDiffs.length ? "bad" : "good"}>
          {chartSztabDiffs.length
            ? `Chart/Sztab mismatch: ${chartSztabDiffs.map((diff) => `${diff.field} chart=${diff.chart ?? "--"} sztab=${diff.sztab ?? "--"}`).join("; ")}`
            : "Chart and Sztab params match for this interval."}
        </MiniStatus>
        <div className="hubert-lab__actions">
          <button type="button" onClick={onSyncChartFromSztab}>Sync chart from Sztab</button>
          <button disabled={locked} type="button" onClick={onPushChartToSztab}>Push chart to Sztab</button>
        </div>
        <div className="hubert-lab__grid">
          <NumberField disabled={locked} label="ATR length" value={config.strategy.atrLength} onChange={(value) => onUpdateStrategy("atrLength", value)} />
          <NumberField disabled={locked} label="ATR multiplier" step="0.1" value={config.strategy.atrMultiplier} onChange={(value) => onUpdateStrategy("atrMultiplier", value)} />
          <NumberField disabled={locked} label="NWE / envelope multiplier" step="0.1" value={config.strategy.envelopeMultiplier} onChange={(value) => onUpdateStrategy("envelopeMultiplier", value)} />
          <NumberField disabled={locked} label="Bandwidth" step="0.1" value={config.strategy.bandwidth} onChange={(value) => onUpdateStrategy("bandwidth", value)} />
          <NumberField disabled={locked} label="Max same-side failures" value={config.strategy.maxSameSideFailures} onChange={(value) => onUpdateStrategy("maxSameSideFailures", value)} />
          <label>
            <span>Strategy source</span>
            <select disabled={locked} value={config.strategy.strategySource === "raw" ? "raw-exchange" : config.strategy.strategySource ?? "pine-ha"} onChange={(event) => onUpdateStrategy("strategySource", event.target.value)}>
              <option value="pine-ha">Pine HA</option>
              <option value="raw-exchange">Raw candles</option>
            </select>
          </label>
        </div>
        <details className="hubert-advanced">
          <summary>Optional deck import reference</summary>
          <p>{strategyDecks.length ? `${strategyDecks.length} Strategy Deck(s) are available in Advanced mode.` : "No saved Strategy Decks are available yet."}</p>
        </details>
        <div className="hubert-lab__actions">
          <button disabled={isRunning} type="button" onClick={onSaveStrategy}>Save Strategy</button>
        </div>
      </section>

      <section className="hubert-sztab-card">
        <div className="hubert-lab__subhead">
          <strong>MM / risk settings</strong>
          <button type="button" onClick={() => onOpenAdvanced("MM Decks")}>Advanced MM</button>
        </div>
        <MiniStatus tone={config.mmDirty ? "bad" : config.mmSavedAt ? "good" : "neutral"}>
          {mmSaveStatus}
        </MiniStatus>
        <div className="hubert-lab__grid">
          <NumberField
            disabled={locked}
            help="Position size is adjusted so that a stop-loss hit risks this % of account equity. This does not mean entering with the full account balance."
            label="Risk per SL (% of account equity)"
            step="0.1"
            value={config.mm.riskPerSlPercent ?? config.mm.oneSlPercent ?? 1}
            onChange={(value) => onUpdateMm("riskPerSlPercent", value)}
          />
          <ReadOnly label="Operational futures capital allocation" value="100% of this subaccount balance" />
        </div>
        <MiniStatus>
          Fixed risk per SL only: position size is adjusted so that a stop-loss hit risks the selected % of account equity. This does not mean entering with the full account balance.
        </MiniStatus>
        <details className="hubert-advanced">
          <summary>Optional MM deck reference</summary>
          <p>{mmDecks.length ? `${mmDecks.length} MM Deck(s) are available in Advanced mode.` : "No saved MM Decks are available yet."}</p>
        </details>
        <div className="hubert-lab__actions">
          <button disabled={isRunning} type="button" onClick={onSaveMm}>Save MM</button>
        </div>
      </section>

      <section className="hubert-sztab-card">
        <div className="hubert-lab__subhead">
          <strong>Save / validate / apply</strong>
          <span>{isRunning ? "Bot running: config edit locked" : "Stopped/editable"}</span>
        </div>
        <div className="hubert-lab__grid">
          <label>
            <span>Assigned API profile / subaccount</span>
            <select disabled={isRunning} value={config.apiProfile ?? ""} onChange={(event) => onUpdateProfile(event.target.value)}>
              <option value="">Choose API profile</option>
              {profileOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <ReadOnly label="Profile status" value={profile?.status ?? "missing"} />
          <ReadOnly label="Balance" value={profileBalanceText(profile)} />
          <ReadOnly label="Open orders" value={profile?.openOrders ?? "--"} />
        </div>
        <div className="hubert-lab__actions">
          <button type="button" onClick={onValidate}>Validate settings</button>
          <button type="button" onClick={onApply}>Apply to bot</button>
          <button disabled={isRunning} type="button" onClick={() => onToggleLock(!(config.strategyLocked && config.mmLocked))}>
            {config.strategyLocked && config.mmLocked ? "🔒 Locked" : "🔓 Unlocked"}
          </button>
        </div>
        {!config.apiProfile && <MiniStatus tone="bad">Missing API profile mapping blocks Start bot.</MiniStatus>}
        {!startReady && <MiniStatus tone="bad">Start requires Strategy saved, MM saved, validation OK, API profile selected, and 🔒 Locked state.</MiniStatus>}
      </section>

      <section className="hubert-sztab-card">
        <div className="hubert-lab__subhead">
          <strong>Bot controls</strong>
          <span>backend Sztab interval runner</span>
        </div>
        <div className="hubert-sztab-controls">
          <button disabled={!startReady || isRunning} type="button" onClick={lockedStart}>Start bot</button>
          <button type="button" onClick={() => onStop(interval)}>Stop bot</button>
          <button disabled={!startReady} type="button" onClick={onRestart}>Restart bot</button>
          <button type="button" onClick={() => onSyncInterval(interval)}>Force sync</button>
          <button type="button" onClick={() => onAction(`latest-signal-${interval}`, "Latest signal", async () => runtime.lastSignal ?? { message: "No latest signal in Sztab runtime." })}>View latest signal</button>
          <button type="button" onClick={() => onAction(`latest-candle-${interval}`, "Latest candle", async () => runtime.lastCandle ?? latestCandle ?? { message: "No latest candle in Sztab runtime yet." })}>View latest candle</button>
          <button type="button" onClick={() => onAction(`latest-decision-${interval}`, "Latest decision", async () => runtime.lastDecision || { message: "No latest decision reason in Sztab runtime yet." })}>View last decision reason</button>
        </div>
      </section>

      <section className="hubert-sztab-card hubert-sztab-card--span">
        <div className="hubert-lab__subhead">
          <strong>Runner diagnostics</strong>
          <button type="button" onClick={onCheckSignalParity}>Check signal parity</button>
        </div>
        {(runtime.runnerDegraded || runtime.priceFeedStatus === "degraded") && (
          <MiniStatus tone="warn">
            Runner zwolnił przez limit API, ale nadal działa. Feed ceny: {runtime.priceFeedMode ?? "--"} / {runtime.priceFeedStatus ?? "--"}.
          </MiniStatus>
        )}
        {runtime.autoRecoveryStatus === "recovered" && (
          <MiniStatus tone="good">Runner automatycznie wznowiony po chwilowym problemie API/sieci.</MiniStatus>
        )}
        <div className="hubert-lab__metrics">
          <Metric label="Tick count" value={runtime.tickCount ?? 0} />
          <Metric label="Last loop" value={compactDateText(runtime.lastTickAt)} />
          <Metric label="Heartbeat age" value={runtime.heartbeatAgeSeconds !== null && runtime.heartbeatAgeSeconds !== undefined ? `${runtime.heartbeatAgeSeconds}s` : "--"} />
          <Metric label="Watchdog" value={runtime.watchdogStatus ?? (runtime.runnerStale ? "stale" : "--")} />
          <Metric label="Loop duration" value={runtime.lastLoopDurationMs !== null && runtime.lastLoopDurationMs !== undefined ? `${runtime.lastLoopDurationMs}ms` : "--"} />
          <Metric label="Candles requested" value={runtime.candlesRequested ?? "--"} />
          <Metric label="Candles loaded" value={runtime.candlesLoaded ?? "--"} />
          <Metric label="Closed candles used" value={runtime.closedCandlesUsed ?? "--"} />
          <Metric label="Last closed candle" value={runtime.lastClosedCandleTime ? dateText(runtime.lastClosedCandleTime) : "--"} />
          <Metric label="Valid NWE bands" value={runtime.validNweBandCount ?? "--"} />
          <Metric label="Profile connected" value={runtime.profileConnected ? "yes" : "no"} />
          <Metric label="Data age" value={runtime.dataAgeSeconds !== null && runtime.dataAgeSeconds !== undefined ? `${runtime.dataAgeSeconds}s` : ageText(runtime.lastSyncAt)} />
          <Metric label="Global execution" value={runtime.globalExecutionState ?? (runtime.executionAllowed ? "enabled" : "blocked")} />
          <Metric label="Crisis mode" value={runtime.crisisModeOn ? "on" : "off"} />
          <Metric label="Manual lock" value={runtime.crisisManualLock ? "active" : "off"} />
          <Metric label="Trading enabled" value={(runtime.tradingEnabled ?? runtime.executionAllowed) ? "true" : "false"} />
          <Metric label="Legacy safety" value={`${runtime.legacySafetyStatus ?? "NOT_CHECKED"}${runtime.legacySafetyStale ? " stale" : ""}`} />
        </div>
        <div className="hubert-lab__metrics">
          <Metric label="Latest setup event" value={eventText(runtime.latestSetupEvent)} />
          <Metric label="Latest entry event" value={eventText(runtime.latestEntryEvent)} />
          <Metric label="Latest executable signal" value={eventText(runtime.lastSignal)} />
          <Metric label="Current setup state" value={runtime.pendingTriggerOrder?.status ?? runtime.latestSetupEvent?.status ?? "none"} />
          <Metric label="Trigger armed" value={triggerOrderIsActive ? "yes" : "no"} />
          <Metric label="Pending trigger order" value={runtime.pendingTriggerOrder?.orderId ?? "--"} />
          <Metric label="Order fingerprint" value={runtime.pendingTriggerOrder?.setupFingerprintShort ?? runtime.setupFingerprintShort ?? "--"} />
          <Metric label="Latest setup FP" value={runtime.latestSetupEvent?.setupFingerprintShort ?? "--"} />
          <Metric label="Fingerprint match" value={runtime.orderFingerprintMatchesLatestSetup === null || runtime.orderFingerprintMatchesLatestSetup === undefined ? "--" : runtime.orderFingerprintMatchesLatestSetup ? "match" : "mismatch"} />
          <Metric label="Execution mode" value={platformTriggerMode ? "platform MARKET trigger" : runtime.executionMode ?? "exchange trigger"} />
          <Metric label="Price feed" value={`${runtime.priceFeedMode ?? "--"} / ${runtime.priceFeedStatus ?? "--"}`} />
          <Metric label="Price feed age" value={runtime.priceFeedAgeMs !== null && runtime.priceFeedAgeMs !== undefined ? `${Math.round(runtime.priceFeedAgeMs)}ms` : "--"} />
          <Metric label="Price rate limits" value={runtime.priceFeedRateLimitCount ?? 0} />
          <Metric label="Price requests" value={runtime.priceFeedRequestCount ?? "--"} />
          <Metric label="Price websocket" value={runtime.priceFeedWebsocketStatus ?? "--"} />
          <Metric label="Auto recovery" value={runtime.autoRecoveryStatus || (runtime.runnerDegraded ? "degraded" : "--")} />
          <Metric label="Next recovery" value={compactDateText(runtime.nextRecoveryAt)} />
          <Metric label="Price source" value={runtime.lastPriceSource ?? runtime.pendingTriggerOrder?.priceSource ?? "--"} />
          <Metric label="Live mark price" value={fmt(runtime.lastMarkPrice ?? runtime.pendingTriggerOrder?.lastMarkPrice)} />
          <Metric label="Trigger price" value={fmt(runtime.pendingTriggerOrder?.triggerPrice ?? runtime.latestSetupEvent?.trigger)} />
          <Metric label="Trigger crossed" value={(runtime.platformTriggerCrossed ?? runtime.pendingTriggerOrder?.triggerCrossed) ? "yes" : "no"} />
          <Metric label="Crossed time" value={compactDateText(runtime.platformTriggerCrossedAt ?? runtime.pendingTriggerOrder?.triggerCrossedAt)} />
          <Metric label="Market entry sent" value={(runtime.platformMarketEntrySent ?? runtime.pendingTriggerOrder?.marketOrderSent) ? "yes" : "no"} />
          <Metric label="Execution price" value={fmt(runtime.executionPrice ?? runtime.pendingTriggerOrder?.executionPrice)} />
          <Metric label="Trigger slippage" value={runtime.platformTriggerSlippagePct !== null && runtime.platformTriggerSlippagePct !== undefined ? `${fmt(runtime.platformTriggerSlippagePct, 4)}%` : "--"} />
          <Metric label="Skipped reason" value={runtime.platformTriggerSkippedReason || runtime.pendingTriggerOrder?.skippedReason || "--"} />
          <Metric label="Distance at placement" value={runtime.triggerDistanceAtPlacementPct !== null && runtime.triggerDistanceAtPlacementPct !== undefined ? `${fmt(runtime.triggerDistanceAtPlacementPct, 4)}%` : "--"} />
          <Metric label="Distance at failure" value={runtime.triggerDistanceAtFailurePct !== null && runtime.triggerDistanceAtFailurePct !== undefined ? `${fmt(runtime.triggerDistanceAtFailurePct, 4)}%` : "--"} />
          <Metric label="Placement warning" value={(runtime.pendingTriggerOrder?.placementDiagnostics?.warnings ?? []).join(", ") || "--"} />
          <Metric label="Equity" value={fmt(marginDiagnostics.equity)} />
          <Metric label="Futures balance" value={fmt(marginDiagnostics.balance)} />
          <Metric label="Available margin" value={fmt(marginDiagnostics.availableMargin)} />
          <Metric label="Used margin" value={fmt(marginDiagnostics.usedMargin)} />
          <Metric label="Account balance used" value={fmt(marginDiagnostics.accountBalanceUsed)} />
          <Metric label="Risk per SL %" value={Number.isFinite(marginDiagnostics.requestedRiskPercent) ? `${fmt(marginDiagnostics.requestedRiskPercent)}%` : "--"} />
          <Metric label="Account risk amount" value={fmt(marginDiagnostics.accountRiskAmount)} />
          <Metric label="Entry price" value={fmt(runtime.pendingTriggerOrder?.triggerPrice)} />
          <Metric label="SL price" value={fmt(runtime.pendingTriggerOrder?.stopLoss ?? runtime.pendingTriggerOrder?.invalidationPrice)} />
          <Metric label="SL distance" value={fmt(marginDiagnostics.slDistance)} />
          <Metric label="Raw qty from account risk" value={fmt(marginDiagnostics.rawQtyFromAccountRisk, 3)} />
          <Metric label="Risk basis used" value={fmt(marginDiagnostics.riskBasis)} />
          <Metric label="Requested SL risk" value={Number.isFinite(marginDiagnostics.requestedRiskPercent) ? `${fmt(marginDiagnostics.requestedRiskUsdt)} (${fmt(marginDiagnostics.requestedRiskPercent)}%)` : "--"} />
          <Metric label="Actual SL risk" value={Number.isFinite(marginDiagnostics.actualRiskPercent) ? `${fmt(marginDiagnostics.actualRiskUsdt)} (${fmt(marginDiagnostics.actualRiskPercent)}%)` : "--"} />
          <Metric label="Desired qty" value={fmt(marginDiagnostics.desiredQuantity, 3)} />
          <Metric label="Final qty" value={fmt(marginDiagnostics.finalQuantity, 3)} />
          <Metric label="Final risk at SL" value={Number.isFinite(marginDiagnostics.finalRiskAtSLPercentOfAccount) ? `${fmt(marginDiagnostics.finalRiskAtSL)} (${fmt(marginDiagnostics.finalRiskAtSLPercentOfAccount)}%)` : "--"} />
          <Metric label="Capped qty reason" value={marginDiagnostics.cappedQtyReason || "--"} />
          <Metric label="Margin cap applied" value={marginDiagnostics.capApplied ? "yes" : "no"} />
          <Metric label="Margin usage cap" value={Number.isFinite(marginDiagnostics.marginUsageCap) ? `${fmt(marginDiagnostics.marginUsageCap * 100, 0)}%` : "--"} />
          <Metric label="Max allowed margin" value={fmt(marginDiagnostics.maxAllowedRequiredMargin)} />
          <Metric label="Required margin est." value={fmt(marginDiagnostics.marginRequired)} />
          <Metric label="Required + buffer" value={fmt(marginDiagnostics.estimatedRequiredMarginWithBuffer)} />
          <Metric label="Margin headroom" value={Number.isFinite(marginDiagnostics.marginHeadroom) ? `${fmt(marginDiagnostics.marginHeadroom)} (${fmt(marginDiagnostics.marginHeadroomPct, 2)}%)` : "--"} />
          <Metric label="Leverage used" value={marginDiagnostics.leverage ?? "--"} />
          <Metric label="Margin mode" value={marginDiagnostics.marginMode ?? "--"} />
          <Metric label="Margin safety" value={marginDiagnostics.marginSafetyReason || "--"} />
          <Metric label="Margin warning" value={marginWarnings.length ? marginWarnings.join(", ") : "--"} />
          <Metric label="Trigger order status" value={runtime.triggerOrderState ?? runtime.pendingTriggerOrder?.status ?? "--"} />
          <Metric label="Exchange terminal status" value={runtime.exchangeTerminalStatus || "--"} />
          <Metric label="Last exchange status" value={runtime.lastExchangeStatus || runtime.pendingTriggerOrder?.lastExchangeStatus || "--"} />
          <Metric label="Last status check" value={compactDateText(runtime.lastStatusCheckAt)} />
          <Metric label="Executed qty" value={runtime.triggerOrderExecutedQty !== null && runtime.triggerOrderExecutedQty !== undefined ? fmt(runtime.triggerOrderExecutedQty, 3) : "--"} />
          <Metric label="Failure classification" value={runtime.triggerFailureClassification || "--"} />
          <Metric label="Failure candidate" value={triggerFailureCandidateText(runtime)} />
          <Metric label="Last trigger failure" value={runtime.lastTriggerFailureReason || "--"} />
          <Metric label="Pending order age" value={runtime.pendingOrderAgeSeconds !== null && runtime.pendingOrderAgeSeconds !== undefined ? `${runtime.pendingOrderAgeSeconds}s` : "--"} />
          <Metric label="Can arm next setup" value={runtime.canArmNextSetup ? "true" : "false"} />
          <Metric label="Trigger fill detected" value={runtime.triggerOrderFillDetected ? "yes" : "no"} />
          <Metric label="SL placed" value={runtime.slPlacementStatus ?? "--"} />
          <Metric label="Calculated qty" value={fmt(runtime.pendingTriggerOrder?.quantity, 3)} />
          <Metric label="Decision reason" value={runtime.lastDecisionReason || runtime.lastDecision || "--"} />
          <Metric label="Blocked reason" value={runtime.lastBlockedReason || "--"} />
          <Metric label="Runner started" value={compactDateText(runtime.currentRunnerStartedAt ?? runtime.startedAt)} />
          <Metric label="Current setup FP" value={runtime.currentSetupFingerprintShort || runtime.currentSetupFingerprint || "--"} />
          <Metric label="Current order ids" value={safeStringRows(runtime.currentLifecycleOrderIds).join(", ") || "--"} />
          <Metric label="Stale historical rows" value={runtime.staleHistoricalOrderCount ?? 0} />
          <Metric label="Interval blocker" value={intervalBlockers.map((blocker) => blocker.type ?? blocker.source).join(", ") || "--"} />
          <Metric label="Last exchange response" value={runtime.lastExchangeResponse ? compactDateText(runtime.lastExchangeResponse.time) : "--"} />
        </div>
        <details className="hubert-advanced" open>
          <summary>Current decision timeline</summary>
          <div className="hubert-lab__table">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Event</th>
                  <th>Setup</th>
                  <th>FP</th>
                  <th>Text</th>
                </tr>
              </thead>
              <tbody>
                {currentDecisionTimeline.length ? currentDecisionTimeline.slice(-20).reverse().map((item, index) => (
                  <tr key={`${item.time ?? index}-${item.event ?? index}`}>
                    <td>{compactDateText(item.time)}</td>
                    <td>{item.event ?? "--"}</td>
                    <td>{item.setupId ?? "--"}</td>
                    <td>{setupFingerprintShort(item.setupFingerprint) || "--"}</td>
                    <td>{item.text ?? item.reason ?? "--"}</td>
                  </tr>
                )) : (
                  <tr><td colSpan="5">Current runner has not written a decision timeline yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </details>
        <details className="hubert-advanced" open>
          <summary>Current setup / order lifecycle</summary>
          <div className="hubert-lab__table">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Setup</th>
                  <th>FP</th>
                  <th>Side</th>
                  <th>Trigger</th>
                  <th>Qty</th>
                  <th>Order</th>
                  <th>Status</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {currentSetupOrderJournal.length ? currentSetupOrderJournal.slice(-20).reverse().map((item, index) => (
                  <tr key={`${item.timestamp ?? index}-${safeOrderId(item) ?? item.setupId ?? index}`}>
                    <td>{compactDateText(item.timestamp)}</td>
                    <td>{item.setupId ?? "--"}</td>
                    <td>{item.setupFingerprintShort || setupFingerprintShort(item.setupFingerprint) || "--"}</td>
                    <td>{item.side ?? "--"}</td>
                    <td>{fmt(item.triggerPrice)}</td>
                    <td>{fmt(item.quantity, 3)}</td>
                    <td>{safeOrderId(item) ?? "--"}</td>
                    <td>{item.status ?? item.event ?? "--"}</td>
                    <td>{item.reason ?? item.failureClassification ?? item.event ?? "--"}</td>
                  </tr>
                )) : (
                  <tr><td colSpan="9">No current setup/order lifecycle entries. Check decision timeline for why no entry was opened.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </details>
        <details className="hubert-advanced">
          <summary>Historical setup / order journal ({runtime.staleHistoricalOrderCount ?? historicalSetupOrderJournal.length})</summary>
          <div className="hubert-lab__table">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Setup</th>
                  <th>FP</th>
                  <th>Side</th>
                  <th>Trigger</th>
                  <th>Status</th>
                  <th>Stale reason</th>
                </tr>
              </thead>
              <tbody>
                {historicalSetupOrderJournal.length ? historicalSetupOrderJournal.slice(-20).reverse().map((item, index) => (
                  <tr key={`historical-${item.timestamp ?? index}-${safeOrderId(item) ?? item.setupId ?? index}`}>
                    <td>{compactDateText(item.timestamp)}</td>
                    <td>{item.setupId ?? "--"}</td>
                    <td>{item.setupFingerprintShort || setupFingerprintShort(item.setupFingerprint) || "--"}</td>
                    <td>{item.side ?? "--"}</td>
                    <td>{fmt(item.triggerPrice)}</td>
                    <td>{item.status ?? item.event ?? "--"}</td>
                    <td>{item.staleHistoricalReason ?? "historical"}</td>
                  </tr>
                )) : (
                  <tr><td colSpan="7">No stale historical order rows.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </details>
        {runtime.orderFingerprintMatchesLatestSetup === false && runtime.pendingTriggerOrder?.setupFingerprint && runtime.latestSetupEvent?.setupFingerprint && (
          <MiniStatus>
            Fresh setup is not linked to the old trigger order: CTP id may match, but setup fingerprints differ.
          </MiniStatus>
        )}
        {platformTriggerMode && triggerOrderStatus === "platform_armed" && (
          <MiniStatus>
            {reversalTrigger
              ? "Pozycja aktywna. Bot czeka na przeciwny trigger do odwrócenia."
              : "Bot pilnuje triggera lokalnie. Po przebiciu ceny BingX mark wyśle MARKET."}
          </MiniStatus>
        )}
        {platformTriggerMode && runtime.reversalStatus === "completed" && (
          <MiniStatus tone="good">
            Reversal wykonany.
          </MiniStatus>
        )}
        {platformTriggerMode && triggerOrderStatus === "reversal_close_failed" && (
          <MiniStatus tone="bad">
            Przeciwny trigger przebity, ale nie udało się zamknąć starej pozycji. Nowa pozycja nie została otwarta.
          </MiniStatus>
        )}
        {platformTriggerMode && triggerOrderStatus === "reversal_close_succeeded_entry_failed" && (
          <MiniStatus tone="bad">
            Zamknięto starą pozycję, ale nie udało się otworzyć nowej.
          </MiniStatus>
        )}
        {platformTriggerMode && runtime.platformMarketEntrySent && (
          <MiniStatus tone="good">
            Trigger przebity — wysłano MARKET.
          </MiniStatus>
        )}
        {platformTriggerMode && triggerOrderStatus === "trigger_crossed_but_price_too_far" && (
          <MiniStatus tone="bad">
            Trigger przebity, ale cena odjechała za daleko — wejście pominięte.
          </MiniStatus>
        )}
        {platformTriggerMode && triggerOrderStatus === "setup_invalidated_before_platform_trigger" && (
          <MiniStatus tone="bad">
            Setup anulowany — poziom negacji został dotknięty przed triggerem.
          </MiniStatus>
        )}
        {cleanupFailureClassification && cleanupFailureClassification !== "cancel_open_orders_ok" && (
          <MiniStatus tone={cleanupFailureClassification === "cancel_open_orders_failed_transient" ? "neutral" : "bad"}>
            Nie udało się anulować starych zleceń na BingX — runner działa dalej / wymaga kontroli.
          </MiniStatus>
        )}
        {detectedLegacyTakeProfitState && (
          <MiniStatus tone="bad">
            Wykryto TP z poprzedniej wersji — rozważ ręczne anulowanie na BingX. Sztab nie zakłada już TP automatycznie.
          </MiniStatus>
        )}
        {marginWarnings.includes("order_too_large_for_available_margin") && (
          <MiniStatus tone="bad">
            Balance exists, but the estimated required margin is larger than available margin for this subaccount.
          </MiniStatus>
        )}
        {marginWarnings.includes("margin_safety_cap_applied") && (
          <MiniStatus>
            Bufor marginu zmniejszył pozycję. Realne ryzyko SL spadło z {fmt(marginDiagnostics.requestedRiskPercent)}% do {fmt(marginDiagnostics.actualRiskPercent)}%.
          </MiniStatus>
        )}
        {marginWarnings.includes("margin_safety_cap_below_min_order_size") && (
          <MiniStatus tone="bad">
            Zlecenie zablokowane: brak wystarczającego marginu po buforze dla minimalnej ilości/notional.
          </MiniStatus>
        )}
        {marginWarnings.includes("margin_headroom_below_diagnostic_buffer") && (
          <MiniStatus>
            Margin headroom is very small. BingX may reject or fail the trigger at activation even though balance is visible.
          </MiniStatus>
        )}
        {globalBlockers.length > 0 && (
          <MiniStatus tone="bad">
            Global execution blocker active: {globalBlockers.map((blocker) => blocker.reason).join("; ")}.
          </MiniStatus>
        )}
        {intervalBlockers.length > 0 && (
          <MiniStatus tone={isRunning ? "bad" : "neutral"}>
            Interval blocker: {intervalBlockers.map((blocker) => blocker.reason).join("; ")}.
          </MiniStatus>
        )}
        {runtime.legacySafetyStale && (
          <MiniStatus>
            Legacy Safety Guardian state is stale and is shown for audit only; it is not treated as an active Sztab blocker.
          </MiniStatus>
        )}
        <details className="hubert-advanced">
          <summary>Raw runner debug</summary>
          <pre>{JSON.stringify({
            globalBlockers,
            intervalBlockers,
            lastError: runtime.lastError || runtime.error || "",
            lastExchangeResponse: runtime.lastExchangeResponse ?? null,
            triggerMarginDiagnostics: runtime.triggerMarginDiagnostics ?? null,
            lastTriggerFailureDiagnostics: runtime.lastTriggerFailureDiagnostics ?? null,
            lastOrderAttempt: runtime.lastOrderAttempt ?? null,
            legacySafetyWarnings: runtime.legacySafetyWarnings ?? [],
            latestEntryEvent: runtime.latestEntryEvent ?? null,
            latestSetupEvent: runtime.latestSetupEvent ?? null,
            latestSignal: runtime.lastSignal ?? null,
            pendingTriggerOrder: runtime.pendingTriggerOrder ?? null,
            setupOrderJournal: runtime.setupOrderJournal ?? [],
          }, null, 2)}</pre>
        </details>
      </section>

      <section className="hubert-sztab-card">
        <div className="hubert-lab__subhead">
          <strong>Live account / subaccount state</strong>
          <span>{profile?.label ?? "No profile selected"}</span>
        </div>
        <div className="hubert-lab__metrics">
          <Metric label="Balance" value={profileBalanceText(profile)} />
          <Metric label="Available margin" value={profile?.availableMargin !== undefined ? fmt(profile.availableMargin) : "Unavailable"} />
          <Metric label="Unrealized PnL" value={fmt(summary.totalUnrealizedPnl ?? 0)} />
          <Metric label="Current positions" value={positions.length} />
          <Metric label="Open orders" value={orders.length || profile?.openOrders || "--"} />
          <Metric label="SL/TP state" value={positions.some((position) => Number(position.stopLoss) > 0) ? "protected" : positions.length ? "missing SL" : "no position"} />
          <Metric label="Data age" value={summary.dataAgeSeconds !== null && summary.dataAgeSeconds !== undefined ? `${summary.dataAgeSeconds}s` : ageText(summary.lastBingxSyncAt)} />
          <Metric label="Last sync" value={compactDateText(summary.lastBingxSyncAt)} />
        </div>
      </section>

      <section className="hubert-sztab-card hubert-sztab-card--span">
        <div className="hubert-lab__subhead">
          <strong>Position management</strong>
          <span>uses exact displayed positionId / positionSide / qty</span>
        </div>
        {positions.length ? (
          <div className="hubert-live-stack">
            {positions.map((position) => (
              <SztabPositionCard
                key={positionCardKey(position)}
                onPositionAction={onPositionAction}
                onPositionRefresh={onPositionRefresh}
                position={position}
                state={positionActionState[positionCardKey(position)]}
              />
            ))}
          </div>
        ) : (
          <MiniStatus>No open BingX position is currently mapped to this interval/profile.</MiniStatus>
        )}
      </section>

      <section className="hubert-sztab-card hubert-sztab-card--span">
        <div className="hubert-lab__subhead">
          <strong>Transaction / decision history</strong>
          <span>latest interval/profile messages</span>
        </div>
        <div className="hubert-lab__table">
          <table>
            <thead><tr><th>Time</th><th>Reason/source</th><th>Context</th></tr></thead>
            <tbody>
              {logs.length ? logs.slice().reverse().map((log) => (
                <tr key={log.id ?? `${log.time}-${log.message}`}>
                  <td>{dateText(log.time)}</td>
                  <td>{log.message}</td>
                  <td>{log.context ? JSON.stringify(log.context).slice(0, 140) : "--"}</td>
                </tr>
              )) : (
                <tr><td colSpan="3">No interval-specific decisions in backend logs yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function SztabPositionCard({ onPositionAction, onPositionRefresh, position, state }) {
  const [controls, setControls] = useState({
    stopPrice: position.stopLoss ? String(position.stopLoss) : "",
    takeProfitPrice: position.takeProfit ? String(position.takeProfit) : "",
  });
  const busy = Boolean(state?.loading);
  const attachedOrders = position.attachedOrders ?? [];
  const hasProtection = attachedOrders.length > 0 || Number(position.stopLoss) > 0 || Number(position.takeProfit) > 0;
  const slValue = controls.stopPrice ?? (position.stopLoss ? String(position.stopLoss) : "");
  const tpValue = controls.takeProfitPrice ?? (position.takeProfit ? String(position.takeProfit) : "");

  useEffect(() => {
    setControls((current) => ({
      stopPrice: current.stopPrice || (position.stopLoss ? String(position.stopLoss) : ""),
      takeProfitPrice: current.takeProfitPrice || (position.takeProfit ? String(position.takeProfit) : ""),
    }));
  }, [position.stopLoss, position.takeProfit]);

  return (
    <div className="hubert-live-card">
      <div className="hubert-live-card__head">
        <strong>{position.symbol} {position.side}</strong>
        <span>{position.apiProfileLabel ?? position.apiProfile} · {position.timeframe ?? "exchange"} · id {positionIdentifier(position) ?? "none"}</span>
      </div>
      {!Number(position.stopLoss) && <MiniStatus tone="bad">Warning: this position has no active SL reported by fresh sync.</MiniStatus>}
      <div className="hubert-lab__metrics">
        <Metric label="Entry" value={fmt(position.entryPrice)} />
        <Metric label="Mark" value={fmt(position.currentPrice)} />
        <Metric label="Quantity" value={fmt(position.quantity, 3)} />
        <Metric label="Notional" value={fmt(position.notionalSize)} />
        <Metric label="PnL" value={fmt(position.unrealizedPnl)} />
        <Metric label="Position side" value={position.positionSide ?? position.side ?? "--"} />
        <Metric label="SL" value={fmt(position.stopLoss)} />
        <Metric label="TP" value={fmt(position.takeProfit)} />
        <Metric label="Protection source" value={position.protectionSource ?? "none"} />
      </div>
      <div className="hubert-position-sources">
        <span><strong>Active SL</strong>{fmt(position.stopLoss)} · {protectionSourceText(position, "SL")}</span>
        <span><strong>Active TP</strong>{fmt(position.takeProfit)} · {protectionSourceText(position, "TP")}</span>
      </div>
      <OrderTable orders={attachedOrders} />
      <div className="hubert-position-controls">
        <label>
          <span>SL</span>
          <input
            inputMode="decimal"
            placeholder="Stop price"
            type="number"
            value={slValue}
            onChange={(event) => setControls((current) => ({ ...current, stopPrice: event.target.value }))}
          />
        </label>
        <button
          disabled={busy || !Number.isFinite(Number(slValue)) || Number(slValue) <= 0}
          type="button"
          onClick={() => onPositionAction(position, "MOVE_SL", { direct: true, stopPrice: slValue })}
        >
          {busy && state?.action === "MOVE_SL" ? "Moving..." : "Move SL"}
        </button>
        <label>
          <span>TP</span>
          <input
            inputMode="decimal"
            placeholder="Take profit"
            type="number"
            value={tpValue}
            onChange={(event) => setControls((current) => ({ ...current, takeProfitPrice: event.target.value }))}
          />
        </label>
        <button
          disabled={busy || !Number.isFinite(Number(tpValue)) || Number(tpValue) <= 0}
          type="button"
          onClick={() => onPositionAction(position, "MOVE_TP", { direct: true, takeProfitPrice: tpValue })}
        >
          {busy && state?.action === "MOVE_TP" ? "Moving..." : "Move TP"}
        </button>
        <button
          disabled={busy}
          type="button"
          onClick={() => onPositionAction(position, "CLOSE_POSITION", {
            confirm: true,
            confirmMessage: `Close ${position.symbol} ${position.side} position ${positionIdentifier(position) ?? ""}?`,
            direct: true,
          })}
        >
          {busy && state?.action === "CLOSE_POSITION" ? "Closing..." : "Close Position"}
        </button>
        <button
          disabled={busy || !hasProtection}
          title={!hasProtection ? "No attached protection/orders reported for this position." : "Cancel protection/orders attached to this exact position."}
          type="button"
          onClick={() => onPositionAction(position, "CANCEL_ATTACHED_ORDERS", {
            confirm: true,
            confirmMessage: `Cancel attached protective/orders for ${position.symbol} ${position.side}?`,
            direct: true,
          })}
        >
          {busy && state?.action === "CANCEL_ATTACHED_ORDERS" ? "Cancelling..." : "Cancel Protection/Orders"}
        </button>
        <button disabled={busy} type="button" onClick={() => onPositionRefresh?.(position)}>
          {busy && state?.action === "FORCE_SYNC" ? "Syncing..." : "Force Sync"}
        </button>
      </div>
      {state?.message && (
        <MiniStatus tone={state.ok === false ? "bad" : state.ok === true ? "good" : "neutral"}>
          {state.message} {state.updatedAt ? `· ${compactDateText(state.updatedAt)}` : ""}
        </MiniStatus>
      )}
      {state?.result && (
        <details className="hubert-details">
          <summary>Position diagnostics</summary>
          <pre>{JSON.stringify({
            action: state.action,
            diagnostics: state.result?.diagnostics ?? state.diagnostics ?? null,
            message: state.result?.message ?? state.message,
            ok: state.result?.ok ?? state.ok,
            result: state.result?.result ?? null,
          }, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

function intervalDisplayLabel(interval) {
  return SZTAB_TIMEFRAMES.find((item) => item.interval === interval)?.label ?? interval;
}

function strategyParamDiffs(left = {}, right = {}) {
  return [
    ["atrLength", "ATR length"],
    ["atrMultiplier", "ATR multiplier"],
    ["bandwidth", "Bandwidth"],
    ["envelopeMultiplier", "NWE multiplier"],
    ["maxSameSideFailures", "Max same-side failures"],
    ["strategySource", "Strategy source"],
  ].flatMap(([key, label]) => (
    String(left?.[key] ?? "") === String(right?.[key] ?? "")
      ? []
      : [{ chart: right?.[key], field: label, sztab: left?.[key] }]
  ));
}

function validationText(validation = {}) {
  if (validation.errors?.length) return validation.errors.join(" ");
  if (validation.ok) return `Validation OK${validation.checkedAt ? ` · ${compactDateText(validation.checkedAt)}` : ""}`;
  return validation.message ?? "Not validated yet.";
}

function positionsForInterval(positions = [], config = {}, interval) {
  return safeObjectRows(positions).filter((position) => {
    const profileMatch = config.apiProfile ? position.apiProfile === config.apiProfile || position.sourceProfileId === config.apiProfile : true;
    const timeframeMatch = position.timeframe ? position.timeframe === interval : true;
    return profileMatch && timeframeMatch;
  });
}

function ordersForInterval(orders = [], config = {}) {
  return safeObjectRows(orders).filter((order) => {
    if (!config.apiProfile) return true;
    return order.apiProfile === config.apiProfile || order.__apiProfileId === config.apiProfile || order.sourceProfileId === config.apiProfile;
  });
}

function sztabWarnings({ accountProfiles = [], botStatus, intervals = {}, positions = [], summary = {} }) {
  const warnings = [];
  const mappedProfileIds = new Set(accountProfiles.map((profile) => profile.id));
  const missingMappings = SZTAB_TIMEFRAMES
    .filter((timeframe) => {
      const config = intervals[timeframe.interval];
      return !config?.apiProfile || !mappedProfileIds.has(config.apiProfile);
    })
    .map((timeframe) => timeframe.label);

  if (secondsSince(summary.lastBingxSyncAt) === null || secondsSince(summary.lastBingxSyncAt) > 120) {
    warnings.push(`Live data is stale or unavailable. Last successful sync: ${ageText(summary.lastBingxSyncAt)}.`);
  }
  if (accountProfiles.some((profile) => !profile.configured || String(profile.status ?? "").includes("missing"))) {
    warnings.push("At least one API profile is missing keys/configuration.");
  }
  if (accountProfiles.some((profile) => String(profile.status ?? "").includes("sync delayed"))) {
    warnings.push("At least one API profile has delayed BingX sync.");
  }
  if (missingMappings.length > 0) {
    warnings.push(`Missing/invalid API profile mapping: ${missingMappings.join(", ")}.`);
  }
  if (["LIVE_RUNNING", "PAPER_RUNNING"].includes(botStatus) && Object.values(intervals).some((config) => !config.locked)) {
    warnings.push("A config is marked unlocked while the bot is running; fields are locked in Sztab until stop.");
  }
  if (positions.some((position) => !Number(position.stopLoss))) {
    warnings.push("One or more open positions have no active SL reported by BingX sync.");
  }

  return warnings;
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
  const ready = Boolean(communication.telegramBotTokenConfigured && communication.telegramChatId);

  return (
    <section className="hubert-lab__section">
      <MiniStatus tone={ready ? "good" : "neutral"}>
        {ready ? "Telegram is ready for backend alerts." : "Telegram alerts need a backend token and chat id before phone notifications can be sent."}
      </MiniStatus>
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

function AiAgentPanel({ aiStatus, apiRequest, onBacktestResult, onOpenAiBacktest, runAction, setActivePanel, setStrategyForm, workspaceContext }) {
  const [prompt, setPrompt] = useState("Run a 50 combination sweep for SOLUSDT 15m over the last 31 days and rank robust settings.");
  const [chatMessages, setChatMessages] = useState(() => {
    if (typeof window === "undefined") return [];
    try {
      const parsed = JSON.parse(window.localStorage.getItem("hubert-ah-chat-v2") ?? "[]");
      return Array.isArray(parsed) ? parsed.slice(-80) : [];
    } catch {
      return [];
    }
  });
  const [followUpText, setFollowUpText] = useState("");
  const [followUpState, setFollowUpState] = useState({ message: "", state: "idle" });
  const [lastAhDiagnostics, setLastAhDiagnostics] = useState(null);
  const [options, setOptions] = useState({
    allowLongRunningJobs: false,
    includeCodeContext: false,
    includeLiveData: true,
    maxCombinations: 100,
    objective: "robustness-adjusted return",
  });
  const [copilotMode, setCopilotMode] = useState("research");
  const [runs, setRuns] = useState([]);
  const [activeRunId, setActiveRunId] = useState("");
  const [manualResult, setManualResult] = useState(null);
  const [baselineCompareName, setBaselineCompareName] = useState("hubert");
  const [baselineCompareResult, setBaselineCompareResult] = useState(null);
  const [copilotMemory, setCopilotMemory] = useState(null);
  const [copilotView, setCopilotView] = useState("chat");
  const [queueStatus, setQueueStatus] = useState(null);
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  const [collapseAllChat, setCollapseAllChat] = useState(false);
  const [clearedChatAtByRun, setClearedChatAtByRun] = useState({});
  const [showRunHistory, setShowRunHistory] = useState(false);
  const [ahExpanded, setAhExpanded] = useState(false);
  const [showAhContext, setShowAhContext] = useState(true);
  const [pendingAhOperation, setPendingAhOperation] = useState(null);
  const [pendingAhName, setPendingAhName] = useState("");
  const chatEndRef = useRef(null);
  const activeRun = runs.find((run) => run.id === activeRunId) ?? runs[0] ?? null;
  const running = ["queued", "running"].includes(activeRun?.status);
  const activeRows = activeRun?.resultSummary?.topRows ?? [];
  const activeResult = activeRows[Math.min(activeResultIndex, Math.max(activeRows.length - 1, 0))] ?? activeRows[0] ?? null;
  const activeWorkspaceContext = useMemo(() => ({
    ...(workspaceContext ?? {}),
    activeResult: activeResult
      ? {
          id: activeResult.id,
          metrics: activeResult.metrics,
          params: activeResult.params,
          rank: activeResult.rank,
          score: activeResult.score,
          symbol: activeResult.symbol,
          timeframe: activeResult.timeframe,
        }
      : null,
    activeRun: activeRun
      ? {
          id: activeRun.id,
          intent: activeRun.parsedIntent,
          plan: activeRun.plan,
          status: activeRun.status,
        }
      : null,
    copilotMode,
  }), [activeResult, activeRun?.id, activeRun?.parsedIntent, activeRun?.plan, activeRun?.status, copilotMode, workspaceContext]);
  const visibleChatMessages = useMemo(() => {
    const persisted = activeRun?.messages ?? [];
    const local = chatMessages.filter((message) => !activeRun?.id || !message.runId || message.runId === activeRun.id);
    const seenIds = new Set();
    const recentContent = new Map();
    const clearedAt = activeRun?.id ? Date.parse(clearedChatAtByRun[activeRun.id] ?? 0) : 0;
    return [...local, ...persisted]
      .filter((message) => !clearedAt || Date.parse(message.time ?? 0) > clearedAt)
      .filter((message) => {
        if (message.id) {
          if (seenIds.has(message.id)) return false;
          seenIds.add(message.id);
        }
        const contentKey = `${message.runId ?? activeRun?.id ?? "global"}|${message.role}|${String(message.text ?? "").slice(0, 500)}`;
        const timeMs = Date.parse(message.time ?? 0) || 0;
        const previousTime = recentContent.get(contentKey);
        if (previousTime && Math.abs(timeMs - previousTime) < 10000) return false;
        recentContent.set(contentKey, timeMs);
        return true;
      })
      .sort((left, right) => Date.parse(left.time ?? 0) - Date.parse(right.time ?? 0));
  }, [activeRun?.id, activeRun?.messages, chatMessages, clearedChatAtByRun]);
  const olderChatMessages = visibleChatMessages.slice(0, Math.max(0, visibleChatMessages.length - 4));
  const recentChatMessages = visibleChatMessages.slice(-4);
  const examples = [
    "Find robust SOLUSDT 15m settings for the last 2 years and reject overfit configs.",
    "Run 1000 sweep combinations for SOLUSDT 15m over the last 2 years and give me the 5 best robust settings.",
    "Compare Legacy vs Conservative fill mode across 15m, 30m and 1H.",
    "Find the best MM sizing settings for Q1 2025 only.",
    "Analyze why this strategy performs worse on 1H than 15m.",
    "Prepare a report and export it to CSV and JSON.",
  ];

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("hubert-ah-chat-v2", JSON.stringify(chatMessages.slice(-80)));
    } catch {
      // Chat persistence is a convenience layer; never block the UI on storage.
    }
  }, [chatMessages]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView?.({ block: "end", behavior: "smooth" });
  }, [visibleChatMessages.length, followUpState.state]);

  async function loadRuns() {
    const payload = await apiRequest("/ai/agent/runs");
    setRuns(payload.runs ?? []);
    setQueueStatus(payload.queue ?? null);
    if (!activeRunId && payload.runs?.[0]) setActiveRunId(payload.runs[0].id);
    return payload;
  }

  async function loadCopilotMemory() {
    const payload = await apiRequest("/ai/copilot/memory");
    setCopilotMemory(payload.memory ?? null);
    return payload;
  }

  async function startRun() {
    return runAction("ai-agent-run", "Start agent", async () => {
      if (!prompt.trim()) throw new Error("Tell the agent what to analyze first.");
      if (copilotMode !== "research") {
        const localRunId = activeRun?.id ?? "platform-evidence";
        setChatMessages((current) => [
          ...current,
          {
            localOnly: true,
            role: "user",
            runId: localRunId,
            text: prompt.trim(),
            time: new Date().toISOString(),
          },
        ]);
        const payload = await apiRequest("/ai/agent/chat", {
          body: {
            message: prompt.trim(),
            mode: copilotMode,
            workspaceContext: activeWorkspaceContext,
            ...(activeRun?.id ? { runId: activeRun.id } : {}),
          },
          method: "POST",
        });
        if (!payload.ok) {
          throw new Error(payload.message ?? "The backend did not generate an evidence answer.");
        }
        setManualResult(payload);
        setChatMessages((current) => [
          ...current,
          {
            confidence: payload.response?.confidence,
            evidence: payload.response?.evidence ?? [],
            intent: payload.response?.intent,
            localOnly: !activeRun?.id,
            platformEvidence: payload.response?.platformEvidence,
            risk: payload.response?.risk,
            role: "assistant",
            runId: localRunId,
            sections: payload.response?.sections ?? [],
            text: payload.response?.answer ?? "No answer came back.",
            time: new Date().toISOString(),
          },
        ]);
        if (activeRun?.id) await loadRuns();
        return payload;
      }
      const payload = await apiRequest("/ai/agent/run", {
        body: {
          options: {
            confirmLargeJob: options.allowLongRunningJobs,
            includeCodeContext: options.includeCodeContext,
            includeLiveData: options.includeLiveData,
            maxCombinations: options.maxCombinations,
            objective: options.objective,
            workspaceContext: activeWorkspaceContext,
          },
          prompt,
          workspaceContext: activeWorkspaceContext,
        },
        method: "POST",
      });
      await loadRuns();
      await loadCopilotMemory();
      if (payload.run?.id) setActiveRunId(payload.run.id);
      setChatMessages((current) => [
        ...current,
        {
          localOnly: true,
          role: "user",
          runId: payload.run?.id,
          text: prompt.trim(),
          time: new Date().toISOString(),
        },
        {
          evidence: [
            `Run: ${payload.run?.id ?? "queued"}`,
            `Requested: ${payload.run?.plan?.requestedCombinations ?? payload.run?.plan?.maxCombinations ?? "n/a"}`,
            `Range: ${payload.run?.plan?.range?.from ? `${dateText(payload.run.plan.range.from)} to ${dateText(payload.run.plan.range.to)}` : "latest"}`,
          ],
          localOnly: true,
          role: "assistant",
          runId: payload.run?.id,
          text: "I started the research job. I will keep this run as the context for follow-up questions.",
          time: new Date().toISOString(),
        },
      ]);
      return payload;
    });
  }

  async function confirmPendingAhOperation() {
    if (!pendingAhOperation) return null;
    return runAction("ah-confirm-operation", "Confirm AH operation", async () => {
      if (!["research-job", "agent-os-research-package"].includes(pendingAhOperation.type)) {
        throw new Error("This pending operation is not wired for execution yet.");
      }
      if (pendingAhOperation.status && pendingAhOperation.status !== "ready_to_confirm") {
        throw new Error("AH is still collecting details for this research plan.");
      }
      const payload = await apiRequest("/ai/agent/run", {
        body: {
          ...(pendingAhOperation.params ?? {}),
          name: pendingAhName || pendingAhOperation.name,
          options: {
            ...(pendingAhOperation.params?.options ?? {}),
            operationId: pendingAhOperation.id,
            operationName: pendingAhName || pendingAhOperation.name,
            workspaceContext: activeWorkspaceContext,
          },
          workspaceContext: activeWorkspaceContext,
        },
        method: "POST",
      });
      await loadRuns();
      await loadCopilotMemory();
      if (payload.run?.id) setActiveRunId(payload.run.id);
      setChatMessages((current) => [
        ...current,
        {
          evidence: [
            `Operation: ${pendingAhOperation.id}`,
            `Run: ${payload.run?.id ?? "queued"}`,
            `Name: ${pendingAhName || pendingAhOperation.name}`,
            pendingAhOperation.summary,
          ],
          intent: "research-confirmed",
          role: "assistant",
          runId: payload.run?.id,
          text: `AH queued the confirmed research job: ${pendingAhName || pendingAhOperation.name}.`,
          time: new Date().toISOString(),
        },
      ]);
      setPendingAhOperation(null);
      setPendingAhName("");
      return payload;
    });
  }

  async function cancelPendingAhOperation() {
    setPendingAhOperation(null);
    setPendingAhName("");
    try {
      await askFollowUp("zacznij od nowa");
    } catch {
      // The visible card is already cleared; backend cleanup failure is shown in chat diagnostics.
    }
  }

  function updatePendingAhPlan(path, value) {
    if (!pendingAhOperation) return;
    const keys = path.split(".");
    setPendingAhOperation((current) => {
      const next = structuredClone(current);
      let target = next.plan;
      let optionsTarget = next.params.options;
      keys.slice(0, -1).forEach((key) => {
        target[key] = target[key] && typeof target[key] === "object" ? target[key] : {};
        optionsTarget[key] = optionsTarget[key] && typeof optionsTarget[key] === "object" ? optionsTarget[key] : {};
        target = target[key];
        optionsTarget = optionsTarget[key];
      });
      const finalKey = keys.at(-1);
      target[finalKey] = value;
      optionsTarget[finalKey] = value;
      if (path === "maxCombinations") {
        next.plan.plannedCombinations = Number(value) || next.plan.plannedCombinations;
        next.plan.requestedCombinations = Number(value) || next.plan.requestedCombinations;
        next.params.options.maxCombinations = Number(value) || next.params.options.maxCombinations;
      }
      return next;
    });
  }

  async function cancelRun(runId) {
    return runAction("ai-agent-cancel", "Cancel agent run", async () => {
      await apiRequest(`/ai/agent/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
      await loadRuns();
    });
  }

  async function restartRun(runId) {
    return runAction("ai-agent-restart", "Restart agent run", async () => {
      const payload = await apiRequest(`/ai/agent/runs/${encodeURIComponent(runId)}/restart`, { method: "POST" });
      await loadRuns();
      if (payload.run?.id) setActiveRunId(payload.run.id);
      return payload;
    });
  }

  async function exportRun(runId, format = "md") {
    return runAction(`ai-agent-export-${format}`, `Export ${format.toUpperCase()}`, async () => {
      const payload = await apiRequest(`/ai/agent/runs/${encodeURIComponent(runId)}/export`, {
        body: { format },
        method: "POST",
      });
      downloadPayload(payload.fileName, payload.content, payload.mime, payload.encoding);
    });
  }

  function rowStrategyDraft(row) {
    const params = row?.params ?? {};
    return {
      allowLong: true,
      allowShort: true,
      atrLength: params.atrLength ?? 14,
      atrMultiplier: params.atrMultiplier ?? 1.2,
      atrPositionSizing: params.sizingMode === "fixed-risk",
      bandwidth: params.bandwidth ?? 8,
      confirmedEntries: true,
      diagnosticSetups: false,
      envelopeMultiplier: params.envelopeMultiplier ?? 3,
      maxSameSideFailures: params.maxSameSideFailures ?? 2,
      name: `AI Draft ${row?.rank ? `#${row.rank}` : new Date().toLocaleTimeString()}`,
      negatedSetups: false,
      sizingMode: params.sizingMode ?? "position-percent",
      slLines: true,
      strategySource: "pine-ha",
      symbol: row?.symbol ?? activeRun?.plan?.symbol ?? "SOLUSDT",
      timeframe: row?.timeframe ?? activeRun?.plan?.timeframe ?? "15m",
      triggerLines: true,
    };
  }

  function verifiedFromFor(row = activeResult) {
    if (!row) return null;
    const canonical = row.canonical ?? {};
    return {
      drawdown: canonical.metrics?.maxDrawdown ?? row.metrics?.maxDrawdown ?? row.maxDrawdown ?? null,
      fillMode: canonical.fillMode ?? row.params?.fillMode ?? activeRun?.plan?.fillMode ?? "legacy",
      integrityScore: row.integrity?.score ?? null,
      integrityStatus: row.integrity?.status ?? canonical.status ?? null,
      integrityWarnings: row.integrity?.warnings ?? [],
      net: canonical.metrics?.netPnl ?? row.metrics?.netProfit ?? row.netProfit ?? null,
      provider: canonical.provider ?? row.provenance?.provider ?? activeRun?.plan?.provider ?? "binance-futures",
      profitFactor: canonical.metrics?.profitFactor ?? row.metrics?.profitFactor ?? row.profitFactor ?? null,
      rank: row.rank ?? null,
      range: canonical.range ?? {
        from: row.provenance?.from ?? activeRun?.plan?.range?.from ?? null,
        to: row.provenance?.to ?? activeRun?.plan?.range?.to ?? null,
      },
      runId: activeRun?.id ?? null,
      sizingMode: canonical.sizingMode ?? row.params?.sizingMode ?? activeRun?.plan?.sizingMode ?? "position-percent",
      symbol: canonical.symbol ?? row.symbol ?? activeRun?.plan?.symbol ?? "SOLUSDT",
      timeframe: canonical.timeframe ?? row.timeframe ?? activeRun?.plan?.timeframe ?? "15m",
      trades: canonical.metrics?.trades ?? row.metrics?.totalTrades ?? row.totalTrades ?? null,
      verified: true,
    };
  }

  function metricText(value, digits = 2, suffix = "") {
    if (value === null || value === undefined || value === "") return "--";
    return `${fmt(value, digits)}${suffix}`;
  }

  function humanIntentLabel(intent) {
    const labels = {
      "chart-backtest-question": "chart / backtest",
      "code-platform-diagnosis": "code / platform diagnosis",
      "conversation-explanation": "conversation / explanation",
      "current-research-result": "current result",
      "general-platform-question": "general platform question",
      "platform-diagnosis": "platform diagnosis",
      "research-request": "research request",
      "unsafe-live-action": "unsafe live action",
    };
    return labels[intent] ?? intent ?? "copilot answer";
  }

  function clearVisibleChat() {
    if (["thinking", "sending", "responding", "streaming"].includes(followUpState.state)) {
      setFollowUpState({ message: "AH is still responding. Wait for the current answer or retry after it fails.", state: "failed" });
      return;
    }
    if (!activeRun?.id) {
      setChatMessages([]);
      return;
    }
    const now = new Date().toISOString();
    setClearedChatAtByRun((current) => ({ ...current, [activeRun.id]: now }));
    setChatMessages((current) => current.filter((message) => message.runId !== activeRun.id));
  }

  function startNewChat() {
    if (["thinking", "sending", "responding", "streaming"].includes(followUpState.state)) {
      setFollowUpState({ message: "AH is still responding. I did not clear the active exchange.", state: "failed" });
      return;
    }
    clearVisibleChat();
    setPrompt("");
    setFollowUpText("");
    setCollapseAllChat(false);
  }

  async function askFollowUp(message = followUpText, row = null) {
    return runAction("ai-agent-follow-up", "Ask AH", async () => {
      if (!message.trim()) throw new Error("Ask a follow-up first.");
      const requestId = `ah-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const startedAt = Date.now();
      const route = "/ai/agent/chat";
      const runId = activeRun?.id ?? "platform-evidence";
      const contextRow = row ?? activeResult;
      const userMessage = {
        id: `${requestId}:user`,
        lifecycle: "queued",
        requestId,
        role: "user",
        runId,
        text: message.trim(),
        time: new Date(startedAt).toISOString(),
      };
      const placeholder = {
        diagnostics: {
          requestId,
          route,
          startedAt: new Date(startedAt).toISOString(),
          status: "pending",
        },
        id: `${requestId}:assistant`,
        intent: "responding",
        lifecycle: "responding",
        requestId,
        role: "assistant",
        runId,
        text: "AH is thinking...",
        time: new Date(startedAt + 1).toISOString(),
      };
      setFollowUpState({ message: "Sending request to AH...", state: "sending" });
      setLastAhDiagnostics({ requestId, route, startedAt: new Date(startedAt).toISOString(), status: "sending" });
      setChatMessages((current) => [...current, userMessage, placeholder]);
      try {
        setChatMessages((current) => current.map((item) => (
          item.id === userMessage.id ? { ...item, lifecycle: "sending" } : item
        )));
        const payload = await apiRequest(route, {
          body: {
            message: message.trim(),
            mode: copilotMode,
            rowId: contextRow?.id,
            rowIndex: contextRow?.rank ? Number(contextRow.rank) - 1 : undefined,
            workspaceContext: activeWorkspaceContext,
            ...(activeRun?.id ? { runId: activeRun.id } : {}),
          },
          method: "POST",
        });
        const latencyMs = Date.now() - startedAt;
        if (!payload.ok) {
          throw new Error(payload.message ?? "The backend did not generate a follow-up response.");
        }
        if (payload.response?.pendingOperation) {
          setPendingAhOperation(payload.response.pendingOperation);
          setPendingAhName(payload.response.pendingOperation.name ?? "AH research");
        }
        setFollowUpState({ message: "Rendering AH response...", state: "responding" });
        const diagnostics = {
          latencyMs,
          requestId,
          responseStatus: "ok",
          route,
          status: "completed",
        };
        setLastAhDiagnostics(diagnostics);
        setChatMessages((current) => current.map((item) => {
          if (item.id === userMessage.id) return { ...item, lifecycle: "completed" };
          if (item.id !== placeholder.id) return item;
          return {
            ...item,
            baselineComparison: payload.response?.baselineComparison,
            confidence: payload.response?.confidence,
            critique: payload.response?.critique,
            diagnostics,
            evidence: payload.response?.evidence ?? [],
            intent: payload.response?.intent,
            lifecycle: "completed",
            platformEvidence: payload.response?.platformEvidence,
            risk: payload.response?.risk,
            row: payload.response?.row,
            sections: payload.response?.sections ?? [],
            text: payload.response?.answer ?? "No answer came back.",
            verifiedFrom: payload.response?.verifiedFrom,
          };
        }));
        setFollowUpText("");
        if (activeRun?.id) {
          await loadRuns();
          await loadCopilotMemory();
        }
        setFollowUpState({ message: "Follow-up answered.", state: "completed" });
        window.setTimeout(() => setFollowUpState((current) => (
          current.state === "completed" ? { message: "", state: "idle" } : current
        )), 1400);
        return payload;
      } catch (error) {
        const messageText = humanError(error);
        const latencyMs = Date.now() - startedAt;
        const diagnostics = {
          lastError: messageText,
          latencyMs,
          requestId,
          responseStatus: "failed",
          route,
          status: "failed",
        };
        setLastAhDiagnostics(diagnostics);
        setFollowUpState({ message: messageText, state: "failed" });
        setChatMessages((current) => current.map((item) => {
          if (item.id === userMessage.id) return { ...item, lifecycle: "completed" };
          if (item.id !== placeholder.id) return item;
          return {
            ...item,
            diagnostics,
            evidence: ["The backend did not return a usable follow-up response."],
            intent: "failed",
            lifecycle: "failed",
            retryText: message.trim(),
            text: `Follow-up failed: ${messageText}`,
          };
        }));
        throw error;
      }
    });
  }

  async function rerunExact(row, { openPanel = false } = {}) {
    return runAction("ai-agent-rerun-exact", "Re-run exact config", async () => {
      if (!activeRun?.id) throw new Error("Open an AI run first.");
      if (openPanel) {
        const opened = await onOpenAiBacktest(activeRun, row);
        setActivePanel?.("Backtests");
        setChatMessages((current) => [
          ...current,
          {
            evidence: [
              `AI PF: ${opened.metricDiff?.aiProfitFactor ?? "n/a"}`,
              `Opened PF: ${opened.metricDiff?.openedProfitFactor ?? "n/a"}`,
              `PF delta: ${opened.metricDiff?.profitFactorDelta ?? "n/a"}`,
            ],
            role: "assistant",
            text: "Opened the exact AI config as a chart-linked backtest. Compare the metric parity before trusting the recommendation.",
            time: new Date().toISOString(),
          },
        ]);
        return opened;
      }
      const payload = await apiRequest(`/ai/agent/runs/${encodeURIComponent(activeRun.id)}/rerun`, {
        body: { rowId: row?.id },
        method: "POST",
      });
      setManualResult(payload);
      const rawRange = payload.result?.range ?? (payload.provenance ? {
        from: payload.provenance.from,
        to: payload.provenance.to,
      } : null);
      const analysisRange = rawRange ? {
        from: typeof rawRange.from === "number" ? rawRange.from : Math.floor(new Date(rawRange.from).getTime() / 1000),
        to: typeof rawRange.to === "number" ? rawRange.to : Math.floor(new Date(rawRange.to).getTime() / 1000),
      } : null;
      const result = {
        ...payload.result,
        analysisRange,
        name: `AI exact rerun ${row?.rank ? `#${row.rank}` : ""}`.trim(),
      };
      setChatMessages((current) => [
        ...current,
        {
          evidence: [
            `Cache: ${payload.cacheHit ? "hit" : "fresh run"}`,
            `AI PF: ${payload.metricDiff?.aiProfitFactor ?? "n/a"}`,
            `Rerun PF: ${payload.metricDiff?.rerunProfitFactor ?? "n/a"}`,
            `Candles match: ${payload.metricDiff?.sameCandles ? "yes" : "no"}`,
          ],
          role: "assistant",
          text: "Exact config re-run completed. Check the metric diff before trusting a recommendation.",
          time: new Date().toISOString(),
        },
      ]);
      return payload;
    });
  }

  async function verifyIntegrity(row = activeResult) {
    return runAction("ai-agent-integrity", "Verify integrity", async () => {
      if (!activeRun?.id) throw new Error("Open an AI run first.");
      if (!row?.id) throw new Error("Choose a result to verify.");
      const payload = await apiRequest(`/ai/agent/runs/${encodeURIComponent(activeRun.id)}/verify`, {
        body: { rowId: row.id },
        method: "POST",
      });
      setManualResult(payload);
      setChatMessages((current) => [
        ...current,
        {
          evidence: payload.result?.warnings?.length ? payload.result.warnings : ["Integrity check completed."],
          role: "assistant",
          runId: activeRun.id,
          text: payload.result?.passed
            ? "Integrity check passed. The stored AI row and exact rerun metrics match within the platform tolerance."
            : "Integrity check found a mismatch or incomplete data. Open Details / Provenance and inspect the metric diff before trusting this row.",
          time: new Date().toISOString(),
          verifiedFrom: verifiedFromFor(row),
        },
      ]);
      return payload;
    });
  }

  async function compareToSavedBacktest(row = activeResult, name = baselineCompareName) {
    return runAction("ai-agent-compare-saved", "Compare to saved backtest", async () => {
      if (!activeRun?.id) throw new Error("Open an AI run first.");
      if (!row?.id) throw new Error("Choose an AI result to compare first.");
      if (!String(name ?? "").trim()) throw new Error("Enter a saved backtest name, for example hubert.");
      const payload = await apiRequest(`/ai/agent/runs/${encodeURIComponent(activeRun.id)}/compare-backtest`, {
        body: {
          backtestNameOrId: String(name).trim(),
          rowId: row.id,
        },
        method: "POST",
      });
      setManualResult(payload);
      setBaselineCompareResult(payload);
      setChatMessages((current) => [
        ...current,
        {
          baselineComparison: payload,
          evidence: [
            `Saved backtest: ${payload.baseline?.name ?? name}`,
            `AI net: ${payload.metricDiff?.netProfit?.ai ?? "n/a"}`,
            `Saved net: ${payload.metricDiff?.netProfit?.saved ?? "n/a"}`,
            `Context match: ${payload.parity?.allContextMatch ? "yes" : "no"}`,
          ],
          role: "assistant",
          runId: activeRun.id,
          row: payload.row,
          text: payload.explanation ?? "Saved backtest comparison completed.",
          time: new Date().toISOString(),
          verifiedFrom: verifiedFromFor(row),
        },
      ]);
      return payload;
    });
  }

  async function callManualTool(toolName, input = {}) {
    return runAction(`ai-manual-${toolName}`, toolName, async () => {
      const payload = await apiRequest("/ai/tool", {
        body: { input: { workspaceContext: activeWorkspaceContext, ...input }, toolName },
        method: "POST",
      });
      setManualResult(payload);
      return payload;
    });
  }

  useEffect(() => {
    loadRuns().catch(() => {});
    loadCopilotMemory().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setActiveResultIndex(0);
    setCollapseAllChat(false);
  }, [activeRun?.id]);

  useEffect(() => {
    if (!running || !activeRun?.id) return undefined;
    let ignore = false;
    const timer = window.setInterval(async () => {
      try {
        const payload = await apiRequest(`/ai/agent/runs/${encodeURIComponent(activeRun.id)}`);
        if (!ignore) {
          setRuns((current) => [payload.run, ...current.filter((run) => run.id !== payload.run.id)]);
        }
      } catch {
        // The next manual refresh will show any backend error in a normal action banner.
      }
    }, 1500);
    return () => {
      ignore = true;
      window.clearInterval(timer);
    };
  }, [activeRun?.id, apiRequest, running]);

  function renderVerifiedFrom(verifiedFrom, row = null) {
    if (!verifiedFrom) return null;
    return (
      <div className="hubert-ai-verified">
        <div className="hubert-lab__subhead">
          <strong>{verifiedFrom.verified ? "Verified from stored metrics" : "Not fully verified"}</strong>
          <span>{verifiedFrom.runId ? verifiedFrom.runId.slice(-6) : "no run"}</span>
        </div>
        <div className="hubert-ai-verified__grid">
          <span>Run <b>{verifiedFrom.runId ?? "--"}</b></span>
          <span>Config <b>{verifiedFrom.rank ? `#${verifiedFrom.rank}` : "--"}</b></span>
          <span>Symbol <b>{verifiedFrom.symbol ?? "--"}</b></span>
          <span>TF <b>{verifiedFrom.timeframe ?? "--"}</b></span>
          <span>Range <b>{verifiedFrom.range?.from ? `${dateText(verifiedFrom.range.from)} → ${dateText(verifiedFrom.range.to)}` : "--"}</b></span>
          <span>Provider <b>{verifiedFrom.provider ?? "--"}</b></span>
          <span>Sizing <b>{verifiedFrom.sizingMode ?? "--"}</b></span>
          <span>Fill <b>{verifiedFrom.fillMode ?? "--"}</b></span>
          <span>Trades <b>{verifiedFrom.trades ?? "--"}</b></span>
          <span>PF <b>{metricText(verifiedFrom.profitFactor)}</b></span>
          <span>Net <b>{metricText(verifiedFrom.net, 2, " USDT")}</b></span>
          <span>DD <b>{metricText(verifiedFrom.drawdown)}</b></span>
          <span title="RRR = average winner / absolute average loser">RRR <b>{row ? rrrText(row) : "RRR unavailable"}</b></span>
          <span title="Avg R / trade = average result in risk units">Avg R <b>{row ? avgRText(row) : "Avg R unavailable"}</b></span>
          <span>Integrity <b>{verifiedFrom.integrityScore ?? "--"} · {verifiedFrom.integrityStatus ?? "unknown"}</b></span>
        </div>
        {verifiedFrom.integrityWarnings?.length > 0 && (
          <MiniStatus tone="warn">{verifiedFrom.integrityWarnings.slice(0, 2).join(" · ")}</MiniStatus>
        )}
        {row?.params ? (
          <div className="hubert-lab__actions">
            <button type="button" onClick={() => verifyIntegrity(row)}>Verify integrity</button>
            <button type="button" onClick={() => rerunExact(row)}>Re-run exact</button>
            <button type="button" onClick={() => rerunExact(row, { openPanel: true })}>Open Backtest</button>
            <button type="button" onClick={() => compareToSavedBacktest(row)}>Compare to saved backtest</button>
            <button type="button" onClick={() => rerunExact(row)}>Show metric diff</button>
          </div>
        ) : (
          <MiniStatus tone="warn">I can explain this message, but I cannot re-run it because the exact config row is not attached.</MiniStatus>
        )}
      </div>
    );
  }

  function renderChatMessage(message, index, total, forcedCollapsed = false) {
    const isAssistant = message.role === "assistant";
    const shouldCollapse = forcedCollapsed || collapseAllChat || (isAssistant && index < total - 4);
    const row = message.row ?? null;
    const content = (
      <>
        <strong>{message.role === "user" ? "You" : "AH"}</strong>
        {message.lifecycle && (
          <small className="hubert-ai-intent">State: {message.lifecycle}</small>
        )}
        {isAssistant && message.intent && (
          <small className="hubert-ai-intent">Intent: {humanIntentLabel(message.intent)}</small>
        )}
        <span>{message.text}</span>
        {isAssistant && (message.confidence || message.risk) && (
          <div className="hubert-ai-badges">
            {message.confidence && <em data-tone={message.confidence.label}>Confidence {message.confidence.label} · {message.confidence.score ?? "--"}/100</em>}
            {message.risk && <em data-tone={message.risk.label}>Risk {message.risk.label}</em>}
          </div>
        )}
        {isAssistant && renderVerifiedFrom(message.verifiedFrom, row)}
        {isAssistant && message.baselineComparison?.ok && (
          <details className="hubert-ai-reasoning" open>
            <summary>Saved baseline comparison · {message.baselineComparison.baseline?.name}</summary>
            <small>{message.baselineComparison.explanation}</small>
          </details>
        )}
        {isAssistant && message.sections?.length > 0 && (
          <details className="hubert-ai-reasoning">
            <summary>Details / reasoning</summary>
            {message.sections.map((section, sectionIndex) => (
              <section key={`${section.title}-${sectionIndex}`}>
                <strong>{section.title}</strong>
                {section.body && <p>{section.body}</p>}
                {section.bullets?.length > 0 && (
                  <ul>
                    {section.bullets.slice(0, 8).map((item, itemIndex) => <li key={`${itemIndex}-${item}`}>{item}</li>)}
                  </ul>
                )}
              </section>
            ))}
          </details>
        )}
        {isAssistant && message.platformEvidence && (
          <details className="hubert-ai-reasoning">
            <summary>Platform evidence</summary>
            <small>Confidence: {message.platformEvidence.confidence ?? "unknown"}</small>
            {message.platformEvidence.inspected?.length > 0 && (
              <ul>
                {message.platformEvidence.inspected.slice(0, 10).map((item, itemIndex) => <li key={`${itemIndex}-${item}`}>{item}</li>)}
              </ul>
            )}
            {message.platformEvidence.unknown?.length > 0 && <small>Unknown: {message.platformEvidence.unknown.join(" · ")}</small>}
          </details>
        )}
        {message.evidence?.length > 0 && (
          <details className="hubert-ai-reasoning">
            <summary>Raw evidence lines</summary>
            <small>{message.evidence.join(" · ")}</small>
          </details>
        )}
        {message.diagnostics && (
          <details className="hubert-ai-reasoning">
            <summary>Request / response diagnostics</summary>
            <div className="hubert-lab__metrics">
              <Metric label="Request" value={message.diagnostics.requestId ?? "--"} />
              <Metric label="Route" value={message.diagnostics.route ?? "--"} />
              <Metric label="Status" value={message.diagnostics.responseStatus ?? message.diagnostics.status ?? "--"} />
              <Metric label="Latency" value={message.diagnostics.latencyMs !== undefined ? `${message.diagnostics.latencyMs}ms` : "--"} />
            </div>
            {message.diagnostics.lastError && <MiniStatus tone="bad">{message.diagnostics.lastError}</MiniStatus>}
          </details>
        )}
        {isAssistant && message.lifecycle === "failed" && message.retryText && (
          <div className="hubert-lab__actions">
            <button type="button" onClick={() => askFollowUp(message.retryText, row)}>Retry</button>
          </div>
        )}
      </>
    );

    if (shouldCollapse) {
      return (
        <details className="hubert-chat-message hubert-chat-message--collapsed" data-role={message.role} key={`${message.time}-${index}`}>
          <summary>{message.role === "user" ? "You" : "AH"} · {String(message.text ?? "").slice(0, 110)}</summary>
          {content}
        </details>
      );
    }

    return (
      <div className="hubert-chat-message" data-role={message.role} key={`${message.time}-${index}`}>
        {content}
      </div>
    );
  }

  return (
    <section className={`hubert-lab__section hubert-ah-workspace${ahExpanded ? " hubert-ah-workspace--expanded" : ""}`}>
      <div className="hubert-lab__subhead">
        <strong>Artificial Hubert (AH)</strong>
        <span>{running ? "working" : pendingAhOperation ? "needs confirmation" : "ready"}</span>
      </div>
      <MiniStatus tone={aiStatus?.connected ? "good" : aiStatus?.lastError ? "bad" : "neutral"}>
        {aiStatus?.message ?? "AH runs through the backend. It cannot place orders without explicit confirmation."}
      </MiniStatus>
      <div className="hubert-lab__metrics">
        <Metric label="Provider" value={aiStatus?.provider ?? "mock"} />
        <Metric label="Model" value={aiStatus?.model ?? "not connected"} />
        <Metric label="Execution" value="Confirmation required" />
      </div>
      <div className="hubert-ai-context-header">
        <span><b>Chart</b>{activeWorkspaceContext.chart?.symbol ?? "SOLUSDT"} · {activeWorkspaceContext.chart?.timeframe ?? "--"} · {activeWorkspaceContext.chart?.renderedCandles ?? 0} candles</span>
        <span><b>Panel</b>{activeWorkspaceContext.activePanel ?? "AI"}</span>
        <span><b>Live</b>{activeWorkspaceContext.live?.openPositions ?? 0} positions · {activeWorkspaceContext.live?.source ?? "syncing"}</span>
        <span><b>Research baseline</b>{copilotMemory?.researchIntent?.baselineQuery || "none active"}</span>
      </div>
      <div className="hubert-lab__actions hubert-chat-toolbar">
        <button type="button" onClick={() => setAhExpanded((value) => !value)}>{ahExpanded ? "Compact AH" : "Expand AH"}</button>
        <button type="button" onClick={() => setShowAhContext((value) => !value)}>{showAhContext ? "Hide Context" : "Show Context"}</button>
        <button type="button" onClick={() => setShowRunHistory((value) => !value)}>{showRunHistory ? "Hide History" : "History"}</button>
        <button type="button" onClick={startNewChat}>New Chat</button>
      </div>

      <div className="hubert-copilot-grid">
        <div>
          <div className="hubert-lab__actions hubert-chat-toolbar">
            <button type="button" onClick={() => setCollapseAllChat(true)}>Collapse all</button>
            <button type="button" onClick={clearVisibleChat}>Clear visible chat</button>
            <button type="button" onClick={() => setShowRunHistory((value) => !value)}>{showRunHistory ? "Hide run history" : "Open run history"}</button>
          </div>
          <div className="hubert-chat-log">
            {visibleChatMessages.length === 0 ? (
              <MiniStatus>Ask a research question, then follow up with “why config #2?” or “would this survive Conservative fill?”.</MiniStatus>
            ) : (
              <>
                {olderChatMessages.length > 0 && (
                  <details className="hubert-chat-older">
                    <summary>{olderChatMessages.length} older message{olderChatMessages.length === 1 ? "" : "s"} collapsed</summary>
                    {olderChatMessages.map((message, index) => renderChatMessage(message, index, olderChatMessages.length, true))}
                  </details>
                )}
                {recentChatMessages.map((message, index) => renderChatMessage(message, index, recentChatMessages.length))}
              </>
            )}
            {["thinking", "sending", "responding", "streaming"].includes(followUpState.state) && (
              <div className="hubert-chat-message" data-role="assistant">
                <strong>AH</strong>
                <span>{followUpState.state === "sending" ? "Sending..." : followUpState.state === "thinking" ? "Thinking..." : "Responding..."}</span>
                <small>{followUpState.message}</small>
              </div>
            )}
            <span ref={chatEndRef} aria-hidden="true" />
          </div>
          <div className="hubert-chat-composer">
            <label>
              <span>Ask Artificial Hubert anything</span>
              <textarea
                data-testid="ah-chat-textarea"
                placeholder="Ask about research, buttons, SL/TP, chart, code paths, errors, limits, or what AH should prepare next."
                value={followUpText}
                onChange={(event) => setFollowUpText(event.target.value)}
              />
            </label>
            <div className="hubert-lab__actions">
              <button type="button" data-testid="ah-chat-send" disabled={["thinking", "sending", "responding", "streaming"].includes(followUpState.state)} onClick={() => askFollowUp(followUpText)}>
                Send
              </button>
              <button type="button" disabled={!activeRun?.id || ["thinking", "sending", "responding", "streaming"].includes(followUpState.state)} onClick={() => askFollowUp(copilotMode === "research" ? "Give me a deep analysis of the current result: strengths, weaknesses, overfit risk, confidence, and exact next tests." : "Answer from platform evidence: inspect files, routes, runtime state, unknowns, and verification steps.", activeResult)}>Deep Analysis</button>
              <button type="button" disabled={!activeRun?.id || ["thinking", "sending", "responding", "streaming"].includes(followUpState.state)} onClick={() => askFollowUp("Explain how you reached this conclusion. Show the evidence chain, rejected alternatives, uncertainty, and what would invalidate it.", activeResult)}>Explain Reasoning</button>
              <button type="button" onClick={startNewChat}>Start New Chat</button>
            </div>
          </div>
          {pendingAhOperation && (
            <article className="hubert-ah-pending">
              <div className="hubert-lab__subhead">
                <strong>Pending AH operation</strong>
                <span>{pendingAhOperation.status ?? pendingAhOperation.type}</span>
              </div>
              <label>
                <span>Research name</span>
                <input value={pendingAhName} onChange={(event) => setPendingAhName(event.target.value)} />
              </label>
              <MiniStatus tone="warn">{pendingAhOperation.summary}</MiniStatus>
              <div className="hubert-lab__metrics">
                <Metric label="Objective" value={pendingAhOperation.plan?.objective ?? "--"} />
                <Metric label="Method" value={pendingAhOperation.plan?.methodology ?? "--"} />
                <Metric label="Combinations" value={pendingAhOperation.plan?.maxCombinations ?? "--"} />
                <Metric label="Range" value={pendingAhOperation.plan?.range ? `${dateText(pendingAhOperation.plan.range.from)} → ${dateText(pendingAhOperation.plan.range.to)}` : "--"} />
                <Metric label="ETA" value={pendingAhOperation.estimatedDuration ?? "--"} />
                <Metric label="Baseline" value={pendingAhOperation.plan?.baselineQuery || "none"} />
                <Metric label="Symbol" value={pendingAhOperation.plan?.symbol ?? "--"} />
                <Metric label="TF" value={pendingAhOperation.plan?.timeframe ?? "--"} />
                <Metric label="Missing" value={pendingAhOperation.plan?.planningSession?.missingFields?.join(", ") || "none"} />
                <Metric label="Artifacts" value={pendingAhOperation.plan?.artifactFormats?.join(", ") || Object.entries(pendingAhOperation.plan?.artifacts ?? {}).filter(([, enabled]) => enabled).map(([key]) => key).join(", ") || "--"} />
                <Metric label="Tools" value={(pendingAhOperation.tools ?? pendingAhOperation.plan?.toolsPlanned ?? []).slice(0, 4).join(", ") || "--"} />
              </div>
              <details className="hubert-advanced">
                <summary>Edit pending parameters</summary>
                <div className="hubert-lab__grid hubert-lab__grid--two">
                  <label>
                    <span>Combinations</span>
                    <input
                      min="1"
                      type="number"
                      value={pendingAhOperation.plan?.maxCombinations ?? ""}
                      onChange={(event) => updatePendingAhPlan("maxCombinations", Number(event.target.value))}
                    />
                  </label>
                  <label>
                    <span>PF minimum</span>
                    <input
                      inputMode="decimal"
                      type="number"
                      value={pendingAhOperation.plan?.constraints?.minProfitFactor ?? ""}
                      onChange={(event) => updatePendingAhPlan("constraints.minProfitFactor", event.target.value === "" ? undefined : Number(event.target.value))}
                    />
                  </label>
                  <label>
                    <span>DD max</span>
                    <input
                      inputMode="decimal"
                      type="number"
                      value={pendingAhOperation.plan?.constraints?.maxDrawdown ?? ""}
                      onChange={(event) => updatePendingAhPlan("constraints.maxDrawdown", event.target.value === "" ? undefined : Number(event.target.value))}
                    />
                  </label>
                  <label>
                    <span>Min trades</span>
                    <input
                      min="0"
                      type="number"
                      value={pendingAhOperation.plan?.constraints?.minTrades ?? ""}
                      onChange={(event) => updatePendingAhPlan("constraints.minTrades", event.target.value === "" ? undefined : Number(event.target.value))}
                    />
                  </label>
                </div>
              </details>
              <details className="hubert-advanced">
                <summary>Safety notes / exact params</summary>
                <ul>
                  {(pendingAhOperation.riskNotes ?? []).map((note) => <li key={note}>{note}</li>)}
                </ul>
                <pre className="hubert-ai-json">{JSON.stringify(pendingAhOperation.plan, null, 2).slice(0, 7000)}</pre>
              </details>
              <div className="hubert-lab__actions">
                <button type="button" disabled={pendingAhOperation.status && pendingAhOperation.status !== "ready_to_confirm"} onClick={confirmPendingAhOperation}>Confirm</button>
                <button type="button" onClick={cancelPendingAhOperation}>Cancel</button>
              </div>
            </article>
          )}
          <details className="hubert-advanced">
            <summary>Advanced / manual job queue</summary>
            <label>
            <span>New research command</span>
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} />
            </label>
            <div className="hubert-lab__actions">
              <button type="button" onClick={startRun}>{copilotMode === "research" ? "Run Research" : "Ask from Platform Evidence"}</button>
              <button type="button" onClick={() => runAction("ai-agent-refresh", "Refresh agent runs", loadRuns)}>Refresh</button>
              {running && <button type="button" onClick={() => cancelRun(activeRun.id)}>Cancel</button>}
              {["interrupted", "stalled", "cancelled", "failed"].includes(activeRun?.status) && (
                <button type="button" onClick={() => restartRun(activeRun.id)}>Restart Same Prompt</button>
              )}
            </div>
            <div className="hubert-lab__actions hubert-ai-mode">
              <button type="button" data-active={copilotMode === "research"} onClick={() => setCopilotMode("research")}>Research mode</button>
              <button type="button" data-active={copilotMode === "platform-diagnosis"} onClick={() => setCopilotMode("platform-diagnosis")}>Platform diagnosis mode</button>
              <button type="button" data-active={copilotMode === "code-evidence"} onClick={() => setCopilotMode("code-evidence")}>Code/data evidence mode</button>
            </div>
          </details>
          {followUpState.state !== "idle" && (
            <MiniStatus tone={followUpState.state === "failed" ? "bad" : followUpState.state === "completed" ? "good" : "neutral"}>
              Follow-up: {followUpState.state}. {followUpState.message}
            </MiniStatus>
          )}
          {lastAhDiagnostics && (
            <details className="hubert-advanced">
              <summary>AH request diagnostics</summary>
              <div className="hubert-lab__metrics">
                <Metric label="Request" value={lastAhDiagnostics.requestId ?? "--"} />
                <Metric label="Route" value={lastAhDiagnostics.route ?? "--"} />
                <Metric label="Status" value={lastAhDiagnostics.responseStatus ?? lastAhDiagnostics.status ?? "--"} />
                <Metric label="Latency" value={lastAhDiagnostics.latencyMs !== undefined ? `${lastAhDiagnostics.latencyMs}ms` : "--"} />
              </div>
              {lastAhDiagnostics.lastError && <MiniStatus tone="bad">{lastAhDiagnostics.lastError}</MiniStatus>}
            </details>
          )}
        </div>
        {showAhContext && <aside className="hubert-live-card">
          <div className="hubert-lab__subhead"><strong>Run Context</strong><span>{activeRun?.id?.slice(-6) ?? "none"}</span></div>
          <ReadOnly label="Symbol" value={activeRun?.plan?.symbol ?? "SOLUSDT"} />
          <ReadOnly label="Timeframe" value={(activeRun?.plan?.timeframes ?? [activeRun?.plan?.timeframe ?? "15m"]).join(", ")} />
          <ReadOnly label="Provider" value={activeRun?.plan?.provider ?? "binance-futures"} />
          <ReadOnly label="Range" value={activeRun?.plan?.range ? `${dateText(activeRun.plan.range.from)} → ${dateText(activeRun.plan.range.to)}` : "Latest"} />
          <ReadOnly label="Capital" value={`${fmt(activeRun?.plan?.startingBalance ?? 10000)} USDT`} />
          <ReadOnly label="Sizing" value={activeRun?.plan?.sizingMode ?? "position-percent"} />
          <ReadOnly label="Fill" value={activeRun?.plan?.fillMode ?? "legacy"} />
        </aside>}
      </div>

      {(copilotView === "chat" || copilotView === "research") && (
      <details className="hubert-advanced">
        <summary>Examples and advanced limits</summary>
        <div className="hubert-lab__actions hubert-ai-tabs">
          {[
            ["chat", "Chat"],
            ["research", "Research details"],
            ["diagnostics", "Evidence tools"],
            ["memory", "Memory"],
            ["history", "Run queue"],
          ].map(([view, label]) => (
            <button data-active={copilotView === view} key={view} type="button" onClick={() => setCopilotView(view)}>{label}</button>
          ))}
        </div>
        <div className="hubert-ai-examples">
          {examples.map((example) => (
            <button key={example} type="button" onClick={() => setPrompt(example)}>{example}</button>
          ))}
        </div>
        <div className="hubert-lab__grid">
          <NumberField label="Max combinations" max="5000" min="1" value={options.maxCombinations} onChange={(value) => setOptions({ ...options, maxCombinations: value })} />
          <SelectField label="Default objective" value={options.objective} onChange={(value) => setOptions({ ...options, objective: value })} options={[["robustness-adjusted return", "Robustness"], ["net profit", "Net profit"], ["profit factor", "Profit factor"], ["win rate", "Win rate"], ["drawdown-adjusted return", "Drawdown adjusted"]]} />
        </div>
        <ToggleGrid
          values={options}
          onChange={(key, value) => setOptions({ ...options, [key]: value })}
          items={[
            ["allowLongRunningJobs", "Allow >1000 tests"],
            ["includeLiveData", "Include live status"],
            ["includeCodeContext", "Include code map"],
          ]}
        />
        <MiniStatus>Runs above 1000 combinations require the long-running option. The agent stores compact summaries, not full trade lists for every row.</MiniStatus>
      </details>
      )}

      {activeRun && (copilotView === "chat" || copilotView === "research") && (
        <details className="hubert-advanced hubert-ah-task" open={running}>
          <summary>Current AH task · {activeRun.status} · {activeRun.currentStep ?? "waiting"}</summary>
          <article className="hubert-live-card">
          <div className="hubert-lab__subhead">
            <strong>{activeRun.status.toUpperCase()}</strong>
            <span>{activeRun.currentStep ?? "waiting"}</span>
          </div>
          <div className="hubert-lab__metrics">
            <Metric label="Progress" value={`${activeRun.progress?.percent ?? 0}%`} />
            <Metric label="Stage" value={`${activeRun.progress?.stageProgress ?? activeRun.progress?.percent ?? 0}%`} />
            <Metric label="Completed" value={`${activeRun.progress?.completed ?? 0}/${activeRun.progress?.total ?? 0}`} />
            <Metric label="Requested" value={activeRun.plan?.requestedCombinations ?? activeRun.plan?.maxCombinations ?? "--"} />
            <Metric label="Planned" value={activeRun.plan?.plannedCombinations ?? activeRun.plan?.maxCombinations ?? "--"} />
            <Metric label="Executed" value={activeRun.resultSummary?.executedCombinations ?? activeRun.progress?.completed ?? 0} />
            <Metric label="Speed" value={`${fmt(activeRun.progress?.combinationsPerSecond ?? 0, 2)}/s`} />
            <Metric label="ETA" value={activeRun.progress?.etaSeconds ? `${activeRun.progress.etaSeconds}s` : "--"} />
            <Metric label="Cache hits" value={`${activeRun.cacheStats?.hits ?? activeRun.resultSummary?.cacheStats?.hits ?? 0}/${activeRun.cacheStats?.total ?? activeRun.resultSummary?.cacheStats?.total ?? 0}`} />
            <Metric label="Workers" value={`${queueStatus?.activeWorkerCount ?? activeRun.progress?.activeWorkers ?? 0}/${queueStatus?.concurrency ?? "--"}`} />
            <Metric label="Heartbeat" value={activeRun.heartbeatAt ? ageText(activeRun.heartbeatAt) : "--"} />
            <Metric label="Intent" value={activeRun.parsedIntent ?? "analysis"} />
            <Metric label="Started" value={dateText(activeRun.startedAt)} />
          </div>
          <details className="hubert-advanced">
            <summary>Details / worker diagnostics</summary>
            <div className="hubert-lab__metrics">
              <Metric label="Last index" value={activeRun.progress?.worker?.lastCompletedIndex ?? "--"} />
              <Metric label="Worker message" value={activeRun.progress?.worker?.lastMessage ?? "--"} />
              <Metric label="Worker error" value={activeRun.progress?.worker?.lastError || "--"} />
            </div>
          </details>
          {activeRun.plan?.requestedCombinations !== activeRun.plan?.plannedCombinations && (
            <MiniStatus tone="warn">
              Requested {activeRun.plan?.requestedCombinations}, running {activeRun.plan?.plannedCombinations} after safety planning.
            </MiniStatus>
          )}
          {activeRun.partialResults?.length > 0 && (
            <MiniStatus>
              Early best: rank {activeRun.partialResults[0]?.rank ?? 1} · score {fmt(activeRun.partialResults[0]?.score)} · {activeRun.partialResults[0]?.research?.label ?? "exploring"}
            </MiniStatus>
          )}
          {activeRun.warnings?.length > 0 && <MiniStatus tone="warn">{activeRun.warnings[0]}</MiniStatus>}
          {activeRun.errors?.length > 0 && <MiniStatus tone="bad">{activeRun.errors[0]}</MiniStatus>}
          {activeRun.resultSummary && (
            <div className="hubert-agent-result">
              <strong>{activeRun.resultSummary.message}</strong>
              {activeRun.resultSummary.topRows?.length > 0 && (
                <>
                  <div className="hubert-ai-result-switcher">
                    {activeRun.resultSummary.topRows.slice(0, 5).map((row, index) => (
                      <button data-active={index === activeResultIndex} key={`${row.id ?? index}`} type="button" onClick={() => setActiveResultIndex(index)}>
                        #{row.rank ?? index + 1}
                      </button>
                    ))}
                  </div>
                  {activeResult && (
                    <article className="hubert-live-card">
                      <div className="hubert-lab__subhead"><strong>Current Result #{activeResult.rank ?? activeResultIndex + 1}</strong><span>{activeResult.research?.label ?? activeResult.params?.sizingMode ?? "result"}</span></div>
                      <div className="hubert-ai-badges">
                        {activeResult.research?.overfit?.label && <em data-tone={activeResult.research.overfit.label === "low" ? "low" : activeResult.research.overfit.label}>Overfit {activeResult.research.overfit.label}</em>}
                        {activeResult.research?.robustnessScore !== undefined && <em data-tone="moderate">Robustness {fmt(activeResult.research.robustnessScore)}</em>}
                      </div>
                      <div className="hubert-lab__metrics">
                        <Metric label="Robustness" value={fmt(activeResult.research?.robustnessScore ?? activeResult.score)} />
                        <Metric label="Net" value={metricText(activeResult.canonical?.metrics?.netPnl ?? activeResult.metrics?.netProfit ?? activeResult.netProfit, 2, " USDT")} />
                        <Metric label="PF" value={metricText(activeResult.canonical?.metrics?.profitFactor ?? activeResult.metrics?.profitFactor ?? activeResult.profitFactor)} />
                        <Metric help="RRR = average winning trade divided by absolute average losing trade." label="RRR" value={rrrText(activeResult)} />
                        <Metric help="Avg R / trade = average result in risk units when available." label="Avg R / trade" value={avgRText(activeResult)} />
                        <Metric label="Trades" value={activeResult.canonical?.metrics?.trades ?? activeResult.metrics?.totalTrades ?? activeResult.totalTrades ?? 0} />
                      </div>
                      {renderVerifiedFrom(verifiedFromFor(activeResult), activeResult)}
                      <MiniStatus>
                        {activeResult.params ? `BW ${activeResult.params.bandwidth}, NWE ${activeResult.params.envelopeMultiplier}, ATR ${activeResult.params.atrLength}/${activeResult.params.atrMultiplier}, max failures ${activeResult.params.maxSameSideFailures}` : "exact settings stored"}
                      </MiniStatus>
                      <details className="hubert-advanced">
                        <summary>Details / Provenance</summary>
                        <pre className="hubert-ai-json">{JSON.stringify({ params: activeResult.params, provenance: activeResult.provenance, validation: activeResult.validation, research: activeResult.research }, null, 2).slice(0, 7000)}</pre>
                      </details>
                      <div className="hubert-lab__actions">
                        <button type="button" onClick={() => rerunExact(activeResult)}>Re-run exact</button>
                        <button type="button" onClick={() => verifyIntegrity(activeResult)}>Verify integrity</button>
                        <button type="button" onClick={() => rerunExact(activeResult, { openPanel: true })}>Open Backtest</button>
                        <button type="button" onClick={() => compareToSavedBacktest(activeResult)}>Compare to saved backtest</button>
                        <button type="button" onClick={() => rerunExact(activeResult)}>Show metric diff</button>
                        <button type="button" onClick={() => {
                          setStrategyForm?.(rowStrategyDraft(activeResult));
                          setActivePanel?.("Strategy Decks");
                        }}>Open Strategy Draft</button>
                        <button type="button" onClick={() => askFollowUp(`Explain current result #${activeResult.rank ?? activeResultIndex + 1}.`, activeResult)}>Ask about this</button>
                      </div>
                      <div className="hubert-inline-form">
                        <label>
                          <span>Saved baseline</span>
                          <input value={baselineCompareName} onChange={(event) => setBaselineCompareName(event.target.value)} placeholder="hubert" />
                        </label>
                        <button type="button" onClick={() => compareToSavedBacktest(activeResult)}>Compare</button>
                      </div>
                      {baselineCompareResult?.ok && baselineCompareResult.runId === activeRun.id && (
                        <details className="hubert-advanced" open>
                          <summary>Saved backtest comparison: {baselineCompareResult.baseline?.name}</summary>
                          <MiniStatus tone={baselineCompareResult.parity?.allContextMatch ? "good" : "warn"}>
                            {baselineCompareResult.explanation}
                          </MiniStatus>
                          <div className="hubert-lab__metrics">
                            <Metric label="AI net" value={metricText(baselineCompareResult.metricDiff?.netProfit?.ai, 2, " USDT")} />
                            <Metric label="Saved net" value={metricText(baselineCompareResult.metricDiff?.netProfit?.saved, 2, " USDT")} />
                            <Metric label="AI PF" value={metricText(baselineCompareResult.metricDiff?.profitFactor?.ai)} />
                            <Metric label="Saved PF" value={metricText(baselineCompareResult.metricDiff?.profitFactor?.saved)} />
                            <Metric label="Context" value={baselineCompareResult.parity?.allContextMatch ? "Match" : "Different"} />
                          </div>
                          <pre className="hubert-ai-json">{JSON.stringify({
                            contextDiff: baselineCompareResult.contextDiff,
                            metricDiff: baselineCompareResult.metricDiff,
                            resolution: baselineCompareResult.baseline?.resolved,
                          }, null, 2).slice(0, 7000)}</pre>
                        </details>
                      )}
                    </article>
                  )}
                </>
              )}
            </div>
          )}
          {activeRun.artifacts?.length > 0 && (
            <div className="hubert-lab__actions">
              <button type="button" onClick={() => exportRun(activeRun.id, "md")}>Export Markdown</button>
              <button type="button" onClick={() => exportRun(activeRun.id, "json")}>Export JSON</button>
              <button type="button" onClick={() => exportRun(activeRun.id, "csv")}>Export CSV</button>
              {activeRun.artifacts?.some((artifact) => artifact.format === "docx") && <button type="button" onClick={() => exportRun(activeRun.id, "docx")}>Export Word</button>}
              {activeRun.artifacts?.some((artifact) => artifact.format === "xlsx") && <button type="button" onClick={() => exportRun(activeRun.id, "xlsx")}>Export Excel</button>}
            </div>
          )}
          </article>
        </details>
      )}

      {(showRunHistory || copilotView === "history") && (
        <>
          <div className="hubert-lab__subhead"><strong>Run history</strong><span>{runs.length}</span></div>
          <div className="hubert-list-compact">
            {runs.slice(0, 8).map((run) => (
              <article key={run.id}>
                <strong>{run.parsedIntent ?? "analysis"} · {run.status}</strong>
                <span>{run.prompt}</span>
                <div className="hubert-lab__actions">
                  <button type="button" onClick={() => setActiveRunId(run.id)}>Open</button>
                  {["queued", "running"].includes(run.status) && <button type="button" onClick={() => cancelRun(run.id)}>Cancel</button>}
                </div>
              </article>
            ))}
          </div>
        </>
      )}

      {copilotView === "memory" && (
        <article className="hubert-live-card">
          <div className="hubert-lab__subhead"><strong>AH Memory</strong><span>{copilotMemory?.updatedAt ? dateText(copilotMemory.updatedAt) : "fresh"}</span></div>
          <MiniStatus>
            AH uses this to remember baselines, preferences, previous conclusions, and recent workspace context. It stays read-only for trading.
          </MiniStatus>
          <div className="hubert-lab__metrics">
            <Metric label="Language" value={copilotMemory?.preferences?.language ?? "auto"} />
            <Metric label="Preferred metrics" value={copilotMemory?.preferences?.metrics?.join(", ") || "not learned yet"} />
            <Metric label="Baselines" value={copilotMemory?.favoriteBaselines?.length ?? 0} />
            <Metric label="Conclusions" value={copilotMemory?.previousConclusions?.length ?? 0} />
          </div>
          <div className="hubert-lab__actions">
            <button type="button" onClick={() => runAction("ai-load-copilot-memory", "Load copilot memory", loadCopilotMemory)}>Refresh memory</button>
            <button type="button" onClick={() => runAction("ai-clear-copilot-memory", "Clear copilot memory", async () => {
              const payload = await apiRequest("/ai/copilot/memory", { method: "DELETE" });
              setCopilotMemory(payload.memory ?? null);
            })}>Clear memory</button>
          </div>
          <details className="hubert-advanced" open>
            <summary>Memory details</summary>
            <pre className="hubert-ai-json">{JSON.stringify(copilotMemory ?? {}, null, 2).slice(0, 12000)}</pre>
          </details>
        </article>
      )}

      {copilotView === "diagnostics" && (
      <details className="hubert-advanced" open>
        <summary>Manual backend tools</summary>
        <div className="hubert-ai-actions">
          <button type="button" onClick={() => callManualTool("getCurrentWorkspaceState", {}, "Current workspace state")}>Current workspace state</button>
          <button type="button" onClick={() => callManualTool("explainCurrentSetup")}>Explain current setup</button>
          <button type="button" onClick={() => callManualTool("getPlatformStatus")}>Platform status</button>
          <button type="button" onClick={() => callManualTool("summarizeBacktest")}>Latest backtest</button>
          <button type="button" onClick={() => callManualTool("createAlertDraft", { condition: "live data stale over 60 seconds", name: "Data freshness watch" })}>Create alert draft</button>
        </div>
        {manualResult && <pre className="hubert-ai-json">{JSON.stringify(manualResult, null, 2).slice(0, 12000)}</pre>}
      </details>
      )}
    </section>
  );
}

function AiPanel({
  aiContext,
  aiStatus,
  apiRequest,
  messages,
  mmDecks,
  onAsk,
  question,
  runAction,
  setAiContext,
  setMessages,
  setQuestion,
  strategyDecks,
}) {
  const examples = [
    "Explain why Backtest 1 made more than Backtest 2.",
    "Is this drawdown dangerous?",
    "Why can't I move SL?",
    "Which deck is currently strongest?",
    "Explain this platform error like I am a beginner.",
  ];
  const [builder, setBuilder] = useState({
    format: "json",
    from: "",
    maxCombinations: 50,
    objective: "drawdown-adjusted return",
    provider: "binance-futures",
    sizingMode: "position-percent",
    symbol: "SOLUSDT",
    timeframe: "15m",
    timeframes: "10m,15m,20m,30m,1h,4h",
    to: "",
  });
  const [toolResult, setToolResult] = useState(null);
  const [reports, setReports] = useState([]);
  const [alertDrafts, setAlertDrafts] = useState([]);
  const [alertForm, setAlertForm] = useState({
    condition: "live data stale over 60 seconds",
    name: "Data freshness watch",
    source: "live data",
    symbol: "SOLUSDT",
    timeframe: "15m",
  });
  const [codeMap, setCodeMap] = useState(null);
  const [snippetRequest, setSnippetRequest] = useState({
    filePath: "hubert-platform/frontend/src/components/ControlCenter.jsx",
    line: 1,
  });
  const [codeSnippet, setCodeSnippet] = useState(null);
  const strategyOptions = [["", "Current/default"], ...(strategyDecks ?? []).map((deck) => [deck.id, deck.name])];
  const mmOptions = [["", "Current/default"], ...(mmDecks ?? []).map((deck) => [deck.id, deck.name])];
  const commonInput = {
    ...builder,
    strategyDeckId: builder.strategyDeckId || undefined,
    mmDeckId: builder.mmDeckId || undefined,
    timeframes: String(builder.timeframes ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  };

  async function callTool(toolName, input = {}, label = toolName) {
    return runAction(`ai-tool-${toolName}`, label, async () => {
      const payload = await apiRequest("/ai/tool", {
        body: { input, toolName },
        method: "POST",
      });
      setToolResult(payload);
      if (toolName === "exportReport") {
        setReports(await apiRequest("/ai/reports"));
      }
      if (toolName === "createAlertDraft") {
        setAlertDrafts(await apiRequest("/ai/alerts"));
      }
      return payload;
    });
  }

  async function loadReports() {
    return runAction("ai-load-reports", "Load AI reports", async () => {
      setReports(await apiRequest("/ai/reports"));
    });
  }

  async function exportReport(report, format) {
    return runAction(`ai-export-${report.id}-${format}`, `Export ${format.toUpperCase()}`, async () => {
      const payload = await apiRequest("/ai/reports/export", {
        body: { format, reportId: report.id },
        method: "POST",
      });
      downloadPayload(payload.fileName, payload.content, payload.mime, payload.encoding);
    });
  }

  async function loadCodeMap() {
    return runAction("ai-code-map", "Load code map", async () => {
      setCodeMap(await apiRequest("/ai/code-map"));
    });
  }

  async function inspectSnippet() {
    return runAction("ai-code-snippet", "Inspect file", async () => {
      setCodeSnippet(await apiRequest("/ai/code-snippet", {
        body: snippetRequest,
        method: "POST",
      }));
    });
  }

  return (
    <section className="hubert-lab__section">
      <div className="hubert-lab__subhead"><strong>AI Analyst Workbench</strong><span>analysis only</span></div>
      <MiniStatus tone={aiStatus?.connected ? "good" : aiStatus?.lastError ? "bad" : "neutral"}>
        {aiStatus?.message ?? "AI Workbench runs through the backend in mock mode."}
      </MiniStatus>
      <div className="hubert-lab__metrics">
        <Metric label="Provider" value={aiStatus?.provider ?? "mock"} />
        <Metric label="Model" value={aiStatus?.model ?? "not connected"} />
        <Metric label="State" value={aiStatus?.connected ? "Connected" : aiStatus?.lastError ? "Error" : "Mock / local"} />
      </div>
      <MiniStatus>AI can analyze data and prepare reports, but it cannot place orders or change live execution.</MiniStatus>
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
          ["includeCodeMap", "Code map"],
        ]}
      />

      <div className="hubert-lab__subhead"><strong>Ask AI</strong><span>{aiStatus?.provider ?? "mock"} provider</span></div>
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
        <button type="button" onClick={() => setMessages([])}>Clear screen</button>
        <button type="button" onClick={() => runAction("ai-clear-memory", "Clear AI memory", async () => {
          await apiRequest("/ai/sessions", { method: "DELETE" });
          setMessages([]);
        })}>Clear saved memory</button>
      </div>

      <div className="hubert-lab__subhead"><strong>Quick Actions</strong><span>backend tools</span></div>
      <div className="hubert-ai-actions">
        <button type="button" onClick={() => callTool("explainCurrentSetup", {}, "Explain current setup")}>Explain current setup</button>
        <button type="button" onClick={() => callTool("summarizeBacktest", {}, "Analyze latest backtest")}>Analyze latest backtest</button>
        <button type="button" onClick={() => callTool("compareBacktests", {}, "Compare backtests")}>Compare selected backtests</button>
        <button type="button" onClick={() => callTool("analyzeTimeframes", commonInput, "Find best timeframe")}>Find best timeframe</button>
        <button type="button" onClick={() => callTool("optimizeSettings", commonInput, "Optimize settings")}>Optimize settings</button>
        <button type="button" onClick={() => callTool("diagnoseIssue", { question }, "Diagnose data issue")}>Diagnose data issue</button>
        <button type="button" onClick={() => callTool("runSweepAnalysis", { ...commonInput, maxCombinations: Math.min(Number(builder.maxCombinations) || 50, 100) }, "Summarize sweep")}>Summarize sweep</button>
        <button type="button" onClick={() => callTool("exportReport", { format: builder.format, type: "backtest" }, "Build report")}>Build report</button>
        <button type="button" onClick={() => callTool("createAlertDraft", alertForm, "Create alert draft")}>Create alert draft</button>
      </div>

      <details className="hubert-advanced">
        <summary>Analysis Builder</summary>
        <div className="hubert-lab__grid">
          <TextField label="Symbol" value={builder.symbol} onChange={(value) => setBuilder({ ...builder, symbol: value })} />
          <TextField label="Timeframe(s)" value={builder.timeframes} onChange={(value) => setBuilder({ ...builder, timeframes: value })} />
          <TextField label="From" value={builder.from} onChange={(value) => setBuilder({ ...builder, from: value })} />
          <TextField label="To" value={builder.to} onChange={(value) => setBuilder({ ...builder, to: value })} />
          <SelectField label="Provider" value={builder.provider} onChange={(value) => setBuilder({ ...builder, provider: value })} options={[["binance-futures", "Binance Futures"], ["binance-spot", "Binance Spot"]]} />
          <SelectField label="Strategy Deck" value={builder.strategyDeckId ?? ""} onChange={(value) => setBuilder({ ...builder, strategyDeckId: value })} options={strategyOptions} />
          <SelectField label="MM Deck" value={builder.mmDeckId ?? ""} onChange={(value) => setBuilder({ ...builder, mmDeckId: value })} options={mmOptions} />
          <SelectField label="Sizing mode" value={builder.sizingMode} onChange={(value) => setBuilder({ ...builder, sizingMode: value })} options={[["position-percent", "Position Percent"], ["fixed-risk", "Fixed Risk Per Trade"]]} />
          <SelectField label="Objective" value={builder.objective} onChange={(value) => setBuilder({ ...builder, objective: value })} options={[["net profit", "Net profit"], ["win rate", "Win rate"], ["profit factor", "Profit factor"], ["drawdown-adjusted return", "Drawdown-adjusted return"], ["robustness", "Robustness"]]} />
          <NumberField label="Max combinations" max="500" min="1" value={builder.maxCombinations} onChange={(value) => setBuilder({ ...builder, maxCombinations: value })} />
          <SelectField label="Output format" value={builder.format} onChange={(value) => setBuilder({ ...builder, format: value })} options={[["json", "JSON"], ["csv", "CSV"]]} />
        </div>
        <div className="hubert-lab__actions">
          <button type="button" onClick={() => callTool("runHistoricalBacktest", commonInput, "Run AI backtest tool")}>Run Historical Backtest Tool</button>
          <button type="button" onClick={() => callTool("runSweepAnalysis", commonInput, "Run AI sweep tool")}>Run Sweep Tool</button>
          <button type="button" onClick={() => callTool("analyzePeriods", commonInput, "Analyze periods")}>Analyze Periods</button>
        </div>
      </details>

      {toolResult && (
        <details className="hubert-advanced" open>
          <summary>Latest Tool Output</summary>
          <pre className="hubert-ai-json">{JSON.stringify(toolResult, null, 2).slice(0, 12000)}</pre>
        </details>
      )}

      <div className="hubert-lab__subhead"><strong>Reports</strong><span>{reports.length}</span></div>
      <div className="hubert-lab__actions">
        <button type="button" onClick={loadReports}>Load reports</button>
      </div>
      {reports.length === 0 ? (
        <MiniStatus>No generated AI reports yet.</MiniStatus>
      ) : (
        <div className="hubert-list-compact">
          {reports.slice(0, 8).map((report) => (
            <article key={report.id}>
              <strong>{report.name ?? report.title}</strong>
              <span>{report.source ?? "report"} · {dateText(report.createdAt)}</span>
              <div className="hubert-lab__actions">
                <button type="button" onClick={() => exportReport(report, "json")}>Export JSON</button>
                <button type="button" onClick={() => exportReport(report, "csv")}>Export CSV</button>
                <button type="button" onClick={() => navigator.clipboard?.writeText(JSON.stringify(report, null, 2))}>Copy summary</button>
              </div>
            </article>
          ))}
        </div>
      )}

      <div className="hubert-lab__subhead"><strong>Alerts / Watch Drafts</strong><span>draft only</span></div>
      <div className="hubert-lab__grid">
        <TextField label="Alert name" value={alertForm.name} onChange={(value) => setAlertForm({ ...alertForm, name: value })} />
        <TextField label="Condition" value={alertForm.condition} onChange={(value) => setAlertForm({ ...alertForm, condition: value })} />
        <TextField label="Source" value={alertForm.source} onChange={(value) => setAlertForm({ ...alertForm, source: value })} />
        <TextField label="Symbol" value={alertForm.symbol} onChange={(value) => setAlertForm({ ...alertForm, symbol: value })} />
        <TextField label="Timeframe" value={alertForm.timeframe} onChange={(value) => setAlertForm({ ...alertForm, timeframe: value })} />
      </div>
      <div className="hubert-lab__actions">
        <button type="button" onClick={() => callTool("createAlertDraft", alertForm, "Create alert draft")}>Save draft</button>
        <button type="button" onClick={() => runAction("ai-load-alerts", "Load alert drafts", async () => setAlertDrafts(await apiRequest("/ai/alerts")))}>Load drafts</button>
      </div>
      {alertDrafts.length > 0 && (
        <div className="hubert-list-compact">
          {alertDrafts.slice(0, 8).map((draft) => (
            <article key={draft.id}>
              <strong>{draft.name}</strong>
              <span>{draft.condition} · {draft.status}</span>
            </article>
          ))}
        </div>
      )}

      <div className="hubert-lab__subhead"><strong>Code Assistant</strong><span>safe files only</span></div>
      <div className="hubert-lab__actions">
        <button type="button" onClick={loadCodeMap}>Load code map</button>
      </div>
      {codeMap && (
        <details className="hubert-advanced">
          <summary>Code map: {codeMap.scannedFiles} files</summary>
          <pre className="hubert-ai-json">{JSON.stringify(codeMap.sections, null, 2).slice(0, 12000)}</pre>
        </details>
      )}
      <div className="hubert-lab__grid">
        <TextField label="Safe relative file path" value={snippetRequest.filePath} onChange={(value) => setSnippetRequest({ ...snippetRequest, filePath: value })} />
        <NumberField label="Line" min="1" value={snippetRequest.line} onChange={(value) => setSnippetRequest({ ...snippetRequest, line: value })} />
      </div>
      <div className="hubert-lab__actions">
        <button type="button" onClick={inspectSnippet}>Inspect file</button>
      </div>
      {codeSnippet && (
        <pre className="hubert-ai-json">{codeSnippet.snippet}</pre>
      )}

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

function FavoritesPanel({ favorites, onDelete, onHide, onOpen, onRename }) {
  const groups = ["Strategy Decks", "MM Decks", "Battle Decks", "Backtests", "Sweep Results", "Analytics Reports"];
  const visibleFavorites = favorites.filter((item) => !item.hidden);

  return (
    <section className="hubert-lab__section">
      {groups.map((group) => (
        <div className="hubert-lab__section" key={group}>
          <div className="hubert-lab__subhead"><strong>{group}</strong><span>{visibleFavorites.filter((item) => item.category === group).length}</span></div>
          <DeckList
            deleteLabel="Remove"
            decks={visibleFavorites.filter((item) => item.category === group)}
            extra={(favorite) => (
              <>
                <button type="button" onClick={() => onOpen(favorite)}>Open</button>
                <button type="button" onClick={() => onRename(favorite)}>Rename</button>
                <button type="button" onClick={() => onHide(favorite)}>Hide</button>
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

function DeckList({ decks, deleteLabel = "Delete", extra, onDelete, onDuplicate, onEdit, onFavorite }) {
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
            {onDelete && <button type="button" onClick={() => onDelete(deck)}>{deleteLabel}</button>}
          </div>
        </div>
      ))}
    </div>
  );
}

function BacktestResult({ onResetChartView, onViewTrade, result }) {
  const audit = useMemo(() => sizingAudit(result?.trades ?? []), [result?.trades]);
  const displayEquityCurve = useMemo(() => equityCurveForResult(result), [result]);
  const curveStats = useMemo(() => equityStats(displayEquityCurve), [displayEquityCurve]);
  const analytics = useMemo(() => derivedBacktestAnalytics(result ?? {}, displayEquityCurve), [displayEquityCurve, result]);
  const hasEndTrade = Boolean(result?.trades?.some((trade) => trade.exitReason === "END" || trade.reason === "END"));

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
        <Metric label="Fill mode" value={fillModeLabel(result.fillMode)} />
        <Metric label="Ambiguous candles" value={result.ambiguousCandlesCount ?? result.ambiguity?.ambiguousCandlesCount ?? 0} />
        <Metric label="Conservative adjusted" value={result.conservativeAdjustedTrades ?? result.ambiguity?.conservativeAdjustedTrades ?? 0} />
        <Metric label="Skipped entries" value={result.conservativeSkippedEntries ?? result.ambiguity?.conservativeSkippedEntries ?? 0} />
        <Metric label="Expectancy" value={fmt(analytics.expectancy)} />
        <Metric help="RRR = average winning trade divided by absolute average losing trade." label="RRR" value={Number.isFinite(analytics.rrr.value) ? fmt(analytics.rrr.value) : "RRR unavailable"} />
        <Metric help="Avg R / trade = average trade result in risk units when trade risk is available." label="Avg R / trade" value={Number.isFinite(analytics.avgR.value) ? fmt(analytics.avgR.value) : "Avg R unavailable"} />
        <Metric label="Average trade" value={fmt(analytics.averageTrade)} />
        <Metric label="Median trade" value={analytics.medianTrade === null ? "--" : fmt(analytics.medianTrade)} />
        <Metric label="Best trade" value={fmt(metrics.largestWin)} />
        <Metric label="Worst trade" value={fmt(metrics.largestLoss)} />
        <Metric label="Max wins streak" value={analytics.maxConsecutiveWins} />
        <Metric label="Max losses streak" value={analytics.maxConsecutiveLosses} />
        <Metric label="DD recovery" value={durationText(analytics.recoverySeconds)} />
        <Metric label="Profit concentration" value={analytics.profitConcentration === null ? "Unavailable" : `${fmt(analytics.profitConcentration)}% top wins`} />
        <Metric label="Monthly consistency" value={analytics.monthlyConsistency} />
      </div>
      <div className="hubert-lab__metrics">
        <Metric label="Starting capital" value={`${fmt(curveStats.start)} USDT`} />
        <Metric label="Ending capital" value={`${fmt(curveStats.end)} USDT`} />
        <Metric label="High-water mark" value={`${fmt(curveStats.highWater)} USDT`} />
        <Metric label="Equity low" value={`${fmt(curveStats.min)} USDT`} />
        <Metric label="Curve from" value={dateText(curveStats.from)} />
        <Metric label="Curve to" value={dateText(curveStats.to)} />
      </div>
      <MiniStatus>
        {result.strategyDeckName ?? "Strategy"} · {result.timeframe ?? "selected timeframe"} · provider {result.provider ?? result.dataDiagnostics?.provider ?? "binance-futures"} ·
        test candles {result.candlesUsed ?? result.sourceCandles?.length ?? "--"} · chart rendered {result.chartCandlesRendered ?? "--"}
        {result.analysisRange ? ` · ${dateText(result.analysisRange.from)} → ${dateText(result.analysisRange.to)}.` : "."}
      </MiniStatus>
      <MiniStatus>
        Evaluated setups: {result.diagnosticSummary?.totalEvaluatedCandles ?? "--"} candles.
        {result.dataDiagnostics?.providerLimitMessage ? ` ${result.dataDiagnostics.providerLimitMessage}` : ""}
      </MiniStatus>
      <MiniStatus>
        Fill Mode: {fillModeLabel(result.fillMode)}. Ambiguous candles: {result.ambiguousCandlesCount ?? result.ambiguity?.ambiguousCandlesCount ?? 0}. Conservative-adjusted trades: {result.conservativeAdjustedTrades ?? result.ambiguity?.conservativeAdjustedTrades ?? 0}. Skipped entries: {result.conservativeSkippedEntries ?? result.ambiguity?.conservativeSkippedEntries ?? 0}.
      </MiniStatus>
      {metrics.totalTrades === 0 && (
        <MiniStatus tone="neutral">
          No trades opened in this range. Evaluated candles: {result.diagnosticSummary?.totalEvaluatedCandles ?? "unknown"};
          valid LONG setups: {result.diagnosticSummary?.validLongSetups ?? 0};
          valid SHORT setups: {result.diagnosticSummary?.validShortSetups ?? 0}.
        </MiniStatus>
      )}
      <SingleCurveChart
        title="Equity Curve"
        caption={`Account equity over time. Start ${fmt(curveStats.start)} USDT, final ${fmt(curveStats.end)} USDT, high-water ${fmt(curveStats.highWater)} USDT.`}
        curve={displayEquityCurve}
        footer={`${dateText(curveStats.from)} → ${dateText(curveStats.to)} · y-axis ${fmt(curveStats.min)} to ${fmt(curveStats.highWater)} USDT`}
        onResetChartView={onResetChartView}
        yLabel="Account equity (USDT)"
      />
      <details className="hubert-advanced">
        <summary>Drawdown curve</summary>
        <SingleCurveChart
          title="Drawdown Curve"
          caption={`Drawdown from high-water mark. Max preview drawdown ${fmt(curveStats.maxDrawdownPercent)}%.`}
          curve={displayEquityCurve}
          footer={`${dateText(curveStats.from)} → ${dateText(curveStats.to)} · y-axis 0% to ${fmt(curveStats.maxDrawdownPercent)}%`}
          yLabel="Drawdown (%)"
          drawdown
        />
      </details>
      <MiniStatus>{analyzeBacktest(result)}</MiniStatus>
      {hasEndTrade && (
        <MiniStatus>END means the trade was still open when the selected test range ended. It is not a live open position.</MiniStatus>
      )}
      <div className="hubert-lab__subhead"><strong>Position Sizing Audit</strong><span>transparent sizing</span></div>
      <div className="hubert-lab__metrics">
        <Metric label="Average size" value={fmt(audit.averageSize)} />
        <Metric label="Min size" value={fmt(audit.minSize)} />
        <Metric label="Max size" value={fmt(audit.maxSize)} />
        <Metric label="Average leverage" value={`${fmt(audit.averageLeverage, 1)}x`} />
        <Metric label="Average risk" value={fmt(audit.averageRisk)} />
        <Metric label="Avg capital risk" value={`${fmt(audit.averageCapitalRiskPercent)}%`} />
        <Metric label="Biggest exposure" value={fmt(audit.biggestExposure)} />
        <Metric label="Clamped trades" value={audit.clamped} />
      </div>
      <MiniStatus>{audit.note}</MiniStatus>
      <div className="hubert-lab__actions">
        <button title="Center chart on current backtest range and restore default zoom." type="button" onClick={onResetChartView}>Center Chart</button>
        <button type="button" onClick={() => exportJson(`${result.name ?? "backtest"}.json`, exportableBacktestResult(result))}>Export JSON</button>
        <button type="button" onClick={() => exportBacktestCsv(`${result.name ?? "backtest"}-trades.csv`, result)}>Export CSV</button>
      </div>
      <SideBreakdown trades={result.trades} />
      <TradeTable onViewTrade={onViewTrade} trades={result.trades} />
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

function curvePointsForChart(curve = [], drawdown = false) {
  const sampled = sampleCurve(curve, 650);
  if (!drawdown) {
    return sampled
      .map((point) => ({
        time: Number(point.time ?? 0),
        value: Number(point.equity ?? 0),
      }))
      .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.value));
  }

  let peak = Number(sampled[0]?.equity ?? 0);
  return sampled
    .map((point) => {
      const equity = Number(point.equity ?? 0);
      peak = Math.max(peak, equity);
      return {
        time: Number(point.time ?? 0),
        value: peak > 0 ? ((peak - equity) / peak) * 100 : 0,
      };
    })
    .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.value));
}

function curvePath(points = [], viewport) {
  const visible = points.slice(viewport.start, viewport.end + 1);
  if (!visible.length) {
    return {
      max: 0,
      min: 0,
      path: "",
      visible,
    };
  }
  const minTime = visible[0].time;
  const maxTime = visible.at(-1).time;
  const values = visible.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const timeSpan = maxTime - minTime || 1;
  return {
    max,
    min,
    path: visible
      .map((point) => {
        const x = ((point.time - minTime) / timeSpan) * 100;
        const y = 100 - ((point.value - min) / span) * 100;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" "),
    visible,
  };
}

function SingleCurveChart({ caption, curve = [], drawdown = false, footer = "", onResetChartView, title, yLabel = "Value" }) {
  const points = useMemo(() => curvePointsForChart(curve, drawdown), [curve, drawdown]);
  const [viewport, setViewport] = useState({ end: 0, start: 0 });
  const [hover, setHover] = useState(null);
  const dragRef = useRef(null);

  useEffect(() => {
    setViewport({ end: Math.max(0, points.length - 1), start: 0 });
    setHover(null);
  }, [points.length, title, drawdown]);

  const safeViewport = useMemo(() => {
    const end = Math.min(Math.max(viewport.end, viewport.start), Math.max(0, points.length - 1));
    const start = Math.max(0, Math.min(viewport.start, end));
    return { end, start };
  }, [points.length, viewport]);
  const series = useMemo(() => curvePath(points, safeViewport), [points, safeViewport]);
  const firstVisible = series.visible[0];
  const lastVisible = series.visible.at(-1);
  const hoverPoint = hover === null ? null : series.visible[hover] ?? null;

  function resetLocalView() {
    setViewport({ end: Math.max(0, points.length - 1), start: 0 });
    setHover(null);
    onResetChartView?.();
  }

  function zoomChart(event) {
    if (points.length < 3) return;
    event.preventDefault();
    const windowSize = safeViewport.end - safeViewport.start + 1;
    const direction = event.deltaY > 0 ? 1 : -1;
    const nextSize = Math.max(8, Math.min(points.length, Math.round(windowSize * (direction > 0 ? 1.18 : 0.82))));
    const anchor = (event.nativeEvent.offsetX ?? 0) / Math.max(1, event.currentTarget.clientWidth);
    const anchorIndex = safeViewport.start + Math.round(windowSize * anchor);
    const nextStart = Math.max(0, Math.min(points.length - nextSize, anchorIndex - Math.round(nextSize * anchor)));
    setViewport({ end: nextStart + nextSize - 1, start: nextStart });
  }

  function hoverChart(event) {
    if (!series.visible.length) return;
    const ratio = (event.nativeEvent.offsetX ?? 0) / Math.max(1, event.currentTarget.clientWidth);
    const index = Math.max(0, Math.min(series.visible.length - 1, Math.round(ratio * (series.visible.length - 1))));
    setHover(index);
    if (dragRef.current !== null) {
      const delta = Math.round((dragRef.current - (event.clientX ?? 0)) / 8);
      const windowSize = safeViewport.end - safeViewport.start + 1;
      const nextStart = Math.max(0, Math.min(points.length - windowSize, safeViewport.start + delta));
      setViewport({ end: nextStart + windowSize - 1, start: nextStart });
      dragRef.current = event.clientX ?? dragRef.current;
    }
  }

  return (
    <div className="hubert-chart-box hubert-chart-box--analytics">
      <div className="hubert-lab__subhead">
        <strong>{title}</strong>
        <button title="Center chart on current backtest range and restore default zoom." type="button" onClick={resetLocalView}>Reset View</button>
      </div>
      <span>{caption}</span>
      <div className="hubert-chart-axis">
        <span>Y: {yLabel} · {fmt(series.min)} to {fmt(series.max)}</span>
        <span>X: {dateText(firstVisible?.time)} → {dateText(lastVisible?.time)}</span>
      </div>
      <div
        className="hubert-equity-interactive"
        onMouseDown={(event) => {
          dragRef.current = event.clientX;
        }}
        onMouseLeave={() => {
          dragRef.current = null;
          setHover(null);
        }}
        onMouseMove={hoverChart}
        onMouseUp={() => {
          dragRef.current = null;
        }}
        onWheel={zoomChart}
        role="presentation"
      >
        <svg className={`hubert-lab__equity${drawdown ? " hubert-lab__equity--drawdown" : ""}`} viewBox="0 0 100 100" preserveAspectRatio="none">
          <polyline points={series.path} />
          {hoverPoint && (
            <line
              className="hubert-equity-hover-line"
              x1={(hover / Math.max(1, series.visible.length - 1)) * 100}
              x2={(hover / Math.max(1, series.visible.length - 1)) * 100}
              y1="0"
              y2="100"
            />
          )}
        </svg>
        {hoverPoint && (
          <div className="hubert-equity-tooltip">
            <strong>{dateText(hoverPoint.time)}</strong>
            <span>{drawdown ? "Drawdown" : "Equity"}: {fmt(hoverPoint.value)}{drawdown ? "%" : " USDT"}</span>
          </div>
        )}
      </div>
      {footer && <span>{footer}</span>}
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

function TradeTable({ onViewTrade, trades }) {
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
            <tr><th>Time</th><th>Side</th><th>Sizing</th><th>Fill</th><th>Ambiguity</th><th>Capital</th><th>Size</th><th>Lev</th><th>SL dist</th><th>SL loss</th><th>R</th><th>Cap</th><th>PnL</th><th>Chart</th></tr>
          </thead>
          <tbody>
            {visibleTrades.map((trade, index) => (
              <tr key={trade.id ?? `${trade.entryTime}-${safePage}-${index}`}>
                <td>{dateText(trade.entryTime)}</td>
                <td>{trade.direction ?? trade.side}</td>
                <td title={trade.sizingClampReason || ""}>{trade.sizingMode ?? "--"}</td>
                <td>{fillModeLabel(trade.fillMode)}</td>
                <td title={trade.ambiguityReason || ""}>
                  {trade.sameCandleSl ? "same-candle SL" : trade.ambiguity ? "ambiguous" : "--"}
                </td>
                <td>{fmt(trade.accountCapitalAtEntry)}</td>
                <td>{fmt(trade.size)}</td>
                <td>{trade.assumedLeverage ? `${fmt(trade.assumedLeverage, 1)}x` : "--"}</td>
                <td>{trade.slDistancePercent ? `${fmt(trade.slDistancePercent * 100)}%` : "--"}</td>
                <td title={`Configured risk: ${fmt(trade.configuredRiskPercent)}% · raw notional ${fmt(trade.rawNotional)}`}>{fmt(trade.expectedSlLossAmount ?? trade.riskAmount)}</td>
                <td>{Number.isFinite(rMultipleForTrade(trade)) ? fmt(rMultipleForTrade(trade)) : "--"}</td>
                <td title={trade.sizingClampReason || "No sizing clamp"}>{trade.sizingClampReason ? "clamped" : "ok"}</td>
                <td>{fmt(trade.netPnl ?? trade.pnl)}</td>
                <td>
                  <button disabled={!onViewTrade} type="button" onClick={() => onViewTrade?.(trade)}>
                    {displayExitReason(trade.exitReason ?? trade.reason)} · View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function OrderTable({ orders }) {
  const visibleOrders = safeObjectRows(orders);
  if (!visibleOrders.length) {
    return <MiniStatus>No open exchange orders reported.</MiniStatus>;
  }

  return (
    <div className="hubert-lab__table">
      <table>
        <thead>
          <tr><th>Symbol</th><th>Type</th><th>Side</th><th>Price</th><th>Status</th></tr>
        </thead>
        <tbody>
          {visibleOrders.slice(-20).map((order, index) => (
            <tr key={`${safeOrderId(order) ?? "order"}-${order.type ?? order.orderType ?? "type"}-${order.stopPrice ?? order.price ?? index}-${index}`}>
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

function Metric({ help, label, value }) {
  return (
    <div title={help ?? ""}>
      <span>{label} {help && <Help text={help} />}</span>
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

function NumberField({ commitEmpty = true, disabled = false, help, label, max, min, onChange, step = "1", value }) {
  const [draft, setDraft] = useState(value ?? "");

  useEffect(() => {
    setDraft(value ?? "");
  }, [value]);

  return (
    <label>
      <span>{label} {help && <Help text={help} />}</span>
      <input
        inputMode="decimal"
        disabled={disabled}
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

function TextField({ disabled = false, label, onChange, value }) {
  return (
    <label>
      <span>{label}</span>
      <input disabled={disabled} value={value ?? ""} onChange={(event) => onChange(event.target.value)} />
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

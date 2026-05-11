import { useEffect, useMemo, useRef, useState } from "react";
import { runBacktest } from "../backtest/backtestEngine";
import { fetchHistoricalCandles } from "../api/binance";

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
const SWEEP_DEFAULT_COMBINATIONS = 200;
const SWEEP_MAX_COMBINATIONS = 500;

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

async function apiFetchDetailed(path, options = {}) {
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

  return {
    ...backtestForm,
    fillMode: form.manualFillMode ?? backtestForm.fillMode ?? "legacy",
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
  const headers = ["entryTime", "direction", "entryPrice", "exitTime", "exitPrice", "netPnl", "exitReason", "fillMode", "sameCandleSl", "ambiguityReason"];
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
  chartDiagnostics,
  fullHistoryDataset,
  onApplyChart,
  onAnalyzeBacktest,
  onBacktestResult,
  onClearBacktest,
  onClose,
  onExitBacktestAnalysis,
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
  const [manualActionResult, setManualActionResult] = useState(null);
  const [manualMessage, setManualMessage] = useState("");
  const [manualForm, setManualForm] = useState({
    positionId: "",
    positionSide: "",
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
  const fullLoadedDays = useMemo(
    () => daysFromCandles(fullHistoryDataset ?? [], selectedInterval),
    [fullHistoryDataset, selectedInterval],
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
    const hardCap = sweepForm.sweepAdvancedCapacity ? SWEEP_MAX_COMBINATIONS : SWEEP_DEFAULT_COMBINATIONS;
    const cap = Math.min(hardCap, Math.max(1, Number(sweepForm.maxCombinations) || SWEEP_DEFAULT_COMBINATIONS));

    try {
      const manualSweepForm = { ...sweepForm, mode: "manual" };
      const combinations = buildSweepCombinations({ baseDeck: null, baseMmDeck: null, form: manualSweepForm });
      return {
        cap,
        count: combinations.length,
        error: "",
        hardCap,
        needsAdvanced: combinations.length > SWEEP_DEFAULT_COMBINATIONS && !sweepForm.sweepAdvancedCapacity,
        warning: combinations.length > SWEEP_DEFAULT_COMBINATIONS
          ? `This sweep has ${combinations.length} combinations. Above ${SWEEP_DEFAULT_COMBINATIONS}, use Advanced capacity and keep the browser focused until it finishes.`
          : "",
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

  async function refreshLiveStatus({ fresh = false } = {}) {
    const suffix = fresh ? "?fresh=1" : "";
    const [nextLivestream, nextAccounts, nextSystem] = await Promise.all([
      apiFetch(`/livestream${suffix}`),
      apiFetch(`/accounts/profiles${suffix}`),
      apiFetch("/system/status"),
    ]);
    setLivestream(nextLivestream);
    setAccountProfiles(nextAccounts);
    setSystem(nextSystem);
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
      return runAction(`position-card-${action}`, action === "MOVE_SL" ? "Move SL" : action === "MOVE_TP" ? "Move TP" : "Send manual action", async () => {
        if (values.confirm && !window.confirm(values.confirmMessage ?? "Send this manual action for the displayed BingX position?")) {
          throw new Error("Manual action cancelled.");
        }
        await apiFetch("/execution/crisis/on", { method: "POST" });
        setManualActionResult(null);
        setManualMessage("Request sent to BingX...");
        let response;

        try {
          response = await apiFetchDetailed("/manual/action", {
            body: {
              ...nextForm,
              action,
              stopPrice: values.stopPrice ?? nextForm.stopPrice,
              takeProfitPrice: values.takeProfitPrice ?? nextForm.takeProfitPrice,
            },
            method: "POST",
          });
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

  async function runSweepBacktest() {
    const manualSweepForm = { ...sweepForm, mode: "manual" };
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
        setSweepResults(rankSweepRows(rows).slice(0, 50));
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
    setSweepResults(ranked.slice(0, 50));
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
          onRefresh={() => runAction("refresh-live", "Refresh live stream", () => refreshLiveStatus({ fresh: true }))}
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
          chartDiagnostics={chartDiagnostics}
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
          onAnalyze={() => runAction("analyze-backtest", "Analyze on Chart", () => analyzeCurrentBacktest())}
          onClear={() => runAction("clear-backtest", "Clear result", async () => {
            setBacktestResult(null);
            onClearBacktest();
          })}
          onExitAnalysis={() => runAction("exit-backtest-analysis", "Exit analysis", async () => {
            onExitBacktestAnalysis();
          })}
          onViewTrade={(trade) => runAction("view-backtest-trade", "View trade on chart", () => analyzeCurrentBacktest(trade))}
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

function LivestreamPanel({ accountProfiles = [], livestream, manualMessage, manualResult, onPositionAction, onRefresh }) {
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
      {manualMessage && (
        <MiniStatus tone={manualResult?.ok === false ? "bad" : manualResult?.ok === true ? "good" : "neutral"}>
          {manualMessage}
        </MiniStatus>
      )}
      {manualResult && (
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
            const key = `${position.symbol}-${position.side}-${position.apiProfile}-${position.positionId ?? ""}`;
            const controls = positionControls[key] ?? {};
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
                  disabled={!Number.isFinite(Number(slValue)) || Number(slValue) <= 0}
                  onClick={() => onPositionAction(position, "MOVE_SL", { direct: true, stopPrice: slValue })}
                >
                  Move SL
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
                  disabled={!Number.isFinite(Number(tpValue)) || Number(tpValue) <= 0}
                  onClick={() => onPositionAction(position, "MOVE_TP", { direct: true, takeProfitPrice: tpValue })}
                >
                  Move TP
                </button>
                <button
                  type="button"
                  onClick={() => onPositionAction(position, "CLOSE_POSITION", {
                    confirm: true,
                    confirmMessage: `Close ${position.symbol} ${position.side} position ${position.positionId ?? ""}?`,
                    direct: true,
                  })}
                >
                  Close Position
                </button>
                <button type="button" onClick={onRefresh}>Force Sync</button>
              </div>
              <div className="hubert-lab__actions">
                <button
                  type="button"
                  disabled={(position.attachedOrders ?? []).length === 0}
                  onClick={() => onPositionAction(position, "CANCEL_ATTACHED_ORDERS", {
                    confirm: true,
                    confirmMessage: `Cancel attached protective/orders for ${position.symbol} ${position.side}?`,
                    direct: true,
                  })}
                >
                  Cancel Protection/Orders
                </button>
                <button type="button" onClick={() => onPositionAction(position, null)}>Crisis Control</button>
              </div>
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
  onViewTrade,
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
                <button type="button" onClick={onExitAnalysis}>Exit Analysis</button>
                <button type="button" onClick={onClear}>Clear Result</button>
              </div>
            </div>
          )}
          <BacktestResult result={result} onViewTrade={onViewTrade} />
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
      <MiniStatus>Manual Sweep ignores saved Strategy/MM Deck values. It fetches its own Binance Futures historical range and never draws chart overlays during the sweep.</MiniStatus>
      <MiniStatus tone="good">Active sizing source: Manual Sweep. Strategy/MM Decks do not override this sweep.</MiniStatus>
      <div className="hubert-lab__subhead"><strong>Historical Range Sweep</strong><span>independent data</span></div>
      <div className="hubert-lab__grid">
        <TextField label="Symbol" value={form.manualSymbol} onChange={(value) => setForm({ ...form, manualSymbol: value })} />
        <SelectField label="Timeframe" value={form.manualTimeframe} onChange={(value) => setForm({ ...form, manualTimeframe: value })} options={TIMEFRAMES.map((item) => [item.interval, item.label])} />
        <NumberField label="Last X days" min="1" value={form.manualLastDays} onChange={(value) => setForm({ ...form, manualLastDays: value })} />
        <NumberField label="Starting balance" min="1" value={form.manualStartingBalance} onChange={(value) => setForm({ ...form, manualStartingBalance: value })} />
        <SelectField label="Backtest Fill Mode" value={form.manualFillMode ?? "legacy"} onChange={(value) => setForm({ ...form, manualFillMode: value })} options={[
          ["legacy", "Current / Legacy"],
          ["conservative", "Conservative"],
        ]} />
        <TextField label="From date/time" value={form.manualFrom} onChange={(value) => setForm({ ...form, manualFrom: value })} />
        <TextField label="To date/time" value={form.manualTo} onChange={(value) => setForm({ ...form, manualTo: value })} />
      </div>
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
          : `Combinations ready: ${preview?.count ?? 0} / ${preview?.cap ?? SWEEP_DEFAULT_COMBINATIONS}${preview?.tooMany ? ". Narrow ranges or raise the Advanced cap." : "."}`}
      </MiniStatus>
      {preview?.warning && <MiniStatus tone={preview?.tooMany ? "bad" : "neutral"}>{preview.warning}</MiniStatus>}
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
  return `${symbol} · source ${params.source ?? "default"} · fill ${fillModeLabel(params.fillMode ?? row.fillMode)} · ATR length ${params.atrLength ?? "--"} · ${params.sizeLabel ?? "Sizing"} ${params.sizeValue ?? "--"} · mode ${params.sizingMode ?? "--"}`;
}

function sweepHeaderSizingText(row) {
  const params = row?.params ?? {};
  const riskText = params.riskPercent === null || params.riskPercent === undefined ? "--" : `${fmt(params.riskPercent, 2)}%`;
  const positionText = params.positionPercent === null || params.positionPercent === undefined ? "--" : `${fmt(params.positionPercent, 2)}%`;
  return `Sizing: ${sweepSizingShortText(row)} · Fixed Risk target: ${riskText} · Position Percent: ${positionText}`;
}

function SweepResultTable({ onOpenResult, results }) {
  if (!results?.length) {
    return <MiniStatus>No sweep results yet. Run a sweep to rank parameter sets.</MiniStatus>;
  }
  const firstResult = results[0];

  return (
    <div className="hubert-lab__section">
      <MiniStatus>
        Sweep used {firstResult.candlesUsed ?? "--"} candles on {firstResult.params?.timeframe ?? "--"} from {firstResult.dataDiagnostics?.provider ?? "binance-futures"}.
        {firstResult.analysisRange ? ` Range: ${dateText(firstResult.analysisRange.from)} to ${dateText(firstResult.analysisRange.to)}.` : ""}
      </MiniStatus>
      <MiniStatus>
        Fill Mode: {fillModeLabel(firstResult.fillMode ?? firstResult.params?.fillMode)} · ambiguous candles: {firstResult.ambiguousCandlesCount ?? firstResult.ambiguity?.ambiguousCandlesCount ?? 0} · conservative-adjusted trades: {firstResult.conservativeAdjustedTrades ?? firstResult.ambiguity?.conservativeAdjustedTrades ?? 0} · skipped entries: {firstResult.conservativeSkippedEntries ?? firstResult.ambiguity?.conservativeSkippedEntries ?? 0}
      </MiniStatus>
      <MiniStatus>{sweepHeaderSizingText(firstResult)}</MiniStatus>
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
      </div>
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
            <Metric label="Position ID" value={positionIdentifier(activePosition) ?? "BingX did not provide one"} />
            <Metric label="Position side" value={activePosition.positionSide ?? activePosition.side ?? "--"} />
            <Metric label="PnL" value={fmt(activePosition.unrealizedPnl)} />
            <Metric label="SL" value={fmt(activePosition.stopLoss)} />
            <Metric label="TP" value={fmt(activePosition.takeProfit)} />
          </div>
          <OrderTable orders={activePosition.attachedOrders ?? []} />
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

function AiAgentPanel({ aiStatus, apiRequest, onBacktestResult, onOpenAiBacktest, runAction, setActivePanel, setStrategyForm }) {
  const [prompt, setPrompt] = useState("Run a 50 combination sweep for SOLUSDT 15m over the last 31 days and rank robust settings.");
  const [chatMessages, setChatMessages] = useState([]);
  const [followUpText, setFollowUpText] = useState("");
  const [followUpState, setFollowUpState] = useState({ message: "", state: "idle" });
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
  const [queueStatus, setQueueStatus] = useState(null);
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  const [collapseAllChat, setCollapseAllChat] = useState(false);
  const [clearedChatAtByRun, setClearedChatAtByRun] = useState({});
  const [showRunHistory, setShowRunHistory] = useState(false);
  const activeRun = runs.find((run) => run.id === activeRunId) ?? runs[0] ?? null;
  const running = ["queued", "running"].includes(activeRun?.status);
  const activeRows = activeRun?.resultSummary?.topRows ?? [];
  const activeResult = activeRows[Math.min(activeResultIndex, Math.max(activeRows.length - 1, 0))] ?? activeRows[0] ?? null;
  const visibleChatMessages = useMemo(() => {
    const persisted = activeRun?.messages ?? [];
    const local = chatMessages.filter((message) => !activeRun?.id || !message.runId || message.runId === activeRun.id);
    const seen = new Set();
    const clearedAt = activeRun?.id ? Date.parse(clearedChatAtByRun[activeRun.id] ?? 0) : 0;
    return [...persisted, ...local]
      .filter((message) => !clearedAt || Date.parse(message.time ?? 0) > clearedAt)
      .filter((message) => {
        const key = `${message.role}|${message.time}|${message.text}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((left, right) => Date.parse(left.time ?? 0) - Date.parse(right.time ?? 0));
  }, [activeRun?.id, activeRun?.messages, chatMessages, clearedChatAtByRun]);
  const olderChatMessages = visibleChatMessages.slice(0, Math.max(0, visibleChatMessages.length - 6));
  const recentChatMessages = visibleChatMessages.slice(-6);
  const examples = [
    "Find robust SOLUSDT 15m settings for the last 2 years and reject overfit configs.",
    "Run 1000 sweep combinations for SOLUSDT 15m over the last 2 years and give me the 5 best robust settings.",
    "Compare Legacy vs Conservative fill mode across 15m, 30m and 1H.",
    "Find the best MM sizing settings for Q1 2025 only.",
    "Analyze why this strategy performs worse on 1H than 15m.",
    "Prepare a report and export it to CSV and JSON.",
  ];

  async function loadRuns() {
    const payload = await apiRequest("/ai/agent/runs");
    setRuns(payload.runs ?? []);
    setQueueStatus(payload.queue ?? null);
    if (!activeRunId && payload.runs?.[0]) setActiveRunId(payload.runs[0].id);
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
          },
          prompt,
        },
        method: "POST",
      });
      await loadRuns();
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
      downloadText(payload.fileName, payload.content, payload.mime);
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

  function clearVisibleChat() {
    if (!activeRun?.id) {
      setChatMessages([]);
      return;
    }
    const now = new Date().toISOString();
    setClearedChatAtByRun((current) => ({ ...current, [activeRun.id]: now }));
    setChatMessages((current) => current.filter((message) => message.runId !== activeRun.id));
  }

  function startNewChat() {
    clearVisibleChat();
    setPrompt("");
    setFollowUpText("");
    setCollapseAllChat(false);
  }

  async function askFollowUp(message = followUpText, row = null) {
    return runAction("ai-agent-follow-up", "Ask copilot", async () => {
      if (!message.trim()) throw new Error("Ask a follow-up first.");
      if (!activeRun?.id && copilotMode === "research") throw new Error("Open an AI run before asking a follow-up.");
      const runId = activeRun?.id ?? "platform-evidence";
      const contextRow = row ?? activeResult;
      const userMessage = { role: "user", runId, text: message.trim(), time: new Date().toISOString() };
      setFollowUpState({ message: "Thinking with the active run context...", state: "thinking" });
      setChatMessages((current) => [...current, userMessage]);
      try {
        const payload = await apiRequest("/ai/agent/chat", {
          body: {
            message: message.trim(),
            mode: copilotMode,
            rowId: contextRow?.id,
            rowIndex: contextRow?.rank ? Number(contextRow.rank) - 1 : undefined,
            ...(activeRun?.id ? { runId: activeRun.id } : {}),
          },
          method: "POST",
        });
        if (!payload.ok) {
          throw new Error(payload.message ?? "The backend did not generate a follow-up response.");
        }
        setFollowUpState({ message: "Rendering response...", state: "responding" });
        setChatMessages((current) => [
          ...current,
          {
            confidence: payload.response?.confidence,
            critique: payload.response?.critique,
            evidence: payload.response?.evidence ?? [],
            platformEvidence: payload.response?.platformEvidence,
            risk: payload.response?.risk,
            role: "assistant",
            row: payload.response?.row,
            runId,
            sections: payload.response?.sections ?? [],
            text: payload.response?.answer ?? "No answer came back.",
            time: new Date().toISOString(),
            verifiedFrom: payload.response?.verifiedFrom,
          },
        ]);
        setFollowUpText("");
        if (activeRun?.id) {
          await loadRuns();
          setChatMessages((current) => current.filter((item) => item.runId !== runId || item.localOnly));
        }
        setFollowUpState({ message: "Follow-up answered.", state: "completed" });
        window.setTimeout(() => setFollowUpState((current) => (
          current.state === "completed" ? { message: "", state: "idle" } : current
        )), 1400);
        return payload;
      } catch (error) {
        const messageText = humanError(error);
        setFollowUpState({ message: messageText, state: "failed" });
        setChatMessages((current) => [
          ...current,
          {
            evidence: ["The backend did not return a usable follow-up response."],
            role: "assistant",
            runId,
            text: `Follow-up failed: ${messageText}`,
            time: new Date().toISOString(),
          },
        ]);
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
        body: { input, toolName },
        method: "POST",
      });
      setManualResult(payload);
      return payload;
    });
  }

  useEffect(() => {
    loadRuns().catch(() => {});
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
        <strong>{message.role === "user" ? "You" : "Copilot"}</strong>
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
      </>
    );

    if (shouldCollapse) {
      return (
        <details className="hubert-chat-message hubert-chat-message--collapsed" data-role={message.role} key={`${message.time}-${index}`}>
          <summary>{message.role === "user" ? "You" : "Copilot"} · {String(message.text ?? "").slice(0, 110)}</summary>
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
    <section className="hubert-lab__section">
      <div className="hubert-lab__subhead"><strong>AI Copilot Workspace</strong><span>analysis only</span></div>
      <MiniStatus tone={aiStatus?.connected ? "good" : aiStatus?.lastError ? "bad" : "neutral"}>
        {aiStatus?.message ?? "AI Agent runs through the backend. It cannot place orders."}
      </MiniStatus>
      <div className="hubert-lab__metrics">
        <Metric label="Provider" value={aiStatus?.provider ?? "mock"} />
        <Metric label="Model" value={aiStatus?.model ?? "not connected"} />
        <Metric label="Trading" value="Blocked for AI" />
      </div>
      <div className="hubert-lab__actions hubert-ai-mode">
        <button type="button" data-active={copilotMode === "research"} onClick={() => setCopilotMode("research")}>Research mode</button>
        <button type="button" data-active={copilotMode === "platform-diagnosis"} onClick={() => setCopilotMode("platform-diagnosis")}>Platform diagnosis mode</button>
        <button type="button" data-active={copilotMode === "code-evidence"} onClick={() => setCopilotMode("code-evidence")}>Code/data evidence mode</button>
      </div>
      <MiniStatus>
        {copilotMode === "research"
          ? "Research mode starts queued analysis jobs."
          : "Evidence mode answers from source files, routes, runtime state, and saved platform data. It is read-only."}
      </MiniStatus>

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
            {["thinking", "responding"].includes(followUpState.state) && (
              <div className="hubert-chat-message" data-role="assistant">
                <strong>Copilot</strong>
                <span>{followUpState.state === "thinking" ? "Thinking..." : "Responding..."}</span>
                <small>{followUpState.message}</small>
              </div>
            )}
          </div>
          <div className="hubert-chat-composer">
            <label>
              <span>Ask about current result</span>
              <textarea
                placeholder={activeRun?.id || copilotMode !== "research" ? "Ask a follow-up, for example: trace the Move SL button." : "Open or run research before asking about a result."}
                value={followUpText}
                onChange={(event) => setFollowUpText(event.target.value)}
              />
            </label>
            <div className="hubert-lab__actions">
              <button type="button" disabled={(copilotMode === "research" && !activeRun?.id) || ["thinking", "responding"].includes(followUpState.state)} onClick={() => askFollowUp(followUpText)}>
                {copilotMode === "research" ? "Ask About Current Result" : "Ask with Evidence"}
              </button>
              <button type="button" disabled={(copilotMode === "research" && !activeRun?.id) || ["thinking", "responding"].includes(followUpState.state)} onClick={() => askFollowUp(copilotMode === "research" ? "Give me a deep analysis of the current result: strengths, weaknesses, overfit risk, confidence, and exact next tests." : "Answer from platform evidence: inspect files, routes, runtime state, unknowns, and verification steps.", activeResult)}>Deep Analysis</button>
              <button type="button" onClick={startNewChat}>Start New Chat</button>
            </div>
          </div>
          <details className="hubert-advanced">
            <summary>Start new research job</summary>
            <label>
            <span>New research command</span>
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} />
            </label>
          </details>
          {followUpState.state !== "idle" && (
            <MiniStatus tone={followUpState.state === "failed" ? "bad" : followUpState.state === "completed" ? "good" : "neutral"}>
              Follow-up: {followUpState.state}. {followUpState.message}
            </MiniStatus>
          )}
          <div className="hubert-lab__actions">
            <button type="button" onClick={startRun}>{copilotMode === "research" ? "Run Research" : "Ask from Platform Evidence"}</button>
            <button type="button" onClick={() => runAction("ai-agent-refresh", "Refresh agent runs", loadRuns)}>Refresh</button>
            {running && <button type="button" onClick={() => cancelRun(activeRun.id)}>Cancel</button>}
            {["interrupted", "stalled", "cancelled", "failed"].includes(activeRun?.status) && (
              <button type="button" onClick={() => restartRun(activeRun.id)}>Restart Same Prompt</button>
            )}
          </div>
        </div>
        <aside className="hubert-live-card">
          <div className="hubert-lab__subhead"><strong>Run Context</strong><span>{activeRun?.id?.slice(-6) ?? "none"}</span></div>
          <ReadOnly label="Symbol" value={activeRun?.plan?.symbol ?? "SOLUSDT"} />
          <ReadOnly label="Timeframe" value={(activeRun?.plan?.timeframes ?? [activeRun?.plan?.timeframe ?? "15m"]).join(", ")} />
          <ReadOnly label="Provider" value={activeRun?.plan?.provider ?? "binance-futures"} />
          <ReadOnly label="Range" value={activeRun?.plan?.range ? `${dateText(activeRun.plan.range.from)} → ${dateText(activeRun.plan.range.to)}` : "Latest"} />
          <ReadOnly label="Capital" value={`${fmt(activeRun?.plan?.startingBalance ?? 10000)} USDT`} />
          <ReadOnly label="Sizing" value={activeRun?.plan?.sizingMode ?? "position-percent"} />
          <ReadOnly label="Fill" value={activeRun?.plan?.fillMode ?? "legacy"} />
        </aside>
      </div>

      <details className="hubert-advanced">
        <summary>Examples and advanced limits</summary>
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

      {activeRun && (
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
            </div>
          )}
        </article>
      )}

      {showRunHistory && (
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

      <details className="hubert-advanced">
        <summary>Manual backend tools</summary>
        <div className="hubert-ai-actions">
          <button type="button" onClick={() => callManualTool("explainCurrentSetup")}>Explain current setup</button>
          <button type="button" onClick={() => callManualTool("getPlatformStatus")}>Platform status</button>
          <button type="button" onClick={() => callManualTool("summarizeBacktest")}>Latest backtest</button>
          <button type="button" onClick={() => callManualTool("createAlertDraft", { condition: "live data stale over 60 seconds", name: "Data freshness watch" })}>Create alert draft</button>
        </div>
        {manualResult && <pre className="hubert-ai-json">{JSON.stringify(manualResult, null, 2).slice(0, 12000)}</pre>}
      </details>
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
      downloadText(payload.fileName, payload.content, payload.mime);
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
  const groups = ["Strategy Decks", "MM Decks", "Battle Decks", "Backtests", "Analytics Reports"];
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

function BacktestResult({ onViewTrade, result }) {
  const audit = useMemo(() => sizingAudit(result?.trades ?? []), [result?.trades]);
  const displayEquityCurve = useMemo(() => equityCurveForResult(result), [result]);
  const curveStats = useMemo(() => equityStats(displayEquityCurve), [displayEquityCurve]);
  const equityPoints = useMemo(() => equityPolyline(displayEquityCurve), [displayEquityCurve]);
  const drawdownPoints = useMemo(() => drawdownPolyline(displayEquityCurve), [displayEquityCurve]);
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
        <Metric label="Expectancy" value={fmt(metrics.expectancy)} />
        <Metric label="Average trade" value={fmt(metrics.averageTrade)} />
        <Metric label="Best trade" value={fmt(metrics.largestWin)} />
        <Metric label="Worst trade" value={fmt(metrics.largestLoss)} />
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
        footer={`${dateText(curveStats.from)} → ${dateText(curveStats.to)} · y-axis ${fmt(curveStats.min)} to ${fmt(curveStats.highWater)} USDT`}
        yLabel="Account equity (USDT)"
        points={equityPoints}
      />
      <SingleCurveChart
        title="Drawdown Curve"
        caption={`Drawdown from high-water mark. Max preview drawdown ${fmt(curveStats.maxDrawdownPercent)}%.`}
        footer={`${dateText(curveStats.from)} → ${dateText(curveStats.to)} · y-axis 0% to ${fmt(curveStats.maxDrawdownPercent)}%`}
        yLabel="Drawdown (%)"
        points={drawdownPoints}
        drawdown
      />
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
        <button type="button" onClick={() => exportJson(`${result.name ?? "backtest"}.json`, result)}>Export JSON</button>
        <button type="button" onClick={() => exportCsv(`${result.name ?? "backtest"}-trades.csv`, result.trades)}>Export CSV</button>
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

function SingleCurveChart({ caption, drawdown = false, footer = "", points, title, yLabel = "Value" }) {
  return (
    <div className="hubert-chart-box">
      <strong>{title}</strong>
      <span>{caption}</span>
      <div className="hubert-chart-axis">
        <span>Y: {yLabel}</span>
        <span>X: date/time</span>
      </div>
      <svg className={`hubert-lab__equity${drawdown ? " hubert-lab__equity--drawdown" : ""}`} viewBox="0 0 100 100" preserveAspectRatio="none">
        <polyline points={points} />
      </svg>
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
            <tr><th>Time</th><th>Side</th><th>Sizing</th><th>Fill</th><th>Ambiguity</th><th>Capital</th><th>Size</th><th>Lev</th><th>SL dist</th><th>SL loss</th><th>Cap</th><th>PnL</th><th>Chart</th></tr>
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

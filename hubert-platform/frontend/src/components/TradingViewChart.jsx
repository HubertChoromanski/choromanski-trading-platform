import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  CrosshairMode,
  LineSeries,
  createChart,
  createSeriesMarkers,
} from "lightweight-charts";
import { createSolKlineSocket, fetchHistoricalCandles } from "../api/binance";
import {
  STRATEGY_EVENT_TYPES,
  evaluateChoromanskiStrategy,
  filterStrategyEvents,
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

function positionSide(position = {}) {
  const raw = String(position.positionSide ?? position.side ?? position.direction ?? "").toUpperCase();
  if (raw.includes("LONG")) return "LONG";
  if (raw.includes("SHORT")) return "SHORT";
  const amount = Number(position.positionAmt ?? position.positionAmount ?? position.quantity ?? 0);
  return amount < 0 ? "SHORT" : "LONG";
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
  return ["accepted", "placed", "new", "partially_filled", "pending_sync"].includes(String(status ?? "").toLowerCase());
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
    "cancel_failed",
  ].includes(String(status ?? "").toLowerCase());
}

function classifyMarkerReality({ activeAnalysisSession, markerSource, selectedHistoricalWindow }) {
  if (activeAnalysisSession) {
    return {
      label: "SIMULATED BACKTEST TRADE",
      note: "Backtest markers are simulated analysis objects, not exchange positions.",
      tone: "simulated",
    };
  }
  if (selectedHistoricalWindow?.mode === "historical" || String(markerSource ?? "").includes("historical")) {
    return {
      label: "HISTORICAL MARKER",
      note: "This setup exists in chart history only. The bot may not have been online or armed then.",
      tone: "stale",
    };
  }
  return {
    label: "SIMULATED ENTRY",
    note: "Chart strategy markers show calculated signals. Live execution requires the Sztab runner and BingX order state.",
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
    text: item.message ?? item.status ?? "Trigger order update",
  }));
  const setup = runtime.latestSetupEvent
    ? [{
        time: runtime.latestSetupEvent.time,
        text: `${runtime.latestSetupEvent.direction ?? ""} setup observed (${runtime.latestSetupEvent.setupId ?? "no id"})`,
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
  const side = item.side ? ` ${item.side}` : "";
  switch (item.event) {
    case "order_accepted":
      return `BingX accepted${side} trigger order${setup}${trigger}.`;
    case "order_terminal":
      return `Exchange ended trigger order${setup}: ${item.reason ?? item.status ?? "terminal"}.`;
    case "order_missing":
      return `Trigger order${setup} is missing on exchange.`;
    case "order_canceled":
      return `Pending trigger${setup} canceled: ${item.reason ?? "operator/replacement"}.`;
    case "fill_detected_sl_placed":
      return `Position fill detected${setup}; SL protection requested.`;
    case "fill_detected_sl_failed":
      return `Position fill detected${setup}; SL placement failed.`;
    case "filled_but_position_missing":
      return `Exchange reports fill${setup}, but no live position was found.`;
    case "risk_blocked":
      return `Risk blocked setup${setup}: ${item.reason ?? "risk manager"}.`;
    case "order_rejected":
      return `BingX rejected trigger order${setup}: ${item.reason ?? "exchange rejection"}.`;
    default:
      return `${item.event ?? item.status ?? "Runtime update"}${setup}${trigger}.`;
  }
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
  const triggerPrice = Number(pending?.triggerPrice ?? setup?.trigger);
  const side = pending?.direction ?? setup?.direction ?? positionSide(livePosition ?? {});
  const blockedReason = runtime.lastBlockedReason || pending?.terminalReason || pending?.failureClassification || runtime.lastDecisionReason || "";
  const base = {
    detail: runtime.lastDecision || runtime.lastDecisionReason || markerReality.note,
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
    const protectionActive = Number(livePosition.stopLoss) > 0 || (livePosition.attachedOrders ?? []).length > 0 || runtime.slPlacementStatus === "placed";
    return {
      ...base,
      detail: protectionActive ? "Live exchange position exists and protection is visible." : "Live exchange position exists but SL/protection is missing.",
      headline: `${positionSide(livePosition)} position active`,
      rows: [
        ["Entry", formatChartPrice(positionEntry(livePosition))],
        ["SL", formatChartPrice(livePosition.stopLoss)],
        ["PnL", formatChartPnl(positionPnl(livePosition))],
        ["Qty", formatChartPrice(positionAmount(livePosition))],
      ],
      tags: [
        { label: "LIVE POSITION", tone: "live" },
        { label: protectionActive ? "SL placed correctly" : "Live protection missing (critical)", tone: protectionActive ? "live" : "critical" },
      ],
      tone: protectionActive ? "live" : "critical",
      visualObjects: [{ label: "LIVE POSITION", note: "Position comes from live BingX account state.", tone: "live" }],
    };
  }

  if (status === "interrupted" || status === "error" || status === "recovering") {
    return {
      ...base,
      headline: status === "recovering" ? "Runner recovering" : "Runner interrupted, no live execution",
      rows: [
        ["Runtime", runtime.watchdogStatus ?? status],
        ["Last error", runtime.error || runtime.lastError || "--"],
      ],
      tags: [
        { label: status === "error" ? "EXCHANGE/RUNNER FAILED" : "BOT OFFLINE AT SIGNAL", tone: "critical" },
        { label: markerReality.label, tone: markerReality.tone },
      ],
      tone: "critical",
    };
  }

  if (status !== "running") {
    return {
      ...base,
      headline: "Bot offline for this interval",
      detail: "Sztab runner is not running, so chart markers are simulated/historical only.",
      rows: [
        ["Runtime", status || "stopped"],
        ["Last signal", setup?.setupId ? `${setup.direction} ${compactId(setup.setupId)}` : "--"],
      ],
      tags: [
        { label: "BOT OFFLINE AT SIGNAL", tone: "stale" },
        { label: markerReality.label, tone: markerReality.tone },
      ],
      tone: "stale",
    };
  }

  if (isActivePendingStatus(pendingStatus)) {
    return {
      ...base,
      headline: `${side ?? ""} setup armed`.trim() || "Setup armed",
      detail: "Exchange-side trigger order is armed; waiting for trigger touch/fill confirmation.",
      rows: [
        ["Trigger", formatChartPrice(triggerPrice)],
        ["Current chart price", formatChartPrice(currentPrice)],
        ["Pending order", pending?.orderId ? compactId(pending.orderId) : "--"],
        ["BingX status", runtime.lastExchangeStatus || pendingStatus],
      ],
      tags: [
        { label: "LIVE PENDING TRIGGER", tone: "pending" },
        { label: "Waiting for trigger touch", tone: "pending" },
      ],
      tone: "pending",
      visualObjects: [{ label: "LIVE PENDING TRIGGER", note: "Pending trigger order is local runtime plus BingX order status.", tone: "pending" }],
    };
  }

  if (pending && isTerminalExchangeStatus(pendingStatus)) {
    return {
      ...base,
      headline: pendingStatus === "filled_but_position_missing"
        ? "Fill reported, position missing"
        : "Trigger order failed on exchange",
      detail: pendingStatus === "filled_but_position_missing"
        ? "BingX reported executed quantity, but fresh sync did not find a matching position."
        : `Pending trigger is terminal: ${pending.terminalReason ?? pending.failureClassification ?? pendingStatus}.`,
      rows: [
        ["Last trigger", formatChartPrice(pending.triggerPrice)],
        ["Order", pending.orderId ? compactId(pending.orderId) : "--"],
        ["Exchange status", runtime.lastExchangeStatus || pending.exchangeTerminalStatus || pendingStatus],
        ["Executed qty", pending.executedQty ?? runtime.triggerOrderExecutedQty ?? "--"],
      ],
      tags: [
        { label: pendingStatus === "filled_but_position_missing" ? "LIVE POSITION UNKNOWN" : "EXCHANGE FAILED", tone: "critical" },
        { label: "Next setup can arm", tone: runtime.canArmNextSetup ? "live" : "critical" },
      ],
      tone: "critical",
      visualObjects: [{ label: "EXCHANGE FAILED", note: "Exchange returned a terminal trigger-order state.", tone: "critical" }],
    };
  }

  if (blockedReason.includes("risk") || blockedReason.includes("blocked") || pendingStatus === "risk_blocked") {
    return {
      ...base,
      headline: `${side ?? ""} setup blocked`.trim() || "Setup blocked",
      detail: blockedReason || "The runner rejected the setup before order placement.",
      rows: [
        ["Trigger", formatChartPrice(triggerPrice)],
        ["Current chart price", formatChartPrice(currentPrice)],
        ["Reason", blockedReason || "--"],
      ],
      tags: [{ label: "BLOCKED SETUP", tone: "blocked" }],
      tone: "blocked",
      visualObjects: [{ label: "BLOCKED SETUP", note: "Setup did not become an exchange order.", tone: "blocked" }],
    };
  }

  if (setup?.setupId) {
    return {
      ...base,
      headline: `Waiting for ${setup.direction ?? "next"} trigger/order`,
      detail: runtime.lastDecision || "A setup is visible in runner state, but no active exchange trigger is armed.",
      rows: [
        ["Setup", compactId(setup.setupId)],
        ["Trigger", formatChartPrice(setup.trigger)],
        ["Current chart price", formatChartPrice(currentPrice)],
      ],
      tags: [
        { label: "SIMULATED ENTRY", tone: "simulated" },
        { label: "No live trigger armed", tone: "stale" },
      ],
      tone: "neutral",
    };
  }

  return {
    ...base,
    headline: "No valid setup",
    detail: runtime.lastDecision || "Runner is healthy and waiting for the next benchmark/setup.",
    rows: [
      ["Runtime", runtime.watchdogStatus ?? "healthy"],
      ["Last candle", runtime.lastClosedCandleTime ? formatChartTime(runtime.lastClosedCandleTime) : "--"],
      ["Current chart price", formatChartPrice(currentPrice)],
    ],
    tags: [{ label: "Waiting for benchmark candle", tone: "neutral" }],
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
      aria-label="Live operational state"
    >
      <div className="hubert-operational-panel__head">
        <div>
          <strong>Operational state</strong>
          <span>Live vs simulated status for Sztab intervals</span>
        </div>
        <div>
          <button type="button" onClick={() => onToggleCompact?.()}>{compact ? "Expand" : "Compact"}</button>
          <button type="button" onClick={() => onDock?.(dock === "left" ? "right" : "left")}>Dock {dock === "left" ? "right" : "left"}</button>
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
            <strong>What the chart objects mean</strong>
            {(selected.visualObjects ?? []).map((item, index) => (
              <span data-tone={item.tone} key={`${item.label}-${index}`}>
                <b>{item.label}</b>
                <i>{item.note}</i>
              </span>
            ))}
          </div>

          <div className="hubert-operational-section">
            <strong>Readable timeline</strong>
            {(selected.timeline ?? []).length ? (selected.timeline ?? []).map((item, index) => (
              <span key={`${item.time ?? index}-${index}`}>
                <b>{formatChartTime(item.time)}</b>
                <i>{item.text}</i>
              </span>
            )) : (
              <span>
                <b>Now</b>
                <i>No setup/order lifecycle events have been recorded yet.</i>
              </span>
            )}
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

function normalizeBackendUrl(value) {
  const normalized = String(value || "").replace(/\/+$/u, "");
  return normalized.endsWith("/api") ? normalized : `${normalized}/api`;
}

const BACKEND_URL = normalizeBackendUrl(
  import.meta.env.VITE_BACKEND_URL ?? (import.meta.env.PROD ? "/api" : "http://127.0.0.1:8787"),
);
const DASHBOARD_TOKEN = import.meta.env.VITE_DASHBOARD_TOKEN ?? "";

async function apiFetch(path) {
  const response = await fetch(`${BACKEND_URL}${path}`, {
    headers: DASHBOARD_TOKEN ? { "x-dashboard-token": DASHBOARD_TOKEN } : {},
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
    markerSource: "No markers rendered yet",
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
    const intervals = (sztabTelemetry?.config?.intervals ?? {});
    return Object.fromEntries(
      timeframes
        .filter((item) => item.interval !== "4h")
        .map((item) => [
          item.interval,
          deriveOperationalState({
            activeAnalysisSession,
            config: intervals[item.interval] ?? {},
            currentPrice: currentChartPrice,
            interval: item.interval,
            livestream: livestreamTelemetry,
            markerSource: chartRenderStats.markerSource,
            runtime: sztabTelemetry?.intervals?.[item.interval]?.runtime ?? intervals[item.interval]?.runtime ?? {},
            selectedHistoricalWindow,
          }),
        ]),
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
  }, [indicatorSettingsByInterval, selectedInterval, settings]);

  const clearStrategyLines = useCallback(() => {
    if (!chartRef.current) {
      strategyLineSeriesRef.current = [];
      return;
    }

    strategyLineSeriesRef.current.forEach((series) => {
      chartRef.current?.removeSeries(series);
    });
    strategyLineSeriesRef.current = [];
  }, []);

  const addStrategySegment = useCallback(({ color, lineStyle = 0, lineWidth = 1, value, startTime, endTime, showLabel }) => {
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
      chartRef.current?.removeSeries(series);
    });
    liveOrderLineSeriesRef.current = [];
  }, []);

  const addLiveOrderSegment = useCallback(({ color, lineStyle = 0, title = "", value, startTime, endTime }) => {
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
      lineWidth: 2,
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

  const renderStrategyLines = useCallback(
    (events, candles) => {
      clearStrategyLines();

      if (!settings.showSl && !settings.showTrigger) {
        return;
      }

      events
        .filter(
          (event) =>
            event.type === STRATEGY_EVENT_TYPES.ENTRY_TRIGGERED ||
            (event.type === STRATEGY_EVENT_TYPES.SETUP_ACTIVE && settings.showBenchmarks) ||
            (event.type === STRATEGY_EVENT_TYPES.SETUP_INVALIDATED && settings.showNegated),
        )
        .slice(-MAX_STRATEGY_LINE_EVENTS)
        .forEach((event) => {
          if (!Number.isFinite(event.trigger) || !Number.isFinite(event.stopLoss)) {
            return;
          }

          const startIndex = event.benchmarkIndex ?? event.index;
          const triggerEndIndex = Math.min(startIndex + 6, candles.length - 1);
          const stopEndIndex = Math.min(startIndex + 8, candles.length - 1);
          const triggerEndTime = candles[triggerEndIndex]?.time ?? event.time;
          const stopEndTime = candles[stopEndIndex]?.time ?? event.time;
          const triggerColor = event.direction === "LONG" ? "#f5f5f5" : "#050505";
          const startTime = event.benchmarkTime ?? event.time;

          if (settings.showTrigger) {
            addStrategySegment({
              color: triggerColor,
              lineWidth: 1,
              value: event.trigger,
              startTime,
              endTime: triggerEndTime,
              showLabel: false,
            });
          }

          if (settings.showSl) {
            addStrategySegment({
              color: "rgba(120, 24, 24, 0.72)",
              lineStyle: 2,
              lineWidth: 1,
              value: event.stopLoss,
              startTime,
              endTime: stopEndTime,
              showLabel: true,
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
    (result, overlaySettings, candles = []) => {
      clearStrategyLines();

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
              showLabel: true,
	              startTime,
	              value: Number(trade.stopLoss),
	            });
	            if (rendered) linesRendered += 1;
	          }
	
	          if (Number.isFinite(Number(trade.takeProfit))) {
	            const rendered = addStrategySegment({
	              color: "rgba(245, 245, 245, 0.78)",
	              endTime,
              lineStyle: 2,
              lineWidth: 1,
              showLabel: true,
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

      if (mode.analysisResult) {
        const markers = sanitizeMarkers(
          labelMarkers(toBacktestAnalysisMarkers(mode.analysisResult, mode.overlaySettings, chartCandles), "BT SIM"),
          "backtest analysis markers",
        );
        strategyMarkersRef.current?.setMarkers(markers);
        const slTpLines = renderBacktestLines(mode.analysisResult, mode.overlaySettings, chartCandles);
        const visibleTrades = visibleBacktestTrades(mode.analysisResult, chartCandles).length;
        const debugMarkers = mode.overlaySettings?.showDebug
          ? markers.filter((marker) => String(marker.id ?? "").startsWith("analysis-debug")).length
          : 0;
        const totalTrades = mode.analysisResult?.trades?.length ?? 0;
		        setChartRenderStats({
		          cappedMarkers: Math.max(0, totalTrades - visibleTrades),
		          debugMarkers,
		          durationMs: Math.round(performance.now() - renderStartedAt),
              markerNote: "Backtest analysis markers are visual audit markers, not live executable signals.",
              markerSource: "backtest analysis marker",
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

	        const markerEvents = filterStrategyEvents(strategyEvents, renderSettings);
	        const cappedMarkerEvents = markerEvents.slice(-MAX_BACKTEST_CHART_MARKERS);
        const markerLabelPrefix = selectedHistoricalWindowRef.current?.mode === "historical" ? "HIST" : "SIM";
	        const strategyMarkers = sanitizeMarkers(labelMarkers(toStrategyMarkers(cappedMarkerEvents), markerLabelPrefix), "strategy markers");

	        strategyMarkersRef.current?.setMarkers(strategyMarkers);
	        renderStrategyLines(strategyEvents, closedCandles);
		        setChartRenderStats({
		          cappedMarkers: Math.max(0, markerEvents.length - cappedMarkerEvents.length),
		          debugMarkers: 0,
		          durationMs: Math.round(performance.now() - renderStartedAt),
              markerNote: selectedHistoricalWindowRef.current?.mode === "historical"
                ? "Historical chart signals can be older than the live executable candle window."
                : "Latest chart markers are executable only when they occur on the latest closed candle or one candle back.",
              markerSource: selectedHistoricalWindowRef.current?.mode === "historical"
                ? "historical chart signal"
                : "live/latest chart signal window",
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
    [renderBacktestLines, renderStrategyLines, settings],
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
      try {
        const [status, livestream] = await Promise.all([
          apiFetch("/sztab/status"),
          apiFetch("/livestream?fresh=1").catch(() => null),
        ]);
        if (!ignore) {
          setSztabTelemetry(status);
          setLivestreamTelemetry(livestream);
        }
      } catch {
        if (!ignore) {
          setSztabTelemetry(null);
          setLivestreamTelemetry(null);
        }
      }
    }

    refreshSztabTelemetry();
    const intervalId = window.setInterval(refreshSztabTelemetry, 12_000);
    return () => {
      ignore = true;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    clearLiveOrderLines();
    const runtime = sztabTelemetry?.intervals?.[selectedInterval]?.runtime;
    const pending = runtime?.pendingTriggerOrder;
    const firstTime = rawCandles[0]?.time;
    const lastTime = rawCandles.at(-1)?.time;

    if (!runtime || !firstTime || !lastTime) return;

    if (pending && ["accepted", "placed", "new", "pending_sync"].includes(String(pending.status ?? "").toLowerCase())) {
      addLiveOrderSegment({
        color: pending.direction === "LONG" ? "rgba(21, 152, 112, 0.95)" : "rgba(182, 50, 66, 0.95)",
        endTime: lastTime,
        startTime: Math.max(firstTime, Number(pending.entryEvent?.benchmarkTime ?? pending.entryEvent?.time ?? firstTime)),
        title: "LIVE PENDING TRIGGER",
        value: pending.triggerPrice,
      });
    }

    if (pending?.stopLoss && ["filled_protected", "filled_sl_failed"].includes(String(pending.status ?? "").toLowerCase())) {
      addLiveOrderSegment({
        color: pending.status === "filled_protected" ? "rgba(255, 186, 73, 0.95)" : "rgba(255, 83, 83, 0.95)",
        endTime: lastTime,
        lineStyle: 2,
        startTime: Math.max(firstTime, Number(pending.fillDetectedAt ? Math.floor(new Date(pending.fillDetectedAt).getTime() / 1000) : firstTime)),
        title: pending.status === "filled_protected" ? "LIVE SL PROTECTION" : "SL PLACEMENT FAILED",
        value: pending.stopLoss,
      });
    }
  }, [addLiveOrderSegment, clearLiveOrderLines, rawCandles, selectedInterval, sztabTelemetry]);

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
        title="Double-click to center chart on current range"
      />

      <div className="hubert-window-panel" aria-label="Chart window controls">
        <strong>{dataDiagnostics.provider ?? "binance-futures"}</strong>
        <span>{rawCandles.length} rendered / {fullHistoryDataset.length || dataDiagnostics.fullCandles || 0} loaded</span>
        <span>{chartRenderStats.markers} markers · {chartRenderStats.slTpLines} lines · {chartRenderStats.durationMs}ms render</span>
        <span title={chartRenderStats.markerNote}>{chartRenderStats.markerSource}</span>
        <span>{selectedHistoricalWindow.mode === "historical" ? "Viewing historical window" : "Live/latest window"}</span>
        <span>Time: {DISPLAY_TIME_ZONE}</span>
        <div>
          <input
            aria-label="Jump to date"
            type="date"
            value={jumpDate}
            onChange={(event) => setJumpDate(event.target.value)}
          />
          <button type="button" onClick={jumpToHistoricalDate}>Jump</button>
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
        aria-label="Ruler percent tool"
      >
        %
      </button>

      <button
        className="hubert-reset-tool"
        onClick={resetChartView}
        type="button"
        aria-label="Reset chart view"
        title="Center chart on current backtest range and restore default zoom."
      >
        Reset View
      </button>

      {(isLoading || error) && (
        <div className="hubert-chart-state" role="status">
          {error || "Loading SOLUSDT Binance data"}
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
    <aside className="hubert-backtest-banner" aria-label="Backtest Analysis Mode">
      <div className="hubert-backtest-banner__head">
        <div>
          <strong>Backtest Analysis Mode</strong>
          <span>
            {session.strategyDeckName} · {session.mmDeckName} · {session.timeframe} · {tradeCount} trades
          </span>
          <span>Viewing historical window from backtest: {formatChartTime(range.from)} → {formatChartTime(range.to)}</span>
          <span>Full test range: {formatChartTime(fullRange.from)} → {formatChartTime(fullRange.to)}</span>
          <span>{session.candles?.length ?? 0} chart candles · {session.backtestCandles?.length ?? session.result?.candlesUsed ?? "--"} backtest candles</span>
          <span className={hasMismatch ? "hubert-backtest-banner__warning" : ""}>
            Trades in table: {tradeCount} · rendered on chart: {renderedCount}
          </span>
        </div>
        <div className="hubert-backtest-banner__actions">
          <button type="button" onClick={onAnalyze}>Analyze on Chart</button>
          <button type="button" onClick={onExit}>Exit Backtest Analysis</button>
        </div>
      </div>
      <div className="hubert-backtest-banner__toggles">
        {[
          ["showTrades", "Trades"],
          ["showSelectedTradeSlTp", "Selected trade SL/TP"],
          ["showPnlLabels", "PnL labels"],
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
          <summary>Advanced / Debug</summary>
          <label>
            <input checked={Boolean(overlaySettings.showExits)} type="checkbox" onChange={(event) => onToggle("showExits", event.target.checked)} />
            <span>Exit markers</span>
          </label>
          <label>
            <input checked={Boolean(overlaySettings.showVisibleTradeSlTp || overlaySettings.showSlTp)} type="checkbox" onChange={(event) => onToggle("showVisibleTradeSlTp", event.target.checked)} />
            <span>SL/TP for visible trades</span>
          </label>
          <label>
            <input checked={Boolean(overlaySettings.showDebug)} type="checkbox" onChange={(event) => onToggle("showDebug", event.target.checked)} />
            <span>Skipped/debug markers</span>
          </label>
          <span>
            Rendered: {renderStats?.renderedCandles ?? 0} candles · {renderStats?.markers ?? 0} markers · {renderStats?.slTpLines ?? 0} lines · {renderStats?.durationMs ?? 0}ms
          </span>
        </details>
      </div>
      {hasMismatch && (
        <div className="hubert-backtest-banner__warning">
          Chart markers are capped to keep zoom and pan responsive. The table remains the full record.
        </div>
      )}
      {hasEndTrade && (
        <div className="hubert-backtest-banner__warning">
          END means a trade was still open when the test range ended. It is not a live open position.
        </div>
      )}
      {overlaySettings.showDebug && (
        <div className="hubert-backtest-legend">
          <span><b />HA missing = Heikin Ashi confirmation missing</span>
          <span><b />Candidate = setup candidate checked</span>
          <span><b />In position = already in a trade/setup</span>
          <span><b />SL limiter = blocked by same-side SL limit</span>
          <span><b />MM invalid = sizing/money management invalid</span>
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

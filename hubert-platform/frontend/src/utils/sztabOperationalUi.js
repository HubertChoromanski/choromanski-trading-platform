import {
  CANONICAL_EVENT_SOURCES,
  CANONICAL_EVENT_TYPES,
} from "../events/canonicalEventStream.js";

export const DEFAULT_SHOW_DEBUG_OVERLAYS = false;
export const HISTORY_LIFECYCLE_LIMIT = 20;

function numericTime(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return value > 10_000_000_000 ? Math.round(value / 1000) : value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.round(parsed / 1000) : 0;
}

function safeRows(value) {
  return Array.isArray(value) ? value.filter((row) => row && typeof row === "object") : [];
}

function normalizeSide(value = "") {
  const text = String(value || "").toUpperCase();
  if (text.includes("LONG") || text === "BUY") return "LONG";
  if (text.includes("SHORT") || text === "SELL") return "SHORT";
  return text || "--";
}

function shortId(value = "") {
  const text = String(value || "");
  return text.length > 10 ? `${text.slice(0, 6)}...${text.slice(-3)}` : text;
}

function eventPriority(event = {}) {
  const order = {
    [CANONICAL_EVENT_TYPES.LIVE_PENDING_TRIGGER]: 60,
    [CANONICAL_EVENT_TYPES.ENTRY_TRIGGERED]: 50,
    [CANONICAL_EVENT_TYPES.SETUP_ACTIVE]: 40,
    [CANONICAL_EVENT_TYPES.SETUP_BLOCKED]: 30,
    [CANONICAL_EVENT_TYPES.SETUP_INVALIDATED]: 20,
    [CANONICAL_EVENT_TYPES.POSITION_EXITED]: 10,
  };
  return order[event.eventType] ?? 0;
}

export function selectVisibleChartEvents(events = [], mode = "live", showDebugOverlays = DEFAULT_SHOW_DEBUG_OVERLAYS) {
  const rows = safeRows(events);
  if (mode === "live") {
    return rows
      .filter((event) => event.source === CANONICAL_EVENT_SOURCES.LIVE_SZTAB && event.actionable)
      .sort((left, right) => {
        const timeDiff = numericTime(left.eventTime ?? left.candleOpenTime) - numericTime(right.eventTime ?? right.candleOpenTime);
        if (timeDiff !== 0) return timeDiff;
        return eventPriority(left) - eventPriority(right);
      })
      .slice(-1);
  }
  return showDebugOverlays ? rows : [];
}

function overlayPriority(line = {}) {
  const state = String(line.state || "");
  if (state === "live_confirmed") return 60;
  if (state === "active_live") return 50;
  if (state === "current_setup") return 40;
  if (state === "planned") return 30;
  return 0;
}

export function limitActiveOverlayLines(lines = [], mode = "live", showDebugOverlays = DEFAULT_SHOW_DEBUG_OVERLAYS) {
  const rows = safeRows(lines);
  if (mode !== "live" && showDebugOverlays) return rows;
  const selectedByType = new Map();
  for (const line of rows) {
    const type = String(line.type || "line");
    if (!["entry", "sl", "trigger", "tp"].includes(type)) continue;
    if (!["live_confirmed", "active_live", "current_setup", "planned"].includes(String(line.state || ""))) continue;
    const previous = selectedByType.get(type);
    if (!previous || overlayPriority(line) >= overlayPriority(previous)) {
      selectedByType.set(type, line);
    }
  }
  return [...selectedByType.values()].sort((left, right) => {
    const order = { entry: 0, trigger: 1, sl: 2, tp: 3 };
    return (order[left.type] ?? 9) - (order[right.type] ?? 9);
  });
}

function resultFromState(value = "") {
  const state = String(value || "").toUpperCase();
  if (["ENTRY_SENT", "ENTRY_CONFIRMED", "SL_SENT", "SL_CONFIRMED", "POSITION_OPEN"].includes(state)) return "ENTERED";
  if (["SETUP_INVALIDATED"].includes(state)) return "INVALIDATED";
  if (["POSITION_CLOSED"].includes(state)) return "CLOSED";
  if (["ERROR"].includes(state)) return "ERROR";
  if (["SETUP_SKIPPED"].includes(state)) return "SKIPPED";
  return "";
}

function resultFromJournal(row = {}) {
  const text = String(row.status ?? row.event ?? row.type ?? row.message ?? row.reason ?? "").toLowerCase();
  if (text.includes("filled") || text.includes("entry") || text.includes("market_order_sent")) return "ENTERED";
  if (text.includes("invalidated")) return "INVALIDATED";
  if (text.includes("closed") || text.includes("cancelled") || text.includes("canceled")) return "CLOSED";
  if (text.includes("failed") || text.includes("error") || text.includes("rejected")) return "ERROR";
  if (text.includes("skipped") || text.includes("blocked")) return "SKIPPED";
  return "SKIPPED";
}

function lifecycleRow(row = {}, fallback = {}) {
  const stateResult = resultFromState(row.state);
  const result = stateResult || resultFromJournal(row);
  return {
    orderId: row.orderId ?? row.triggerOrderId ?? row.protectionOrderId ?? fallback.orderId ?? "",
    reason: row.reasonCode ?? row.reason ?? row.failureClassification ?? row.status ?? row.event ?? row.message ?? fallback.reason ?? "",
    result,
    setupId: shortId(row.setupId ?? fallback.setupId ?? ""),
    side: normalizeSide(row.side ?? row.direction ?? row.positionSide ?? fallback.side),
    time: row.timestamp ?? row.time ?? row.createdAt ?? row.updatedAt ?? fallback.time ?? "",
  };
}

export function lifecycleHistoryRows(runtime = {}, limit = HISTORY_LIFECYCLE_LIMIT) {
  const rows = [
    ...safeRows(runtime.executionTransitionLog).map((row) => lifecycleRow(row)),
    ...safeRows(runtime.currentDecisionTimeline).map((row) => lifecycleRow(row, {
      reason: row.text,
      setupId: runtime.currentSetupId ?? runtime.latestSetupEvent?.setupId,
      side: runtime.latestSetupEvent?.direction,
    })),
    ...safeRows(runtime.currentSetupOrderJournal).map((row) => lifecycleRow(row)),
    ...safeRows(runtime.historicalSetupOrderJournal).map((row) => lifecycleRow(row)),
    ...safeRows(runtime.setupOrderJournal).map((row) => lifecycleRow(row)),
    ...safeRows(runtime.pendingTriggerOrder?.orderLifecycle).map((row) => lifecycleRow(row, {
      orderId: runtime.pendingTriggerOrder?.orderId,
      setupId: runtime.pendingTriggerOrder?.setupId,
      side: runtime.pendingTriggerOrder?.direction ?? runtime.pendingTriggerOrder?.positionSide,
    })),
  ];
  const unique = new Map();
  for (const row of rows) {
    if (!row.time && !row.reason && !row.setupId && !row.orderId) continue;
    unique.set([
      numericTime(row.time),
      row.result,
      row.setupId,
      row.orderId,
      row.reason,
    ].join(":"), row);
  }
  return [...unique.values()]
    .sort((left, right) => numericTime(right.time) - numericTime(left.time))
    .slice(0, limit);
}

export const CANONICAL_EVENT_SOURCES = {
  BACKTEST: "backtest",
  CHART_SIMULATION: "chart_simulation",
  LIVE_SZTAB: "live_sztab",
};

export const CANONICAL_EVENT_TYPES = {
  BENCHMARK_CONFIRMED: "BENCHMARK_CONFIRMED",
  ENTRY_TRIGGERED: "ENTRY_TRIGGERED",
  LIVE_EXECUTION: "LIVE_EXECUTION",
  LIVE_PENDING_TRIGGER: "LIVE_PENDING_TRIGGER",
  POSITION_EXITED: "POSITION_EXITED",
  SETUP_ACTIVE: "SETUP_ACTIVE",
  SETUP_BLOCKED: "SETUP_BLOCKED",
  SETUP_INVALIDATED: "SETUP_INVALIDATED",
};

const STRATEGY_EVENT_TYPES_FOR_CANONICAL = new Set([
  CANONICAL_EVENT_TYPES.BENCHMARK_CONFIRMED,
  CANONICAL_EVENT_TYPES.ENTRY_TRIGGERED,
  CANONICAL_EVENT_TYPES.POSITION_EXITED,
  CANONICAL_EVENT_TYPES.SETUP_ACTIVE,
  CANONICAL_EVENT_TYPES.SETUP_BLOCKED,
  CANONICAL_EVENT_TYPES.SETUP_INVALIDATED,
]);

export function canonicalDirection(...values) {
  for (const value of values) {
    const text = String(value || "").toUpperCase();
    if (text.includes("LONG") || text === "BUY") return "LONG";
    if (text.includes("SHORT") || text === "SELL") return "SHORT";
  }
  return "";
}

export function canonicalIntervalSeconds(interval = "15m") {
  const text = String(interval || "15m").toLowerCase();
  if (text.endsWith("h")) return Math.max(1, Number.parseInt(text, 10) || 1) * 3600;
  if (text.endsWith("m")) return Math.max(1, Number.parseInt(text, 10) || 15) * 60;
  return 15 * 60;
}

export function canonicalTimeSeconds(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" || (typeof value === "string" && /^-?\d+(\.\d+)?$/u.test(value.trim()))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return numeric > 10_000_000_000 ? Math.round(numeric / 1000) : Math.round(numeric);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.round(parsed / 1000) : null;
}

export function canonicalEventId(event = {}) {
  return [
    event.source ?? "unknown",
    event.interval ?? "",
    event.eventType ?? "",
    event.fingerprint ?? "",
    event.setupId ?? "",
    event.candleOpenTime ?? "",
    event.eventTime ?? "",
  ].join(":");
}

function stableNumber(value, decimals = 8) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "";
  return Number(numeric.toFixed(decimals));
}

function stableHash(input) {
  const text = JSON.stringify(input);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function fallbackFingerprint({ event = {}, interval, source, strategyParameters = {}, symbol }) {
  return `cf_${stableHash({
    benchmarkTime: stableNumber(event.benchmarkTime ?? event.time, 0),
    direction: canonicalDirection(event.direction, event.positionSide, event.side),
    interval,
    invalidation: stableNumber(event.invalidationPrice ?? event.stopLoss),
    source,
    strategyParameters: {
      atrLength: stableNumber(strategyParameters.atrLength, 4),
      atrMultiplier: stableNumber(strategyParameters.atrMultiplier),
      bandwidth: stableNumber(strategyParameters.bandwidth),
      envelopeMultiplier: stableNumber(strategyParameters.envelopeMultiplier),
      maxSameSideFailures: stableNumber(strategyParameters.maxSameSideFailures, 4),
      strategySource: String(strategyParameters.strategySource ?? "pine-ha"),
    },
    symbol,
    trigger: stableNumber(event.trigger ?? event.triggerPrice),
  })}`;
}

export function setupActionabilityForCanonical(event = {}, interval = "15m", nowMs = Date.now()) {
  const candleOpenSeconds = canonicalTimeSeconds(event.candleOpenTime ?? event.benchmarkTime ?? event.setupCandleTime ?? event.time);
  if (candleOpenSeconds === null) {
    return {
      actionable: true,
      reasonCode: "",
      triggerEligibleFrom: null,
      triggerEligibleFromIso: "",
      waitingForBenchmarkClose: false,
    };
  }
  const triggerEligibleFrom = candleOpenSeconds + canonicalIntervalSeconds(event.interval ?? event.timeframe ?? interval);
  const actionable = nowMs >= triggerEligibleFrom * 1000;
  return {
    actionable,
    reasonCode: actionable ? "" : "waiting_for_benchmark_candle_close",
    triggerEligibleFrom,
    triggerEligibleFromIso: new Date(triggerEligibleFrom * 1000).toISOString(),
    waitingForBenchmarkClose: !actionable,
  };
}

function eventExecutionState({ actionable, eventType, source, status }) {
  const normalizedStatus = String(status ?? "").toLowerCase();
  if (source === CANONICAL_EVENT_SOURCES.CHART_SIMULATION) return "simulation_only";
  if (source === CANONICAL_EVENT_SOURCES.BACKTEST) return "backtest_only";
  if (normalizedStatus) return normalizedStatus;
  if (eventType === CANONICAL_EVENT_TYPES.LIVE_PENDING_TRIGGER) return "pending_trigger";
  if (eventType === CANONICAL_EVENT_TYPES.ENTRY_TRIGGERED) return "entry_triggered";
  if (eventType === CANONICAL_EVENT_TYPES.SETUP_INVALIDATED) return "setup_invalidated";
  if (eventType === CANONICAL_EVENT_TYPES.SETUP_BLOCKED) return "setup_blocked";
  if (eventType === CANONICAL_EVENT_TYPES.SETUP_ACTIVE) return actionable ? "actionable_setup" : "forming_candidate";
  return "observed";
}

function eventReasonCode({ actionable, event = {}, source }) {
  const explicit = event.reasonCode ?? event.reason ?? event.staleEntryIgnoredReason ?? event.skippedReason ?? event.failureClassification ?? "";
  if (explicit) return String(explicit);
  if (!actionable) return "waiting_for_benchmark_candle_close";
  if (source === CANONICAL_EVENT_SOURCES.CHART_SIMULATION) return "chart_simulation_not_live";
  if (source === CANONICAL_EVENT_SOURCES.BACKTEST) return "backtest_not_live";
  return "";
}

export function canonicalEventFromStrategyEvent(event = {}, options = {}) {
  if (!event || !STRATEGY_EVENT_TYPES_FOR_CANONICAL.has(event.type)) return null;
  const interval = options.interval ?? event.interval ?? event.timeframe ?? "15m";
  const source = options.source ?? CANONICAL_EVENT_SOURCES.CHART_SIMULATION;
  const symbol = String(options.symbol ?? event.symbol ?? "SOLUSDT").toUpperCase();
  const actionability = setupActionabilityForCanonical(event, interval, options.nowMs ?? Date.now());
  const strategyActionable = event.type === CANONICAL_EVENT_TYPES.SETUP_ACTIVE ? actionability.actionable : true;
  const liveActionableOverride = typeof event.actionable === "boolean" ? event.actionable : undefined;
  const actionable = source === CANONICAL_EVENT_SOURCES.LIVE_SZTAB
    ? liveActionableOverride ?? strategyActionable
    : false;
  const candleOpenTime = canonicalTimeSeconds(event.benchmarkTime ?? event.setupCandleTime ?? event.time);
  const eventTime = canonicalTimeSeconds(event.time ?? event.timestamp);
  const fingerprint = event.setupFingerprint || fallbackFingerprint({
    event,
    interval,
    source: source === CANONICAL_EVENT_SOURCES.LIVE_SZTAB ? "strategy" : source,
    strategyParameters: options.strategyParameters ?? {},
    symbol,
  });
  const eventType = event.type;
  const reasonCode = eventReasonCode({ actionable: strategyActionable, event, source });

  return {
    actionable,
    candleCloseTime: candleOpenTime === null ? null : candleOpenTime + canonicalIntervalSeconds(interval),
    candleOpenTime,
    eventTime,
    eventType,
    executionState: eventExecutionState({ actionable: strategyActionable, eventType, source, status: event.status }),
    fingerprint,
    id: canonicalEventId({
      candleOpenTime,
      eventTime,
      eventType,
      fingerprint,
      interval,
      setupId: event.setupId ?? "",
      source,
    }),
    interval,
    invalidation: Number.isFinite(Number(event.invalidationPrice ?? event.stopLoss)) ? Number(event.invalidationPrice ?? event.stopLoss) : null,
    raw: event,
    reasonCode,
    setupId: event.setupId ?? "",
    setupFingerprintShort: event.setupFingerprintShort ?? fingerprint.replace(/^sf_|^cf_/u, "").slice(0, 8).toUpperCase(),
    side: canonicalDirection(event.direction, event.positionSide, event.side),
    source,
    strategyActionable,
    symbol,
    trigger: Number.isFinite(Number(event.trigger ?? event.triggerPrice)) ? Number(event.trigger ?? event.triggerPrice) : null,
    triggerEligibleFrom: actionability.triggerEligibleFrom,
    triggerEligibleFromIso: actionability.triggerEligibleFromIso,
  };
}

export function canonicalEventsFromStrategyEvents(events = [], options = {}) {
  return (Array.isArray(events) ? events : [])
    .map((event) => canonicalEventFromStrategyEvent(event, options))
    .filter(Boolean);
}

export function canonicalEventFromPendingTrigger(pending = {}, options = {}) {
  if (!pending || typeof pending !== "object") return null;
  const interval = options.interval ?? pending.interval ?? pending.timeframe ?? "15m";
  const source = options.source ?? CANONICAL_EVENT_SOURCES.LIVE_SZTAB;
  const candleOpenTime = canonicalTimeSeconds(pending.benchmarkTime ?? pending.entryEvent?.benchmarkTime ?? pending.armedAt ?? pending.updatedAt);
  const fingerprint = pending.setupFingerprint || fallbackFingerprint({
    event: {
      benchmarkTime: candleOpenTime,
      direction: pending.direction ?? pending.positionSide ?? pending.side,
      stopLoss: pending.stopLoss ?? pending.invalidationPrice,
      trigger: pending.triggerPrice,
    },
    interval,
    source: "runtime",
    symbol: options.symbol ?? pending.symbol,
  });
  const status = String(pending.status ?? "").toLowerCase();
  const actionable = ["accepted", "new", "partially_filled", "pending_sync", "placed", "platform_armed"].includes(status);
  const eventType = CANONICAL_EVENT_TYPES.LIVE_PENDING_TRIGGER;
  return {
    actionable,
    candleCloseTime: candleOpenTime === null ? null : candleOpenTime + canonicalIntervalSeconds(interval),
    candleOpenTime,
    eventTime: canonicalTimeSeconds(pending.armedAt ?? pending.updatedAt ?? pending.lastStatusCheckAt),
    eventType,
    executionState: eventExecutionState({ actionable, eventType, source, status }),
    fingerprint,
    id: canonicalEventId({
      candleOpenTime,
      eventTime: canonicalTimeSeconds(pending.armedAt ?? pending.updatedAt ?? pending.lastStatusCheckAt),
      eventType,
      fingerprint,
      interval,
      setupId: pending.setupId ?? "",
      source,
    }),
    interval,
    invalidation: Number.isFinite(Number(pending.invalidationPrice ?? pending.stopLoss)) ? Number(pending.invalidationPrice ?? pending.stopLoss) : null,
    orderId: pending.orderId ?? null,
    raw: pending,
    reasonCode: pending.skippedReason ?? pending.terminalReason ?? pending.failureClassification ?? "",
    setupId: pending.setupId ?? "",
    setupFingerprintShort: pending.setupFingerprintShort ?? fingerprint.replace(/^sf_|^cf_/u, "").slice(0, 8).toUpperCase(),
    side: canonicalDirection(pending.direction, pending.positionSide, pending.side),
    source,
    strategyActionable: actionable,
    symbol: String(options.symbol ?? pending.symbol ?? "SOLUSDT").toUpperCase(),
    trigger: Number.isFinite(Number(pending.triggerPrice)) ? Number(pending.triggerPrice) : null,
    triggerEligibleFrom: pending.triggerEligibleFrom ?? null,
    triggerEligibleFromIso: pending.triggerEligibleFromIso ?? "",
  };
}

export function canonicalEventsFromRuntime(runtime = {}, options = {}) {
  const interval = options.interval ?? runtime.interval ?? runtime.timeframe ?? "15m";
  const symbol = options.symbol ?? runtime.symbol ?? "SOLUSDT";
  const rows = [];
  if (runtime.formingSetupCandidate) {
    rows.push(canonicalEventFromStrategyEvent({
      ...runtime.formingSetupCandidate,
      actionable: false,
      reasonCode: runtime.formingSetupCandidate.reason ?? "waiting_for_benchmark_candle_close",
      status: "forming_candidate",
    }, { interval, nowMs: options.nowMs, source: CANONICAL_EVENT_SOURCES.LIVE_SZTAB, symbol }));
  }
  if (runtime.latestSetupEvent) {
    rows.push(canonicalEventFromStrategyEvent({
      ...runtime.latestSetupEvent,
      actionable: runtime.latestSetupEventActionable !== false,
    }, { interval, nowMs: options.nowMs, source: CANONICAL_EVENT_SOURCES.LIVE_SZTAB, symbol }));
  }
  if (runtime.latestEntryEvent) {
    rows.push(canonicalEventFromStrategyEvent(runtime.latestEntryEvent, {
      interval,
      nowMs: options.nowMs,
      source: CANONICAL_EVENT_SOURCES.LIVE_SZTAB,
      symbol,
    }));
  }
  if (runtime.pendingTriggerOrder) {
    rows.push(canonicalEventFromPendingTrigger(runtime.pendingTriggerOrder, { interval, source: CANONICAL_EVENT_SOURCES.LIVE_SZTAB, symbol }));
  }
  return dedupeCanonicalEvents(rows.filter(Boolean));
}

export function dedupeCanonicalEvents(events = []) {
  const byId = new Map();
  for (const event of events) {
    byId.set(event.id ?? canonicalEventId(event), event);
  }
  return [...byId.values()].sort((left, right) => {
    const leftTime = left.eventTime ?? left.candleOpenTime ?? 0;
    const rightTime = right.eventTime ?? right.candleOpenTime ?? 0;
    return leftTime - rightTime;
  });
}

export function mergeCanonicalEventStreams(...streams) {
  return dedupeCanonicalEvents(streams.flat().filter(Boolean));
}

export function filterCanonicalEventsForMode(events = [], mode = "live") {
  const relevant = dedupeCanonicalEvents(events).filter((event) => event.trigger !== null || event.eventType === CANONICAL_EVENT_TYPES.LIVE_EXECUTION);
  if (mode === "live") {
    return relevant.filter((event) => event.source === CANONICAL_EVENT_SOURCES.LIVE_SZTAB && event.actionable).slice(-8);
  }
  if (mode === "operational") {
    const live = relevant.filter((event) => event.source === CANONICAL_EVENT_SOURCES.LIVE_SZTAB).slice(-8);
    if (live.length) return live;
    return relevant.filter((event) => event.source === CANONICAL_EVENT_SOURCES.CHART_SIMULATION).slice(-1);
  }
  if (mode === "history") {
    return relevant.filter((event) => event.source !== CANONICAL_EVENT_SOURCES.BACKTEST).slice(-18);
  }
  return relevant.slice(-100);
}

export function canonicalEventDebugSummary(event = {}) {
  return [
    event.interval,
    event.source,
    event.eventType,
    event.side,
    event.setupId,
    event.setupFingerprintShort ? `fp:${event.setupFingerprintShort}` : "",
    event.actionable ? "actionable" : "not-actionable",
    event.executionState,
    event.reasonCode ? `reason:${event.reasonCode}` : "",
    event.triggerEligibleFromIso ? `eligible:${event.triggerEligibleFromIso}` : "",
  ].filter(Boolean).join(" · ");
}

export function canonicalMarkerFromEvent(event = {}, mode = "live") {
  const live = event.source === CANONICAL_EVENT_SOURCES.LIVE_SZTAB;
  const side = canonicalDirection(event.side);
  const isLong = side === "LONG";
  const simulationOnly = !live || !event.actionable;
  const prefix = live && event.actionable
    ? "LIVE"
    : event.source === CANONICAL_EVENT_SOURCES.BACKTEST
      ? "BACKTEST"
      : event.source === CANONICAL_EVENT_SOURCES.CHART_SIMULATION
        ? "WYKRES"
        : "INFO";
  const baseText = event.eventType === CANONICAL_EVENT_TYPES.ENTRY_TRIGGERED
    ? `${prefix} ENTRY ${side}`
    : event.eventType === CANONICAL_EVENT_TYPES.SETUP_INVALIDATED
      ? `${prefix} SETUP X ${side}`
      : event.eventType === CANONICAL_EVENT_TYPES.LIVE_PENDING_TRIGGER
        ? `${prefix} TRIGGER ${side}`
        : `${prefix} SETUP ${side}`;
  return {
    color: simulationOnly ? "rgba(148, 163, 184, 0.78)" : isLong ? "#22c55e" : "#ef4444",
    id: `canonical-${event.id}`,
    position: isLong ? "belowBar" : "aboveBar",
    shape: event.eventType === CANONICAL_EVENT_TYPES.ENTRY_TRIGGERED ? (isLong ? "arrowUp" : "arrowDown") : "square",
    size: simulationOnly ? 0.55 : 0.9,
    text: mode === "debug" ? `${baseText} · ${canonicalEventDebugSummary(event)}` : baseText,
    time: event.eventTime ?? event.candleOpenTime,
  };
}

export function canonicalLineTitles(event = {}, mode = "live") {
  const side = event.side ? ` — ${event.side}` : "";
  if (event.source === CANONICAL_EVENT_SOURCES.LIVE_SZTAB && event.actionable) {
    return {
      slTitle: `LIVE POZIOM NEGACJI / SL${side}`,
      triggerTitle: event.eventType === CANONICAL_EVENT_TYPES.LIVE_PENDING_TRIGGER
        ? `LIVE TRIGGER — ZDARZENIE SZTABU${side}`
        : `LIVE SETUP AKCYJNY — ZDARZENIE SZTABU${side}`,
    };
  }
  if (event.source === CANONICAL_EVENT_SOURCES.LIVE_SZTAB) {
    return {
      slTitle: `NIEAKTYWNY POZIOM NEGACJI SZTABU${side}`,
      triggerTitle: `NIEAKTYWNY SETUP SZTABU — ${event.reasonCode || event.executionState}${side}`,
    };
  }
  if (event.source === CANONICAL_EVENT_SOURCES.BACKTEST) {
    return {
      slTitle: `BACKTEST SL / NEGACJA${side}`,
      triggerTitle: `BACKTEST TRIGGER${side}`,
    };
  }
  return {
    slTitle: `SYMULACJA WYKRESU — POZIOM NEGACJI${side}`,
    triggerTitle: `SYMULACJA WYKRESU — NIE JEST LIVE TRIGGEREM${side}`,
  };
}

export function canonicalVisibilityInvariants(events = [], visibleEvents = [], mode = "live") {
  const messages = [];
  const visibleIds = new Set(visibleEvents.map((event) => event.id));
  for (const event of visibleEvents) {
    if (
      mode === "live" &&
      event.eventType === CANONICAL_EVENT_TYPES.LIVE_PENDING_TRIGGER &&
      (event.source !== CANONICAL_EVENT_SOURCES.LIVE_SZTAB || !event.actionable)
    ) {
      messages.push(`live_trigger_without_actionable_sztab_event:${event.id}`);
    }
  }
  for (const event of events) {
    if (
      mode === "live" &&
      event.source === CANONICAL_EVENT_SOURCES.LIVE_SZTAB &&
      event.actionable &&
      [CANONICAL_EVENT_TYPES.LIVE_PENDING_TRIGGER, CANONICAL_EVENT_TYPES.SETUP_ACTIVE, CANONICAL_EVENT_TYPES.ENTRY_TRIGGERED].includes(event.eventType) &&
      !visibleIds.has(event.id)
    ) {
      messages.push(`actionable_sztab_event_not_visible:${event.id}`);
    }
  }
  return messages;
}

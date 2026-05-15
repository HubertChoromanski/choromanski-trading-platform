import { cancelLivePendingTriggerOrder, processLiveProfileExecution } from "../execution/executionEngine.js";
import { withSetupFingerprint } from "../execution/setupFingerprint.js";
import { runStrategyForProfile, runStrategyOnCandles } from "../strategy/strategyRunner.js";

export const SZTAB_INTERVALS = ["10m", "15m", "20m", "30m", "1h"];
const DEFAULT_LOOP_MS = Number(process.env.SZTAB_INTERVAL_LOOP_MS || 30_000);
const DEFAULT_SZTAB_CANDLE_LIMITS = {
  "10m": 10000,
  "15m": 10000,
  "20m": 10000,
  "30m": 10000,
  "1h": 10000,
};

function sztabExecutionMode() {
  return String(process.env.SZTAB_EXECUTION_MODE ?? "exchange_trigger").toLowerCase() === "platform_market_trigger"
    ? "platform_market_trigger"
    : "exchange_trigger";
}

function triggerWatchMs() {
  const configured = Number(process.env.SZTAB_TRIGGER_WATCH_MS);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return sztabExecutionMode() === "platform_market_trigger" ? 1000 : 5000;
}

function autoRecoverRunners() {
  return String(process.env.SZTAB_AUTO_RECOVER_RUNNERS ?? "true").toLowerCase() !== "false";
}

function runnerRecoveryCooldownMs() {
  const configured = Number(process.env.SZTAB_RUNNER_RECOVERY_COOLDOWN_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 10_000;
}

function maxTransientErrorsBeforePause() {
  const configured = Number(process.env.SZTAB_MAX_TRANSIENT_ERRORS_BEFORE_PAUSE);
  return Number.isFinite(configured) && configured > 0 ? configured : 20;
}

function isRunningStatus(status) {
  return ["running", "degraded", "recovering"].includes(String(status ?? "").toLowerCase());
}

function isTransientRunnerError(error) {
  const message = String(error?.message ?? error ?? "").toLowerCase();
  const code = String(error?.code ?? error?.status ?? error?.payload?.code ?? "").toLowerCase();
  return Boolean(error?.transient || error?.priceFeedDegraded) ||
    error?.status === 429 ||
    code === "429" ||
    error?.name === "AbortError" ||
    ["etimedout", "econnreset", "econnrefused", "enotfound", "eai_again"].includes(code) ||
    message.includes("429") ||
    message.includes("too many request") ||
    message.includes("rate limit") ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("timeout") ||
    error?.status >= 500;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeSymbol(symbol = "SOLUSDT") {
  return String(symbol || "SOLUSDT").toUpperCase().replace("-", "");
}

function intervalLabel(interval) {
  return interval === "1h" ? "1H" : interval;
}

function numberValue(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function timeValueMs(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" || (typeof value === "string" && /^-?\d+(\.\d+)?$/u.test(value.trim()))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return numeric > 10_000_000_000 ? Math.round(numeric) : Math.round(numeric * 1000);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function orderIdCandidates(value = {}) {
  return [
    value?.orderId,
    value?.clientOrderId,
    value?.data?.orderId,
    value?.data?.clientOrderId,
    value?.raw?.orderId,
    value?.raw?.clientOrderId,
  ]
    .filter((item) => item !== null && item !== undefined && item !== "")
    .map((item) => String(item));
}

function lifecycleOrderIds(pending = {}) {
  return [...new Set([
    ...orderIdCandidates(pending),
    ...orderIdCandidates(pending?.exchangeResponse),
    ...orderIdCandidates(pending?.marketOrder),
    ...orderIdCandidates(pending?.stopOrder),
    ...orderIdCandidates(pending?.takeProfitOrder),
  ])];
}

function journalItemTimeMs(item = {}) {
  return timeValueMs(item.timestamp ?? item.time ?? item.createdAt ?? item.updatedAt);
}

function setupFingerprintFromRuntime(runtime = {}, pending = null) {
  return pending?.setupFingerprint ??
    runtime.activeSetupFingerprint ??
    runtime.latestSetupFingerprint ??
    runtime.latestSetupEvent?.setupFingerprint ??
    runtime.setupFingerprint ??
    "";
}

function setupFingerprintShort(value = "") {
  return value ? String(value).replace(/^sf_/u, "").slice(0, 8).toUpperCase() : "";
}

function currentJournalPredicate({ currentOrderIds = [], currentRunnerStartedAt = null, currentSetupFingerprint = "", item = {} } = {}) {
  const itemFingerprint = item.setupFingerprint ?? "";
  if (currentSetupFingerprint && itemFingerprint && itemFingerprint !== currentSetupFingerprint) return false;
  const startedMs = timeValueMs(currentRunnerStartedAt);
  const itemMs = journalItemTimeMs(item);
  if (startedMs !== null && itemMs !== null && itemMs < startedMs) return false;
  if (currentSetupFingerprint && itemFingerprint === currentSetupFingerprint) return true;
  if (item.orderId && currentOrderIds.includes(String(item.orderId))) return true;
  return !currentSetupFingerprint && startedMs !== null && itemMs !== null && itemMs >= startedMs;
}

function splitSetupOrderJournal({ journal = [], pending = null, runtime = {} } = {}) {
  const currentRunnerStartedAt = runtime.currentRunnerStartedAt ?? runtime.startedAt ?? null;
  const currentSetupFingerprint = setupFingerprintFromRuntime(runtime, pending);
  const currentLifecycleOrderIds = lifecycleOrderIds(pending);
  const currentSetupOrderJournal = [];
  const historicalSetupOrderJournal = [];
  for (const item of Array.isArray(journal) ? journal : []) {
    const current = currentJournalPredicate({
      currentOrderIds: currentLifecycleOrderIds,
      currentRunnerStartedAt,
      currentSetupFingerprint,
      item,
    });
    const decorated = {
      ...item,
      historical: !current,
      staleHistoricalReason: current
        ? ""
        : item.setupFingerprint && currentSetupFingerprint && item.setupFingerprint !== currentSetupFingerprint
          ? "different_setup_fingerprint"
          : currentRunnerStartedAt && journalItemTimeMs(item) !== null && timeValueMs(currentRunnerStartedAt) !== null && journalItemTimeMs(item) < timeValueMs(currentRunnerStartedAt)
            ? "older_than_current_runner_start"
            : "not_current_lifecycle",
    };
    if (current) currentSetupOrderJournal.push(decorated);
    else historicalSetupOrderJournal.push(decorated);
  }
  return {
    currentLifecycleOrderIds,
    currentRunnerStartedAt,
    currentSetupFingerprint,
    currentSetupFingerprintShort: setupFingerprintShort(currentSetupFingerprint),
    currentSetupOrderJournal: currentSetupOrderJournal.slice(-50),
    historicalSetupOrderJournal: historicalSetupOrderJournal.slice(-100),
    staleHistoricalOrderCount: historicalSetupOrderJournal.length,
  };
}

function currentDecisionTimeline({ latestSetupEvent = null, pending = null, runtime = {} } = {}) {
  const timeline = [];
  const runnerStartedAt = runtime.currentRunnerStartedAt ?? runtime.startedAt ?? null;
  if (runnerStartedAt) {
    timeline.push({
      event: "runner_started",
      text: "Runner wystartował dla tego interwału.",
      time: runnerStartedAt,
    });
  }
  if (latestSetupEvent) {
    timeline.push({
      direction: latestSetupEvent.direction ?? null,
      event: "setup_detected",
      setupFingerprint: latestSetupEvent.setupFingerprint ?? "",
      setupId: latestSetupEvent.setupId ?? "",
      text: `Strategia wykryła setup ${latestSetupEvent.direction ?? ""}${latestSetupEvent.setupId ? ` ${latestSetupEvent.setupId}` : ""}.`,
      time: latestSetupEvent.time ?? null,
    });
  }
  if (pending) {
    timeline.push({
      direction: pending.direction ?? pending.positionSide ?? null,
      event: "setup_armed",
      setupFingerprint: pending.setupFingerprint ?? "",
      setupId: pending.setupId ?? "",
      text: "Aktualny setup jest uzbrojony w runtime Sztabu.",
      time: pending.armedAt ?? pending.updatedAt ?? null,
      triggerPrice: pending.triggerPrice ?? null,
    });
    if (pending.triggerEligibleFromIso ?? pending.triggerEligibleFrom) {
      timeline.push({
        event: "trigger_waiting",
        setupFingerprint: pending.setupFingerprint ?? "",
        text: "Bot czeka na eligible trigger po zamknięciu świecy setupu.",
        time: pending.triggerEligibleFromIso ?? pending.triggerEligibleFrom,
        triggerPrice: pending.triggerPrice ?? null,
      });
    }
    if (pending.triggerCrossed) {
      timeline.push({
        event: "trigger_crossed",
        setupFingerprint: pending.setupFingerprint ?? "",
        text: "Trigger został przebity według bieżącego runtime.",
        time: pending.triggerCrossedAt ?? pending.updatedAt ?? null,
        triggerPrice: pending.triggerPrice ?? null,
      });
    } else if (String(pending.status ?? "").toLowerCase() === "platform_armed") {
      timeline.push({
        event: "trigger_not_crossed",
        setupFingerprint: pending.setupFingerprint ?? "",
        text: "Trigger nie został jeszcze przebity w aktualnym cyklu.",
        time: pending.lastStatusCheckAt ?? pending.updatedAt ?? null,
        triggerPrice: pending.triggerPrice ?? null,
      });
    }
    if (pending.marketOrderSent) {
      timeline.push({
        event: "market_order_sent",
        orderId: pending.orderId ?? null,
        setupFingerprint: pending.setupFingerprint ?? "",
        text: "MARKET został wysłany do BingX.",
        time: pending.marketSentAt ?? pending.updatedAt ?? null,
      });
    }
    if (["filled_protected", "filled_sl_failed"].includes(String(pending.status ?? "").toLowerCase())) {
      timeline.push({
        event: "position_confirmed",
        orderId: pending.orderId ?? null,
        setupFingerprint: pending.setupFingerprint ?? "",
        text: pending.status === "filled_protected"
          ? "Pozycja została potwierdzona, a SL wysłany."
          : "Pozycja została potwierdzona, ale SL wymaga kontroli.",
        time: pending.fillDetectedAt ?? pending.updatedAt ?? null,
      });
    }
    if (["setup_invalidated_before_platform_trigger", "invalidated_before_fill"].includes(String(pending.status ?? "").toLowerCase())) {
      timeline.push({
        event: "setup_invalidated",
        setupFingerprint: pending.setupFingerprint ?? "",
        text: "Setup został anulowany przed wykonaniem triggera.",
        time: pending.updatedAt ?? null,
      });
    }
  }
  if (!pending && !latestSetupEvent && ["running", "degraded", "recovering"].includes(String(runtime.status ?? "").toLowerCase())) {
    timeline.push({
      event: "waiting_for_setup",
      text: "Runner działa i czeka na nowy setup strategii.",
      time: runtime.lastTickAt ?? runtime.heartbeatAt ?? null,
    });
  }
  if (runtime.lastDecisionReason || runtime.lastDecision || runtime.lastBlockedReason) {
    timeline.push({
      event: runtime.lastBlockedReason ? "blocker" : "decision",
      reason: runtime.lastDecisionReason ?? "",
      text: runtime.lastBlockedReason || runtime.lastDecision || runtime.lastDecisionReason,
      time: runtime.lastTickAt ?? runtime.heartbeatAt ?? null,
    });
  }
  return timeline
    .filter((item) => item.text)
    .sort((left, right) => (timeValueMs(right.time) ?? 0) - (timeValueMs(left.time) ?? 0))
    .slice(0, 20);
}

export function deriveCurrentRuntimeContext({ latestSetupEvent = null, pending = null, runtime = {} } = {}) {
  const split = splitSetupOrderJournal({
    journal: runtime.setupOrderJournal ?? [],
    pending,
    runtime: {
      ...runtime,
      latestSetupEvent,
    },
  });
  return {
    ...split,
    currentDecisionTimeline: currentDecisionTimeline({
      latestSetupEvent,
      pending,
      runtime: {
        ...runtime,
        currentRunnerStartedAt: split.currentRunnerStartedAt,
      },
    }),
  };
}

function compactSymbol(symbol) {
  return String(symbol ?? "").replace("-", "").toUpperCase();
}

function normalizeExchangeList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.positions)) return value.positions;
  if (Array.isArray(value?.orders)) return value.orders;
  if (Array.isArray(value?.data)) return value.data;
  return value ? [value] : [];
}

function calculateSetupTakeProfit(event = {}, risk = {}) {
  if (risk.takeProfitEnabled !== true) return null;
  const entry = Number(event.trigger ?? event.triggerPrice);
  const stopLoss = Number(event.stopLoss ?? event.invalidationPrice);
  const rr = Number(risk.takeProfitRr ?? 2);
  const riskDistance = Math.abs(entry - stopLoss);
  if (!Number.isFinite(entry) || !Number.isFinite(stopLoss) || !Number.isFinite(rr) || rr <= 0 || riskDistance <= 0) {
    return null;
  }
  return String(event.direction ?? "").toUpperCase() === "LONG"
    ? entry + riskDistance * rr
    : entry - riskDistance * rr;
}

function eventSummary(event, profile = null) {
  if (!event) return null;
  const fingerprinted = profile
    ? withSetupFingerprint(
        {
          ...event,
          interval: profile.timeframe,
          symbol: profile.symbol,
          takeProfit: calculateSetupTakeProfit(event, profile.risk),
        },
        {
          interval: profile.timeframe,
          strategyParameters: profile.strategyParameters,
          symbol: profile.symbol,
          takeProfit: calculateSetupTakeProfit(event, profile.risk),
        },
      )
    : event;
  return {
    direction: fingerprinted.direction ?? null,
    index: fingerprinted.index ?? null,
    price: fingerprinted.price ?? null,
    setupFingerprint: fingerprinted.setupFingerprint ?? "",
    setupFingerprintShort: fingerprinted.setupFingerprintShort ?? "",
    setupId: fingerprinted.setupId ?? "",
    signalTime: fingerprinted.signalTime ?? null,
    status: fingerprinted.status ?? "",
    stopLoss: fingerprinted.stopLoss ?? null,
    takeProfit: fingerprinted.takeProfit ?? null,
    time: fingerprinted.time ?? null,
    trigger: fingerprinted.trigger ?? null,
    type: fingerprinted.type ?? "",
  };
}

function accountDataAgeSeconds(summary = {}) {
  const value = summary.lastRefreshAt ?? summary.lastBingxSyncAt ?? null;
  if (!value) return null;
  const timestamp = typeof value === "number" ? value * 1000 : new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
}

function secondsSinceIso(value) {
  if (!value) return null;
  const timestamp = typeof value === "number" ? value * 1000 : new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
}

function clearTransientBlockers() {
  return {
    globalBlockers: [],
    globalExecutionState: "enabled",
    lastBlockedReason: "",
    tradingBlockedForAI: false,
  };
}

function positionAmount(position) {
  return Math.abs(Number(position?.positionAmt ?? position?.positionAmount ?? position?.quantity ?? position?.availableAmt ?? 0));
}

function positionSideFromPosition(position = {}) {
  const raw = String(position.positionSide ?? position.side ?? position.direction ?? "").toUpperCase();
  if (raw.includes("LONG")) return "LONG";
  if (raw.includes("SHORT")) return "SHORT";
  const amount = Number(position.positionAmt ?? position.positionAmount ?? position.quantity ?? 0);
  return amount < 0 ? "SHORT" : "LONG";
}

function matchingExchangePositionForLiveState(exchangePositions = [], livePosition = null, pending = null) {
  const side = positionSideFromPosition(livePosition ?? pending ?? {});
  return exchangePositions.find((position) => positionSideFromPosition(position) === side && positionAmount(position) > 0) ?? null;
}

function appendRuntimeJournal(profile, entry) {
  profile.live = {
    setupOrderJournal: [],
    ...(profile.live ?? {}),
  };
  profile.live.setupOrderJournal = [
    ...(profile.live.setupOrderJournal ?? []),
    {
      timestamp: nowIso(),
      symbol: profile.symbol,
      profileId: profile.id,
      ...entry,
    },
  ].slice(-100);
}

function terminalPendingStatus(status) {
  return [
    "canceled",
    "cancelled",
    "expired",
    "filled_but_position_missing",
    "invalidated_before_fill",
    "market_sent_position_missing",
    "missing",
    "platform_blocked_existing_position",
    "platform_market_order_rejected",
    "rejected",
    "reversal_close_failed",
    "reversal_close_succeeded_entry_failed",
    "setup_invalidated_before_platform_trigger",
    "simulated_only",
    "terminal_failed",
    "trigger_crossed_but_price_too_far",
    "trigger_order_rejected",
  ].includes(String(status ?? "").toLowerCase());
}

function isActivePendingTrigger(order) {
  return ["accepted", "placed", "new", "partially_filled", "pending_sync", "platform_armed"].includes(String(order?.status ?? "").toLowerCase());
}

function reconcileLocalScenarioWithExchange(profile, exchangePositions = []) {
  const pending = profile.live?.pendingTriggerOrder ?? null;
  const localPosition = profile.live?.openPosition ?? null;
  const matchingPosition = localPosition
    ? matchingExchangePositionForLiveState(exchangePositions, localPosition, pending)
    : null;

  profile.live = {
    ...(profile.live ?? {}),
    activeScenarioCanBlockNewSetup: Boolean(localPosition || isActivePendingTrigger(pending)),
    livePositionConfirmed: Boolean(matchingPosition),
    liveProtectionConfirmed: false,
    protectionOrderId: null,
    protectionSource: matchingPosition ? "bingx_order" : pending ? "local_planned" : "none",
    scenarioTerminalReason: pending?.terminalReason ?? "",
    supersededBySetupId: pending?.supersededBySetupId ?? null,
  };

  if (!localPosition || matchingPosition) {
    return profile;
  }

  const staleReason = "filled_but_position_missing";
  profile.live.openPosition = null;
  profile.live.lastProcessedSetupId = null;
  profile.live.activeScenarioCanBlockNewSetup = false;
  profile.live.livePositionConfirmed = false;
  profile.live.liveProtectionConfirmed = false;
  profile.live.protectionOrderId = null;
  profile.live.protectionSource = "stale_local";
  profile.live.scenarioTerminalReason = staleReason;

  if (pending && !terminalPendingStatus(pending.status)) {
    profile.live.pendingTriggerOrder = {
      ...pending,
      canArmNextSetup: true,
      critical: staleReason,
      failureClassification: staleReason,
      lastExchangeStatus: pending.lastExchangeStatus ?? "POSITION_NOT_FOUND",
      orderLifecycle: [
        ...(pending.orderLifecycle ?? []),
        {
          message: "Local live position was cleared because fresh BingX sync did not find the expected position.",
          status: staleReason,
          time: nowIso(),
        },
      ].slice(-20),
      protectionSource: "stale_local",
      status: staleReason,
      terminal: true,
      terminalReason: staleReason,
      updatedAt: nowIso(),
    };
  } else if (!pending && localPosition?.setupId) {
    profile.live.pendingTriggerOrder = {
      canArmNextSetup: true,
      direction: localPosition.direction ?? positionSideFromPosition(localPosition),
      failureClassification: staleReason,
      protectionSource: "stale_local",
      setupFingerprint: localPosition.setupFingerprint ?? null,
      setupFingerprintShort: localPosition.setupFingerprintShort ?? null,
      setupId: localPosition.setupId,
      status: staleReason,
      terminal: true,
      terminalReason: staleReason,
      triggerPrice: localPosition.entryPrice ?? null,
      updatedAt: nowIso(),
    };
  }

  appendRuntimeJournal(profile, {
    event: "filled_but_position_missing",
    failureClassification: staleReason,
    interval: profile.timeframe,
    reason: "Fresh BingX sync did not find the local live position; scenario will not block a newer setup.",
    setupId: pending?.setupId ?? localPosition?.setupId ?? null,
    setupFingerprint: pending?.setupFingerprint ?? localPosition?.setupFingerprint ?? null,
    setupFingerprintShort: pending?.setupFingerprintShort ?? localPosition?.setupFingerprintShort ?? null,
    side: pending?.side ?? positionSideFromPosition(localPosition),
    status: staleReason,
    triggerPrice: pending?.triggerPrice ?? localPosition?.entryPrice ?? null,
  });

  return profile;
}

function apiProfileLabel(apiProfiles = [], id = "") {
  return apiProfiles.find((profile) => profile.id === id)?.label ?? id;
}

function defaultIntervalConfig(interval) {
  return {
    apiProfile: "",
    interval,
    locked: false,
    mm: {
      riskPerSlPercent: 1,
    },
    mmLocked: false,
    mmSavedAt: null,
    runtime: {
      candlesLoaded: 0,
      candlesRequested: 0,
      closedCandlesUsed: 0,
      consecutiveErrors: 0,
      crisisModeOn: false,
      crisisManualLock: false,
      dataAgeSeconds: null,
      error: "",
      executionAllowed: true,
      globalBlockers: [],
      globalExecutionState: "enabled",
      heartbeatAt: null,
      heartbeatAgeSeconds: null,
      intervalBlockers: [],
      lastCandle: null,
      lastClosedCandleTime: null,
      lastDecision: "",
      lastDecisionReason: "",
      lastError: "",
      lastExchangeResponse: null,
      lastLoopDurationMs: null,
      lastTickAt: null,
      lastOrderAttempt: null,
      pendingTriggerOrder: null,
      activeScenarioCanBlockNewSetup: false,
      canArmNextSetup: true,
      executionMode: sztabExecutionMode(),
      executionPrice: null,
      exchangeTerminalStatus: "",
      lastMarkPrice: null,
      lastExchangeStatus: "",
      lastPriceSource: null,
      lastStatusCheckAt: null,
      lastTriggerFailureReason: "",
      orderFingerprintMatchesLatestSetup: null,
      lastBlockedReason: "",
      lastTriggerFailureCandidate: "",
      lastTriggerFailureDiagnostics: null,
      pendingOrderAgeSeconds: null,
      platformMarketEntrySent: false,
      platformTriggerCrossed: false,
      platformTriggerCrossedAt: null,
      platformTriggerDiagnostics: null,
      platformTriggerSkippedReason: "",
      platformTriggerSlippagePct: null,
      livePositionConfirmed: false,
      liveProtectionConfirmed: false,
      protectionOrderId: null,
      protectionSource: "none",
      scenarioTerminalReason: "",
      slPlacementStatus: "",
      setupOrderJournal: [],
      currentDecisionTimeline: [],
      currentLifecycleOrderIds: [],
      currentRunnerStartedAt: null,
      currentSetupFingerprint: "",
      currentSetupFingerprintShort: "",
      currentSetupOrderJournal: [],
      historicalSetupOrderJournal: [],
      staleHistoricalOrderCount: 0,
      setupFingerprint: "",
      setupFingerprintShort: "",
      supersededBySetupId: null,
      supersededBySetupFingerprint: null,
      triggerDistanceAtFailurePct: null,
      triggerDistanceAtPlacementPct: null,
      triggerFailureClassification: "",
      triggerOrderFillDetected: false,
      triggerOrderExecutedQty: null,
      triggerOrderState: "none",
      latestEntryEvent: null,
      latestSetupEvent: null,
      lastSignal: null,
      lastSyncAt: null,
      profileConnected: false,
      runnerStale: false,
      startedAt: null,
      status: "stopped",
      stoppedAt: null,
      tickCount: 0,
      tradingEnabled: true,
      watchdogStatus: "idle",
      tradingBlockedForAI: false,
      legacySafetyAgeSeconds: null,
      legacySafetyStale: false,
      legacySafetyStatus: "NOT_CHECKED",
      legacySafetyWarnings: [],
      validNweBandCount: 0,
    },
    strategy: {
      atrLength: 14,
      atrMultiplier: 1.2,
      bandwidth: 8,
      envelopeMultiplier: 3,
      maxSameSideFailures: 2,
      strategySource: "pine-ha",
    },
    strategyLocked: false,
    strategySavedAt: null,
    symbol: "SOLUSDT",
    validation: {
      checkedAt: null,
      errors: [],
      ok: false,
      warnings: [],
    },
  };
}

function normalizeConfig(config = {}) {
  const intervals = {};

  for (const interval of SZTAB_INTERVALS) {
    const base = defaultIntervalConfig(interval);
    const current = config.intervals?.[interval] ?? {};
    intervals[interval] = {
      ...base,
      ...current,
      interval,
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
      },
      validation: {
        ...base.validation,
        ...(current.validation ?? {}),
      },
    };
  }

  return {
    intervals,
    updatedAt: config.updatedAt ?? null,
    version: 1,
  };
}

function setIntervalConfig(config, interval, patch) {
  return normalizeConfig({
    ...config,
    intervals: {
      ...config.intervals,
      [interval]: {
        ...(config.intervals?.[interval] ?? defaultIntervalConfig(interval)),
        ...patch,
      },
    },
    updatedAt: nowIso(),
  });
}

function configToProfile(config, existing = {}) {
  const riskPerSl = numberValue(config.mm?.riskPerSlPercent ?? config.mm?.oneSlPercent, 1);
  const runtimeLive = config.runtime ?? {};
  const existingLive = existing.live ?? {};

  return {
    ...existing,
    account: {
      ...(existing.account ?? {}),
      apiProfile: config.apiProfile,
      exchange: "BingX",
      label: config.apiProfileLabel ?? config.apiProfile,
      type: config.apiProfile === "main" ? "main" : "subaccount",
    },
    enabled: true,
    executionMode: "live",
    id: `sztab-${config.interval}`,
    live: {
      lastProcessedSetupFingerprint: null,
      lastProcessedSetupId: null,
      openPosition: null,
      orderLog: [],
      setupOrderJournal: runtimeLive.setupOrderJournal ?? [],
      ...existingLive,
      pendingTriggerOrder: existingLive.pendingTriggerOrder ?? runtimeLive.pendingTriggerOrder ?? null,
      setupOrderJournal: existingLive.setupOrderJournal ?? runtimeLive.setupOrderJournal ?? [],
    },
    liveModeEnabled: true,
    locked: true,
    paper: existing.paper ?? { equity: 0, lastProcessedSetupId: null, openPosition: null, realizedPnl: 0, tradesToday: 0 },
    risk: {
      ...(existing.risk ?? {}),
      allowLong: true,
      allowShort: true,
      emergencyStop: false,
      leverage: 1,
      marginMode: "isolated",
      maxDailyLossPercent: 100,
      maxOpenPositions: 1,
      maxTradesPerDay: 100,
      positionSizeMode: "risk-based",
      riskPerTradePercent: riskPerSl,
      startingBalance: 0,
      takeProfitEnabled: false,
      takeProfitRr: null,
    },
    runner: "sztab",
    status: "Sztab live ready",
    strategyDeployed: true,
    strategyParameters: {
      atrLength: numberValue(config.strategy?.atrLength, 14),
      atrMultiplier: numberValue(config.strategy?.atrMultiplier, 1.2),
      bandwidth: numberValue(config.strategy?.bandwidth, 8),
      envelopeMultiplier: numberValue(config.strategy?.envelopeMultiplier, 3),
      maxSameSideFailures: numberValue(config.strategy?.maxSameSideFailures, 2),
      strategySource: config.strategy?.strategySource ?? "pine-ha",
    },
    symbol: normalizeSymbol(config.symbol),
    timeframe: config.interval,
    version: numberValue(existing.version, 0) + 1,
  };
}

function validationFor(config, apiProfiles = []) {
  const errors = [];
  const warnings = [];
  const strategy = config.strategy ?? {};
  const mm = config.mm ?? {};
  const profile = apiProfiles.find((item) => item.id === config.apiProfile);

  for (const [key, label] of [
    ["atrLength", "ATR length"],
    ["atrMultiplier", "ATR multiplier"],
    ["bandwidth", "Bandwidth"],
    ["envelopeMultiplier", "NWE multiplier"],
  ]) {
    if (numberValue(strategy[key], NaN) <= 0) errors.push(`${label} must be greater than 0.`);
  }

  if (numberValue(strategy.maxSameSideFailures, NaN) < 0) {
    errors.push("Max same-side failures cannot be negative.");
  }
  if (numberValue(mm.riskPerSlPercent ?? mm.oneSlPercent, NaN) <= 0) {
    errors.push("Risk per SL must be greater than 0.");
  }
  if (!config.apiProfile) {
    errors.push("API profile/subaccount mapping is missing.");
  } else if (!profile) {
    errors.push(`API profile ${config.apiProfile} is not available.`);
  } else if (!profile.configured) {
    errors.push(`API profile ${apiProfileLabel(apiProfiles, config.apiProfile)} is missing keys.`);
  }
  if (!config.strategySavedAt) errors.push("Strategy settings must be saved.");
  if (!config.mmSavedAt) errors.push("MM settings must be saved.");
  if (!config.strategyLocked || !config.mmLocked || !config.locked) {
    errors.push("Strategy and MM must be locked before start.");
  }

  return {
    checkedAt: nowIso(),
    errors,
    ok: errors.length === 0,
    warnings,
  };
}

function statusFromConfig(config) {
  return Object.fromEntries(
    SZTAB_INTERVALS.map((interval) => {
      const current = config.intervals[interval];
      const heartbeatAgeSeconds = secondsSinceIso(current.runtime?.heartbeatAt ?? current.runtime?.lastTickAt);
      const staleThreshold = Number(process.env.SZTAB_RUNNER_STALE_SECONDS || 120);
      const runnerActive = isRunningStatus(current.runtime?.status);
      const runnerStale = runnerActive && heartbeatAgeSeconds !== null && heartbeatAgeSeconds > staleThreshold;
      return [
        interval,
        {
          apiProfile: current.apiProfile,
          interval,
          mmSavedAt: current.mmSavedAt,
          runtime: {
            ...current.runtime,
            heartbeatAgeSeconds,
            runnerStale,
            watchdogStatus: runnerActive
              ? runnerStale ? "stale" : current.runtime?.runnerDegraded ? "degraded" : "healthy"
              : current.runtime?.status ?? "idle",
          },
          strategySavedAt: current.strategySavedAt,
          symbol: current.symbol,
          validation: current.validation,
        },
      ];
    }),
  );
}

export function createSztabRunner({
  buildLivestreamPayload,
  getApiProfileClient,
  maxCandlesPerTimeframe = DEFAULT_SZTAB_CANDLE_LIMITS,
  priceService = null,
  publicApiProfiles,
  store,
}) {
  const timers = new Map();
  const triggerWatchers = new Map();
  const executionLocks = new Map();
  const liveProfiles = new Map();

  async function withIntervalExecutionLock(interval, fn) {
    const previous = executionLocks.get(interval) ?? Promise.resolve();
    let release = () => {};
    const currentLock = previous
      .catch(() => {})
      .then(() => new Promise((resolve) => {
        release = resolve;
      }));
    executionLocks.set(interval, currentLock);
    await previous.catch(() => {});

    try {
      return await fn();
    } finally {
      release();
      if (executionLocks.get(interval) === currentLock) {
        executionLocks.delete(interval);
      }
    }
  }

  async function persistRuntime(interval, patch) {
    const config = normalizeConfig(store.getSztabConfig());
    const current = config.intervals[interval] ?? defaultIntervalConfig(interval);
    const next = setIntervalConfig(config, interval, {
      runtime: {
        ...current.runtime,
        ...patch,
      },
    });
    await store.setSztabConfig(next);
    return next.intervals[interval].runtime;
  }

  async function appendLog(message, context = {}) {
    return store.appendLog({ context: { runner: "sztab", ...context }, message });
  }

  function candleLimitForInterval(interval) {
    return Math.max(10000, Number(maxCandlesPerTimeframe?.[interval] ?? DEFAULT_SZTAB_CANDLE_LIMITS[interval] ?? 10000));
  }

  function priceFeedRuntime(symbol, source = "binance_futures") {
    const snapshot = typeof priceService?.snapshot === "function"
      ? priceService.snapshot({ source, symbol: normalizeSymbol(symbol) })
      : null;
    return {
      priceFeedAgeMs: snapshot?.ageMs ?? null,
      priceFeedBackoffUntil: snapshot?.backoffUntil ?? null,
      priceFeedFallbackActive: Boolean(snapshot?.fallbackActive),
      priceFeedLastError: snapshot?.lastError ?? null,
      priceFeedLastWebsocketTickAt: snapshot?.lastWebsocketTickAt ?? null,
      priceFeedMode: snapshot?.mode ?? "rest",
      priceFeedRateLimitCount: snapshot?.rateLimitCount ?? 0,
      priceFeedRequestCount: snapshot?.requestCount ?? 0,
      priceFeedSource: snapshot?.source ?? source,
      priceFeedStatus: snapshot?.status ?? "unknown",
      priceFeedWebsocketAgeMs: snapshot?.websocketAgeMs ?? null,
      priceFeedWebsocketConfigReason: snapshot?.websocketConfigReason ?? "",
      priceFeedWebsocketDisabledReason: snapshot?.websocketDisabledReason ?? "",
      priceFeedWebsocketError: snapshot?.websocketError ?? "",
      priceFeedWebsocketStatus: snapshot?.websocketStatus ?? "unknown",
    };
  }

  function statusFromConfigWithFreshPriceFeed(config) {
    const intervals = statusFromConfig(config);
    for (const interval of SZTAB_INTERVALS) {
      const current = config.intervals[interval];
      const pendingSource = current.runtime?.pendingTriggerOrder?.priceSource;
      const source = String(process.env.SZTAB_PRICE_SOURCE ?? "").toLowerCase() === "binance_futures"
        ? "binance_futures"
        : pendingSource || current.runtime?.lastPriceSource || "binance_futures";
      intervals[interval] = {
        ...intervals[interval],
        runtime: {
          ...intervals[interval].runtime,
          ...priceFeedRuntime(current.symbol, source),
        },
      };
    }
    return intervals;
  }

  function globalExecutionDiagnostics() {
    const state = store.getState();
    const botStatus = state.botStatus ?? "STOPPED";
    const safetyAgeSeconds = secondsSinceIso(state.safety?.lastCheckAt);
    const safetyStale = state.safety?.blocked && (safetyAgeSeconds === null || safetyAgeSeconds > 180);
    const safetyFresh = state.safety?.blocked && !safetyStale;
    const activeLegacySafetyBlock = Boolean(safetyFresh && ["LIVE_RUNNING", "PAPER_RUNNING"].includes(botStatus));
    const crisisModeOn = Boolean(state.crisisMode || botStatus === "CRISIS");
    const crisisManualLock = Boolean(crisisModeOn || state.stopNewEntries || botStatus === "PAUSED");
    const globalBlockers = [];

    if (state.globalEmergencyStop) {
      globalBlockers.push({
        source: "globalEmergencyStop",
        value: true,
        reason: "Global emergency stop is active",
      });
    }
    if (crisisManualLock) {
      globalBlockers.push({
        source: "crisis/manual",
        value: {
          botStatus,
          crisisMode: Boolean(state.crisisMode),
          stopNewEntries: Boolean(state.stopNewEntries),
        },
        reason: "Crisis/manual lock is active",
      });
    }
    if (activeLegacySafetyBlock) {
      globalBlockers.push({
        source: "legacySafetyGuardian",
        value: state.safety,
        reason: "Fresh legacy Safety Guardian block is active",
      });
    }
    const tradingBlockedForAI = globalBlockers.length > 0;

    return {
      botStatus,
      crisisModeOn,
      crisisManualLock,
      executionAllowed: !tradingBlockedForAI,
      globalBlockers,
      globalExecutionState: tradingBlockedForAI ? "blocked" : "enabled",
      legacySafetyAgeSeconds: safetyAgeSeconds,
      legacySafetyStale: Boolean(safetyStale),
      legacySafetyStatus: state.safety?.status ?? "NOT_CHECKED",
      legacySafetyWarnings: state.safety?.warnings ?? [],
      tradingEnabled: !tradingBlockedForAI,
      tradingBlockedForAI,
    };
  }

  async function initialize() {
    const config = normalizeConfig(store.getSztabConfig());
    const autoResume = process.env.SZTAB_AUTO_RESUME_ON_START === "true";
    const intervalsToResume = [];
    let changed = false;

    for (const interval of SZTAB_INTERVALS) {
      const runtime = config.intervals[interval].runtime;
      if (isRunningStatus(runtime.status) || runtime.status === "starting") {
        if (autoResume) {
          runtime.status = "recovering";
          runtime.error = "";
          runtime.globalBlockers = [];
          runtime.globalExecutionState = "enabled";
          runtime.intervalBlockers = [];
          runtime.lastBlockedReason = "";
          runtime.lastDecision = "Backend restarted; auto-resume is enabled and Sztab will attempt safe recovery.";
          runtime.lastDecisionReason = "startup_auto_recovery_pending";
          runtime.tradingBlockedForAI = false;
          runtime.tradingEnabled = true;
          intervalsToResume.push(interval);
        } else {
          runtime.status = "interrupted";
          runtime.error = "Backend restarted while this interval runner was active.";
          runtime.globalBlockers = [];
          runtime.globalExecutionState = "enabled";
          runtime.intervalBlockers = [{
            reason: "Backend restarted while this interval runner was active",
            source: "stale_runtime_lock",
            type: "stale_runtime_lock",
          }];
          runtime.lastBlockedReason = "";
          runtime.lastDecisionReason = "runtime_interrupted";
          runtime.stoppedAt = nowIso();
          runtime.tradingBlockedForAI = false;
          runtime.tradingEnabled = false;
        }
        changed = true;
      } else if (runtime.status !== "running") {
        runtime.globalBlockers = [];
        runtime.globalExecutionState = "enabled";
        runtime.lastBlockedReason = "";
        runtime.tradingBlockedForAI = false;
        runtime.tradingEnabled = false;
        if (!Array.isArray(runtime.intervalBlockers)) {
          runtime.intervalBlockers = runtime.lastDecisionReason === "stopped_by_operator"
            ? [{
                reason: "Sztab interval runner is stopped by operator",
                source: "operator_stop",
                type: "operator_stop",
              }]
            : [];
        }
        changed = true;
      }
    }

    if (changed) {
      await store.setSztabConfig(config);
    }

    if (intervalsToResume.length) {
      for (const interval of intervalsToResume) {
        try {
          const result = await start(interval, {
            confirmExistingExposure: true,
            confirmOpenOrders: true,
            recoveredAfterRestart: true,
          });
          if (!result?.ok) {
            await persistRuntime(interval, {
              error: result?.message ?? "Auto-resume did not pass startup validation.",
              intervalBlockers: [{
                reason: result?.message ?? "Auto-resume did not pass startup validation",
                source: "startup_auto_recovery",
                type: "startup_auto_recovery_blocked",
              }],
              lastDecision: "Auto-resume after backend startup was blocked. Manual restart required.",
              lastDecisionReason: "startup_auto_recovery_blocked",
              status: "interrupted",
              tradingEnabled: false,
            });
          }
          await appendLog("Sztab interval auto-resume attempted after backend startup", { interval, result });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await persistRuntime(interval, {
            error: message,
            intervalBlockers: [{
              reason: "Auto-resume after backend startup failed",
              source: "startup_auto_recovery",
              type: "startup_auto_recovery_failed",
            }],
            lastDecision: "Auto-resume after backend startup failed. Manual restart required.",
            lastDecisionReason: "startup_auto_recovery_failed",
            status: "interrupted",
            tradingEnabled: false,
          });
          await appendLog("Sztab interval auto-resume failed after backend startup", { error: message, interval });
        }
      }
    }

    const profiles = store.getProfiles();
    const userProfiles = profiles.filter((profile) => !(profile.runner === "sztab" || String(profile.id ?? "").startsWith("sztab-")));
    if (userProfiles.length !== profiles.length) {
      await store.setProfiles(userProfiles);
      await appendLog("Removed generated Sztab runtime profiles from the shared Battle runner store");
    }
  }

  async function getConfig() {
    return normalizeConfig(store.getSztabConfig());
  }

  async function updateConfig(interval, body = {}) {
    if (!SZTAB_INTERVALS.includes(interval)) {
      return { ok: false, message: "Unsupported Sztab interval." };
    }

    const config = normalizeConfig(store.getSztabConfig());
    const current = config.intervals[interval] ?? defaultIntervalConfig(interval);
    const nextInterval = {
      ...current,
      apiProfile: body.apiProfile !== undefined ? String(body.apiProfile || "") : current.apiProfile,
      locked: body.locked !== undefined ? Boolean(body.locked) : current.locked,
      mm: body.mm ? { ...current.mm, ...body.mm } : current.mm,
      mmLocked: body.mmLocked !== undefined ? Boolean(body.mmLocked) : current.mmLocked,
      mmSavedAt: body.saveMm ? nowIso() : current.mmSavedAt,
      strategy: body.strategy ? { ...current.strategy, ...body.strategy } : current.strategy,
      strategyLocked: body.strategyLocked !== undefined ? Boolean(body.strategyLocked) : current.strategyLocked,
      strategySavedAt: body.saveStrategy ? nowIso() : current.strategySavedAt,
      symbol: body.symbol ? normalizeSymbol(body.symbol) : current.symbol,
    };
    nextInterval.locked = nextInterval.strategyLocked && nextInterval.mmLocked;

    const apiProfiles = await publicApiProfiles({ fresh: false }).catch(() => []);
    nextInterval.validation = validationFor(nextInterval, apiProfiles);
    const nextConfig = setIntervalConfig(config, interval, nextInterval);
    const saved = await store.setSztabConfig(nextConfig);

    return {
      config: saved,
      interval: saved.intervals[interval],
      ok: true,
    };
  }

  async function syncInterval(interval) {
    if (!SZTAB_INTERVALS.includes(interval)) {
      return { ok: false, message: "Unsupported Sztab interval." };
    }

    const apiProfiles = await publicApiProfiles({ fresh: true });
    const livestream = buildLivestreamPayload(apiProfiles);
    const summary = livestream.accountSummary ?? {};
    const fresh = summary.source === "fresh BingX";
    await persistRuntime(interval, {
      ...clearTransientBlockers(),
      dataAgeSeconds: accountDataAgeSeconds(summary),
      lastSyncAt: summary.lastRefreshAt ?? nowIso(),
      lastDecision: fresh
        ? "Fresh BingX sync completed."
        : `Sync attempted; source is ${summary.source ?? "unavailable"}.`,
      lastDecisionReason: fresh ? "fresh_sync_completed" : "sync_source_not_fresh",
    });
    return { apiProfiles, livestream, ok: true };
  }

  async function assertStartable(interval, body = {}) {
    const config = normalizeConfig(store.getSztabConfig());
    const current = config.intervals[interval];
    const sync = await syncInterval(interval);
    const apiProfiles = sync.apiProfiles;
    const profile = apiProfiles.find((item) => item.id === current.apiProfile);
    const validation = validationFor(current, apiProfiles);

    if (!validation.ok) {
      await store.setSztabConfig(setIntervalConfig(config, interval, { validation }));
      return { ok: false, status: 400, message: validation.errors.join(" "), validation };
    }
    if (!profile || profile.status !== "connected") {
      return { ok: false, status: 400, message: "Selected API profile is not freshly connected to BingX." };
    }

    const livestream = sync.livestream;
    const matchingPositions = (livestream.positions ?? []).filter((position) => {
      const profileMatch = position.apiProfile === current.apiProfile || position.sourceProfileId === current.apiProfile;
      const symbolMatch = compactSymbol(position.symbol) === compactSymbol(current.symbol);
      return profileMatch && symbolMatch;
    });
    const missingSl = matchingPositions.filter((position) => !Number(position.stopLoss));

    if (missingSl.length > 0) {
      return { ok: false, status: 409, message: "Start blocked: an existing position has no active SL protection.", positions: matchingPositions };
    }
    if (matchingPositions.length > 0 && body.confirmExistingExposure !== true) {
      return {
        needsConfirmation: true,
        ok: false,
        status: 409,
        message: "Active position exists on this profile/symbol. Confirm start if you want Sztab to run with existing exposure.",
        positions: matchingPositions,
      };
    }
    if (Number(profile.openOrders ?? 0) > 0 && body.confirmOpenOrders !== true) {
      return {
        needsConfirmation: true,
        ok: false,
        status: 409,
        message: "Open orders exist on this profile. Confirm start if these orders are expected.",
      };
    }

    return { config: current, ok: true };
  }

  async function tick(interval) {
    const loopStartedAt = Date.now();
    const config = normalizeConfig(store.getSztabConfig());
    const current = config.intervals[interval];
    if (!current || !isRunningStatus(current.runtime?.status)) return null;
    const candlesRequested = candleLimitForInterval(interval);
    const executionDiagnostics = globalExecutionDiagnostics();

    await persistRuntime(interval, {
      ...executionDiagnostics,
      candlesRequested,
      heartbeatAt: nowIso(),
      intervalBlockers: [],
      lastTickAt: nowIso(),
      lastDecision: "Running strategy tick...",
      tickCount: Number(current.runtime?.tickCount ?? 0) + 1,
    });

    try {
      const client = getApiProfileClient(current.apiProfile);
      const apiProfiles = await publicApiProfiles({ fresh: false }).catch(() => []);
      const publicProfile = apiProfiles.find((item) => item.id === current.apiProfile);
      const profileSyncAt = publicProfile?.lastSyncAt ?? publicProfile?.lastRefreshAt ?? null;
      const existingProfile = liveProfiles.get(interval) ?? {};
      let profile = configToProfile({
        ...current,
        apiProfileLabel: current.apiProfile,
      }, existingProfile);
      const exchangePositions = normalizeExchangeList(await client.getOpenPositions(profile.symbol))
        .filter((position) => compactSymbol(position.symbol) === compactSymbol(profile.symbol) && positionAmount(position) > 0);
      profile = reconcileLocalScenarioWithExchange(profile, exchangePositions);

      if (exchangePositions.length > 0 && !profile.live?.openPosition && !isActivePendingTrigger(profile.live?.pendingTriggerOrder)) {
        await persistRuntime(interval, {
          ...executionDiagnostics,
          consecutiveErrors: 0,
          intervalBlockers: [],
          lastBlockedReason: "Exchange position exists; Sztab skipped new entry to avoid duplicate exposure.",
          lastDecision: "Exchange position exists; Sztab skipped new entry to avoid duplicate exposure.",
          lastDecisionReason: "existing_exchange_position",
          lastLoopDurationMs: Date.now() - loopStartedAt,
          lastSyncAt: nowIso(),
          profileConnected: publicProfile?.status === "connected",
        });
        await appendLog("Sztab skipped entry because exchange position exists", { interval, profileId: profile.id, symbol: profile.symbol });
        return null;
      }

      const strategyResult = await runStrategyForProfile(profile, { limit: candlesRequested });
      const lastCandle = strategyResult.sourceCandles.at(-1);
      const rawLastSignal = strategyResult.latestEvent
        ? eventSummary(strategyResult.latestEvent, profile)
        : null;
      const rawLatestEntryEvent = eventSummary(strategyResult.latestEntryEvent, profile);
      const latestSetupEvent = eventSummary(strategyResult.latestSetupEvent, profile);
      const latestEntryFingerprint = rawLatestEntryEvent?.setupFingerprint ?? "";
      const latestSetupFingerprint = latestSetupEvent?.setupFingerprint ?? "";
      const staleEntryIgnoredReason = rawLatestEntryEvent && latestSetupEvent && latestEntryFingerprint && latestSetupFingerprint && latestEntryFingerprint !== latestSetupFingerprint
        ? "latest_entry_fingerprint_mismatch_with_current_setup"
        : "";
      const latestEntryEvent = staleEntryIgnoredReason ? null : rawLatestEntryEvent;
      const lastSignalStaleReason = rawLastSignal && latestSetupEvent && rawLastSignal.setupFingerprint && latestSetupFingerprint && rawLastSignal.setupFingerprint !== latestSetupFingerprint
        ? "latest_signal_fingerprint_mismatch_with_current_setup"
        : "";
      const lastSignal = lastSignalStaleReason ? null : rawLastSignal;

      if (lastSignal && executionDiagnostics.globalBlockers.length > 0) {
        const blockedReason = executionDiagnostics.globalBlockers.map((blocker) => blocker.reason).join("; ");
        const currentRuntimeContext = deriveCurrentRuntimeContext({
          latestSetupEvent,
          pending: null,
          runtime: {
            ...(current.runtime ?? {}),
            lastBlockedReason: blockedReason,
            lastDecision: "Fresh signal blocked by global execution lock.",
            lastDecisionReason: "global_execution_block",
          },
        });
        await persistRuntime(interval, {
          ...executionDiagnostics,
          ...currentRuntimeContext,
          candlesLoaded: strategyResult.rawCandles.length,
          candlesRequested,
          closedCandlesUsed: strategyResult.sourceCandles.length,
          consecutiveErrors: 0,
          error: "",
          intervalBlockers: [],
          lastBlockedReason: blockedReason,
          lastCandle: lastCandle
            ? {
                close: lastCandle.close,
                high: lastCandle.high,
                low: lastCandle.low,
                open: lastCandle.open,
                time: lastCandle.time,
              }
            : null,
          lastClosedCandleTime: strategyResult.diagnostics?.lastClosedCandleTime ?? lastCandle?.time ?? null,
          lastDecision: "Fresh signal blocked by global execution lock.",
          lastDecisionReason: "global_execution_block",
          lastError: "",
          lastLoopDurationMs: Date.now() - loopStartedAt,
          lastSignal,
          lastSyncAt: nowIso(),
          latestEntryEvent,
          latestEntryFingerprint,
          latestSetupEvent,
          latestSetupFingerprint,
          profileConnected: publicProfile?.status === "connected",
          staleEntryIgnoredReason: staleEntryIgnoredReason || lastSignalStaleReason,
          staleLatestEntryFingerprint: latestEntryFingerprint,
          validNweBandCount: strategyResult.diagnostics?.validNweBandCount ?? 0,
        });
        await appendLog("Sztab signal blocked by global execution lock", {
          blockers: executionDiagnostics.globalBlockers,
          interval,
          profileId: profile.id,
          signal: lastSignal,
        });
        return profile;
      }

      const updatedProfile = await withIntervalExecutionLock(interval, async () => {
        const lockedExistingProfile = liveProfiles.get(interval) ?? profile;
        const lockedProfile = configToProfile({
          ...current,
          apiProfileLabel: current.apiProfile,
        }, lockedExistingProfile);
        return processLiveProfileExecution({
          bingxClient: client,
          logger: (message, context) => appendLog(message, { interval, profileId: lockedProfile.id, ...context }),
          priceService,
          profile: lockedProfile,
          store,
          strategyResult,
        });
      });
      liveProfiles.set(interval, updatedProfile);

      const lastOrderAttempt = updatedProfile.live?.orderLog?.at?.(-1) ?? null;
      const lastExchangeResponse = lastOrderAttempt
        ? {
          marketOrder: lastOrderAttempt.marketOrder ?? null,
          triggerOrder: lastOrderAttempt.triggerOrder ?? null,
          stopOrder: lastOrderAttempt.stopOrder ?? null,
          takeProfitOrder: lastOrderAttempt.takeProfitOrder ?? null,
          time: lastOrderAttempt.time ?? null,
        }
        : null;
      const pendingTriggerOrder = updatedProfile.live?.pendingTriggerOrder ?? null;
      const triggerOrderState = pendingTriggerOrder?.status ?? "none";
      const triggerSummary = triggerRuntimeSummary(pendingTriggerOrder, updatedProfile.live);
      const currentRuntimeContext = deriveCurrentRuntimeContext({
        latestSetupEvent,
        pending: pendingTriggerOrder,
        runtime: {
          ...(current.runtime ?? {}),
          lastBlockedReason: "",
          lastDecision: pendingTriggerOrder
            ? triggerOrderDecisionText(pendingTriggerOrder)
            : lastSignal
              ? `Latest ${lastSignal.direction} signal ${lastSignal.setupId}`
              : "No fresh entry signal on latest closed candle.",
          lastDecisionReason: lastSignal
            ? "fresh_executable_entry_signal"
            : pendingTriggerOrder
              ? `trigger_order_${triggerOrderState}`
              : latestEntryEvent
                ? "latest_entry_signal_is_historical_or_stale"
                : "no_entry_signal",
          setupOrderJournal: triggerSummary.setupOrderJournal,
        },
      });
      const orderFingerprintMatchesLatestSetup = Boolean(
        pendingTriggerOrder?.setupFingerprint &&
        latestSetupEvent?.setupFingerprint &&
        pendingTriggerOrder.setupFingerprint === latestSetupEvent.setupFingerprint,
      );
      if (isActivePendingTrigger(pendingTriggerOrder)) {
        scheduleTriggerWatcher(interval);
      } else {
        clearTriggerWatcher(interval);
      }
      const lastDecisionReason = lastSignal
        ? "fresh_executable_entry_signal"
        : pendingTriggerOrder
          ? `trigger_order_${triggerOrderState}`
        : latestEntryEvent
          ? "latest_entry_signal_is_historical_or_stale"
          : "no_entry_signal";
      await persistRuntime(interval, {
        ...executionDiagnostics,
        ...priceFeedRuntime(updatedProfile.symbol ?? current.symbol, pendingTriggerOrder?.priceSource ?? "binance_futures"),
        ...currentRuntimeContext,
        autoRecoveryStatus: current.runtime?.runnerDegraded ? "recovered" : current.runtime?.autoRecoveryStatus ?? "",
        candlesLoaded: strategyResult.rawCandles.length,
        candlesRequested,
        closedCandlesUsed: strategyResult.sourceCandles.length,
        consecutiveErrors: 0,
        dataAgeSeconds: accountDataAgeSeconds({ lastRefreshAt: profileSyncAt ?? nowIso() }),
        error: "",
        intervalBlockers: [],
        lastCandle: lastCandle
          ? {
              close: lastCandle.close,
              high: lastCandle.high,
              low: lastCandle.low,
              open: lastCandle.open,
              time: lastCandle.time,
            }
          : null,
        lastBlockedReason: "",
        lastClosedCandleTime: strategyResult.diagnostics?.lastClosedCandleTime ?? lastCandle?.time ?? null,
        lastDecision: pendingTriggerOrder
          ? triggerOrderDecisionText(pendingTriggerOrder)
          : lastSignal
            ? `Latest ${lastSignal.direction} signal ${lastSignal.setupId}`
            : "No fresh entry signal on latest closed candle.",
        lastDecisionReason,
        lastError: "",
        lastExchangeResponse: lastExchangeResponse ?? (pendingTriggerOrder?.lastOrderStatus
          ? {
              orderStatus: pendingTriggerOrder.lastOrderStatus,
              triggerOrder: pendingTriggerOrder.exchangeResponse ?? null,
              time: pendingTriggerOrder.lastStatusCheckAt ?? pendingTriggerOrder.updatedAt ?? nowIso(),
            }
          : null),
        lastLoopDurationMs: Date.now() - loopStartedAt,
        lastOrderAttempt,
        lastSignal,
        lastSyncAt: nowIso(),
        nextRecoveryAt: null,
        pendingTriggerOrder,
        runnerDegraded: false,
        activeScenarioCanBlockNewSetup: triggerSummary.activeScenarioCanBlockNewSetup,
        canArmNextSetup: triggerSummary.canArmNextSetup,
        exchangeTerminalStatus: triggerSummary.exchangeTerminalStatus,
        lastExchangeStatus: triggerSummary.lastExchangeStatus,
        lastStatusCheckAt: triggerSummary.lastStatusCheckAt,
        orderFingerprintMatchesLatestSetup: pendingTriggerOrder?.setupFingerprint && latestSetupEvent?.setupFingerprint
          ? orderFingerprintMatchesLatestSetup
          : null,
        cleanupFailureClassification: triggerSummary.cleanupFailureClassification,
        cleanupFailureMessage: triggerSummary.cleanupFailureMessage,
        cleanupFailureReason: triggerSummary.cleanupFailureReason,
        executionMode: triggerSummary.executionMode,
        executionPrice: triggerSummary.executionPrice,
        ignoredPreEligibilityTriggerTicks: triggerSummary.ignoredPreEligibilityTriggerTicks,
        lastMarkPrice: triggerSummary.lastMarkPrice,
        lastPriceSource: triggerSummary.lastPriceSource,
        lastTriggerFailureCandidate: triggerSummary.lastTriggerFailureCandidate,
        lastTriggerFailureDiagnostics: triggerSummary.lastTriggerFailureDiagnostics,
        lastTriggerFailureReason: triggerSummary.lastTriggerFailureReason,
        livePositionConfirmed: triggerSummary.livePositionConfirmed,
        liveProtectionConfirmed: triggerSummary.liveProtectionConfirmed,
        activeSetupFingerprint: triggerSummary.activeSetupFingerprint,
        activeSetupFingerprintShort: triggerSummary.activeSetupFingerprintShort,
        latestEntryEvent,
        latestEntryFingerprint,
        latestSetupEvent,
        latestSetupFingerprint,
        pendingOrderAgeSeconds: triggerSummary.pendingOrderAgeSeconds,
        platformMarketEntrySent: triggerSummary.marketOrderSent,
        platformTriggerCrossed: triggerSummary.platformTriggerCrossed,
        platformTriggerCrossedAt: triggerSummary.platformTriggerCrossedAt,
        platformTriggerDiagnostics: triggerSummary.platformTriggerDiagnostics,
        platformTriggerSkippedReason: triggerSummary.platformTriggerSkippedReason,
        platformTriggerSlippagePct: triggerSummary.platformTriggerSlippagePct,
        protectionOrderId: triggerSummary.protectionOrderId,
        protectionSource: triggerSummary.protectionSource,
        reversalFromDirection: triggerSummary.reversalFromDirection,
        reversalReason: triggerSummary.reversalReason,
        reversalStatus: triggerSummary.reversalStatus,
        reversalTrigger: triggerSummary.reversalTrigger,
        profileConnected: publicProfile?.status === "connected",
        scenarioTerminalReason: triggerSummary.scenarioTerminalReason,
        setupFingerprint: latestSetupFingerprint || triggerSummary.setupFingerprint || "",
        setupFingerprintShort: latestSetupEvent?.setupFingerprintShort || triggerSummary.setupFingerprintShort || "",
        slPlacementStatus: pendingTriggerOrder?.status === "filled_protected"
          ? "placed"
          : pendingTriggerOrder?.status === "filled_sl_failed"
            ? "failed"
            : pendingTriggerOrder?.stopOrder
              ? "placed"
              : "not_placed",
        setupOrderJournal: triggerSummary.setupOrderJournal,
        staleEntryIgnoredReason: staleEntryIgnoredReason || lastSignalStaleReason,
        supersededBySetupFingerprint: triggerSummary.supersededBySetupFingerprint,
        supersededBySetupId: triggerSummary.supersededBySetupId,
        triggerDistanceAtFailurePct: triggerSummary.triggerDistanceAtFailurePct,
        triggerDistanceAtPlacementPct: triggerSummary.triggerDistanceAtPlacementPct,
        triggerEligibleFrom: triggerSummary.triggerEligibleFrom,
        triggerEligibleFromIso: triggerSummary.triggerEligibleFromIso,
        triggerMarginDiagnostics: triggerSummary.triggerMarginDiagnostics,
        triggerFailureClassification: triggerSummary.triggerFailureClassification,
        triggerOrderExecutedQty: triggerSummary.triggerOrderExecutedQty,
        triggerOrderFillDetected: triggerSummary.triggerOrderFillDetected,
        triggerOrderState,
        status: "running",
        validNweBandCount: strategyResult.diagnostics?.validNweBandCount ?? 0,
      });

      return updatedProfile;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const consecutiveErrors = Number(current.runtime?.consecutiveErrors ?? 0) + 1;
      const maxConsecutiveErrors = Number(process.env.SZTAB_MAX_CONSECUTIVE_ERRORS || 5);
      const transientError = isTransientRunnerError(error);
      const autoRecover = autoRecoverRunners() && transientError;
      const transientLimit = maxTransientErrorsBeforePause();
      const terminalError = !autoRecover && consecutiveErrors >= maxConsecutiveErrors;
      const recoveryCooldown = runnerRecoveryCooldownMs();
      const nextRecoveryAt = autoRecover
        ? new Date(Date.now() + recoveryCooldown).toISOString()
        : null;
      const degradedStatus = autoRecover && consecutiveErrors >= transientLimit ? "degraded" : "running";
      await persistRuntime(interval, {
        ...priceFeedRuntime(current.symbol, current.runtime?.lastPriceSource ?? "binance_futures"),
        autoRecoveryStatus: autoRecover ? "cooldown" : "",
        consecutiveErrors,
        intervalBlockers: [{
          reason: autoRecover
            ? "Runner zwolnił przez limit API lub chwilowy błąd sieci, ale nadal działa."
            : terminalError
            ? "Sztab interval runner failed repeatedly"
            : "Sztab interval runner tick failed; retry is scheduled",
          source: autoRecover ? "runner_auto_recovery" : terminalError ? "runner_error" : "runner_retry",
          type: autoRecover ? "runner_auto_recovery" : terminalError ? "runner_error" : "runner_retry",
        }],
        lastError: message,
        lastLoopDurationMs: Date.now() - loopStartedAt,
        error: autoRecover ? "" : message,
        lastDecision: autoRecover
          ? `Runner zwolnił przez limit API/błąd sieci (${consecutiveErrors}/${transientLimit}); automatycznie spróbuje dalej.`
          : terminalError
          ? "Sztab interval runner failed repeatedly and was stopped."
          : `Sztab interval tick failed (${consecutiveErrors}/${maxConsecutiveErrors}); retrying next cycle.`,
        lastDecisionReason: autoRecover ? "runner_auto_recovery" : terminalError ? "runner_error" : "runner_retry",
        nextRecoveryAt,
        runnerDegraded: Boolean(autoRecover),
        status: terminalError ? "error" : degradedStatus,
      });
      await appendLog(autoRecover ? "Sztab interval runner transient error; auto recovery active" : "Sztab interval runner error", {
        autoRecover,
        consecutiveErrors,
        error: message,
        interval,
        terminalError,
        transientError,
      });
      if (terminalError) {
        clearTimer(interval);
        throw error;
      }
      return null;
    }
  }

  function clearTimer(interval) {
    const timer = timers.get(interval);
    if (timer) {
      clearInterval(timer);
      timers.delete(interval);
    }
  }

  function triggerFailureCandidate(pending = {}) {
    if (pending?.failureDiagnostics?.triggerAlreadyCrossed) return "trigger_price_invalid_or_crossed";
    return pending?.failureCandidate ?? "";
  }

  function triggerRuntimeSummary(pending, live = {}) {
    const isActive = isActivePendingTrigger(pending);
    const status = String(pending?.status ?? "none");
    return {
      activeScenarioCanBlockNewSetup: Boolean(live?.activeScenarioCanBlockNewSetup ?? isActive),
      activeSetupFingerprint: pending?.setupFingerprint ?? "",
      activeSetupFingerprintShort: pending?.setupFingerprintShort ?? "",
      canArmNextSetup: pending ? Boolean(pending.canArmNextSetup ?? !isActive) : true,
      executionMode: pending?.executionMode ?? sztabExecutionMode(),
      exchangeTerminalStatus: pending?.exchangeTerminalStatus ?? (pending?.terminal ? pending?.lastExchangeStatus ?? status : ""),
      executionPrice: pending?.executionPrice ?? null,
      lastExchangeStatus: pending?.lastExchangeStatus ?? "",
      lastMarkPrice: pending?.lastMarkPrice ?? pending?.platformTriggerDiagnostics?.markPrice ?? null,
      lastPriceSource: pending?.lastPriceSource ?? pending?.priceSource ?? pending?.platformTriggerDiagnostics?.priceSource ?? null,
      lastStatusCheckAt: pending?.lastStatusCheckAt ?? null,
      cleanupFailureClassification: live?.lastCleanupWarning?.classification ?? "",
      cleanupFailureMessage: live?.lastCleanupWarning?.message ?? "",
      cleanupFailureReason: live?.lastCleanupWarning?.reason ?? "",
      lastTriggerFailureCandidate: triggerFailureCandidate(pending),
      lastTriggerFailureDiagnostics: pending?.failureDiagnostics ?? null,
      lastTriggerFailureReason: pending?.terminalReason ?? pending?.failureClassification ?? pending?.critical ?? "",
      livePositionConfirmed: Boolean(live?.livePositionConfirmed),
      liveProtectionConfirmed: Boolean(live?.liveProtectionConfirmed),
      marketOrderSent: Boolean(pending?.marketOrderSent),
      pendingOrderAgeSeconds: pending?.acceptedAt || pending?.updatedAt || pending?.createdAt
        ? secondsSinceIso(pending.acceptedAt ?? pending.updatedAt ?? pending.createdAt)
        : null,
      ignoredPreEligibilityTriggerTicks: pending?.ignoredPreEligibilityTriggerTicks ?? pending?.platformTriggerDiagnostics?.ignoredPreEligibilityTriggerTicks ?? 0,
      priceFeedAgeMs: pending?.platformTriggerDiagnostics?.priceFeed?.ageMs ?? null,
      priceFeedFallbackActive: Boolean(pending?.platformTriggerDiagnostics?.priceFeed?.fallbackActive),
      priceFeedLastWebsocketTickAt: pending?.platformTriggerDiagnostics?.priceFeed?.lastWebsocketTickAt ?? null,
      priceFeedMode: pending?.platformTriggerDiagnostics?.priceFeed?.mode ?? null,
      priceFeedRateLimitCount: pending?.platformTriggerDiagnostics?.priceFeed?.rateLimitCount ?? null,
      priceFeedStatus: pending?.platformTriggerDiagnostics?.priceFeed?.status ?? null,
      priceFeedWebsocketAgeMs: pending?.platformTriggerDiagnostics?.priceFeed?.websocketAgeMs ?? null,
      priceFeedWebsocketConfigReason: pending?.platformTriggerDiagnostics?.priceFeed?.websocketConfigReason ?? "",
      priceFeedWebsocketDisabledReason: pending?.platformTriggerDiagnostics?.priceFeed?.websocketDisabledReason ?? "",
      priceFeedWebsocketError: pending?.platformTriggerDiagnostics?.priceFeed?.websocketError ?? "",
      priceFeedWebsocketStatus: pending?.platformTriggerDiagnostics?.priceFeed?.websocketStatus ?? null,
      platformTriggerCrossed: Boolean(pending?.triggerCrossed),
      platformTriggerCrossedAt: pending?.triggerCrossedAt ?? null,
      platformTriggerDiagnostics: pending?.platformTriggerDiagnostics ?? null,
      platformTriggerSkippedReason: pending?.skippedReason ?? "",
      platformTriggerSlippagePct: pending?.triggerSlippagePct ?? null,
      protectionOrderId: live?.protectionOrderId ?? pending?.stopOrder?.orderId ?? pending?.stopOrder?.data?.orderId ?? null,
      protectionSource: live?.protectionSource ?? pending?.protectionSource ?? (pending ? "local_planned" : "none"),
      reversalFromDirection: pending?.reversalFromDirection ?? "",
      reversalReason: pending?.reversalReason ?? "",
      reversalStatus: pending?.reversalStatus ?? "",
      reversalTrigger: Boolean(pending?.isReversal),
      scenarioTerminalReason: live?.scenarioTerminalReason ?? pending?.terminalReason ?? "",
      setupFingerprint: pending?.setupFingerprint ?? "",
      setupFingerprintShort: pending?.setupFingerprintShort ?? "",
      setupOrderJournal: (live?.setupOrderJournal ?? []).slice(-100),
      staleEntryIgnoredReason: pending?.staleEntryIgnoredReason ?? pending?.platformTriggerDiagnostics?.staleEntryIgnoredReason ?? "",
      staleLatestEntryFingerprint: pending?.staleLatestEntryFingerprint ?? pending?.platformTriggerDiagnostics?.staleLatestEntryFingerprint ?? "",
      triggerEligibleFrom: pending?.triggerEligibleFrom ?? null,
      triggerEligibleFromIso: pending?.triggerEligibleFromIso ?? null,
      supersededBySetupFingerprint: live?.supersededBySetupFingerprint ?? pending?.supersededBySetupFingerprint ?? null,
      supersededBySetupId: live?.supersededBySetupId ?? pending?.supersededBySetupId ?? null,
      triggerDistanceAtFailurePct: pending?.failureDiagnostics?.distanceFromMarkToTriggerPct ?? null,
      triggerDistanceAtPlacementPct: pending?.placementDiagnostics?.distanceFromMarkToTriggerPct ?? null,
      triggerMarginDiagnostics: pending?.failureDiagnostics ?? pending?.placementDiagnostics ?? null,
      triggerFailureClassification: pending?.failureClassification ?? "",
      triggerOrderExecutedQty: pending?.executedQty ?? null,
      triggerOrderFillDetected: ["filled_protected", "filled_sl_failed", "filled_but_position_missing"].includes(status.toLowerCase()),
      triggerOrderState: status,
    };
  }

  function triggerOrderDecisionText(pending) {
    const status = String(pending?.status ?? "none").toLowerCase();
    if (!pending) return "No pending trigger order.";
    if (status === "platform_armed" && pending.isReversal) {
      return "Pozycja aktywna. Bot czeka na przeciwny trigger do odwrócenia.";
    }
    if (status === "platform_armed") return "Bot pilnuje triggera po stronie Binance Futures; BingX zostanie użyty tylko do egzekucji MARKET.";
    if (status === "setup_invalidated_before_platform_trigger") return "Setup invalidated before platform trigger; no market order was sent.";
    if (status === "trigger_crossed_but_price_too_far") return "Platform trigger crossed, but price moved too far from trigger; market entry skipped.";
    if (status === "platform_market_order_rejected") return "Platform trigger crossed, but BingX rejected the MARKET entry.";
    if (status === "market_sent_position_missing") return "Platform MARKET was sent, but no matching live position was found after sync.";
    if (status === "platform_blocked_existing_position") return "Platform trigger crossed, but a matching live position already exists.";
    if (status === "filled_protected" && pending.isReversal) return "Reversal wykonany.";
    if (status === "filled_protected") return "Trigger order fill detected; SL protection placement requested.";
    if (status === "filled_sl_failed" && pending.isReversal) return "Reversal wykonał wejście, ale SL nie został potwierdzony. Wymagana kontrola ręczna.";
    if (status === "filled_sl_failed") return "Trigger order filled but SL placement failed. Manual crisis management required.";
    if (status === "filled_but_position_missing") return "Trigger order reports fill, but no matching position was found after sync.";
    if (status === "invalidated_before_fill") return "Setup invalidated before trigger fill; pending trigger order was cancelled.";
    if (status === "reversal_close_failed") return "Przeciwny trigger przebity, ale nie udało się zamknąć starej pozycji. Nowa pozycja nie została otwarta.";
    if (status === "reversal_close_succeeded_entry_failed") return "Zamknięto starą pozycję, ale nie udało się otworzyć nowej.";
    if (pending.terminal || ["terminal_failed", "canceled", "cancelled", "expired", "rejected", "missing", "invalidated_before_fill"].includes(status)) {
      return `Trigger order terminal: ${pending.terminalReason ?? pending.failureClassification ?? status}.`;
    }
    return "Pending trigger order is still waiting for fill.";
  }

  function pendingTriggerTouchedByTick(pending = {}, price, time = null) {
    const triggerPrice = Number(pending.triggerPrice ?? pending.entryEvent?.trigger);
    const tickPrice = Number(price);
    if (!Number.isFinite(triggerPrice) || !Number.isFinite(tickPrice)) {
      return { ignoredPreEligibility: false, touched: false };
    }
    const direction = String(pending.direction ?? pending.positionSide ?? pending.side ?? "").toUpperCase();
    const isShort = direction.includes("SHORT") || direction === "SELL";
    const touched = isShort ? tickPrice <= triggerPrice : tickPrice >= triggerPrice;
    if (!touched) return { ignoredPreEligibility: false, touched: false };
    const triggerEligibleFromMs = timeValueMs(pending.triggerEligibleFrom ?? pending.triggerEligibleFromIso ?? pending.setupCandleCloseTime);
    const tickTimeMs = timeValueMs(time);
    if (triggerEligibleFromMs !== null && tickTimeMs !== null && tickTimeMs < triggerEligibleFromMs) {
      return { ignoredPreEligibility: true, touched: false };
    }
    return { ignoredPreEligibility: false, touched: true };
  }

  function clearTriggerWatcher(interval) {
    const watcher = triggerWatchers.get(interval);
    if (watcher) {
      clearInterval(watcher);
      triggerWatchers.delete(interval);
    }
  }

  function scheduleTriggerWatcher(interval) {
    if (triggerWatchers.has(interval)) return;
    triggerWatchers.set(interval, setInterval(() => {
      pollPendingTrigger(interval).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        const transientError = isTransientRunnerError(error);
        persistRuntime(interval, {
          ...priceFeedRuntime(normalizeConfig(store.getSztabConfig()).intervals[interval]?.symbol, "binance_futures"),
          autoRecoveryStatus: transientError ? "cooldown" : "",
          intervalBlockers: transientError
            ? [{
                reason: "Runner zwolnił przez limit API, ale nadal działa.",
                source: "trigger_watcher_auto_recovery",
                type: "trigger_watcher_auto_recovery",
              }]
            : [{
                reason: "Trigger watcher error",
                source: "trigger_watcher_error",
                type: "trigger_watcher_error",
              }],
          lastError: message,
          lastDecision: transientError
            ? "Runner zwolnił przez limit API, ale nadal działa."
            : `Trigger watcher error: ${message}`,
          lastDecisionReason: transientError ? "trigger_watcher_auto_recovery" : "trigger_watcher_error",
          runnerDegraded: Boolean(transientError),
          status: transientError ? "degraded" : "running",
        }).catch(() => {});
        appendLog("Sztab trigger watcher error", {
          error: message,
          interval,
          transientError,
        }).catch(() => {});
      });
    }, triggerWatchMs()));
  }

  async function pollPendingTrigger(interval) {
    return withIntervalExecutionLock(interval, async () => {
    const config = normalizeConfig(store.getSztabConfig());
    const current = config.intervals[interval];
    const existingProfile = liveProfiles.get(interval);
    const pending = existingProfile?.live?.pendingTriggerOrder ?? current?.runtime?.pendingTriggerOrder ?? null;

    if (!current || !isRunningStatus(current.runtime?.status) || !isActivePendingTrigger(pending)) {
      clearTriggerWatcher(interval);
      return null;
    }

    const client = getApiProfileClient(current.apiProfile);
    const profile = configToProfile(current, existingProfile ?? {
      live: {
        pendingTriggerOrder: pending,
      },
    });
    const updatedProfile = await processLiveProfileExecution({
      bingxClient: client,
      logger: (message, context) => appendLog(message, { interval, profileId: profile.id, ...context }),
      priceService,
      profile,
      store,
      strategyResult: {
        latestSetupEvent: null,
        sourceCandles: [],
        strategy: { events: [] },
      },
    });
    liveProfiles.set(interval, updatedProfile);

    const nextPending = updatedProfile.live?.pendingTriggerOrder ?? null;
    const lastOrderAttempt = updatedProfile.live?.orderLog?.at?.(-1) ?? null;
    const triggerSummary = triggerRuntimeSummary(nextPending, updatedProfile.live);
    const currentRuntimeContext = deriveCurrentRuntimeContext({
      latestSetupEvent: current.runtime?.latestSetupEvent ?? null,
      pending: nextPending,
      runtime: {
        ...(current.runtime ?? {}),
        lastDecision: triggerOrderDecisionText(nextPending),
        lastDecisionReason: `trigger_order_${nextPending?.status ?? "none"}`,
        setupOrderJournal: triggerSummary.setupOrderJournal,
      },
    });
    await persistRuntime(interval, {
      ...priceFeedRuntime(updatedProfile.symbol ?? current.symbol, nextPending?.priceSource ?? "binance_futures"),
      ...currentRuntimeContext,
      heartbeatAt: nowIso(),
      lastDecision: triggerOrderDecisionText(nextPending),
      lastDecisionReason: `trigger_order_${nextPending?.status ?? "none"}`,
      lastExchangeResponse: lastOrderAttempt
        ? {
            orderStatus: nextPending?.lastOrderStatus ?? null,
            stopOrder: lastOrderAttempt.stopOrder ?? nextPending?.stopOrder ?? null,
            takeProfitOrder: lastOrderAttempt.takeProfitOrder ?? nextPending?.takeProfitOrder ?? null,
            triggerOrder: lastOrderAttempt.triggerOrder ?? nextPending?.exchangeResponse ?? null,
            time: lastOrderAttempt.time ?? nowIso(),
          }
        : nextPending?.lastOrderStatus
          ? {
              orderStatus: nextPending.lastOrderStatus,
              triggerOrder: nextPending.exchangeResponse ?? null,
              time: nextPending.lastStatusCheckAt ?? nextPending.updatedAt ?? nowIso(),
          }
        : current.runtime?.lastExchangeResponse ?? null,
      lastOrderAttempt,
      pendingTriggerOrder: nextPending,
      activeScenarioCanBlockNewSetup: triggerSummary.activeScenarioCanBlockNewSetup,
      canArmNextSetup: triggerSummary.canArmNextSetup,
      cleanupFailureClassification: triggerSummary.cleanupFailureClassification,
      cleanupFailureMessage: triggerSummary.cleanupFailureMessage,
      cleanupFailureReason: triggerSummary.cleanupFailureReason,
      executionMode: triggerSummary.executionMode,
      executionPrice: triggerSummary.executionPrice,
      exchangeTerminalStatus: triggerSummary.exchangeTerminalStatus,
      lastMarkPrice: triggerSummary.lastMarkPrice,
      lastExchangeStatus: triggerSummary.lastExchangeStatus,
      lastPriceSource: triggerSummary.lastPriceSource,
      lastStatusCheckAt: triggerSummary.lastStatusCheckAt,
      lastTriggerFailureCandidate: triggerSummary.lastTriggerFailureCandidate,
      lastTriggerFailureDiagnostics: triggerSummary.lastTriggerFailureDiagnostics,
      lastTriggerFailureReason: triggerSummary.lastTriggerFailureReason,
      livePositionConfirmed: triggerSummary.livePositionConfirmed,
      liveProtectionConfirmed: triggerSummary.liveProtectionConfirmed,
      activeSetupFingerprint: triggerSummary.activeSetupFingerprint,
      activeSetupFingerprintShort: triggerSummary.activeSetupFingerprintShort,
      ignoredPreEligibilityTriggerTicks: triggerSummary.ignoredPreEligibilityTriggerTicks,
      pendingOrderAgeSeconds: triggerSummary.pendingOrderAgeSeconds,
      platformMarketEntrySent: triggerSummary.marketOrderSent,
      platformTriggerCrossed: triggerSummary.platformTriggerCrossed,
      platformTriggerCrossedAt: triggerSummary.platformTriggerCrossedAt,
      platformTriggerDiagnostics: triggerSummary.platformTriggerDiagnostics,
      platformTriggerSkippedReason: triggerSummary.platformTriggerSkippedReason,
      platformTriggerSlippagePct: triggerSummary.platformTriggerSlippagePct,
      protectionOrderId: triggerSummary.protectionOrderId,
      protectionSource: triggerSummary.protectionSource,
      reversalFromDirection: triggerSummary.reversalFromDirection,
      reversalReason: triggerSummary.reversalReason,
      reversalStatus: triggerSummary.reversalStatus,
      reversalTrigger: triggerSummary.reversalTrigger,
      scenarioTerminalReason: triggerSummary.scenarioTerminalReason,
      setupFingerprint: triggerSummary.setupFingerprint,
      setupFingerprintShort: triggerSummary.setupFingerprintShort,
      setupOrderJournal: triggerSummary.setupOrderJournal,
      staleEntryIgnoredReason: triggerSummary.staleEntryIgnoredReason,
      staleLatestEntryFingerprint: triggerSummary.staleLatestEntryFingerprint,
      slPlacementStatus: nextPending?.status === "filled_protected"
        ? "placed"
        : nextPending?.status === "filled_sl_failed"
          ? "failed"
          : "not_placed",
      status: "running",
      supersededBySetupId: triggerSummary.supersededBySetupId,
      supersededBySetupFingerprint: triggerSummary.supersededBySetupFingerprint,
      triggerDistanceAtFailurePct: triggerSummary.triggerDistanceAtFailurePct,
      triggerDistanceAtPlacementPct: triggerSummary.triggerDistanceAtPlacementPct,
      triggerEligibleFrom: triggerSummary.triggerEligibleFrom,
      triggerEligibleFromIso: triggerSummary.triggerEligibleFromIso,
      triggerMarginDiagnostics: triggerSummary.triggerMarginDiagnostics,
      triggerFailureClassification: triggerSummary.triggerFailureClassification,
      triggerOrderExecutedQty: triggerSummary.triggerOrderExecutedQty,
      triggerOrderFillDetected: triggerSummary.triggerOrderFillDetected,
      triggerOrderState: triggerSummary.triggerOrderState,
    });

    if (!isActivePendingTrigger(nextPending)) {
      clearTriggerWatcher(interval);
    }

    return updatedProfile;
    });
  }

  if (typeof priceService?.onPriceTick === "function") {
    priceService.onPriceTick((tick) => {
      if (tick?.source !== "binance_futures") return;
      const config = normalizeConfig(store.getSztabConfig());
      for (const interval of SZTAB_INTERVALS) {
        const current = config.intervals[interval];
        const existingProfile = liveProfiles.get(interval);
        const pending = existingProfile?.live?.pendingTriggerOrder ?? current?.runtime?.pendingTriggerOrder ?? null;
        if (!current || !isRunningStatus(current.runtime?.status) || !isActivePendingTrigger(pending)) continue;
        if (normalizeSymbol(current.symbol) !== normalizeSymbol(tick.symbol)) continue;
        const touch = pendingTriggerTouchedByTick(pending, tick.price, tick.time);
        if (touch.ignoredPreEligibility) {
          persistRuntime(interval, {
            ignoredPreEligibilityTriggerTicks: Number(current.runtime?.ignoredPreEligibilityTriggerTicks ?? 0) + 1,
            lastDecision: "Tick przebił trigger przed czasem aktywacji setupu; ignoruję go.",
            lastDecisionReason: "pre_eligibility_trigger_tick_ignored",
          }).catch(() => {});
          continue;
        }
        if (!touch.touched) continue;
        pollPendingTrigger(interval).catch((error) => {
          appendLog("Sztab websocket trigger wake failed", {
            error: error instanceof Error ? error.message : String(error),
            interval,
            price: tick.price,
            symbol: tick.symbol,
          }).catch(() => {});
        });
      }
    });
  }

  async function cancelPendingTriggerForInterval(interval, reason = "interval_stopped") {
    const config = normalizeConfig(store.getSztabConfig());
    const current = config.intervals[interval];
    const existingProfile = liveProfiles.get(interval);
    const pending = existingProfile?.live?.pendingTriggerOrder ?? current?.runtime?.pendingTriggerOrder ?? null;

    if (!pending || !["accepted", "placed", "new", "partially_filled", "pending_sync"].includes(String(pending.status ?? "").toLowerCase())) {
      return null;
    }

    try {
      const client = getApiProfileClient(current.apiProfile);
      const profile = configToProfile(current, existingProfile ?? {
        live: {
          pendingTriggerOrder: pending,
        },
      });
      const updatedProfile = await cancelLivePendingTriggerOrder({
        bingxClient: client,
        logger: (message, context) => appendLog(message, { interval, profileId: profile.id, ...context }),
        profile,
        reason,
      });
      liveProfiles.set(interval, updatedProfile);
      const pendingAfterCancel = updatedProfile.live?.pendingTriggerOrder ?? null;
      const triggerSummary = triggerRuntimeSummary(pendingAfterCancel, updatedProfile.live);
      await persistRuntime(interval, {
        lastDecision: `Pending trigger order ${pendingAfterCancel?.status ?? "cancel requested"}: ${reason}.`,
        lastDecisionReason: "pending_trigger_cancelled",
        pendingTriggerOrder: pendingAfterCancel,
        canArmNextSetup: triggerSummary.canArmNextSetup,
        executionMode: triggerSummary.executionMode,
        executionPrice: triggerSummary.executionPrice,
        exchangeTerminalStatus: triggerSummary.exchangeTerminalStatus,
        lastMarkPrice: triggerSummary.lastMarkPrice,
        lastExchangeStatus: triggerSummary.lastExchangeStatus,
        lastPriceSource: triggerSummary.lastPriceSource,
        lastStatusCheckAt: triggerSummary.lastStatusCheckAt,
        lastTriggerFailureCandidate: triggerSummary.lastTriggerFailureCandidate,
        lastTriggerFailureDiagnostics: triggerSummary.lastTriggerFailureDiagnostics,
        lastTriggerFailureReason: triggerSummary.lastTriggerFailureReason,
        pendingOrderAgeSeconds: triggerSummary.pendingOrderAgeSeconds,
        platformMarketEntrySent: triggerSummary.marketOrderSent,
        platformTriggerCrossed: triggerSummary.platformTriggerCrossed,
        platformTriggerCrossedAt: triggerSummary.platformTriggerCrossedAt,
        platformTriggerDiagnostics: triggerSummary.platformTriggerDiagnostics,
        platformTriggerSkippedReason: triggerSummary.platformTriggerSkippedReason,
        platformTriggerSlippagePct: triggerSummary.platformTriggerSlippagePct,
        setupFingerprint: triggerSummary.setupFingerprint,
        setupFingerprintShort: triggerSummary.setupFingerprintShort,
        setupOrderJournal: triggerSummary.setupOrderJournal,
        supersededBySetupFingerprint: triggerSummary.supersededBySetupFingerprint,
        triggerFailureClassification: triggerSummary.triggerFailureClassification,
        triggerDistanceAtFailurePct: triggerSummary.triggerDistanceAtFailurePct,
        triggerDistanceAtPlacementPct: triggerSummary.triggerDistanceAtPlacementPct,
        triggerMarginDiagnostics: triggerSummary.triggerMarginDiagnostics,
        triggerOrderExecutedQty: triggerSummary.triggerOrderExecutedQty,
        triggerOrderFillDetected: triggerSummary.triggerOrderFillDetected,
        triggerOrderState: triggerSummary.triggerOrderState,
      });
      return updatedProfile.live?.pendingTriggerOrder ?? null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await persistRuntime(interval, {
        lastError: message,
        pendingTriggerOrder: {
          ...pending,
          canArmNextSetup: true,
          cancelReason: reason,
          error: message,
          failureClassification: "trigger_order_cancel_failed",
          lastExchangeStatus: "CANCEL_FAILED",
          lastStatusCheckAt: nowIso(),
          terminalReason: "trigger_order_cancel_failed",
          status: "cancel_failed",
          updatedAt: nowIso(),
        },
        canArmNextSetup: true,
        lastExchangeStatus: "CANCEL_FAILED",
        lastStatusCheckAt: nowIso(),
        lastTriggerFailureReason: "trigger_order_cancel_failed",
        triggerFailureClassification: "trigger_order_cancel_failed",
        triggerOrderState: "cancel_failed",
      });
      await appendLog("Sztab pending trigger cancel failed", { error: message, interval, reason });
      return null;
    }
  }

  async function start(interval, body = {}) {
    if (!SZTAB_INTERVALS.includes(interval)) {
      return { ok: false, status: 400, message: "Unsupported Sztab interval." };
    }

    const gate = await assertStartable(interval, body);
    if (!gate.ok) return gate;

    clearTimer(interval);
    const startedAt = nowIso();
    await persistRuntime(interval, {
      ...clearTransientBlockers(),
      autoRecoveryStatus: "",
      currentDecisionTimeline: [{
        event: "runner_started",
        text: "Runner wystartował dla tego interwału.",
        time: startedAt,
      }],
      currentLifecycleOrderIds: [],
      currentRunnerStartedAt: startedAt,
      currentSetupFingerprint: "",
      currentSetupFingerprintShort: "",
      currentSetupOrderJournal: [],
      error: "",
      historicalSetupOrderJournal: [],
      intervalBlockers: [],
      lastDecision: "Starting Sztab interval runner.",
      lastDecisionReason: "starting",
      nextRecoveryAt: null,
      runnerDegraded: false,
      staleHistoricalOrderCount: 0,
      startedAt,
      status: "running",
      stoppedAt: null,
    });
    await appendLog("Sztab interval runner started", { interval });

    try {
      await tick(interval);
    } catch (error) {
      return {
        ok: false,
        status: 500,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    timers.set(interval, setInterval(() => {
      tick(interval).catch(() => {});
    }, DEFAULT_LOOP_MS));

    return {
      interval,
      message: `${intervalLabel(interval)} Sztab runner is running.`,
      ok: true,
      status: (await getStatus()).intervals[interval],
    };
  }

  async function stop(interval) {
    if (!SZTAB_INTERVALS.includes(interval)) {
      return { ok: false, status: 400, message: "Unsupported Sztab interval." };
    }

    clearTimer(interval);
    clearTriggerWatcher(interval);
    await cancelPendingTriggerForInterval(interval, "interval_stopped_by_operator");
    await persistRuntime(interval, {
      ...clearTransientBlockers(),
      autoRecoveryStatus: "",
      intervalBlockers: [{
        reason: "Sztab interval runner is stopped by operator",
        source: "operator_stop",
        type: "operator_stop",
      }],
      lastDecision: "Sztab interval runner stopped by operator.",
      lastDecisionReason: "stopped_by_operator",
      nextRecoveryAt: null,
      runnerDegraded: false,
      status: "stopped",
      stoppedAt: nowIso(),
      tradingEnabled: false,
    });
    await appendLog("Sztab interval runner stopped", { interval });
    return { interval, ok: true, status: (await getStatus()).intervals[interval] };
  }

  async function restart(interval, body = {}) {
    await stop(interval);
    return start(interval, body);
  }

  async function stopAll() {
    for (const interval of SZTAB_INTERVALS) {
      await stop(interval);
    }
    return { ok: true, status: await getStatus() };
  }

  async function syncAll() {
    const results = {};
    for (const interval of SZTAB_INTERVALS) {
      results[interval] = await syncInterval(interval);
    }
    return { ok: true, results, status: await getStatus() };
  }

  async function recoverInterrupted(body = {}) {
    const config = normalizeConfig(store.getSztabConfig());
    const results = {};

    for (const interval of SZTAB_INTERVALS) {
      const runtime = config.intervals[interval]?.runtime ?? {};
      if (!["interrupted", "stalled", "recovering"].includes(String(runtime.status ?? "").toLowerCase())) {
        continue;
      }
      results[interval] = await start(interval, {
        confirmExistingExposure: body.confirmExistingExposure === true,
        confirmOpenOrders: body.confirmOpenOrders === true,
        recoveredAfterRestart: true,
      });
    }

    return { ok: true, results, status: await getStatus() };
  }

  async function cancelPendingTriggers(reason = "operator_cancel_all_pending_triggers") {
    const results = {};
    for (const interval of SZTAB_INTERVALS) {
      results[interval] = await cancelPendingTriggerForInterval(interval, reason);
    }
    return { ok: true, results, status: await getStatus() };
  }

  async function getStatus() {
    const config = normalizeConfig(store.getSztabConfig());
    return {
      config,
      intervals: statusFromConfigWithFreshPriceFeed(config),
      runner: {
        loopMs: DEFAULT_LOOP_MS,
        runningIntervals: [...timers.keys()],
      },
    };
  }

  async function checkSignalParity(interval, context = {}) {
    if (!SZTAB_INTERVALS.includes(interval)) {
      return { ok: false, message: "Unsupported Sztab interval." };
    }

    const config = normalizeConfig(store.getSztabConfig());
    const current = config.intervals[interval];
    const profile = configToProfile(current, liveProfiles.get(interval) ?? {});
    const candlesRequested = candleLimitForInterval(interval);
    const runnerResult = await runStrategyForProfile(profile, { limit: candlesRequested });
    const chart = context.chart ?? {};
    const chartSettings = chart.settings ?? null;
    const chartCandles = Array.isArray(chart.candles) ? chart.candles : [];
    const chartResult = chartCandles.length && chartSettings
      ? runStrategyOnCandles({
          rawCandles: chartCandles,
          strategyParameters: {
            atrLength: chartSettings.atrLength,
            atrMultiplier: chartSettings.atrMultiplier,
            bandwidth: chartSettings.bandwidth,
            envelopeMultiplier: chartSettings.envelopeMultiplier,
            maxSameSideFailures: chartSettings.maxSameSideFailures,
            strategySource: chartSettings.strategySource,
          },
        })
      : null;
    const paramDiffs = [];

    if (chartSettings) {
      for (const [key, label] of [
        ["atrLength", "ATR length"],
        ["atrMultiplier", "ATR multiplier"],
        ["bandwidth", "Bandwidth"],
        ["envelopeMultiplier", "NWE multiplier"],
        ["maxSameSideFailures", "Max same-side failures"],
        ["strategySource", "Strategy source"],
      ]) {
        const runnerValue = profile.strategyParameters[key];
        const chartValue = chartSettings[key];
        if (String(runnerValue) !== String(chartValue)) {
          paramDiffs.push({ chart: chartValue, field: label, runner: runnerValue });
        }
      }
    }

    const runnerSignal = eventSummary(runnerResult.latestEvent);
    const runnerLatestEntry = eventSummary(runnerResult.latestEntryEvent);
    const chartLatestEntry = eventSummary(chartResult?.latestEntryEvent);
    const chartExecutableSignal = eventSummary(chartResult?.latestEvent);
    let explanation = "Runner and chart did not provide enough shared context for a full marker comparison.";

    if (paramDiffs.length > 0) {
      explanation = "Chart and Sztab runner parameters differ, so visible markers may not match live decisions.";
    } else if (chartResult && chartLatestEntry && !runnerLatestEntry) {
      explanation = "Chart has an entry marker in its visible dataset, but the Sztab runner did not produce any entry from its live context.";
    } else if (chartResult && chartLatestEntry && !chartExecutableSignal) {
      explanation = "The latest chart entry marker is historical/stale relative to the latest visible closed candle, not a live executable signal.";
    } else if (runnerResult.diagnostics.validNweBandCount < 10) {
      explanation = "Sztab runner still has too little valid NWE context for reliable live parity.";
    } else if (runnerSignal) {
      explanation = "Sztab has a fresh executable signal; if no order was sent, inspect risk/execution blockers.";
    } else {
      explanation = "Sztab has enough context but no fresh executable entry on the latest closed candle.";
    }

    return {
      ok: true,
      explanation,
      runner: {
        candlesLoaded: runnerResult.rawCandles.length,
        candlesRequested,
        closedCandlesUsed: runnerResult.sourceCandles.length,
        latestEntryEvent: runnerLatestEntry,
        latestExecutableClosedCandleSignal: runnerSignal,
        latestSetupEvent: eventSummary(runnerResult.latestSetupEvent),
        params: profile.strategyParameters,
        validNweBandCount: runnerResult.diagnostics.validNweBandCount,
      },
      chart: {
        candlesProvided: chartCandles.length,
        latestBacktest: context.latestBacktest ?? null,
        latestChartEntry: chartLatestEntry,
        latestExecutableVisibleSignal: chartExecutableSignal,
        markerSource: chart.markerSource ?? "unknown",
        params: chartSettings,
        selectedInterval: chart.selectedInterval ?? null,
        validNweBandCount: chartResult?.diagnostics?.validNweBandCount ?? null,
        window: chart.window ?? null,
      },
      differences: {
        params: paramDiffs,
      },
      summary: explanation,
    };
  }

  return {
    checkSignalParity,
    getConfig,
    getStatus,
    initialize,
    restart,
    recoverInterrupted,
    cancelPendingTriggers,
    start,
    stop,
    stopAll,
    syncAll,
    syncInterval,
    updateConfig,
  };
}

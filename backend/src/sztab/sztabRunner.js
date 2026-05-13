import { cancelLivePendingTriggerOrder, processLiveProfileExecution } from "../execution/executionEngine.js";
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

function eventSummary(event) {
  if (!event) return null;
  return {
    direction: event.direction ?? null,
    index: event.index ?? null,
    price: event.price ?? null,
    setupId: event.setupId ?? "",
    signalTime: event.signalTime ?? null,
    status: event.status ?? "",
    stopLoss: event.stopLoss ?? null,
    time: event.time ?? null,
    trigger: event.trigger ?? null,
    type: event.type ?? "",
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
    "missing",
    "rejected",
    "simulated_only",
    "terminal_failed",
    "trigger_order_rejected",
  ].includes(String(status ?? "").toLowerCase());
}

function isActivePendingTrigger(order) {
  return ["accepted", "placed", "new", "partially_filled", "pending_sync"].includes(String(order?.status ?? "").toLowerCase());
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
      exchangeTerminalStatus: "",
      lastExchangeStatus: "",
      lastStatusCheckAt: null,
      lastTriggerFailureReason: "",
      lastBlockedReason: "",
      pendingOrderAgeSeconds: null,
      livePositionConfirmed: false,
      liveProtectionConfirmed: false,
      protectionOrderId: null,
      protectionSource: "none",
      scenarioTerminalReason: "",
      slPlacementStatus: "",
      setupOrderJournal: [],
      supersededBySetupId: null,
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
      takeProfitRr: 2,
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
      const runnerStale = current.runtime?.status === "running" && heartbeatAgeSeconds !== null && heartbeatAgeSeconds > staleThreshold;
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
            watchdogStatus: current.runtime?.status === "running"
              ? runnerStale ? "stale" : "healthy"
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
  publicApiProfiles,
  store,
}) {
  const timers = new Map();
  const triggerWatchers = new Map();
  const liveProfiles = new Map();

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
      if (runtime.status === "running" || runtime.status === "starting") {
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
    if (!current || current.runtime?.status !== "running") return null;
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
      const lastSignal = strategyResult.latestEvent
        ? eventSummary(strategyResult.latestEvent)
        : null;
      const latestEntryEvent = eventSummary(strategyResult.latestEntryEvent);
      const latestSetupEvent = eventSummary(strategyResult.latestSetupEvent);

      if (lastSignal && executionDiagnostics.globalBlockers.length > 0) {
        const blockedReason = executionDiagnostics.globalBlockers.map((blocker) => blocker.reason).join("; ");
        await persistRuntime(interval, {
          ...executionDiagnostics,
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
          latestSetupEvent,
          profileConnected: publicProfile?.status === "connected",
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

      const updatedProfile = await processLiveProfileExecution({
        bingxClient: client,
        logger: (message, context) => appendLog(message, { interval, profileId: profile.id, ...context }),
        profile,
        store,
        strategyResult,
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
        pendingTriggerOrder,
        activeScenarioCanBlockNewSetup: triggerSummary.activeScenarioCanBlockNewSetup,
        canArmNextSetup: triggerSummary.canArmNextSetup,
        exchangeTerminalStatus: triggerSummary.exchangeTerminalStatus,
        lastExchangeStatus: triggerSummary.lastExchangeStatus,
        lastStatusCheckAt: triggerSummary.lastStatusCheckAt,
        lastTriggerFailureReason: triggerSummary.lastTriggerFailureReason,
        livePositionConfirmed: triggerSummary.livePositionConfirmed,
        liveProtectionConfirmed: triggerSummary.liveProtectionConfirmed,
        latestEntryEvent,
        latestSetupEvent,
        pendingOrderAgeSeconds: triggerSummary.pendingOrderAgeSeconds,
        protectionOrderId: triggerSummary.protectionOrderId,
        protectionSource: triggerSummary.protectionSource,
        profileConnected: publicProfile?.status === "connected",
        scenarioTerminalReason: triggerSummary.scenarioTerminalReason,
        slPlacementStatus: pendingTriggerOrder?.status === "filled_protected"
          ? "placed"
          : pendingTriggerOrder?.status === "filled_sl_failed"
            ? "failed"
            : pendingTriggerOrder?.stopOrder
              ? "placed"
              : "not_placed",
        setupOrderJournal: triggerSummary.setupOrderJournal,
        supersededBySetupId: triggerSummary.supersededBySetupId,
        triggerFailureClassification: triggerSummary.triggerFailureClassification,
        triggerOrderExecutedQty: triggerSummary.triggerOrderExecutedQty,
        triggerOrderFillDetected: triggerSummary.triggerOrderFillDetected,
        triggerOrderState,
        validNweBandCount: strategyResult.diagnostics?.validNweBandCount ?? 0,
      });

      return updatedProfile;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const consecutiveErrors = Number(current.runtime?.consecutiveErrors ?? 0) + 1;
      const maxConsecutiveErrors = Number(process.env.SZTAB_MAX_CONSECUTIVE_ERRORS || 5);
      const terminalError = consecutiveErrors >= maxConsecutiveErrors;
      await persistRuntime(interval, {
        consecutiveErrors,
        intervalBlockers: [{
          reason: terminalError
            ? "Sztab interval runner failed repeatedly"
            : "Sztab interval runner tick failed; retry is scheduled",
          source: terminalError ? "runner_error" : "runner_retry",
          type: terminalError ? "runner_error" : "runner_retry",
        }],
        lastError: message,
        lastLoopDurationMs: Date.now() - loopStartedAt,
        error: message,
        lastDecision: terminalError
          ? "Sztab interval runner failed repeatedly and was stopped."
          : `Sztab interval tick failed (${consecutiveErrors}/${maxConsecutiveErrors}); retrying next cycle.`,
        lastDecisionReason: terminalError ? "runner_error" : "runner_retry",
        status: terminalError ? "error" : "running",
      });
      await appendLog("Sztab interval runner error", { consecutiveErrors, error: message, interval, terminalError });
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

  function triggerRuntimeSummary(pending, live = {}) {
    const isActive = isActivePendingTrigger(pending);
    const status = String(pending?.status ?? "none");
    return {
      activeScenarioCanBlockNewSetup: Boolean(live?.activeScenarioCanBlockNewSetup ?? isActive),
      canArmNextSetup: pending ? Boolean(pending.canArmNextSetup ?? !isActive) : true,
      exchangeTerminalStatus: pending?.exchangeTerminalStatus ?? (pending?.terminal ? pending?.lastExchangeStatus ?? status : ""),
      lastExchangeStatus: pending?.lastExchangeStatus ?? "",
      lastStatusCheckAt: pending?.lastStatusCheckAt ?? null,
      lastTriggerFailureReason: pending?.terminalReason ?? pending?.failureClassification ?? pending?.critical ?? "",
      livePositionConfirmed: Boolean(live?.livePositionConfirmed),
      liveProtectionConfirmed: Boolean(live?.liveProtectionConfirmed),
      pendingOrderAgeSeconds: pending?.acceptedAt || pending?.updatedAt || pending?.createdAt
        ? secondsSinceIso(pending.acceptedAt ?? pending.updatedAt ?? pending.createdAt)
        : null,
      protectionOrderId: live?.protectionOrderId ?? pending?.stopOrder?.orderId ?? pending?.stopOrder?.data?.orderId ?? null,
      protectionSource: live?.protectionSource ?? pending?.protectionSource ?? (pending ? "local_planned" : "none"),
      scenarioTerminalReason: live?.scenarioTerminalReason ?? pending?.terminalReason ?? "",
      setupOrderJournal: (live?.setupOrderJournal ?? []).slice(-100),
      supersededBySetupId: live?.supersededBySetupId ?? pending?.supersededBySetupId ?? null,
      triggerFailureClassification: pending?.failureClassification ?? "",
      triggerOrderExecutedQty: pending?.executedQty ?? null,
      triggerOrderFillDetected: ["filled_protected", "filled_sl_failed", "filled_but_position_missing"].includes(status.toLowerCase()),
      triggerOrderState: status,
    };
  }

  function triggerOrderDecisionText(pending) {
    const status = String(pending?.status ?? "none").toLowerCase();
    if (!pending) return "No pending trigger order.";
    if (status === "filled_protected") return "Trigger order fill detected; SL protection placement requested.";
    if (status === "filled_sl_failed") return "Trigger order filled but SL placement failed. Manual crisis management required.";
    if (status === "filled_but_position_missing") return "Trigger order reports fill, but no matching position was found after sync.";
    if (pending.terminal || ["terminal_failed", "canceled", "cancelled", "expired", "rejected", "missing"].includes(status)) {
      return `Trigger order terminal: ${pending.terminalReason ?? pending.failureClassification ?? status}.`;
    }
    return "Pending trigger order is still waiting for fill.";
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
        appendLog("Sztab trigger watcher error", {
          error: error instanceof Error ? error.message : String(error),
          interval,
        }).catch(() => {});
      });
    }, Number(process.env.SZTAB_TRIGGER_WATCH_MS || 5_000)));
  }

  async function pollPendingTrigger(interval) {
    const config = normalizeConfig(store.getSztabConfig());
    const current = config.intervals[interval];
    const existingProfile = liveProfiles.get(interval);
    const pending = existingProfile?.live?.pendingTriggerOrder ?? current?.runtime?.pendingTriggerOrder ?? null;

    if (!current || current.runtime?.status !== "running" || !isActivePendingTrigger(pending)) {
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
    await persistRuntime(interval, {
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
      exchangeTerminalStatus: triggerSummary.exchangeTerminalStatus,
      lastExchangeStatus: triggerSummary.lastExchangeStatus,
      lastStatusCheckAt: triggerSummary.lastStatusCheckAt,
      lastTriggerFailureReason: triggerSummary.lastTriggerFailureReason,
      livePositionConfirmed: triggerSummary.livePositionConfirmed,
      liveProtectionConfirmed: triggerSummary.liveProtectionConfirmed,
      pendingOrderAgeSeconds: triggerSummary.pendingOrderAgeSeconds,
      protectionOrderId: triggerSummary.protectionOrderId,
      protectionSource: triggerSummary.protectionSource,
      scenarioTerminalReason: triggerSummary.scenarioTerminalReason,
      setupOrderJournal: triggerSummary.setupOrderJournal,
      slPlacementStatus: nextPending?.status === "filled_protected"
        ? "placed"
        : nextPending?.status === "filled_sl_failed"
          ? "failed"
          : "not_placed",
      supersededBySetupId: triggerSummary.supersededBySetupId,
      triggerFailureClassification: triggerSummary.triggerFailureClassification,
      triggerOrderExecutedQty: triggerSummary.triggerOrderExecutedQty,
      triggerOrderFillDetected: triggerSummary.triggerOrderFillDetected,
      triggerOrderState: triggerSummary.triggerOrderState,
    });

    if (!isActivePendingTrigger(nextPending)) {
      clearTriggerWatcher(interval);
    }

    return updatedProfile;
  }

  async function cancelPendingTriggerForInterval(interval, reason = "interval_stopped") {
    const config = normalizeConfig(store.getSztabConfig());
    const current = config.intervals[interval];
    const existingProfile = liveProfiles.get(interval);
    const pending = existingProfile?.live?.pendingTriggerOrder ?? current?.runtime?.pendingTriggerOrder ?? null;

    if (!pending || !["accepted", "placed", "new", "partially_filled"].includes(String(pending.status ?? "").toLowerCase())) {
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
        exchangeTerminalStatus: triggerSummary.exchangeTerminalStatus,
        lastExchangeStatus: triggerSummary.lastExchangeStatus,
        lastStatusCheckAt: triggerSummary.lastStatusCheckAt,
        lastTriggerFailureReason: triggerSummary.lastTriggerFailureReason,
        pendingOrderAgeSeconds: triggerSummary.pendingOrderAgeSeconds,
        setupOrderJournal: triggerSummary.setupOrderJournal,
        triggerFailureClassification: triggerSummary.triggerFailureClassification,
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
    await persistRuntime(interval, {
      ...clearTransientBlockers(),
      error: "",
      intervalBlockers: [],
      lastDecision: "Starting Sztab interval runner.",
      lastDecisionReason: "starting",
      startedAt: nowIso(),
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
      intervalBlockers: [{
        reason: "Sztab interval runner is stopped by operator",
        source: "operator_stop",
        type: "operator_stop",
      }],
      lastDecision: "Sztab interval runner stopped by operator.",
      lastDecisionReason: "stopped_by_operator",
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
      intervals: statusFromConfig(config),
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

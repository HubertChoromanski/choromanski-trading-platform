import { processLiveProfileExecution } from "../execution/executionEngine.js";
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
      lastError: "",
      lastExchangeResponse: null,
      lastLoopDurationMs: null,
      lastTickAt: null,
      lastOrderAttempt: null,
      lastBlockedReason: "",
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
    live: existing.live ?? { lastProcessedSetupId: null, openPosition: null, orderLog: [] },
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
      return [
        interval,
        {
          apiProfile: current.apiProfile,
          interval,
          mmSavedAt: current.mmSavedAt,
          runtime: current.runtime,
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
    let changed = false;

    for (const interval of SZTAB_INTERVALS) {
      const runtime = config.intervals[interval].runtime;
      if (runtime.status === "running" || runtime.status === "starting") {
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
      const profile = configToProfile({
        ...current,
        apiProfileLabel: current.apiProfile,
      }, existingProfile);
      const exchangePositions = normalizeExchangeList(await client.getOpenPositions(profile.symbol))
        .filter((position) => compactSymbol(position.symbol) === compactSymbol(profile.symbol) && positionAmount(position) > 0);

      if (exchangePositions.length > 0 && !profile.live?.openPosition) {
        await persistRuntime(interval, {
          ...executionDiagnostics,
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
            stopOrder: lastOrderAttempt.stopOrder ?? null,
            takeProfitOrder: lastOrderAttempt.takeProfitOrder ?? null,
            time: lastOrderAttempt.time ?? null,
          }
        : null;
      const lastDecisionReason = lastSignal
        ? "fresh_executable_entry_signal"
        : latestEntryEvent
          ? "latest_entry_signal_is_historical_or_stale"
          : "no_entry_signal";
      await persistRuntime(interval, {
        ...executionDiagnostics,
        candlesLoaded: strategyResult.rawCandles.length,
        candlesRequested,
        closedCandlesUsed: strategyResult.sourceCandles.length,
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
        lastDecision: lastSignal ? `Latest ${lastSignal.direction} signal ${lastSignal.setupId}` : "No fresh entry signal on latest closed candle.",
        lastDecisionReason,
        lastError: "",
        lastExchangeResponse,
        lastLoopDurationMs: Date.now() - loopStartedAt,
        lastOrderAttempt,
        lastSignal,
        lastSyncAt: nowIso(),
        latestEntryEvent,
        latestSetupEvent,
        profileConnected: publicProfile?.status === "connected",
        validNweBandCount: strategyResult.diagnostics?.validNweBandCount ?? 0,
      });

      return updatedProfile;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await persistRuntime(interval, {
        intervalBlockers: [{
          reason: "Sztab interval runner failed",
          source: "runner_error",
          type: "runner_error",
        }],
        lastError: message,
        lastLoopDurationMs: Date.now() - loopStartedAt,
        error: message,
        lastDecision: "Sztab interval runner failed.",
        lastDecisionReason: "runner_error",
        status: "error",
      });
      clearTimer(interval);
      await appendLog("Sztab interval runner error", { error: message, interval });
      throw error;
    }
  }

  function clearTimer(interval) {
    const timer = timers.get(interval);
    if (timer) {
      clearInterval(timer);
      timers.delete(interval);
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
    start,
    stop,
    stopAll,
    syncAll,
    syncInterval,
    updateConfig,
  };
}

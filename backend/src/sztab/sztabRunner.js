import { processLiveProfileExecution } from "../execution/executionEngine.js";
import { runStrategyForProfile } from "../strategy/strategyRunner.js";

export const SZTAB_INTERVALS = ["10m", "15m", "20m", "30m", "1h"];
const DEFAULT_LOOP_MS = Number(process.env.SZTAB_INTERVAL_LOOP_MS || 30_000);

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
      error: "",
      lastCandle: null,
      lastDecision: "",
      lastOrderAttempt: null,
      lastSignal: null,
      lastSyncAt: null,
      startedAt: null,
      status: "stopped",
      stoppedAt: null,
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

  async function initialize() {
    const config = normalizeConfig(store.getSztabConfig());
    let changed = false;

    for (const interval of SZTAB_INTERVALS) {
      const runtime = config.intervals[interval].runtime;
      if (runtime.status === "running" || runtime.status === "starting") {
        runtime.status = "interrupted";
        runtime.error = "Backend restarted while this interval runner was active.";
        runtime.stoppedAt = nowIso();
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
      lastSyncAt: summary.lastRefreshAt ?? nowIso(),
      lastDecision: fresh
        ? "Fresh BingX sync completed."
        : `Sync attempted; source is ${summary.source ?? "unavailable"}.`,
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
    const config = normalizeConfig(store.getSztabConfig());
    const current = config.intervals[interval];
    if (!current || current.runtime?.status !== "running") return null;

    await persistRuntime(interval, {
      heartbeatAt: nowIso(),
      lastDecision: "Running strategy tick...",
    });

    try {
      const client = getApiProfileClient(current.apiProfile);
      const existingProfile = liveProfiles.get(interval) ?? {};
      const profile = configToProfile({
        ...current,
        apiProfileLabel: current.apiProfile,
      }, existingProfile);
      const exchangePositions = normalizeExchangeList(await client.getOpenPositions(profile.symbol))
        .filter((position) => compactSymbol(position.symbol) === compactSymbol(profile.symbol) && positionAmount(position) > 0);

      if (exchangePositions.length > 0 && !profile.live?.openPosition) {
        await persistRuntime(interval, {
          lastDecision: "Exchange position exists; Sztab skipped new entry to avoid duplicate exposure.",
          lastSyncAt: nowIso(),
        });
        await appendLog("Sztab skipped entry because exchange position exists", { interval, profileId: profile.id, symbol: profile.symbol });
        return null;
      }

      const strategyResult = await runStrategyForProfile(profile);
      const updatedProfile = await processLiveProfileExecution({
        bingxClient: client,
        logger: (message, context) => appendLog(message, { interval, profileId: profile.id, ...context }),
        profile,
        store,
        strategyResult,
      });
      liveProfiles.set(interval, updatedProfile);

      const lastCandle = strategyResult.sourceCandles.at(-1);
      const lastSignal = strategyResult.latestEvent
        ? {
            direction: strategyResult.latestEvent.direction,
            setupId: strategyResult.latestEvent.setupId,
            time: strategyResult.latestEvent.time,
            type: strategyResult.latestEvent.type,
          }
        : null;
      const lastOrderAttempt = updatedProfile.live?.orderLog?.at?.(-1) ?? null;
      await persistRuntime(interval, {
        error: "",
        lastCandle: lastCandle
          ? {
              close: lastCandle.close,
              high: lastCandle.high,
              low: lastCandle.low,
              open: lastCandle.open,
              time: lastCandle.time,
            }
          : null,
        lastDecision: lastSignal ? `Latest ${lastSignal.direction} signal ${lastSignal.setupId}` : "No fresh entry signal on latest closed candle.",
        lastOrderAttempt,
        lastSignal,
        lastSyncAt: nowIso(),
      });

      return updatedProfile;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await persistRuntime(interval, {
        error: message,
        lastDecision: "Sztab interval runner failed.",
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
      error: "",
      lastDecision: "Starting Sztab interval runner.",
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
      lastDecision: "Sztab interval runner stopped by operator.",
      status: "stopped",
      stoppedAt: nowIso(),
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

  return {
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

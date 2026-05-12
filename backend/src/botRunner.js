import {
  processLiveProfileExecution,
  processProfileExecution,
} from "./execution/executionEngine.js";
import { reconcileBingxState } from "./execution/reconciliation.js";
import { createSafetyGuardian } from "./safety/safetyGuardian.js";
import { runStrategyForProfile } from "./strategy/strategyRunner.js";

export const BOT_STATES = {
  EMERGENCY_STOP: "EMERGENCY_STOP",
  ERROR: "ERROR",
  LIVE_ARMED: "LIVE_ARMED",
  LIVE_RUNNING: "LIVE_RUNNING",
  NEEDS_RECONCILIATION: "NEEDS_RECONCILIATION",
  PAPER: "PAPER",
  PAPER_RUNNING: "PAPER_RUNNING",
  STOPPED: "STOPPED",
  WARNING: "WARNING",
};

export function createBotRunner({ bingxClient, store }) {
  let timer = null;
  let reconcileTimer = null;
  const safetyGuardian = createSafetyGuardian({ bingxClient, logger: log, store });

  async function log(message, context = {}) {
    return store.appendLog({ context, message });
  }

  async function tick() {
    const state = store.getState();

    if (![BOT_STATES.PAPER_RUNNING, BOT_STATES.LIVE_RUNNING].includes(state.botStatus)) return;

    try {
      if (state.globalEmergencyStop) {
        await stopWithState(BOT_STATES.EMERGENCY_STOP, "Global emergency stop active");
        return;
      }

      if (state.stopNewEntries) {
        await log("execution blocked", { reason: "Stop new entries is active" });
        return;
      }

      if (state.safety?.blocked) {
        await log("execution blocked", { reason: "Safety Guardian is blocking execution", warnings: state.safety.warnings });
        return;
      }

      const profiles = store.getProfiles();
      const liveMode = state.botStatus === BOT_STATES.LIVE_RUNNING;
      const updatedProfiles = [];

      for (const profile of profiles) {
        if (profile.runner === "sztab" || String(profile.id ?? "").startsWith("sztab-")) {
          updatedProfiles.push(profile);
          continue;
        }

        if (!profile.enabled) {
          updatedProfiles.push(profile);
          continue;
        }

        if (profile.risk.emergencyStop) {
          await log("risk blocked", { profileId: profile.id, reason: "Emergency stop active" });
          updatedProfiles.push({ ...profile, status: "Emergency stop" });
          continue;
        }

        if (liveMode && profile.executionMode !== "live") {
          updatedProfiles.push(profile);
          continue;
        }

        if (!liveMode && profile.executionMode === "live") {
          updatedProfiles.push(profile);
          continue;
        }

        const strategyResult = await runStrategyForProfile(profile);
        await store.setState({
          lastCandleTime: strategyResult.sourceCandles.at(-1)?.time ?? null,
          lastStrategySignal: strategyResult.latestEvent
            ? {
                direction: strategyResult.latestEvent.direction,
                setupId: strategyResult.latestEvent.setupId,
                time: strategyResult.latestEvent.time,
                type: strategyResult.latestEvent.type,
              }
            : store.getState().lastStrategySignal,
        });
        const updatedProfile = liveMode
          ? await processLiveProfileExecution({
              bingxClient,
              logger: log,
              profile,
              store,
              strategyResult,
            })
          : await processProfileExecution({
              logger: log,
              profile,
              store,
              strategyResult,
            });
        updatedProfiles.push(updatedProfile);
      }

      await store.setProfiles(updatedProfiles);
      await store.setState({
        heartbeatAt: new Date().toISOString(),
        lastExecutionDecision: liveMode ? "Live tick completed" : "Paper tick completed",
        lastTickAt: new Date().toISOString(),
        lastError: "",
      });
    } catch (error) {
      await log("error", { message: error instanceof Error ? error.message : String(error) });
      await stopWithState(BOT_STATES.ERROR, error instanceof Error ? error.message : String(error));
    }
  }

  async function reconcile() {
    const state = store.getState();

    if (state.botStatus !== BOT_STATES.LIVE_RUNNING) return;

    try {
      const bingx = await reconcileBingxState({
        client: bingxClient,
        logger: log,
        profiles: store.getProfiles(),
        repairMissingStops: true,
      });
      await store.setState({ bingx });

      if (bingx.reconciliationStatus === "WARNING") {
        await stopWithState(BOT_STATES.WARNING, bingx.warning);
      }
    } catch (error) {
      await log("API error", { message: error instanceof Error ? error.message : String(error) });
      await stopWithState(BOT_STATES.ERROR, error instanceof Error ? error.message : String(error));
    }
  }

  function stopTimers() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }

    if (reconcileTimer) {
      clearInterval(reconcileTimer);
      reconcileTimer = null;
    }
  }

  async function stopWithState(botStatus, lastError = "") {
    stopTimers();
    safetyGuardian.stop();
    await store.setState({ botStatus, lastError });
  }

  return {
    async armLive() {
      const state = store.getState();

      if (state.needsManualResume) {
        return store.setState({
          botStatus: BOT_STATES.NEEDS_RECONCILIATION,
          lastError: "Manual reconciliation confirmation is required before live can be armed.",
          liveArmed: false,
        });
      }

      if (!bingxClient.auth.configured) {
        await log("risk blocked", { reason: "Cannot arm live without BingX API keys" });
        return store.setState({
          botStatus: BOT_STATES.PAPER,
          lastError: "BingX API keys are not configured.",
          liveArmed: false,
        });
      }

      if (!state.bingx?.liveReady || Number(state.bingx?.activeExecutionBalance ?? 0) <= 0) {
        await log("risk blocked", { reason: "Cannot arm live without confirmed futures balance" });
        return store.setState({
          botStatus: BOT_STATES.PAPER,
          lastError: "USDT-M Perpetual / Swap futures balance must be confirmed above 0 before live can be armed.",
          liveArmed: false,
        });
      }

      const liveProfiles = store
        .getProfiles()
        .filter((profile) => profile.enabled && profile.executionMode === "live" && profile.runner !== "sztab" && !String(profile.id ?? "").startsWith("sztab-"));

      if (liveProfiles.length === 0) {
        return store.setState({
          botStatus: BOT_STATES.PAPER,
          lastError: "No enabled live execution profile.",
          liveArmed: false,
        });
      }

      await log("live armed", { profiles: liveProfiles.map((profile) => profile.id) });
      return store.setState({
        botStatus: BOT_STATES.LIVE_ARMED,
        lastError: "",
        liveArmed: true,
      });
    },

    async emergencyStop({ closePositions = false } = {}) {
      stopTimers();
      await log("emergency stop", { closePositions });

      if (closePositions && bingxClient.auth.configured) {
        for (const profile of store.getProfiles().filter((item) => item.executionMode === "live" && item.runner !== "sztab" && !String(item.id ?? "").startsWith("sztab-"))) {
          await bingxClient.closePosition(profile.symbol);
          await bingxClient.cancelOpenOrders(profile.symbol);
        }
      }

      return store.setState({
        botStatus: BOT_STATES.EMERGENCY_STOP,
        globalEmergencyStop: true,
        liveArmed: false,
      });
    },

    async startLive({ confirmed = false } = {}) {
      const state = store.getState();

      if (!confirmed || !state.liveArmed || !bingxClient.auth.configured) {
        await log("risk blocked", { reason: "Live start confirmation or API keys missing" });
        return store.setState({
          lastError: "Live start requires armed state, API keys, and explicit confirmation.",
        });
      }

      await log("bot started", { mode: "live" });
      stopTimers();
      await store.setState({
        botStatus: BOT_STATES.LIVE_RUNNING,
        globalEmergencyStop: false,
        lastError: "",
        startedAt: new Date().toISOString(),
      });
      timer = setInterval(tick, 30_000);
      reconcileTimer = setInterval(reconcile, 15_000);
      safetyGuardian.start();
      reconcile();
      tick();
      return store.getState();
    },

    async startPaper() {
      await store.setState({
        botStatus: BOT_STATES.PAPER_RUNNING,
        globalEmergencyStop: false,
        lastError: "",
        startedAt: new Date().toISOString(),
      });
      await log("bot started", { mode: "paper" });
      stopTimers();
      timer = setInterval(tick, 30_000);
      safetyGuardian.start();
      tick();
      return store.getState();
    },

    async stop() {
      stopTimers();
      safetyGuardian.stop();
      await store.setState({
        botStatus: BOT_STATES.STOPPED,
        crisisMode: false,
        liveArmed: false,
        safety: {
          blocked: false,
          clearedAt: new Date().toISOString(),
          clearReason: "global runner stopped",
          lastCheckAt: null,
          status: "NOT_CHECKED",
          warnings: [],
        },
        stopNewEntries: false,
      });
      await log("bot stopped");
      return store.getState();
    },

    async confirmResumeAfterReconciliation() {
      const bingx = await reconcileBingxState({
        client: bingxClient,
        logger: log,
        profiles: store.getProfiles(),
        repairMissingStops: true,
      });
      await store.setState({ bingx });

      if (bingx.reconciliationStatus !== "OK") {
        return store.setState({
          botStatus: BOT_STATES.WARNING,
          lastError: bingx.warning || "Reconciliation did not pass.",
          needsManualResume: true,
        });
      }

      await log("manual resume confirmed", { reconciliationStatus: bingx.reconciliationStatus });
      return store.setState({
        botStatus: BOT_STATES.STOPPED,
        lastError: "",
        needsManualResume: false,
      });
    },

    async reconcileNow() {
      const bingx = await reconcileBingxState({
        client: bingxClient,
        logger: log,
        profiles: store.getProfiles(),
        repairMissingStops: true,
      });
      await store.setState({ bingx });
      return store.getState();
    },

    async stopNewEntries(value = true) {
      await log("operator control", { stopNewEntries: value });
      return store.setState({ stopNewEntries: value });
    },

    tick,
  };
}

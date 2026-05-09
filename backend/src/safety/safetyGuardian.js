export function createSafetyGuardian({ bingxClient, logger, store }) {
  let timer = null;

  async function check() {
    const state = store.getState();
    const warnings = [];
    const now = Date.now();

    try {
      if (bingxClient.auth.configured) {
        await bingxClient.getServerTime();
      } else if (state.botStatus === "LIVE_RUNNING") {
        warnings.push("BingX API keys are missing during live mode");
      }

      if (state.lastTickAt && now - Date.parse(state.lastTickAt) > 120_000) {
        warnings.push("Strategy loop heartbeat is stale");
      }

      if (state.lastCandleTime && now / 1000 - Number(state.lastCandleTime) > 3600) {
        warnings.push("Market data candle is stale");
      }

      for (const profile of store.getProfiles().filter((item) => item.executionMode === "live")) {
        if (profile.risk?.emergencyStop) {
          warnings.push(`${profile.id}: profile emergency stop active`);
        }

        if (profile.paper?.tradesToday >= profile.risk?.maxTradesPerDay) {
          warnings.push(`${profile.id}: max trades per day reached`);
        }

        if (profile.live?.openPosition && !Number.isFinite(Number(profile.live.openPosition.stopLoss))) {
          warnings.push(`${profile.id}: live position has no local stop loss`);
        }
      }

      const safety = {
        blocked: warnings.length > 0,
        lastCheckAt: new Date().toISOString(),
        status: warnings.length > 0 ? "BLOCKED" : "OK",
        warnings,
      };

      await store.setState({ safety });

      if (warnings.length > 0) {
        await logger("safety warning", { warnings });
      }

      return safety;
    } catch (error) {
      const warning = error instanceof Error ? error.message : String(error);
      const safety = {
        blocked: true,
        lastCheckAt: new Date().toISOString(),
        status: "ERROR",
        warnings: [warning],
      };
      await store.setState({ safety });
      await logger("safety warning", { warnings: [warning] });
      return safety;
    }
  }

  return {
    check,
    start() {
      if (timer) clearInterval(timer);
      timer = setInterval(check, 5000);
      check();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

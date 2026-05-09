import { createAccountRoute } from "./accountRouter.js";
import { defaultExecutionConfig } from "./executionEngine.js";

export const EXECUTION_TIMEFRAMES = [
  { label: "10m", interval: "10m" },
  { label: "15m", interval: "15m" },
  { label: "20m", interval: "20m" },
  { label: "30m", interval: "30m" },
  { label: "1H", interval: "1h" },
  { label: "4H", interval: "4h" },
];

export const MONEY_PRESETS = {
  turtle: {
    label: "Zolw",
    description: "Conservative 1% risk to SL.",
    leverage: 1,
    riskPerTradePercent: 1,
  },
  aggressive: {
    label: "Agresywny",
    description: "Aggressive 5% risk to SL.",
    leverage: 3,
    riskPerTradePercent: 5,
  },
  run: {
    label: "Run",
    description: "High risk 10% risk to SL.",
    leverage: 5,
    riskPerTradePercent: 10,
  },
  custom: {
    label: "Custom",
    description: "Manual controls.",
  },
};

export const defaultStrategyParameters = {
  atrLength: 14,
  atrMultiplier: 1.2,
  bandwidth: 8,
  envelopeMultiplier: 3,
  maxSameSideFailures: 2,
  strategySource: "pine-ha",
};

export function createExecutionProfile(interval, label, enabled = false) {
  const now = new Date().toISOString();

  return {
    id: `profile-${interval}`,
    accountRoute: createAccountRoute(),
    cooldownAfterLoss: 0,
    compounding: true,
    draftConfig: {
      ...defaultExecutionConfig,
      mode: "paper",
      symbol: "SOLUSDT",
    },
    enabled,
    fixedEquityMode: "fixed",
    interval,
    label,
    lastDeployedFrom: enabled ? "Default 15m profile" : "",
    lastSavedAt: now,
    lastSavedConfig: {
      ...defaultExecutionConfig,
      mode: "paper",
      symbol: "SOLUSDT",
    },
    locked: true,
    minimumPositionSize: 5,
    maximumPositionSize: 10000,
    moneyPreset: "turtle",
    paperState: {
      currentEquity: 10000,
      dailyLossUsed: 0,
      openPosition: null,
      realizedPnl: 0,
      tradesToday: 0,
      tradeLog: [],
      unrealizedPnl: 0,
    },
    status: enabled ? "Paper ready" : "Disabled",
    strategyParameters: defaultStrategyParameters,
    version: enabled ? 1 : 0,
  };
}

export function createDefaultExecutionProfiles() {
  return EXECUTION_TIMEFRAMES.map(({ interval, label }) =>
    createExecutionProfile(interval, label, interval === "15m"),
  );
}

export function applyMoneyPreset(profile, presetKey) {
  const preset = MONEY_PRESETS[presetKey] ?? MONEY_PRESETS.custom;

  return {
    ...profile,
    draftConfig: {
      ...profile.draftConfig,
      leverage: preset.leverage ?? profile.draftConfig.leverage,
      riskPerTradePercent:
        preset.riskPerTradePercent ?? profile.draftConfig.riskPerTradePercent,
    },
    moneyPreset: presetKey,
  };
}

export function deployStrategyToProfile(profile, strategyParameters, sourceName = "Strategy Lab") {
  return {
    ...profile,
    enabled: true,
    lastDeployedFrom: sourceName,
    lastSavedAt: new Date().toISOString(),
    locked: true,
    status: "Paper ready",
    strategyParameters: {
      ...profile.strategyParameters,
      ...strategyParameters,
    },
    version: profile.version + 1,
  };
}

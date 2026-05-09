import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../data");

const defaultProfiles = [
  {
    id: "profile-15m",
    enabled: true,
    symbol: "SOLUSDT",
    timeframe: "15m",
    status: "Paper ready",
    executionMode: "paper",
    locked: true,
    strategyDeployed: true,
    account: {
      type: "main",
      label: "Main Account",
      apiProfile: "paper-main",
      exchange: "BingX",
    },
    strategyParameters: {
      atrLength: 14,
      atrMultiplier: 1.2,
      bandwidth: 8,
      envelopeMultiplier: 3,
      maxSameSideFailures: 2,
      strategySource: "pine-ha",
    },
    risk: {
      allowLong: true,
      allowShort: true,
      emergencyStop: false,
      leverage: 1,
      maxDailyLossPercent: 5,
      maxOpenPositions: 1,
      maxTradesPerDay: 10,
      positionSizeMode: "risk-based",
      riskPerTradePercent: 1,
      startingBalance: 10000,
      takeProfitRr: 2,
    },
    paper: {
      equity: 10000,
      lastProcessedSetupId: null,
      openPosition: null,
      realizedPnl: 0,
      tradesToday: 0,
    },
    live: {
      lastProcessedSetupId: null,
      openPosition: null,
      orderLog: [],
    },
    version: 1,
  },
];

const defaultState = {
  botStatus: "STOPPED",
  bingx: {
    activeExecutionBalance: null,
    apiConfigured: false,
    balance: null,
    balances: {
      fund: null,
      futures: null,
      spot: null,
    },
    lastSyncAt: null,
    liveReady: false,
    openOrders: [],
    openPositions: [],
    reconciliationStatus: "NOT_CHECKED",
  },
  globalEmergencyStop: false,
  heartbeatAt: null,
  lastError: "",
  lastExecutionDecision: null,
  lastStrategySignal: null,
  liveArmed: false,
  lastTickAt: null,
  needsManualResume: false,
  runtime: {
    mode: process.env.NODE_ENV ?? "development",
    processManager: process.env.pm_id !== undefined ? "pm2" : "node",
    startedAt: null,
  },
  safety: {
    blocked: false,
    lastCheckAt: null,
    status: "NOT_CHECKED",
    warnings: [],
  },
  startedAt: null,
  stopNewEntries: false,
};

const defaultExecutionConfig = {
  version: 1,
  lockedProfileIds: [],
  updatedAt: null,
};

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

async function readJson(fileName, fallback) {
  await ensureDataDir();

  try {
    return JSON.parse(await readFile(path.join(DATA_DIR, fileName), "utf8"));
  } catch {
    await writeJson(fileName, fallback);
    return structuredClone(fallback);
  }
}

async function writeJson(fileName, value) {
  await ensureDataDir();
  await writeFile(path.join(DATA_DIR, fileName), `${JSON.stringify(value, null, 2)}\n`);
}

export async function createStateStore() {
  const store = {
    equity: await readJson("equity.json", []),
    executionConfig: await readJson("execution-config.json", defaultExecutionConfig),
    logs: await readJson("logs.json", []),
    orders: await readJson("orders.json", []),
    profiles: (await readJson("profiles.json", defaultProfiles)).map(normalizeProfile),
    state: normalizeState(await readJson("state.json", defaultState)),
    trades: await readJson("trades.json", []),
  };

  if (["LIVE_RUNNING", "LIVE_ARMED"].includes(store.state.botStatus)) {
    store.state = {
      ...store.state,
      botStatus: "NEEDS_RECONCILIATION",
      lastError: "Backend restarted after live mode. Reconcile and manually resume before new live entries.",
      liveArmed: false,
      needsManualResume: true,
    };
    await writeJson("state.json", store.state);
  }

  async function persist(key) {
    const fileNames = {
      executionConfig: "execution-config.json",
    };
    await writeJson(fileNames[key] ?? `${key}.json`, store[key]);
  }

  return {
    async appendLog(entry) {
      const log = {
        id: `${Date.now()}-${store.logs.length}`,
        time: new Date().toISOString(),
        ...entry,
      };
      store.logs.push(log);
      await persist("logs");
      return log;
    },
    getLogs() {
      return store.logs;
    },
    getOrders() {
      return store.orders;
    },
    getProfiles() {
      return store.profiles;
    },
    getState() {
      return store.state;
    },
    getTrades() {
      return store.trades;
    },
    getEquity() {
      return store.equity;
    },
    getExecutionConfig() {
      return store.executionConfig;
    },
    async setExecutionConfig(config) {
      store.executionConfig = {
        ...store.executionConfig,
        ...config,
        updatedAt: new Date().toISOString(),
      };
      await persist("executionConfig");
      return store.executionConfig;
    },
    async setProfiles(profiles) {
      store.profiles = profiles.map(normalizeProfile);
      await persist("profiles");
      return store.profiles;
    },
    async setState(patch) {
      store.state = {
        ...store.state,
        ...patch,
        bingx: {
          ...store.state.bingx,
          ...(patch.bingx ?? {}),
        },
      };
      await persist("state");
      return store.state;
    },
    async upsertTrade(trade) {
      const existingIndex = store.trades.findIndex((item) => item.id === trade.id);

      if (existingIndex >= 0) {
        store.trades[existingIndex] = trade;
      } else {
        store.trades.push(trade);
      }

      await persist("trades");
      return trade;
    },
    async appendEquity(point) {
      store.equity.push({
        time: new Date().toISOString(),
        ...point,
      });
      await persist("equity");
      return point;
    },
    async upsertOrder(order) {
      const existingIndex = store.orders.findIndex((item) => item.id === order.id);
      const nextOrder = {
        updatedAt: new Date().toISOString(),
        ...order,
      };

      if (existingIndex >= 0) {
        store.orders[existingIndex] = nextOrder;
      } else {
        store.orders.push(nextOrder);
      }

      await persist("orders");
      return nextOrder;
    },
  };
}

function normalizeProfile(profile) {
  const fallback = defaultProfiles[0];

  return {
    ...fallback,
    ...profile,
    account: {
      ...fallback.account,
      ...(profile.account ?? {}),
    },
    live: {
      ...fallback.live,
      ...(profile.live ?? {}),
    },
    paper: {
      ...fallback.paper,
      ...(profile.paper ?? {}),
    },
    risk: {
      ...fallback.risk,
      ...(profile.risk ?? {}),
    },
    strategyParameters: {
      ...fallback.strategyParameters,
      ...(profile.strategyParameters ?? {}),
    },
  };
}

function normalizeState(state) {
  return {
    ...defaultState,
    ...state,
    bingx: {
      ...defaultState.bingx,
      ...(state.bingx ?? {}),
    },
  };
}

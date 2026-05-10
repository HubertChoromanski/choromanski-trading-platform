import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

const collectionDefaults = {
  aiAlertDrafts: [],
  aiAgentRuns: [],
  aiReports: [],
  aiSessions: [],
  analytics: [],
  backtests: [],
  battleDecks: [],
  communication: {
    alertTypes: {
      apiDisconnected: true,
      backendRestarted: true,
      botPaused: true,
      botStarted: true,
      botStopped: true,
      crisisModeEnabled: true,
      dailySummary: true,
      newSignal: false,
      orderRejected: true,
      positionClosed: true,
      positionOpened: true,
      reconciliationNeeded: true,
      slMoved: true,
      tpMoved: true,
      weeklySummary: true,
    },
    enabled: false,
    telegramBotTokenConfigured: false,
    telegramChatId: "",
  },
  favorites: [],
  mmDecks: [],
  strategyDecks: [],
};

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

async function readJson(fileName, fallback) {
  await ensureDataDir();
  const filePath = path.join(DATA_DIR, fileName);

  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      await rename(filePath, `${filePath}.bad-${Date.now()}`).catch(() => {});
    }
    await writeJson(fileName, fallback);
    return structuredClone(fallback);
  }
}

async function writeJson(fileName, value) {
  await ensureDataDir();
  const filePath = path.join(DATA_DIR, fileName);
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tempPath, filePath);
}

export async function createStateStore() {
	  const store = {
	    aiAlertDrafts: await readJson("ai-alert-drafts.json", collectionDefaults.aiAlertDrafts),
	    aiAgentRuns: await readJson("ai-agent-runs.json", collectionDefaults.aiAgentRuns),
	    aiReports: await readJson("ai-reports.json", collectionDefaults.aiReports),
	    aiSessions: await readJson("ai-sessions.json", collectionDefaults.aiSessions),
	    analytics: await readJson("analytics.json", collectionDefaults.analytics),
    backtests: await readJson("backtests.json", collectionDefaults.backtests),
    battleDecks: await readJson("battle-decks.json", collectionDefaults.battleDecks),
    communication: await readJson("communication.json", collectionDefaults.communication),
    equity: await readJson("equity.json", []),
    executionConfig: await readJson("execution-config.json", defaultExecutionConfig),
    favorites: await readJson("favorites.json", collectionDefaults.favorites),
    logs: await readJson("logs.json", []),
    mmDecks: await readJson("mm-decks.json", collectionDefaults.mmDecks),
    orders: await readJson("orders.json", []),
    profiles: (await readJson("profiles.json", defaultProfiles)).map(normalizeProfile),
    state: normalizeState(await readJson("state.json", defaultState)),
    strategyDecks: await readJson("strategy-decks.json", collectionDefaults.strategyDecks),
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

  if (store.state.botStatus === "PAPER_RUNNING" || store.state.botStatus === "PAPER") {
    store.state = {
      ...store.state,
      botStatus: "STOPPED",
      lastError: "",
    };
    await writeJson("state.json", store.state);
  }

  async function persist(key) {
    const fileNames = {
      aiAlertDrafts: "ai-alert-drafts.json",
      aiAgentRuns: "ai-agent-runs.json",
      aiReports: "ai-reports.json",
      aiSessions: "ai-sessions.json",
      battleDecks: "battle-decks.json",
      executionConfig: "execution-config.json",
      mmDecks: "mm-decks.json",
      strategyDecks: "strategy-decks.json",
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
    getCollection(name) {
      return store[name];
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
    async setCollection(name, value) {
      store[name] = value;
      await persist(name);
      return store[name];
    },
    async upsertCollectionItem(name, item) {
      const now = new Date().toISOString();
      const current = Array.isArray(store[name]) ? store[name] : [];
      const nextItem = {
        createdAt: item.createdAt ?? now,
        id: item.id ?? `${name}-${Date.now()}`,
        updatedAt: now,
        ...item,
      };
      const existingIndex = current.findIndex((entry) => entry.id === nextItem.id);

      if (existingIndex >= 0) {
        current[existingIndex] = nextItem;
      } else {
        current.push(nextItem);
      }

      store[name] = current;
      await persist(name);
      return nextItem;
    },
    async deleteCollectionItem(name, id) {
      const current = Array.isArray(store[name]) ? store[name] : [];
      store[name] = current.filter((item) => item.id !== id);
      await persist(name);
      return store[name];
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

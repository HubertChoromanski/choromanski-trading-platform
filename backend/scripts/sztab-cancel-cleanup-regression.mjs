import { createBingxClient } from "../src/exchanges/bingxClient.js";
import { processLiveProfileExecution } from "../src/execution/executionEngine.js";
import { STRATEGY_EVENT_TYPES } from "../../hubert-platform/frontend/src/engine/strategyEngine.js";

async function assertCancelAllUsesDelete() {
  const calls = [];
  const client = createBingxClient({
    apiKey: "test-key",
    apiSecret: "test-secret",
    baseUrl: "https://example.test",
    fetchImpl: async (url, options) => {
      calls.push({ options, url });
      return {
        ok: true,
        text: async () => JSON.stringify({ code: 0, data: { ok: true } }),
      };
    },
  });

  await client.cancelOpenOrders("SOLUSDT");
  const call = calls[0];
  if (call.options.method !== "DELETE") {
    throw new Error(`cancelOpenOrders should use DELETE, got ${call.options.method}`);
  }
  if (!call.url.includes("/openApi/swap/v2/trade/allOpenOrders?")) {
    throw new Error(`cancelOpenOrders used unexpected endpoint: ${call.url}`);
  }
  if (!call.url.includes("symbol=SOL-USDT")) {
    throw new Error(`cancelOpenOrders did not send normalized symbol: ${call.url}`);
  }
  if (!call.url.includes("timestamp=") || !call.url.includes("signature=")) {
    throw new Error(`cancelOpenOrders DELETE request was not signed: ${call.url}`);
  }
}

async function assertCleanupMethodErrorDoesNotThrow() {
  process.env.SZTAB_EXECUTION_MODE = "platform_market_trigger";
  const profile = {
    enabled: true,
    executionMode: "live",
    id: "sztab-10m",
    live: {
      openPosition: {
        direction: "LONG",
        entryPrice: 100,
        entryTime: 1000,
        quantity: 1,
        setupId: "old-long",
        stopLoss: 95,
      },
      orderLog: [],
      setupOrderJournal: [],
    },
    liveModeEnabled: true,
    locked: true,
    paper: { tradesToday: 0 },
    risk: {
      allowLong: true,
      allowShort: true,
      emergencyStop: false,
      leverage: 10,
      marginMode: "isolated",
      maxDailyLossPercent: 99,
      maxTradesPerDay: 100,
      positionSizeMode: "risk-based",
      riskPerTradePercent: 1,
      startingBalance: 1000,
      takeProfitEnabled: false,
    },
    runner: "sztab",
    strategyDeployed: true,
    strategyParameters: {},
    symbol: "SOLUSDT",
    timeframe: "10m",
  };
  const strategyResult = {
    latestSetupEvent: null,
    sourceCandles: [{ close: 96, high: 100, low: 95, open: 99, time: 3000 }],
    strategy: {
      events: [{
        exitPrice: 96,
        exitReason: "FAILED_OPPOSITE_SETUP_LIMIT",
        setupId: "old-long",
        time: 3000,
        type: STRATEGY_EVENT_TYPES.POSITION_EXITED,
      }],
    },
  };
  const methodError = new Error("Please use the correct request method. The request method for this endpoint is DELETE");
  methodError.bingx = {
    endpoint: "/openApi/swap/v2/trade/allOpenOrders",
    method: "POST",
    response: { code: 100001, msg: methodError.message },
  };
  const client = {
    auth: { configured: true },
    cancelOpenOrders: async () => {
      throw methodError;
    },
    closePosition: async () => ({ ok: true }),
  };
  const store = {
    getState: () => ({ botStatus: "LIVE_RUNNING" }),
    trades: [],
    upsertOrder: async () => {},
    upsertTrade: async (trade) => {
      store.trades.push(trade);
    },
  };
  const result = await processLiveProfileExecution({
    bingxClient: client,
    logger: async () => {},
    profile,
    store,
    strategyResult,
  });

  if (result.live.openPosition !== null) {
    throw new Error("Position close path did not finish after cleanup warning.");
  }
  if (store.trades.length !== 1) {
    throw new Error("Closed trade was not persisted after cleanup warning.");
  }
  if (result.live.lastCleanupWarning?.classification !== "cancel_open_orders_method_error") {
    throw new Error(`Cleanup failure was not classified correctly: ${result.live.lastCleanupWarning?.classification}`);
  }
}

await assertCancelAllUsesDelete();
await assertCleanupMethodErrorDoesNotThrow();
console.log("Sztab cancel cleanup regression passed");

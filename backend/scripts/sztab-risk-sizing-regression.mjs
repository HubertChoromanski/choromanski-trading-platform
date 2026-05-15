import { processLiveProfileExecution } from "../src/execution/executionEngine.js";
import { calculatePaperPositionSize } from "../src/execution/paperBroker.js";
import { STRATEGY_EVENT_TYPES } from "../../hubert-platform/frontend/src/engine/strategyEngine.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function entryEvent() {
  return {
    benchmarkTime: 1_000,
    direction: "LONG",
    index: 10,
    setupId: "risk-sizing-test",
    signalTime: 400,
    stopLoss: 95,
    time: 1_600,
    trigger: 100,
    type: STRATEGY_EVENT_TYPES.ENTRY_TRIGGERED,
  };
}

function setupEvent() {
  return {
    benchmarkTime: 1_000,
    direction: "LONG",
    index: 10,
    setupId: "default-execution-mode-test",
    signalTime: 400,
    stopLoss: 95,
    time: 1_000,
    trigger: 100,
    type: STRATEGY_EVENT_TYPES.SETUP_ACTIVE,
  };
}

function strategyResult({ latestEvent = null, latestSetupEvent = null } = {}) {
  return {
    latestEvent,
    latestSetupEvent,
    sourceCandles: [{ close: 100, high: 101, low: 99, open: 100, time: 1_600 }],
    strategy: { events: latestEvent ? [latestEvent] : [] },
  };
}

function baseProfile() {
  return {
    enabled: true,
    executionMode: "live",
    id: "sztab-h1",
    live: { openPosition: null, orderLog: [], setupOrderJournal: [] },
    liveModeEnabled: true,
    locked: true,
    paper: { tradesToday: 0 },
    risk: {
      allowLong: true,
      allowShort: true,
      emergencyStop: false,
      leverage: 1,
      marginMode: "isolated",
      maxDailyLossPercent: 99,
      maxTradesPerDay: 100,
      positionSizeMode: "risk-based",
      riskPerTradePercent: 10,
      startingBalance: 100,
      takeProfitEnabled: false,
    },
    runner: "sztab",
    strategyDeployed: true,
    strategyParameters: {
      atrLength: 14,
      atrMultiplier: 2,
      bandwidth: 8,
      envelopeMultiplier: 2,
      maxSameSideFailures: 2,
      strategySource: "pine-ha",
    },
    symbol: "SOLUSDT",
    timeframe: "1h",
  };
}

function createStore() {
  return {
    orders: [],
    getState: () => ({ botStatus: "LIVE_RUNNING" }),
    upsertOrder: async (order) => {
      store.orders.push(order);
    },
    upsertTrade: async () => {},
  };
}

const store = createStore();

function createBingxClient() {
  const calls = [];
  let positions = [];
  return {
    auth: { configured: true },
    calls,
    getOpenPositions: async () => positions,
    getPerpetualFuturesBalance: async () => ({
      balance: {
        availableBalance: 100,
        availableMargin: 1000,
        balance: 100,
        equity: 100,
      },
    }),
    placeMarketOrder: async (symbol, side, quantity) => {
      calls.push({ quantity, side, symbol, type: "placeMarketOrder" });
      positions = [{
        avgPrice: 100,
        positionAmt: quantity,
        positionId: "long-risk-test",
        positionSide: "LONG",
        quantity,
        symbol,
      }];
      return { data: { executedQty: quantity, orderId: "market-risk-test", status: "FILLED" } };
    },
    placePositionStopLoss: async (symbol, side, stopLoss, options = {}) => {
      calls.push({ options, side, stopLoss, symbol, type: "placePositionStopLoss" });
      return { data: { orderId: "sl-risk-test", status: "NEW" } };
    },
    setLeverage: async (symbol, leverage, side) => {
      calls.push({ leverage, side, symbol, type: "setLeverage" });
      return { data: { ok: true } };
    },
    setMarginMode: async (symbol, marginMode) => {
      calls.push({ marginMode, symbol, type: "setMarginMode" });
      return { data: { ok: true } };
    },
  };
}

const sizing = calculatePaperPositionSize({
  entryPrice: 100,
  equity: 100,
  risk: { positionSizeMode: "risk-based", riskPerTradePercent: 10 },
  stopLoss: 95,
});
assert(sizing.riskAmount === 10, `Expected account risk amount 10, got ${sizing.riskAmount}`);
assert(sizing.quantity === 2, `Expected qty 2 from account risk, got ${sizing.quantity}`);
assert(sizing.notionalSize === 200, `Expected notional 200, got ${sizing.notionalSize}`);

delete process.env.SZTAB_EXECUTION_MODE;
const defaultModeClient = createBingxClient();
const armed = await processLiveProfileExecution({
  bingxClient: defaultModeClient,
  logger: async () => {},
  priceService: { getPrice: async () => ({ ageMs: 0, price: 99, source: "binance_futures", status: "ok", time: new Date().toISOString() }) },
  profile: baseProfile(),
  store,
  strategyResult: strategyResult({ latestSetupEvent: setupEvent() }),
});
assert(armed.live.pendingTriggerOrder?.executionMode === "platform_market_trigger", "Default Sztab mode is not platform_market_trigger.");
assert(armed.live.pendingTriggerOrder?.status === "platform_armed", "Default Sztab mode did not arm platform trigger.");

process.env.SZTAB_EXECUTION_MODE = "platform_market_trigger";
const client = createBingxClient();
const event = entryEvent();
const result = await processLiveProfileExecution({
  bingxClient: client,
  logger: async () => {},
  priceService: { getPrice: async () => ({ ageMs: 0, price: 100, source: "binance_futures", status: "ok", time: new Date().toISOString() }) },
  profile: baseProfile(),
  store,
  strategyResult: strategyResult({ latestEvent: event }),
});
const market = client.calls.find((call) => call.type === "placeMarketOrder");
assert(market, "Market order was not sent for strategy entry event.");
assert(market.quantity === 2, `Expected MARKET qty 2, got ${market.quantity}`);
assert(result.live.pendingTriggerOrder?.marginSafety?.accountBalanceUsed === 100, "Risk basis did not use account equity/balance.");
assert(result.live.pendingTriggerOrder?.marginSafety?.accountRiskAmount === 10, "Account risk amount diagnostic is wrong.");
assert(result.live.pendingTriggerOrder?.marginSafety?.rawQtyFromAccountRisk === 2, "Raw account-risk quantity diagnostic is wrong.");
assert(result.live.pendingTriggerOrder?.marginSafety?.finalRiskAtSL === 10, "Final risk at SL diagnostic is wrong.");

console.log("Sztab risk sizing regression passed");

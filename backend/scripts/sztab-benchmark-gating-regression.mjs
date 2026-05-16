import { processLiveProfileExecution } from "../src/execution/executionEngine.js";
import { aggregateCandles } from "../src/strategy/strategyRunner.js";
import { STRATEGY_EVENT_TYPES } from "../../hubert-platform/frontend/src/engine/strategyEngine.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function baseProfile() {
  return {
    enabled: true,
    executionMode: "live",
    id: "sztab-10m",
    live: { openPosition: null, orderLog: [], setupOrderJournal: [] },
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
      startingBalance: 10_000,
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
    timeframe: "10m",
  };
}

function setupEvent({ benchmarkTime, setupId = "gate-test", trigger = 100 } = {}) {
  return {
    benchmarkTime,
    direction: "LONG",
    index: 120,
    setupId,
    signalTime: benchmarkTime - 600,
    stopLoss: 95,
    time: benchmarkTime,
    trigger,
    type: STRATEGY_EVENT_TYPES.SETUP_ACTIVE,
  };
}

function strategyResult({ latestSetupEvent = null } = {}) {
  return {
    latestEvent: null,
    latestSetupEvent,
    sourceCandles: [{ close: 99, high: 100, low: 98, open: 99, time: Math.floor(Date.now() / 1000) }],
    strategy: { events: latestSetupEvent ? [latestSetupEvent] : [] },
  };
}

function createStore() {
  const store = {
    orders: [],
    getState: () => ({ botStatus: "LIVE_RUNNING" }),
    upsertOrder: async (order) => {
      store.orders.push(order);
    },
    upsertTrade: async () => {},
  };
  return store;
}

function createBingxClient() {
  const calls = [];
  let positions = [];
  const openOrders = [];
  return {
    auth: { configured: true },
    calls,
    getOpenPositions: async () => positions,
    getOpenOrders: async () => openOrders,
    getPerpetualFuturesBalance: async () => ({
      balance: {
        availableBalance: 10_000,
        availableMargin: 10_000,
        balance: 10_000,
        equity: 10_000,
      },
    }),
    placeMarketOrder: async (symbol, side, quantity) => {
      calls.push({ quantity, side, symbol, type: "placeMarketOrder" });
      positions = [{
        avgPrice: 100,
        positionAmt: quantity,
        positionId: "long-gate-test",
        positionSide: "LONG",
        quantity,
        symbol,
      }];
      return { data: { executedQty: quantity, orderId: "market-gate-test", status: "FILLED" } };
    },
    placePositionStopLoss: async (symbol, side, stopLoss, options = {}) => {
      calls.push({ options, side, stopLoss, symbol, type: "placePositionStopLoss" });
      const order = {
        orderId: "sl-gate-test",
        positionSide: options.positionSide ?? (side === "BUY" ? "LONG" : "SHORT"),
        status: "NEW",
        stopPrice: stopLoss,
        symbol,
        type: "STOP_MARKET",
      };
      openOrders.push(order);
      return { data: order };
    },
    placeTriggerMarketOrder: async () => {
      calls.push({ type: "placeTriggerMarketOrder" });
      return { data: { orderId: "trigger-should-not-be-used", status: "NEW" } };
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

function createPriceService({ price = 99, recentTicks = [], time = new Date().toISOString() } = {}) {
  return {
    getPrice: async () => ({
      ageMs: 0,
      degraded: false,
      mode: "websocket",
      price,
      raw: { price },
      recentHigh: recentTicks.length ? Math.max(...recentTicks.map((tick) => tick.price)) : null,
      recentLow: recentTicks.length ? Math.min(...recentTicks.map((tick) => tick.price)) : null,
      recentTicks,
      source: "binance_futures",
      stale: false,
      status: "ok",
      time,
      websocketAgeMs: 0,
      websocketStatus: "connected",
    }),
  };
}

function assertCustomAggregationDoesNotClosePartialBucket() {
  const bucketOpen = Date.UTC(2026, 0, 1, 12, 0, 0);
  const fiveMinutes = 5 * 60 * 1000;
  const candles = [{
    close: 100,
    closeTime: bucketOpen + fiveMinutes - 1,
    high: 101,
    isClosed: true,
    low: 99,
    open: 100,
    openTime: bucketOpen,
    time: Math.floor(bucketOpen / 1000),
    volume: 1,
  }];
  const partial = aggregateCandles(candles, 10, bucketOpen + fiveMinutes + 1);
  assert(partial[0]?.isClosed === false, "Partial 10m bucket was marked closed before bucket close.");

  const full = aggregateCandles([
    ...candles,
    {
      close: 101,
      closeTime: bucketOpen + 2 * fiveMinutes - 1,
      high: 102,
      isClosed: true,
      low: 100,
      open: 100,
      openTime: bucketOpen + fiveMinutes,
      time: Math.floor((bucketOpen + fiveMinutes) / 1000),
      volume: 1,
    },
  ], 10, bucketOpen + 10 * 60 * 1000);
  assert(full[0]?.isClosed === true, "Completed 10m bucket was not marked closed.");
}

async function assertFormingSetupDoesNotArm() {
  delete process.env.SZTAB_EXECUTION_MODE;
  const client = createBingxClient();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const result = await processLiveProfileExecution({
    bingxClient: client,
    logger: async () => {},
    priceService: createPriceService({
      price: 101,
      recentTicks: [{ price: 101, time: new Date(nowSeconds * 1000).toISOString() }],
    }),
    profile: baseProfile(),
    store: createStore(),
    strategyResult: strategyResult({ latestSetupEvent: setupEvent({ benchmarkTime: nowSeconds - 300, setupId: "forming" }) }),
  });

  assert(!result.live.pendingTriggerOrder, "Forming setup created a pending trigger before benchmark close.");
  assert(result.live.formingSetupCandidate?.setupId === "forming", "Forming setup candidate diagnostic was not retained.");
  assert(!client.calls.some((call) => call.type === "placeMarketOrder" || call.type === "placeTriggerMarketOrder"), "Forming setup sent a live order.");
}

async function assertClosedSetupArmsAndExecutesAfterTick() {
  delete process.env.SZTAB_EXECUTION_MODE;
  const client = createBingxClient();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const setup = setupEvent({ benchmarkTime: nowSeconds - 900, setupId: "closed" });
  const armed = await processLiveProfileExecution({
    bingxClient: client,
    logger: async () => {},
    priceService: createPriceService({ price: 99 }),
    profile: baseProfile(),
    store: createStore(),
    strategyResult: strategyResult({ latestSetupEvent: setup }),
  });
  assert(armed.live.pendingTriggerOrder?.status === "platform_armed", "Closed setup did not arm platform trigger.");
  assert(armed.live.pendingTriggerOrder?.executionMode === "platform_market_trigger", "Default execution mode is not platform_market_trigger.");
  assert(!client.calls.some((call) => call.type === "placeTriggerMarketOrder"), "Default mode used BingX trigger order.");

  const postTick = new Date((nowSeconds + 1) * 1000).toISOString();
  const executed = await processLiveProfileExecution({
    bingxClient: client,
    logger: async () => {},
    priceService: createPriceService({
      price: 100.01,
      recentTicks: [{ price: 100.01, time: postTick }],
      time: postTick,
    }),
    profile: armed,
    store: createStore(),
    strategyResult: strategyResult(),
  });
  assert(executed.live.pendingTriggerOrder?.status === "filled_protected", "Post-close Binance tick did not execute MARKET.");
  assert(client.calls.some((call) => call.type === "placeMarketOrder"), "Post-close trigger did not send MARKET.");
}

assertCustomAggregationDoesNotClosePartialBucket();
await assertFormingSetupDoesNotArm();
await assertClosedSetupArmsAndExecutesAfterTick();

console.log("Sztab benchmark gating regression passed");

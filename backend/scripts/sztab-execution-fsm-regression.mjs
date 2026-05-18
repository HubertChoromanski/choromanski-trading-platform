import { processLiveProfileExecution } from "../src/execution/executionEngine.js";
import { LIVE_EXECUTION_STATES } from "../src/execution/liveExecutionFsm.js";
import { STRATEGY_EVENT_TYPES } from "../../hubert-platform/frontend/src/engine/strategyEngine.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function intervalSeconds(interval = "10m") {
  if (interval.endsWith("h")) return Number.parseInt(interval, 10) * 3600;
  return Number.parseInt(interval, 10) * 60;
}

function baseProfile({ interval = "10m", live = {} } = {}) {
  return {
    enabled: true,
    executionMode: "live",
    id: `sztab-${interval}`,
    live: {
      openPosition: null,
      orderLog: [],
      setupOrderJournal: [],
      ...live,
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
    timeframe: interval,
  };
}

function setupEvent({ direction = "LONG", interval = "10m", setupId = "setup-1", stopLoss = 95, trigger = 100 } = {}) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const benchmarkTime = nowSeconds - intervalSeconds(interval) - 30;
  return {
    benchmarkTime,
    direction,
    index: 120,
    setupId,
    signalTime: benchmarkTime - intervalSeconds(interval),
    stopLoss,
    time: benchmarkTime,
    trigger,
    type: STRATEGY_EVENT_TYPES.SETUP_ACTIVE,
  };
}

function invalidationEvent(setup) {
  return {
    ...setup,
    time: setup.time + intervalSeconds("10m"),
    type: STRATEGY_EVENT_TYPES.SETUP_INVALIDATED,
  };
}

function strategyResult({ events = [], latestEvent = null, latestSetupEvent = null } = {}) {
  return {
    latestEvent,
    latestSetupEvent,
    sourceCandles: [{ close: 99, high: 101, low: 98, open: 99, time: Math.floor(Date.now() / 1000) }],
    strategy: { events },
  };
}

function createStore() {
  const store = {
    orders: [],
    trades: [],
    getState: () => ({ botStatus: "LIVE_RUNNING" }),
    upsertOrder: async (order) => store.orders.push(order),
    upsertTrade: async (trade) => store.trades.push(trade),
  };
  return store;
}

function createPriceService({ price = 99, recentTicks = [], source = "binance_futures" } = {}) {
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
      source,
      stale: false,
      status: "ok",
      time: new Date().toISOString(),
      websocketAgeMs: 0,
      websocketStatus: "connected",
    }),
  };
}

function createClient({ marketCreatesPosition = true } = {}) {
  const calls = [];
  let positions = [];
  const openOrders = [];
  return {
    auth: { configured: true },
    calls,
    cancelOrder: async (symbol, options = {}) => {
      calls.push({ options, symbol, type: "cancelOrder" });
      return { data: { orderId: options.orderId, status: "CANCELED" } };
    },
    getOpenPositions: async () => positions,
    getOpenOrders: async () => openOrders,
    getOrderStatus: async (orderId) => {
      calls.push({ orderId, type: "getOrderStatus" });
      return { data: { executedQty: 0, orderId, status: "NEW" } };
    },
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
      if (marketCreatesPosition) {
        positions = [{
          avgPrice: side === "BUY" ? 100 : 90,
          positionAmt: quantity,
          positionSide: side === "BUY" ? "LONG" : "SHORT",
          quantity,
          symbol,
        }];
      }
      return { data: { executedQty: quantity, orderId: "market-1", status: "FILLED" } };
    },
    placePositionStopLoss: async (symbol, side, stopLoss, options = {}) => {
      calls.push({ options, side, stopLoss, symbol, type: "placePositionStopLoss" });
      const order = { orderId: "sl-1", positionSide: options.positionSide, status: "NEW", stopPrice: stopLoss, symbol, type: "STOP_MARKET" };
      openOrders.push(order);
      return { data: order };
    },
    setLeverage: async () => {},
    setMarginMode: async () => {},
  };
}

async function assertPreviousAcceptedCannotBlockNextSetup() {
  process.env.SZTAB_EXECUTION_MODE = "platform_market_trigger";
  const oldPending = {
    acceptedAt: "2026-05-17T10:00:00.000Z",
    direction: "SHORT",
    executionMode: "exchange_trigger",
    orderId: "old-trigger",
    setupFingerprint: "sf_old_accepted",
    setupId: "old-setup",
    side: "SELL",
    status: "accepted",
    stopLoss: 110,
    triggerPrice: 100,
  };
  const setup = setupEvent({ direction: "LONG", setupId: "next-setup", trigger: 101 });
  const client = createClient();
  const result = await processLiveProfileExecution({
    bingxClient: client,
    logger: async () => {},
    priceService: createPriceService({ price: 99 }),
    profile: baseProfile({ live: { pendingTriggerOrder: oldPending } }),
    store: createStore(),
    strategyResult: strategyResult({ latestSetupEvent: setup }),
  });

  assert(client.calls.some((call) => call.type === "cancelOrder" && call.options.orderId === "old-trigger"), "Old accepted trigger was not canceled.");
  assert(result.live.pendingTriggerOrder?.setupId === "next-setup", "New setup did not own the pending lifecycle.");
  assert(result.live.currentExecutionState === LIVE_EXECUTION_STATES.TRIGGER_ARMED, "New setup did not transition to TRIGGER_ARMED.");
}

async function assertStaleAcceptedPendingGetsCleaned() {
  process.env.SZTAB_EXCHANGE_TRIGGER_ACCEPTED_TIMEOUT_MS = "1";
  const pending = {
    acceptedAt: "2026-05-17T10:00:00.000Z",
    direction: "LONG",
    executionMode: "exchange_trigger",
    orderId: "stale-trigger",
    setupFingerprint: "sf_stale",
    setupId: "stale-setup",
    side: "BUY",
    status: "accepted",
    stopLoss: 95,
    triggerPrice: 100,
  };
  const client = createClient();
  const result = await processLiveProfileExecution({
    bingxClient: client,
    logger: async () => {},
    priceService: createPriceService({ price: 99 }),
    profile: baseProfile({ live: { pendingTriggerOrder: pending } }),
    store: createStore(),
    strategyResult: strategyResult(),
  });

  assert(result.live.pendingTriggerOrder?.status === "accepted_trigger_reconcile_timeout", "Stale accepted trigger did not become terminal timeout.");
  assert(result.live.pendingTriggerOrder?.canArmNextSetup === true, "Timed-out trigger still blocks next setup.");
  assert(result.live.currentExecutionState === LIVE_EXECUTION_STATES.SETUP_SKIPPED, "Timeout did not transition to SETUP_SKIPPED.");
  delete process.env.SZTAB_EXCHANGE_TRIGGER_ACCEPTED_TIMEOUT_MS;
}

async function assertTriggerCrossedWithoutEntryHasReason() {
  process.env.SZTAB_EXECUTION_MODE = "platform_market_trigger";
  const setup = setupEvent({ direction: "LONG", setupId: "missing-position", trigger: 100 });
  const client = createClient({ marketCreatesPosition: false });
  const armed = await processLiveProfileExecution({
    bingxClient: client,
    logger: async () => {},
    priceService: createPriceService({ price: 99 }),
    profile: baseProfile(),
    store: createStore(),
    strategyResult: strategyResult({ latestSetupEvent: setup }),
  });
  const result = await processLiveProfileExecution({
    bingxClient: client,
    logger: async () => {},
    priceService: createPriceService({ price: 100.01, recentTicks: [{ price: 100.01, time: new Date().toISOString() }] }),
    profile: armed,
    store: createStore(),
    strategyResult: strategyResult(),
  });

  assert(
    result.live.pendingTriggerOrder?.status === "market_sent_position_missing",
    `Missing position did not get explicit status: ${JSON.stringify(result.live.pendingTriggerOrder)}`,
  );
  assert(result.live.currentExecutionState === LIVE_EXECUTION_STATES.ERROR, "Missing position did not transition to ERROR.");
  assert(result.live.currentExecutionReason === "market_sent_position_missing", "Missing position reason was not exposed.");
}

async function assertInvalidationResetsForNextSetup() {
  process.env.SZTAB_EXECUTION_MODE = "platform_market_trigger";
  const first = setupEvent({ direction: "LONG", setupId: "first-setup", trigger: 100 });
  const client = createClient();
  const armed = await processLiveProfileExecution({
    bingxClient: client,
    logger: async () => {},
    priceService: createPriceService({ price: 99 }),
    profile: baseProfile(),
    store: createStore(),
    strategyResult: strategyResult({ latestSetupEvent: first }),
  });
  const invalidated = await processLiveProfileExecution({
    bingxClient: client,
    logger: async () => {},
    priceService: createPriceService({ price: 99 }),
    profile: armed,
    store: createStore(),
    strategyResult: strategyResult({ events: [invalidationEvent(first)] }),
  });
  assert(invalidated.live.currentExecutionState === LIVE_EXECUTION_STATES.SETUP_INVALIDATED, "Invalidation did not transition to SETUP_INVALIDATED.");
  const next = setupEvent({ direction: "SHORT", setupId: "second-setup", stopLoss: 106, trigger: 96 });
  const rearmed = await processLiveProfileExecution({
    bingxClient: client,
    logger: async () => {},
    priceService: createPriceService({ price: 99 }),
    profile: invalidated,
    store: createStore(),
    strategyResult: strategyResult({ latestSetupEvent: next }),
  });
  assert(rearmed.live.pendingTriggerOrder?.setupId === "second-setup", "Next setup did not replace invalidated lifecycle.");
  assert(rearmed.live.currentExecutionState === LIVE_EXECUTION_STATES.TRIGGER_ARMED, "Next setup did not arm after invalidation.");
}

async function assertRepeatedIntervalsArmCleanly() {
  for (const interval of ["10m", "15m", "20m", "1h"]) {
    const client = createClient();
    const setup = setupEvent({ direction: "LONG", interval, setupId: `${interval}-setup`, trigger: 100 });
    const result = await processLiveProfileExecution({
      bingxClient: client,
      logger: async () => {},
      priceService: createPriceService({ price: 99 }),
      profile: baseProfile({ interval }),
      store: createStore(),
      strategyResult: strategyResult({ latestSetupEvent: setup }),
    });
    assert(result.live.pendingTriggerOrder?.setupId === `${interval}-setup`, `${interval} did not own its setup.`);
    assert(result.live.currentExecutionState === LIVE_EXECUTION_STATES.TRIGGER_ARMED, `${interval} did not transition to TRIGGER_ARMED.`);
  }
}

await assertPreviousAcceptedCannotBlockNextSetup();
await assertStaleAcceptedPendingGetsCleaned();
await assertTriggerCrossedWithoutEntryHasReason();
await assertInvalidationResetsForNextSetup();
await assertRepeatedIntervalsArmCleanly();

console.log("Sztab execution FSM regression passed");

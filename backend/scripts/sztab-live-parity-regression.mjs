import { processLiveProfileExecution } from "../src/execution/executionEngine.js";
import { STRATEGY_EVENT_TYPES } from "../../hubert-platform/frontend/src/engine/strategyEngine.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function baseProfile(overrides = {}) {
  return {
    enabled: true,
    executionMode: "live",
    id: "sztab-10m",
    live: {
      openPosition: null,
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
    ...overrides,
  };
}

function entryEvent({ direction = "LONG", setupId = "setup-1", time = 2_000, trigger = 100, stopLoss = 95 } = {}) {
  return {
    benchmarkTime: time - 600,
    direction,
    index: 120,
    setupId,
    signalTime: time - 1_200,
    stopLoss,
    time,
    trigger,
    type: STRATEGY_EVENT_TYPES.ENTRY_TRIGGERED,
  };
}

function setupEvent({ direction = "LONG", setupId = "setup-1", time = 1_400, trigger = 100, stopLoss = 95 } = {}) {
  return {
    benchmarkTime: time,
    direction,
    index: 119,
    setupId,
    signalTime: time - 600,
    stopLoss,
    time,
    trigger,
    type: STRATEGY_EVENT_TYPES.SETUP_ACTIVE,
  };
}

function invalidationEvent({ direction = "LONG", setupId = "setup-1", time = 2_000, trigger = 100, stopLoss = 95 } = {}) {
  return {
    benchmarkTime: time - 600,
    direction,
    index: 120,
    setupId,
    signalTime: time - 1_200,
    stopLoss,
    time,
    trigger,
    type: STRATEGY_EVENT_TYPES.SETUP_INVALIDATED,
  };
}

function strategyResult({ events = [], latestEvent = null, latestSetupEvent = null } = {}) {
  return {
    latestEvent,
    latestSetupEvent,
    sourceCandles: [{ close: 100, high: 101, low: 99, open: 100, time: 2_000 }],
    strategy: { events },
  };
}

function createStore() {
  return {
    orders: [],
    trades: [],
    getState: () => ({ botStatus: "LIVE_RUNNING" }),
    upsertOrder: async (order) => {
      store.orders.push(order);
    },
    upsertTrade: async (trade) => {
      store.trades.push(trade);
    },
  };
}

const store = createStore();

function createPriceService({ mode = "websocket", price = 101, recentTicks = null, source = "binance_futures" } = {}) {
  const calls = [];
  return {
    calls,
    getPrice: async ({ source: requestedSource }) => {
      calls.push(requestedSource);
      return {
        ageMs: 0,
        degraded: false,
        fallbackActive: mode !== "websocket",
        lastWebsocketTickAt: mode === "websocket" ? new Date().toISOString() : null,
        mode,
        price,
        raw: { price },
        recentHigh: Array.isArray(recentTicks) && recentTicks.length
          ? Math.max(...recentTicks.map((tick) => tick.price))
          : null,
        recentLow: Array.isArray(recentTicks) && recentTicks.length
          ? Math.min(...recentTicks.map((tick) => tick.price))
          : null,
        recentTicks: Array.isArray(recentTicks) ? recentTicks : [],
        rateLimitCount: 0,
        source,
        stale: false,
        status: "ok",
        time: new Date().toISOString(),
        websocketAgeMs: mode === "websocket" ? 0 : null,
        websocketStatus: mode === "websocket" ? "connected" : "unconfigured",
      };
    },
  };
}

function createBingxClient({ initialPositions = [] } = {}) {
  const calls = [];
  let positions = [...initialPositions];
  return {
    auth: { configured: true },
    calls,
    cancelOrder: async () => {
      calls.push({ type: "cancelOrder" });
      return { data: { ok: true } };
    },
    cancelOpenOrders: async () => {
      calls.push({ type: "cancelOpenOrders" });
      return { data: { ok: true } };
    },
    closePosition: async (symbol, options = {}) => {
      calls.push({ options, symbol, type: "closePosition" });
      const side = String(options.positionSide ?? options.position?.positionSide ?? "").toUpperCase();
      positions = positions.filter((position) => String(position.positionSide).toUpperCase() !== side);
      return { data: { orderId: "close-1", status: "FILLED" } };
    },
    getOpenPositions: async () => positions,
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
      const positionSide = side === "BUY" ? "LONG" : "SHORT";
      positions = [{
        avgPrice: side === "BUY" ? 100 : 90,
        positionAmt: quantity,
        positionId: `${positionSide.toLowerCase()}-1`,
        positionSide,
        quantity,
        symbol,
      }];
      return { data: { executedQty: quantity, orderId: `${positionSide.toLowerCase()}-market-1`, status: "FILLED" } };
    },
    placePositionStopLoss: async (symbol, side, stopLoss, options = {}) => {
      calls.push({ options, side, stopLoss, symbol, type: "placePositionStopLoss" });
      return { data: { orderId: "sl-1", status: "NEW" } };
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

async function assertArmedSetupBinanceCrossSendsMarket() {
  process.env.SZTAB_EXECUTION_MODE = "platform_market_trigger";
  const client = createBingxClient();
  const priceService = createPriceService({
    price: 99.98,
    recentTicks: [{ price: 100.01, time: new Date(Date.now() + 1000).toISOString() }],
  });
  const armed = await processLiveProfileExecution({
    bingxClient: client,
    logger: async () => {},
    priceService,
    profile: baseProfile(),
    store,
    strategyResult: strategyResult({ latestSetupEvent: setupEvent({ trigger: 100 }) }),
  });
  assert(armed.live.pendingTriggerOrder?.status === "platform_armed", "Setup was not armed.");
  assert(!client.calls.some((call) => call.type === "placeMarketOrder"), "Market order was sent before trigger cross.");

  const executed = await processLiveProfileExecution({
    bingxClient: client,
    logger: async () => {},
    priceService,
    profile: armed,
    store,
    strategyResult: strategyResult(),
  });
  assert(
    executed.live.pendingTriggerOrder?.status === "filled_protected",
    `Binance websocket wick touch did not execute market entry: ${JSON.stringify(executed.live.pendingTriggerOrder?.platformTriggerDiagnostics ?? executed.live.pendingTriggerOrder)}`,
  );
  assert(client.calls.some((call) => call.type === "placeMarketOrder" && call.side === "BUY"), "LONG market order was not sent.");
  assert(priceService.calls.every((source) => source === "binance_futures"), `Unexpected strategic price source: ${priceService.calls.join(",")}`);
  assert(
    executed.live.pendingTriggerOrder?.platformTriggerDiagnostics?.priceFeed?.mode === "websocket",
    "Wick trigger test did not use websocket price feed mode.",
  );
  assert(
    executed.live.pendingTriggerOrder?.platformTriggerDiagnostics?.recentTickTriggerTouched === true,
    "Wick touch was not detected from recent websocket ticks.",
  );
}

async function assertStrategyEntryDoesNotRequireLivePriceCross() {
  process.env.SZTAB_EXECUTION_MODE = "platform_market_trigger";
  const client = createBingxClient();
  const priceService = createPriceService({ price: 90 });
  const event = entryEvent({ direction: "LONG", setupId: "entry-with-price-below-trigger", stopLoss: 95, trigger: 100 });
  const result = await processLiveProfileExecution({
    bingxClient: client,
    logger: async () => {},
    priceService,
    profile: baseProfile(),
    store,
    strategyResult: strategyResult({ events: [event], latestEvent: event }),
  });
  assert(result.live.pendingTriggerOrder?.status === "filled_protected", "Strategy ENTRY_TRIGGERED did not execute.");
  assert(client.calls.some((call) => call.type === "placeMarketOrder" && call.side === "BUY"), "Strategy event did not send MARKET.");

  const marketCalls = client.calls.filter((call) => call.type === "placeMarketOrder").length;
  await processLiveProfileExecution({
    bingxClient: client,
    logger: async () => {},
    priceService,
    profile: result,
    store,
    strategyResult: strategyResult({ events: [event], latestEvent: event }),
  });
  assert(client.calls.filter((call) => call.type === "placeMarketOrder").length === marketCalls, "Repeated polling duplicated strategy event entry.");
}

async function assertReversalClosesThenOpensOpposite() {
  process.env.SZTAB_EXECUTION_MODE = "platform_market_trigger";
  const client = createBingxClient({
    initialPositions: [{
      avgPrice: 100,
      positionAmt: 1,
      positionId: "long-old",
      positionSide: "LONG",
      quantity: 1,
      symbol: "SOLUSDT",
    }],
  });
  const priceService = createPriceService({ price: 100 });
  const oldPosition = {
    direction: "LONG",
    entryPrice: 100,
    entryTime: 1_000,
    quantity: 1,
    setupId: "old-long",
    stopLoss: 95,
  };
  const reverseEntry = entryEvent({ direction: "SHORT", setupId: "new-short", stopLoss: 105, trigger: 99 });
  const reversalExit = {
    exitPrice: 99,
    exitReason: "REVERSAL",
    setupId: "old-long",
    time: reverseEntry.time,
    type: STRATEGY_EVENT_TYPES.POSITION_EXITED,
  };

  const result = await processLiveProfileExecution({
    bingxClient: client,
    logger: async () => {},
    priceService,
    profile: baseProfile({ live: { openPosition: oldPosition, orderLog: [], setupOrderJournal: [] } }),
    store,
    strategyResult: strategyResult({ events: [reversalExit, reverseEntry], latestEvent: reverseEntry }),
  });

  const closeIndex = client.calls.findIndex((call) => call.type === "closePosition");
  const entryIndex = client.calls.findIndex((call) => call.type === "placeMarketOrder" && call.side === "SELL");
  assert(closeIndex >= 0, "Reversal did not close the old position.");
  assert(entryIndex > closeIndex, "Reversal did not open opposite position after close.");
  assert(result.live.pendingTriggerOrder?.reversalStatus === "completed", "Reversal status was not completed.");
}

async function assertStrategyInvalidationCancelsSetup() {
  process.env.SZTAB_EXECUTION_MODE = "platform_market_trigger";
  const client = createBingxClient();
  const priceService = createPriceService({ price: 99 });
  const armed = await processLiveProfileExecution({
    bingxClient: client,
    logger: async () => {},
    priceService,
    profile: baseProfile(),
    store,
    strategyResult: strategyResult({ latestSetupEvent: setupEvent({ setupId: "invalidate-me", trigger: 100 }) }),
  });
  const invalidated = invalidationEvent({ setupId: "invalidate-me", trigger: 100 });
  const result = await processLiveProfileExecution({
    bingxClient: client,
    logger: async () => {},
    priceService,
    profile: armed,
    store,
    strategyResult: strategyResult({ events: [invalidated], latestSetupEvent: invalidated }),
  });
  assert(result.live.pendingTriggerOrder?.status === "setup_invalidated_before_platform_trigger", "Strategy invalidation did not cancel armed setup.");
  assert(!client.calls.some((call) => call.type === "placeMarketOrder"), "Invalidated setup still sent market order.");
}

await assertArmedSetupBinanceCrossSendsMarket();
await assertStrategyEntryDoesNotRequireLivePriceCross();
await assertReversalClosesThenOpensOpposite();
await assertStrategyInvalidationCancelsSetup();
console.log("Sztab live parity regression passed");

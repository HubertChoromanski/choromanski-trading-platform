import { createPriceService } from "../src/market/priceService.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

class MockWebSocket {
  static instances = [];

  constructor(url) {
    this.listeners = new Map();
    this.sent = [];
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type, handler) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }

  send(payload) {
    this.sent.push(payload);
  }

  emit(type, data = {}) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler(data);
    }
  }
}

async function flush() {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function assertBinanceWebsocketTickWinsOverRest() {
  MockWebSocket.instances = [];
  const service = createPriceService({
    WebSocketImpl: MockWebSocket,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ price: "99.00", symbol: "SOLUSDT" }),
    }),
    logger: { warn: () => {} },
  });

  const first = await service.getPrice({ source: "binance_futures", symbol: "SOLUSDT" });
  assert(first.mode === "rest" || first.mode === "websocket+rest", `First sample should be REST fallback, got ${first.mode}`);
  assert(MockWebSocket.instances.length === 1, "Binance Futures websocket was not started for symbol.");
  assert(MockWebSocket.instances[0].url.includes("solusdt@aggTrade"), `Unexpected websocket URL: ${MockWebSocket.instances[0].url}`);

  MockWebSocket.instances[0].emit("open");
  MockWebSocket.instances[0].emit("message", {
    data: JSON.stringify({
      e: "aggTrade",
      p: "100.25",
      s: "SOLUSDT",
    }),
  });
  await flush();

  const sample = await service.getPrice({ source: "binance_futures", symbol: "SOLUSDT" });
  assert(sample.price === 100.25, `Websocket tick did not update price: ${sample.price}`);
  assert(sample.mode === "websocket", `Websocket tick should be primary mode, got ${sample.mode}`);
  assert(sample.fallbackActive === false, "Websocket sample should not be marked as fallback.");
  assert(sample.websocketStatus === "connected", `Unexpected websocket status: ${sample.websocketStatus}`);
  assert(sample.lastWebsocketTickAt, "Last websocket tick timestamp is missing.");
}

async function assertRestFallbackWhenWebsocketUnavailable() {
  MockWebSocket.instances = [];
  const oldEnabled = process.env.BINANCE_FUTURES_PRICE_WEBSOCKET_ENABLED;
  process.env.BINANCE_FUTURES_PRICE_WEBSOCKET_ENABLED = "false";
  try {
    const service = createPriceService({
      WebSocketImpl: MockWebSocket,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ price: "98.75", symbol: "SOLUSDT" }),
      }),
      logger: { warn: () => {} },
    });
    const sample = await service.getPrice({ source: "binance_futures", symbol: "SOLUSDT" });
    assert(sample.price === 98.75, `REST fallback price mismatch: ${sample.price}`);
    assert(sample.mode === "rest", `REST fallback should be rest mode, got ${sample.mode}`);
    assert(sample.fallbackActive === true, "REST fallback should mark fallbackActive=true for Binance source.");
    assert(sample.websocketStatus === "disabled", `Expected disabled websocket, got ${sample.websocketStatus}`);
    assert(MockWebSocket.instances.length === 0, "Disabled websocket still created an instance.");
  } finally {
    if (oldEnabled === undefined) {
      delete process.env.BINANCE_FUTURES_PRICE_WEBSOCKET_ENABLED;
    } else {
      process.env.BINANCE_FUTURES_PRICE_WEBSOCKET_ENABLED = oldEnabled;
    }
  }
}

await assertBinanceWebsocketTickWinsOverRest();
await assertRestFallbackWhenWebsocketUnavailable();
console.log("Sztab price websocket regression passed");

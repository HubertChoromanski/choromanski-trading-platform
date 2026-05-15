import { gunzipSync } from "node:zlib";

const DEFAULT_REST_MIN_INTERVAL_MS = 1_000;
const DEFAULT_REST_BACKOFF_MS = 2_000;
const DEFAULT_REST_BACKOFF_MAX_MS = 30_000;
const DEFAULT_FRESH_MS = 1_200;

function compactSymbol(symbol) {
  return String(symbol ?? "").replace("-", "").toUpperCase();
}

function normalizeSource(source) {
  const value = String(source ?? "bingx_mark").toLowerCase();
  if (value === "bingx_last" || value === "binance_futures") return value;
  return "bingx_mark";
}

function cacheKey(symbol, source) {
  return `${normalizeSource(source)}:${compactSymbol(symbol)}`;
}

function numericValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function extractMarketPrice(payload) {
  const candidates = [
    payload?.markPrice,
    payload?.indexPrice,
    payload?.price,
    payload?.lastPrice,
    payload?.close,
    payload?.data?.markPrice,
    payload?.data?.indexPrice,
    payload?.data?.price,
    payload?.data?.lastPrice,
    payload?.data?.close,
  ];

  for (const candidate of candidates) {
    const value = numericValue(candidate);
    if (value !== null && value > 0) return value;
  }

  return null;
}

function isRateLimitError(error) {
  const message = String(error?.message ?? error ?? "").toLowerCase();
  const code = String(error?.code ?? error?.status ?? error?.payload?.code ?? "").toLowerCase();
  return error?.status === 429 ||
    code === "429" ||
    message.includes("429") ||
    message.includes("too many request") ||
    message.includes("too many requests") ||
    message.includes("rate limit");
}

function isTransientPriceError(error) {
  const message = String(error?.message ?? error ?? "").toLowerCase();
  return isRateLimitError(error) ||
    error?.name === "AbortError" ||
    ["etimedout", "econnreset", "econnrefused", "enotfound", "eai_again"].includes(String(error?.code ?? "").toLowerCase()) ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("timeout") ||
    error?.status >= 500;
}

function sanitizeError(error) {
  return {
    code: error?.code ?? null,
    message: error instanceof Error ? error.message : String(error),
    status: error?.status ?? null,
  };
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class PriceFeedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PriceFeedError";
    this.details = details;
    this.priceFeedDegraded = true;
    this.transient = details.transient !== false;
  }
}

export function createPriceService({
  defaultClient = null,
  fetchImpl = fetch,
  logger = console,
  WebSocketImpl = globalThis.WebSocket,
} = {}) {
  const entries = new Map();
  const binanceWebsockets = new Map();
  const priceTickListeners = new Set();
  const websocketState = {
    connected: false,
    enabled: String(process.env.BINGX_PRICE_WEBSOCKET_ENABLED ?? "true").toLowerCase() !== "false",
    error: "",
    started: false,
    status: "not_started",
    url: process.env.BINGX_PRICE_WS_URL || "",
  };

  const restMinIntervalMs = Number(process.env.SZTAB_PRICE_REST_MIN_INTERVAL_MS || DEFAULT_REST_MIN_INTERVAL_MS);
  const baseBackoffMs = Number(process.env.SZTAB_PRICE_REST_BACKOFF_MS || DEFAULT_REST_BACKOFF_MS);
  const maxBackoffMs = Number(process.env.SZTAB_PRICE_REST_BACKOFF_MAX_MS || DEFAULT_REST_BACKOFF_MAX_MS);
  const freshMs = Number(process.env.SZTAB_PRICE_FRESH_MS || DEFAULT_FRESH_MS);
  const selectedPriceSource = normalizeSource(process.env.SZTAB_PRICE_SOURCE || "binance_futures");
  const binanceWebsocketEnabled = String(process.env.BINANCE_FUTURES_PRICE_WEBSOCKET_ENABLED ?? "true").toLowerCase() !== "false";
  const binanceWebsocketBaseUrl = process.env.BINANCE_FUTURES_PRICE_WS_URL || "wss://fstream.binance.com/ws";
  const binanceReconnectMs = Number(process.env.BINANCE_FUTURES_PRICE_WS_RECONNECT_MS || 2_000);

  function binanceWebsocketConfigReason() {
    if (!binanceWebsocketEnabled) return "disabled_by_env_BINANCE_FUTURES_PRICE_WEBSOCKET_ENABLED";
    if (typeof WebSocketImpl !== "function") return "websocket_runtime_unavailable_rest_fallback_active";
    return "configured_by_SZTAB_PRICE_SOURCE";
  }

  logger.info?.("[price-service] startup", {
    binanceFuturesWebsocketEnabled: binanceWebsocketEnabled,
    selectedSztabPriceSource: selectedPriceSource,
    websocketConfigReason: binanceWebsocketConfigReason(),
  });

  function entryFor(symbol, source) {
    const key = cacheKey(symbol, source);
    if (!entries.has(key)) {
      entries.set(key, {
        backoffUntil: 0,
        consecutiveErrors: 0,
        degraded: false,
        fallbackActive: false,
        inFlight: null,
        key,
        lastError: null,
        lastRequestAt: 0,
        mode: "rest",
        price: null,
        rateLimitCount: 0,
        recentTicks: [],
        requestCount: 0,
        source: normalizeSource(source),
        status: "empty",
        symbol: compactSymbol(symbol),
        updatedAt: null,
        websocketError: "",
        websocketConfigReason: source === "binance_futures" ? binanceWebsocketConfigReason() : "",
        websocketDisabledReason: "",
        websocketStatus: "not_started",
        websocketUpdatedAt: null,
      });
    }
    return entries.get(key);
  }

  function updateEntry(symbol, source, patch = {}) {
    const entry = entryFor(symbol, source);
    Object.assign(entry, patch);
    return entry;
  }

  function appendRecentTick(entry, price, time = nowIso()) {
    const numericPrice = numericValue(price);
    if (numericPrice === null) return entry;
    const cutoff = Date.now() - Number(process.env.BINANCE_FUTURES_PRICE_TICK_WINDOW_MS || 120_000);
    entry.recentTicks = [
      ...(entry.recentTicks ?? []).filter((tick) => Date.parse(tick.time) >= cutoff),
      { price: numericPrice, time },
    ].slice(-Number(process.env.BINANCE_FUTURES_PRICE_MAX_TICKS || 1000));
    return entry;
  }

  function jitter(ms) {
    return Math.round(ms + Math.random() * Math.min(500, ms * 0.25));
  }

  function backoffFor(entry) {
    const exponent = Math.max(0, Number(entry.consecutiveErrors ?? 0) - 1);
    return jitter(Math.min(maxBackoffMs, baseBackoffMs * 2 ** exponent));
  }

  async function fetchRest({ client = defaultClient, source, symbol }) {
    const normalizedSource = normalizeSource(source);
    const normalizedSymbol = compactSymbol(symbol);

    if (normalizedSource === "binance_futures") {
      const params = new URLSearchParams({ symbol: normalizedSymbol });
      const response = await fetchImpl(`https://fapi.binance.com/fapi/v1/ticker/price?${params.toString()}`);
      const raw = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(raw?.msg || `Binance futures price request failed: ${response.status}`);
        error.payload = raw;
        error.status = response.status;
        throw error;
      }
      return raw;
    }

    if (!client) {
      throw new Error("Price service has no BingX client.");
    }

    if (normalizedSource === "bingx_last") {
      return client.getLastPrice(normalizedSymbol);
    }

    return client.getMarkPrice(normalizedSymbol);
  }

  function buildSample(entry, { stale = false } = {}) {
    const websocketStatus = entry.source === "binance_futures"
      ? entry.websocketStatus
      : websocketState.status;
    const websocketError = entry.source === "binance_futures"
      ? entry.websocketError
      : websocketState.error;
    return {
      ageMs: entry.updatedAt ? Date.now() - Date.parse(entry.updatedAt) : null,
      degraded: Boolean(entry.degraded),
      fallbackActive: Boolean(entry.fallbackActive),
      lastError: entry.lastError,
      lastWebsocketTickAt: entry.source === "binance_futures" ? entry.websocketUpdatedAt : null,
      mode: entry.mode,
      price: entry.price,
      raw: entry.raw,
      rateLimitCount: entry.rateLimitCount,
      recentHigh: entry.recentTicks?.length
        ? Math.max(...entry.recentTicks.map((tick) => tick.price))
        : null,
      recentLow: entry.recentTicks?.length
        ? Math.min(...entry.recentTicks.map((tick) => tick.price))
        : null,
      recentTicks: entry.source === "binance_futures" ? [...(entry.recentTicks ?? [])] : [],
      source: entry.source,
      stale,
      status: entry.degraded ? "degraded" : entry.status,
      symbol: entry.symbol,
      time: entry.updatedAt,
      websocketAgeMs: entry.source === "binance_futures" && entry.websocketUpdatedAt
        ? Date.now() - Date.parse(entry.websocketUpdatedAt)
        : null,
      websocketConfigReason: entry.websocketConfigReason ?? "",
      websocketDisabledReason: entry.websocketDisabledReason ?? "",
      websocketError,
      websocketStatus,
    };
  }

  async function requestRest({ client, entry, source, symbol }) {
    const waitMs = Math.max(0, restMinIntervalMs - (Date.now() - Number(entry.lastRequestAt ?? 0)));
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    entry.lastRequestAt = Date.now();
    entry.requestCount += 1;

    try {
      const raw = await fetchRest({ client, source, symbol });
      const price = extractMarketPrice(raw);
      if (price === null) {
        throw new Error(`No market price found in ${normalizeSource(source)} response.`);
      }
      Object.assign(entry, {
        backoffUntil: 0,
        consecutiveErrors: 0,
        degraded: false,
        fallbackActive: entry.source === "binance_futures",
        lastError: null,
        mode: sourceWebsocketConnected(entry) ? "websocket+rest" : "rest",
        price,
        raw,
        status: "ok",
        updatedAt: nowIso(),
      });
      appendRecentTick(entry, price, entry.updatedAt);
      return buildSample(entry);
    } catch (error) {
      entry.consecutiveErrors += 1;
      entry.lastError = sanitizeError(error);
      entry.degraded = true;
      entry.status = "degraded";
      entry.mode = "degraded";
      entry.backoffUntil = Date.now() + backoffFor(entry);
      if (isRateLimitError(error)) {
        entry.rateLimitCount += 1;
      }

      if (entry.price !== null) {
        return buildSample(entry, { stale: true });
      }

      throw new PriceFeedError("Price feed degraded and no cached price is available.", {
        error: entry.lastError,
        source: entry.source,
        symbol: entry.symbol,
        transient: isTransientPriceError(error),
      });
    }
  }

  async function getPrice({ client = defaultClient, source = "bingx_mark", symbol } = {}) {
    if (normalizeSource(source) === "binance_futures") {
      ensureBinanceFuturesWebsocket(symbol);
    }
    const entry = entryFor(symbol, source);
    const ageMs = entry.updatedAt ? Date.now() - Date.parse(entry.updatedAt) : Infinity;

    if (entry.price !== null && ageMs <= freshMs && !entry.degraded) {
      return buildSample(entry);
    }

    if (entry.price !== null && Date.now() < Number(entry.backoffUntil ?? 0)) {
      return buildSample(entry, { stale: true });
    }

    if (entry.inFlight) {
      return entry.inFlight;
    }

    entry.inFlight = requestRest({ client, entry, source, symbol })
      .finally(() => {
        entry.inFlight = null;
      });

    return entry.inFlight;
  }

  function binanceWebsocketKey(symbol) {
    return compactSymbol(symbol);
  }

  function sourceWebsocketConnected(entry) {
    if (entry.source !== "binance_futures") return websocketState.connected;
    return Boolean(binanceWebsockets.get(binanceWebsocketKey(entry.symbol))?.connected);
  }

  function binanceWebsocketUrl(symbol) {
    const stream = `${compactSymbol(symbol).toLowerCase()}@aggTrade`;
    return `${binanceWebsocketBaseUrl.replace(/\/$/u, "")}/${stream}`;
  }

  function updateBinanceWebsocketEntry(symbol, patch = {}) {
    return updateEntry(symbol, "binance_futures", {
      websocketConfigReason: binanceWebsocketConfigReason(),
      websocketUpdatedAt: patch.websocketUpdatedAt ?? nowIso(),
      ...patch,
    });
  }

  function parseBinanceFuturesMessage(payload) {
    const row = payload?.data ?? payload;
    const symbol = compactSymbol(row?.s ?? row?.symbol);
    const price = extractMarketPrice({
      price: row?.p ?? row?.price ?? row?.c ?? row?.lastPrice,
    });
    if (!symbol || price === null) return null;
    return { price, raw: row, symbol };
  }

  function notifyPriceTick(tick) {
    for (const listener of priceTickListeners) {
      try {
        listener(tick);
      } catch (error) {
        logger.warn?.(`[price-service] price tick listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  function scheduleBinanceReconnect(symbol, state) {
    if (!binanceWebsocketEnabled || state.reconnectTimer) return;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      state.started = false;
      ensureBinanceFuturesWebsocket(symbol);
    }, binanceReconnectMs);
  }

  function ensureBinanceFuturesWebsocket(symbol) {
    const normalizedSymbol = compactSymbol(symbol);
    if (!normalizedSymbol) return null;
    const key = binanceWebsocketKey(normalizedSymbol);
    let state = binanceWebsockets.get(key);
    if (state?.started) return state;

    state = {
      connected: false,
      error: "",
      reconnectTimer: state?.reconnectTimer ?? null,
      socket: null,
      started: true,
      status: "not_started",
      symbol: normalizedSymbol,
      url: binanceWebsocketUrl(normalizedSymbol),
    };
    binanceWebsockets.set(key, state);

    if (!binanceWebsocketEnabled) {
      state.status = "disabled";
      updateBinanceWebsocketEntry(normalizedSymbol, {
        websocketDisabledReason: "disabled_by_env_BINANCE_FUTURES_PRICE_WEBSOCKET_ENABLED",
        websocketError: "",
        websocketStatus: state.status,
      });
      return state;
    }

    if (typeof WebSocketImpl !== "function") {
      state.status = "unavailable";
      state.error = "Runtime WebSocket API is unavailable; REST fallback is active.";
      updateBinanceWebsocketEntry(normalizedSymbol, {
        websocketDisabledReason: "websocket_runtime_unavailable_rest_fallback_active",
        websocketError: state.error,
        websocketStatus: state.status,
      });
      return state;
    }

    try {
      const socket = new WebSocketImpl(state.url);
      state.socket = socket;
      state.status = "connecting";
      updateBinanceWebsocketEntry(normalizedSymbol, {
        websocketError: "",
        websocketDisabledReason: "",
        websocketStatus: state.status,
      });
      socket.addEventListener("open", () => {
        state.connected = true;
        state.error = "";
        state.status = "connected";
        updateBinanceWebsocketEntry(normalizedSymbol, {
          websocketError: "",
          websocketDisabledReason: "",
          websocketStatus: state.status,
        });
      });
      socket.addEventListener("message", async (event) => {
        try {
          const text = await decodeWebsocketMessage(event.data);
          const payload = JSON.parse(text);
          const tick = parseBinanceFuturesMessage(payload);
          if (!tick) return;
          const updatedAt = nowIso();
          const entry = updateEntry(tick.symbol, "binance_futures", {
            backoffUntil: 0,
            consecutiveErrors: 0,
            degraded: false,
            fallbackActive: false,
            lastError: null,
            mode: "websocket",
            price: tick.price,
            raw: tick.raw,
            status: "ok",
            updatedAt,
            websocketError: "",
            websocketConfigReason: binanceWebsocketConfigReason(),
            websocketDisabledReason: "",
            websocketStatus: state.status,
            websocketUpdatedAt: updatedAt,
          });
          appendRecentTick(entry, tick.price, updatedAt);
          notifyPriceTick({
            mode: "websocket",
            price: tick.price,
            raw: tick.raw,
            source: "binance_futures",
            symbol: tick.symbol,
            time: updatedAt,
          });
        } catch (error) {
          state.error = error instanceof Error ? error.message : String(error);
          updateBinanceWebsocketEntry(normalizedSymbol, {
            websocketError: state.error,
            websocketDisabledReason: "",
            websocketStatus: state.status,
          });
        }
      });
      socket.addEventListener("close", () => {
        state.connected = false;
        state.status = "disconnected";
        updateBinanceWebsocketEntry(normalizedSymbol, {
          websocketError: state.error,
          websocketDisabledReason: "",
          websocketStatus: state.status,
        });
        scheduleBinanceReconnect(normalizedSymbol, state);
      });
      socket.addEventListener("error", (event) => {
        state.connected = false;
        state.error = event?.message ?? "Binance Futures websocket error";
        state.status = "error";
        updateBinanceWebsocketEntry(normalizedSymbol, {
          websocketError: state.error,
          websocketDisabledReason: "",
          websocketStatus: state.status,
        });
        scheduleBinanceReconnect(normalizedSymbol, state);
      });
    } catch (error) {
      state.connected = false;
      state.error = error instanceof Error ? error.message : String(error);
      state.status = "error";
      updateBinanceWebsocketEntry(normalizedSymbol, {
        websocketError: state.error,
        websocketDisabledReason: "",
        websocketStatus: state.status,
      });
      logger.warn?.(`[price-service] Binance Futures websocket disabled: ${state.error}`);
    }

    return state;
  }

  async function decodeWebsocketMessage(message) {
    if (typeof message === "string") return message;

    let buffer = null;
    if (message instanceof ArrayBuffer) {
      buffer = Buffer.from(message);
    } else if (ArrayBuffer.isView(message)) {
      buffer = Buffer.from(message.buffer, message.byteOffset, message.byteLength);
    } else if (typeof message?.arrayBuffer === "function") {
      buffer = Buffer.from(await message.arrayBuffer());
    }

    if (!buffer) return JSON.stringify(message ?? {});

    try {
      return gunzipSync(buffer).toString("utf8");
    } catch {
      return buffer.toString("utf8");
    }
  }

  async function parseWebsocketMessage(message) {
    const text = await decodeWebsocketMessage(message);
    const payload = JSON.parse(text);
    if (payload?.ping || payload?.ping === 0) {
      return [{ heartbeat: "ping", raw: payload }];
    }
    const rows = Array.isArray(payload?.data) ? payload.data : [payload?.data ?? payload];
    return rows
      .map((row) => ({
        lastPrice: extractMarketPrice({ price: row?.lastPrice ?? row?.last ?? row?.c }),
        markPrice: extractMarketPrice({ markPrice: row?.markPrice ?? row?.mark ?? row?.mp }),
        raw: row,
        symbol: compactSymbol(row?.symbol ?? row?.s ?? row?.contractCode ?? row?.pair),
      }))
      .filter((row) => row.symbol && (row.lastPrice !== null || row.markPrice !== null));
  }

  function startWebsocket() {
    if (websocketState.started) return websocketState;
    websocketState.started = true;

    if (!websocketState.enabled) {
      websocketState.status = "disabled";
      return websocketState;
    }
    if (!websocketState.url) {
      websocketState.status = "unconfigured";
      return websocketState;
    }
    if (typeof WebSocketImpl !== "function") {
      websocketState.status = "unavailable";
      websocketState.error = "Runtime WebSocket API is unavailable; REST fallback is active.";
      return websocketState;
    }

    try {
      const socket = new WebSocketImpl(websocketState.url);
      websocketState.status = "connecting";
      socket.addEventListener("open", () => {
        websocketState.connected = true;
        websocketState.status = "connected";
      });
      socket.addEventListener("message", async (event) => {
        try {
          for (const row of await parseWebsocketMessage(event.data)) {
            if (row.heartbeat === "ping") {
              socket.send(JSON.stringify({ pong: row.raw.ping }));
              continue;
            }
            if (row.markPrice !== null) {
              updateEntry(row.symbol, "bingx_mark", {
                consecutiveErrors: 0,
                degraded: false,
                lastError: null,
                mode: "websocket",
                price: row.markPrice,
                raw: row.raw,
                status: "ok",
                updatedAt: nowIso(),
              });
            }
            if (row.lastPrice !== null) {
              updateEntry(row.symbol, "bingx_last", {
                consecutiveErrors: 0,
                degraded: false,
                lastError: null,
                mode: "websocket",
                price: row.lastPrice,
                raw: row.raw,
                status: "ok",
                updatedAt: nowIso(),
              });
            }
          }
        } catch (error) {
          websocketState.error = error instanceof Error ? error.message : String(error);
        }
      });
      socket.addEventListener("close", () => {
        websocketState.connected = false;
        websocketState.status = "disconnected";
      });
      socket.addEventListener("error", (event) => {
        websocketState.connected = false;
        websocketState.status = "error";
        websocketState.error = event?.message ?? "WebSocket error";
      });
    } catch (error) {
      websocketState.connected = false;
      websocketState.status = "error";
      websocketState.error = error instanceof Error ? error.message : String(error);
      logger.warn?.(`[price-service] websocket disabled: ${websocketState.error}`);
    }

    return websocketState;
  }

  function snapshot({ source = "bingx_mark", symbol } = {}) {
    if (normalizeSource(source) === "binance_futures" && symbol) {
      ensureBinanceFuturesWebsocket(symbol);
    }
    const entry = entryFor(symbol, source);
    return {
      ...buildSample(entry, { stale: entry.updatedAt ? Date.now() - Date.parse(entry.updatedAt) > freshMs : false }),
      backoffUntil: entry.backoffUntil ? new Date(entry.backoffUntil).toISOString() : null,
      requestCount: entry.requestCount,
      websocketError: entry.source === "binance_futures" ? entry.websocketError : websocketState.error,
    };
  }

  function status() {
    return {
      config: {
        binanceFuturesWebsocketEnabled: binanceWebsocketEnabled,
        selectedSztabPriceSource: selectedPriceSource,
        websocketConfigReason: binanceWebsocketConfigReason(),
      },
      entries: Array.from(entries.values()).map((entry) => snapshot({ source: entry.source, symbol: entry.symbol })),
      binanceFuturesWebsockets: Array.from(binanceWebsockets.values()).map((state) => ({
        connected: state.connected,
        error: state.error,
        status: state.status,
        symbol: state.symbol,
        url: state.url,
      })),
      websocket: { ...websocketState },
    };
  }

  function onPriceTick(listener) {
    if (typeof listener !== "function") return () => {};
    priceTickListeners.add(listener);
    return () => priceTickListeners.delete(listener);
  }

  startWebsocket();

  return {
    getPrice,
    onPriceTick,
    snapshot,
    status,
    startWebsocket,
  };
}

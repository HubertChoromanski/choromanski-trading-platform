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
} = {}) {
  const entries = new Map();
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

  function entryFor(symbol, source) {
    const key = cacheKey(symbol, source);
    if (!entries.has(key)) {
      entries.set(key, {
        backoffUntil: 0,
        consecutiveErrors: 0,
        degraded: false,
        inFlight: null,
        key,
        lastError: null,
        lastRequestAt: 0,
        mode: "rest",
        price: null,
        rateLimitCount: 0,
        requestCount: 0,
        source: normalizeSource(source),
        status: "empty",
        symbol: compactSymbol(symbol),
        updatedAt: null,
      });
    }
    return entries.get(key);
  }

  function updateEntry(symbol, source, patch = {}) {
    const entry = entryFor(symbol, source);
    Object.assign(entry, patch);
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
    return {
      ageMs: entry.updatedAt ? Date.now() - Date.parse(entry.updatedAt) : null,
      degraded: Boolean(entry.degraded),
      lastError: entry.lastError,
      mode: entry.mode,
      price: entry.price,
      raw: entry.raw,
      rateLimitCount: entry.rateLimitCount,
      source: entry.source,
      stale,
      status: entry.degraded ? "degraded" : entry.status,
      symbol: entry.symbol,
      time: entry.updatedAt,
      websocketStatus: websocketState.status,
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
        lastError: null,
        mode: websocketState.connected ? "websocket+rest" : "rest",
        price,
        raw,
        status: "ok",
        updatedAt: nowIso(),
      });
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
    if (typeof WebSocket !== "function") {
      websocketState.status = "unavailable";
      websocketState.error = "Runtime WebSocket API is unavailable; REST fallback is active.";
      return websocketState;
    }

    try {
      const socket = new WebSocket(websocketState.url);
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
    const entry = entryFor(symbol, source);
    return {
      ...buildSample(entry, { stale: entry.updatedAt ? Date.now() - Date.parse(entry.updatedAt) > freshMs : false }),
      backoffUntil: entry.backoffUntil ? new Date(entry.backoffUntil).toISOString() : null,
      requestCount: entry.requestCount,
      websocketError: websocketState.error,
    };
  }

  function status() {
    return {
      entries: Array.from(entries.values()).map((entry) => snapshot({ source: entry.source, symbol: entry.symbol })),
      websocket: { ...websocketState },
    };
  }

  startWebsocket();

  return {
    getPrice,
    snapshot,
    status,
    startWebsocket,
  };
}

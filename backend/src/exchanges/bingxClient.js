import crypto from "node:crypto";

const DEFAULT_BASE_URL = "https://open-api.bingx.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;
const MIN_REQUEST_GAP_MS = 180;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeSymbol(symbol) {
  return symbol.includes("-") ? symbol : symbol.replace(/USDT$/u, "-USDT");
}

function normalizeResponse(payload) {
  if (payload?.code !== undefined && Number(payload.code) !== 0) {
    const error = new Error(payload.msg || payload.message || "BingX API error");
    error.code = payload.code;
    error.payload = payload;
    throw error;
  }

  return payload?.data ?? payload;
}

export function createBingxClient({
  apiKey = process.env.BINGX_API_KEY,
  apiSecret = process.env.BINGX_API_SECRET,
  baseUrl = process.env.BINGX_BASE_URL || DEFAULT_BASE_URL,
  fetchImpl = fetch,
} = {}) {
  let lastRequestAt = 0;

  const client = {
    auth: {
      configured: Boolean(apiKey && apiSecret),
      profile: apiKey ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : null,
    },

    async getServerTime() {
      return request("GET", "/openApi/swap/v2/server/time", {}, { signed: false });
    },

    async getBalance() {
      return client.getPerpetualFuturesBalance();
    },

    async getFundBalance() {
      return request("GET", "/openApi/spot/v1/account/balance", {
        accountType: "FUND",
      });
    },

    async getSpotBalance() {
      return request("GET", "/openApi/spot/v1/account/balance");
    },

    async getSwapUsdtBalance() {
      return request("GET", "/openApi/swap/v2/user/balance");
    },

    async getPerpetualFuturesBalance() {
      return client.getSwapUsdtBalance();
    },

    async getLastPrice(symbol) {
      return request("GET", "/openApi/swap/v2/quote/price", {
        symbol: symbol ? normalizeSymbol(symbol) : undefined,
      }, { signed: false });
    },

    async getMarkPrice(symbol) {
      return request("GET", "/openApi/swap/v2/quote/premiumIndex", {
        symbol: symbol ? normalizeSymbol(symbol) : undefined,
      }, { signed: false });
    },

    async getOpenPositions(symbol) {
      return request("GET", "/openApi/swap/v2/user/positions", {
        symbol: symbol ? normalizeSymbol(symbol) : undefined,
      });
    },

    async setLeverage(symbol, leverage, side = "BOTH") {
      return request("POST", "/openApi/swap/v2/trade/leverage", {
        leverage,
        side,
        symbol: normalizeSymbol(symbol),
      });
    },

    async setMarginMode(symbol, marginMode) {
      return request("POST", "/openApi/swap/v2/trade/marginType", {
        marginType: marginMode === "cross" ? "CROSSED" : "ISOLATED",
        symbol: normalizeSymbol(symbol),
      });
    },

    async placeMarketOrder(symbol, side, quantity) {
      return request("POST", "/openApi/swap/v2/trade/order", {
        positionSide: side === "BUY" ? "LONG" : "SHORT",
        quantity,
        side,
        symbol: normalizeSymbol(symbol),
        type: "MARKET",
      });
    },

    async placeReduceOnlyMarketOrder(symbol, side, quantity) {
      return request("POST", "/openApi/swap/v2/trade/order", {
        quantity,
        reduceOnly: true,
        side,
        symbol: normalizeSymbol(symbol),
        type: "MARKET",
      });
    },

    async placeStopLoss(symbol, side, stopPrice, quantity) {
      const closeSide = side === "BUY" ? "SELL" : "BUY";
      return request("POST", "/openApi/swap/v2/trade/order", {
        positionSide: side === "BUY" ? "LONG" : "SHORT",
        quantity,
        reduceOnly: true,
        side: closeSide,
        stopPrice,
        symbol: normalizeSymbol(symbol),
        type: "STOP_MARKET",
      });
    },

    async placeTakeProfit(symbol, side, stopPrice, quantity) {
      const closeSide = side === "BUY" ? "SELL" : "BUY";
      return request("POST", "/openApi/swap/v2/trade/order", {
        positionSide: side === "BUY" ? "LONG" : "SHORT",
        quantity,
        reduceOnly: true,
        side: closeSide,
        stopPrice,
        symbol: normalizeSymbol(symbol),
        type: "TAKE_PROFIT_MARKET",
      });
    },

    async closePosition(symbol) {
      return request("POST", "/openApi/swap/v1/trade/closePosition", {
        symbol: normalizeSymbol(symbol),
      });
    },

    async cancelOpenOrders(symbol) {
      return request("POST", "/openApi/swap/v2/trade/allOpenOrders", {
        symbol: normalizeSymbol(symbol),
      });
    },

    async getOpenOrders(symbol) {
      return request("GET", "/openApi/swap/v2/trade/openOrders", {
        symbol: symbol ? normalizeSymbol(symbol) : undefined,
      });
    },

    async getOrderStatus(orderId, symbol) {
      return request("GET", "/openApi/swap/v2/trade/order", {
        orderId,
        symbol: symbol ? normalizeSymbol(symbol) : undefined,
      });
    },
  };

  async function request(method, endpoint, params = {}, { signed = true } = {}) {
    if (signed && !client.auth.configured) {
      throw new Error("BingX API keys are not configured.");
    }

    await throttle();

    const cleanParams = Object.fromEntries(
      Object.entries(params).filter(([, value]) => value !== undefined && value !== null),
    );
    const requestParams = signed
      ? {
          ...cleanParams,
          timestamp: Date.now(),
        }
      : cleanParams;
    const query = buildQuery(requestParams);
    const signature = signed ? sign(query) : "";
    const fullQuery = signed ? `${query}&signature=${signature}` : query;
    const url = `${baseUrl}${endpoint}${fullQuery ? `?${fullQuery}` : ""}`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

      try {
        const response = await fetchImpl(url, {
          headers: signed ? { "X-BX-APIKEY": apiKey } : {},
          method,
          signal: controller.signal,
        });
        const text = await response.text();
        const payload = text ? JSON.parse(text) : {};

        if (!response.ok) {
          const error = new Error(payload.msg || `BingX HTTP ${response.status}`);
          error.status = response.status;
          throw error;
        }

        return normalizeResponse(payload);
      } catch (error) {
        if (attempt === MAX_RETRIES || !isRetryable(error)) {
          throw error;
        }

        await sleep(300 * (attempt + 1));
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new Error("BingX request failed.");
  }

  function buildQuery(params) {
    return Object.entries(params)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
      .join("&");
  }

  function sign(query) {
    return crypto.createHmac("sha256", apiSecret).update(query).digest("hex");
  }

  async function throttle() {
    const elapsed = Date.now() - lastRequestAt;

    if (elapsed < MIN_REQUEST_GAP_MS) {
      await sleep(MIN_REQUEST_GAP_MS - elapsed);
    }

    lastRequestAt = Date.now();
  }

  function isRetryable(error) {
    return error.name === "AbortError" || error.status === 429 || error.status >= 500;
  }

  return client;
}

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

function normalizePositionSide(value) {
  const side = String(value ?? "").toUpperCase();
  if (side.includes("LONG")) return "LONG";
  if (side.includes("SHORT")) return "SHORT";
  return null;
}

function entrySideToPositionSide(side) {
  return String(side).toUpperCase() === "BUY" ? "LONG" : "SHORT";
}

function closeSideForPositionSide(positionSide) {
  return normalizePositionSide(positionSide) === "LONG" ? "SELL" : "BUY";
}

function oppositeOrderSide(side) {
  return String(side).toUpperCase() === "BUY" ? "SELL" : "BUY";
}

function positionSideFromPosition(position) {
  if (!position || typeof position !== "object") return null;
  const explicit = normalizePositionSide(position?.positionSide ?? position?.side);
  if (explicit) return explicit;
  const amount = Number(position?.positionAmt ?? position?.positionAmount ?? position?.quantity ?? 0);
  return amount < 0 ? "SHORT" : "LONG";
}

function positionIdentifier(position) {
  return (
    position?.positionId ??
    position?.positionID ??
    position?.id ??
    position?.position_id ??
    null
  );
}

function positionQuantity(position) {
  return Math.abs(Number(
    position?.positionAmt ??
      position?.positionAmount ??
      position?.positionQuantity ??
      position?.availableAmt ??
      position?.quantity ??
      position?.positionSize ??
      0,
  ));
}

export function buildTriggerMarketOrderPayload(symbol, side, stopPrice, quantity, options = {}) {
  const normalizedSide = String(side ?? "").toUpperCase();
  const positionSide = normalizePositionSide(options.positionSide) ?? entrySideToPositionSide(normalizedSide);
  const payload = {
    positionSide,
    quantity,
    side: normalizedSide,
    stopPrice,
    symbol: normalizeSymbol(symbol),
    type: "TRIGGER_MARKET",
  };

  if (options.workingType !== false) {
    payload.workingType = options.workingType ?? "MARK_PRICE";
  }
  if (options.clientOrderID) {
    payload.clientOrderID = options.clientOrderID;
  }
  if (options.clientOrderId) {
    payload.clientOrderId = options.clientOrderId;
  }

  return payload;
}

function normalizeExchangeList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.positions)) return value.positions;
  if (Array.isArray(value?.orders)) return value.orders;
  if (Array.isArray(value?.data)) return value.data;
  return value ? [value] : [];
}

function parseBingxJson(text) {
  if (!text) return {};

  const safeText = text.replace(
    /"(orderId|orderID|positionId|positionID|triggerOrderId|mainOrderId)"\s*:\s*(\d{15,})/gu,
    '"$1":"$2"',
  );

  return JSON.parse(safeText);
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

    async placeTriggerMarketOrder(symbol, side, stopPrice, quantity, options = {}) {
      return request("POST", "/openApi/swap/v2/trade/order", buildTriggerMarketOrderPayload(
        symbol,
        side,
        stopPrice,
        quantity,
        options,
      ));
    },

    async placeReduceOnlyMarketOrder(symbol, side, quantity, options = {}) {
      const positionSide = normalizePositionSide(options.positionSide) ?? positionSideFromPosition(options.position);
      const payload = {
        quantity,
        side,
        symbol: normalizeSymbol(symbol),
        type: "MARKET",
      };

      if (positionSide) {
        payload.positionSide = positionSide;
      } else {
        payload.reduceOnly = true;
      }

      return request("POST", "/openApi/swap/v2/trade/order", payload);
    },

    async placeStopLoss(symbol, side, stopPrice, quantity, options = {}) {
      const positionSide = normalizePositionSide(options.positionSide) ?? entrySideToPositionSide(side);
      const payload = {
        positionSide,
        quantity,
        side: positionSide ? closeSideForPositionSide(positionSide) : oppositeOrderSide(side),
        stopPrice,
        symbol: normalizeSymbol(symbol),
        type: "STOP_MARKET",
        workingType: options.workingType ?? "MARK_PRICE",
      };
      const positionId = options.positionId ?? positionIdentifier(options.position);

      if (positionId) {
        payload.positionId = positionId;
      }

      return request("POST", "/openApi/swap/v2/trade/order", payload);
    },

    async placeTakeProfit(symbol, side, stopPrice, quantity, options = {}) {
      const positionSide = normalizePositionSide(options.positionSide) ?? entrySideToPositionSide(side);
      const payload = {
        positionSide,
        quantity,
        side: positionSide ? closeSideForPositionSide(positionSide) : oppositeOrderSide(side),
        stopPrice,
        symbol: normalizeSymbol(symbol),
        type: "TAKE_PROFIT_MARKET",
        workingType: options.workingType ?? "MARK_PRICE",
      };
      const positionId = options.positionId ?? positionIdentifier(options.position);

      if (positionId) {
        payload.positionId = positionId;
      }

      return request("POST", "/openApi/swap/v2/trade/order", payload);
    },

    async placePositionStopLoss(symbol, side, stopPrice, options = {}) {
      const positionSide = normalizePositionSide(options.positionSide) ?? entrySideToPositionSide(side);
      const payload = {
        closePosition: "true",
        positionSide,
        side: positionSide ? closeSideForPositionSide(positionSide) : oppositeOrderSide(side),
        stopPrice,
        symbol: normalizeSymbol(symbol),
        type: "STOP_MARKET",
        workingType: options.workingType ?? "MARK_PRICE",
      };
      const positionId = options.positionId ?? positionIdentifier(options.position);

      if (positionId) {
        payload.positionId = positionId;
      }

      return request("POST", "/openApi/swap/v2/trade/order", payload);
    },

    async placePositionTakeProfit(symbol, side, stopPrice, options = {}) {
      const positionSide = normalizePositionSide(options.positionSide) ?? entrySideToPositionSide(side);
      const payload = {
        closePosition: "true",
        positionSide,
        side: positionSide ? closeSideForPositionSide(positionSide) : oppositeOrderSide(side),
        stopPrice,
        symbol: normalizeSymbol(symbol),
        type: "TAKE_PROFIT_MARKET",
        workingType: options.workingType ?? "MARK_PRICE",
      };
      const positionId = options.positionId ?? positionIdentifier(options.position);

      if (positionId) {
        payload.positionId = positionId;
      }

      return request("POST", "/openApi/swap/v2/trade/order", payload);
    },

    async closePosition(symbol, options = {}) {
      const normalizedSymbol = normalizeSymbol(symbol);
      const positionId = options.positionId ?? positionIdentifier(options.position);

      if (positionId) {
        return request("POST", "/openApi/swap/v1/trade/closePosition", {
          positionId,
          symbol: normalizedSymbol,
        });
      }

      const positions = options.position
        ? [options.position]
        : normalizeExchangeList(await client.getOpenPositions(symbol));
      const requestedSide = normalizePositionSide(options.positionSide ?? options.side);
      const openPositions = positions.filter((position) => {
        if (compactSymbol(position.symbol) !== compactSymbol(symbol)) return false;
        if (positionQuantity(position) <= 0) return false;
        return !requestedSide || positionSideFromPosition(position) === requestedSide;
      });

      if (openPositions.length === 0) {
        return {
          message: "No matching BingX position found to close.",
          ok: false,
          _diagnostics: {
            endpoint: "/openApi/swap/v1/trade/closePosition",
            hedgeMode: requestedSide ? "positionSide selected" : "no positionSide selected",
            payload: { positionSide: requestedSide, symbol: normalizedSymbol },
          },
        };
      }

      const results = [];

      for (const position of openPositions) {
        const candidateId = positionIdentifier(position);

        if (candidateId) {
          results.push(await request("POST", "/openApi/swap/v1/trade/closePosition", {
            positionId: candidateId,
            symbol: normalizedSymbol,
          }));
          continue;
        }

        results.push(await client.placeReduceOnlyMarketOrder(
          symbol,
          closeSideForPositionSide(positionSideFromPosition(position)),
          positionQuantity(position),
          { position, positionSide: positionSideFromPosition(position) },
        ));
      }

      return results.length === 1
        ? results[0]
        : {
            closed: results,
            _diagnostics: {
              endpoint: "/openApi/swap/v1/trade/closePosition",
              payload: { symbol: normalizedSymbol },
            },
          };
    },

    async cancelOpenOrders(symbol) {
      return request("POST", "/openApi/swap/v2/trade/allOpenOrders", {
        symbol: normalizeSymbol(symbol),
      });
    },

    async cancelOrder(symbol, { clientOrderId, orderId } = {}) {
      return request("DELETE", "/openApi/swap/v2/trade/order", {
        clientOrderId,
        orderId,
        symbol: normalizeSymbol(symbol),
      });
    },

    async getOpenOrders(symbol) {
      return request("GET", "/openApi/swap/v2/trade/openOrders", {
        symbol: symbol ? normalizeSymbol(symbol) : undefined,
      });
    },

    async getProtectiveOrders(symbol) {
      const result = await client.getOpenOrders(symbol);
      return withDiagnostics(result, {
        endpoint: "/openApi/swap/v2/trade/openOrders",
        method: "GET",
        note: "BingX normal USD-M futures exposes STOP_MARKET/TAKE_PROFIT_MARKET/TRIGGER_* protection through openOrders; copyTrading setTPSL is not used for regular positions.",
        payload: { symbol: symbol ? normalizeSymbol(symbol) : undefined },
        response: result?._diagnostics?.response ?? result,
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
        const payload = parseBingxJson(text);

        if (!response.ok) {
          const error = new Error(payload.msg || `BingX HTTP ${response.status}`);
          error.payload = payload;
          error.status = response.status;
          throw error;
        }

        let normalized;
        try {
          normalized = normalizeResponse(payload);
        } catch (error) {
          error.bingx = requestDiagnostics({ endpoint, method, payload: cleanParams, response: payload });
          throw error;
        }

        return withDiagnostics(normalized, requestDiagnostics({ endpoint, method, payload: cleanParams, response: payload }));
      } catch (error) {
        if (attempt === MAX_RETRIES || !isRetryable(error)) {
          if (!error.bingx) {
            error.bingx = requestDiagnostics({ endpoint, method, payload: cleanParams, response: error.payload });
          }
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

function compactSymbol(symbol) {
  return String(symbol ?? "").replace("-", "").toUpperCase();
}

function requestDiagnostics({ endpoint, method, payload, response }) {
  return {
    endpoint,
    method,
    payload,
    response,
  };
}

function withDiagnostics(value, diagnostics) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      ...value,
      _diagnostics: diagnostics,
    };
  }

  return value;
}

import http from "node:http";
import "dotenv/config";
import { buildCodeMap, readSafeCodeSnippet } from "./ai/aiCodeMap.js";
import { createAiContextBuilder } from "./ai/aiContextBuilder.js";
import { createAiMemoryStore } from "./ai/aiMemoryStore.js";
import { createAiService } from "./ai/aiService.js";
import { createAiTools } from "./ai/aiTools.js";
import { createAgentOrchestrator } from "./ai/agent/agentOrchestrator.js";
import { createCopilotMemoryStore } from "./ai/copilotMemory/copilotMemoryStore.js";
import { reportToCsv } from "./ai/aiReportBuilder.js";
import { createBotRunner } from "./botRunner.js";
import { createBingxClient } from "./exchanges/bingxClient.js";
import { reconcileBingxState } from "./execution/reconciliation.js";
import { createStateStore } from "./state/store.js";
import { fetchCandles } from "./strategy/strategyRunner.js";
import { createSztabRunner, SZTAB_INTERVALS } from "./sztab/sztabRunner.js";

const PORT = Number(process.env.PORT || 8787);
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || "";
const STARTED_AT = new Date().toISOString();

function runtimeDetails(extra = {}) {
  return {
    nodeEnv: process.env.NODE_ENV ?? "development",
    pid: process.pid,
    pm2: {
      appInstance: process.env.NODE_APP_INSTANCE ?? null,
      id: process.env.pm_id ?? null,
      name: process.env.name ?? process.env.pm_name ?? null,
      watch: process.env.PM2_WATCH ?? process.env.watch ?? "unknown",
    },
    startedAt: STARTED_AT,
    ...extra,
  };
}

function logRuntimeEvent(event, extra = {}) {
  console.log(`[backend-runtime] ${event} ${JSON.stringify(runtimeDetails(extra))}`);
}

const store = await createStateStore();
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
  logRuntimeEvent("unhandledRejection", { reason: message });
  console.warn(`[backend] unhandled rejection: ${message}`);
});
process.on("uncaughtException", (error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  logRuntimeEvent("uncaughtException", { error: message });
  console.warn(`[backend] uncaught exception: ${message}`);
  setTimeout(() => process.exit(1), 50).unref();
});
process.on("SIGINT", () => {
  logRuntimeEvent("SIGINT");
  process.exit(0);
});
process.on("SIGTERM", () => {
  logRuntimeEvent("SIGTERM");
  process.exit(0);
});
process.on("beforeExit", (code) => {
  logRuntimeEvent("beforeExit", { code });
});
process.on("exit", (code) => {
  logRuntimeEvent("exit", { code });
});
const bingxClient = createBingxClient();
await store.setState({
  bingx: {
    apiConfigured: bingxClient.auth.configured,
  },
  runtime: {
    mode: process.env.NODE_ENV ?? "development",
    processManager: process.env.pm_id !== undefined ? "pm2" : "node",
    startedAt: STARTED_AT,
  },
});
const botRunner = createBotRunner({ bingxClient, store });

const DEFAULT_MAX_CANDLES = {
  "10m": 10000,
  "15m": 10000,
  "20m": 10000,
  "30m": 10000,
  "1h": 10000,
  "4h": 5000,
};
const maxCandlesPerTimeframe = {
  ...DEFAULT_MAX_CANDLES,
  ...JSON.parse(process.env.MAX_CANDLES_PER_TIMEFRAME_JSON || "{}"),
};
const TIMEFRAMES = [
  { label: "10m", interval: "10m", minutes: 10, maxCandles: maxCandlesPerTimeframe["10m"] },
  { label: "15m", interval: "15m", minutes: 15, maxCandles: maxCandlesPerTimeframe["15m"] },
  { label: "20m", interval: "20m", minutes: 20, maxCandles: maxCandlesPerTimeframe["20m"] },
  { label: "30m", interval: "30m", minutes: 30, maxCandles: maxCandlesPerTimeframe["30m"] },
  { label: "1H", interval: "1h", minutes: 60, maxCandles: maxCandlesPerTimeframe["1h"] },
  { label: "4H", interval: "4h", minutes: 240, maxCandles: maxCandlesPerTimeframe["4h"] },
];

const COLLECTION_ROUTES = {
  "/decks/strategy": { name: "strategyDecks", limit: 100 },
  "/decks/mm": { name: "mmDecks", limit: 100 },
  "/decks/battle": { name: "battleDecks", limit: 100 },
  "/favorites": { name: "favorites", limit: 500 },
  "/backtests": { name: "backtests", limit: 200 },
};
const BACKTEST_EVENT_RESPONSE_LIMIT = 1000;
const apiProfiles = createApiProfiles();
let availabilityCache = {
  expiresAt: 0,
  rows: [],
};
let historicalCandleCache = new Map();
let apiProfilesCache = {
  expiresAt: 0,
  rows: [],
};
let apiProfilesPromise = null;

function intervalMinutesValue(interval) {
  return TIMEFRAMES.find((item) => item.interval === interval)?.minutes ?? 15;
}

function candleLimitForRange({ from, maxCandles, timeframe, to }) {
  const minutes = intervalMinutesValue(timeframe);
  if (!from || !to) return maxCandles;
  const spanSeconds = Math.max(0, Number(to) - Number(from));
  return Math.min(maxCandles, Math.ceil(spanSeconds / (minutes * 60)) + 8);
}

function candleGapSummary(candles = [], timeframe = "15m") {
  if (candles.length < 2) {
    return {
      count: 0,
      largestGapSeconds: 0,
    };
  }

  const expectedSeconds = intervalMinutesValue(timeframe) * 60;
  let count = 0;
  let largestGapSeconds = 0;

  for (let index = 1; index < candles.length; index += 1) {
    const gap = candles[index].time - candles[index - 1].time;
    if (gap > expectedSeconds * 1.5) {
      count += 1;
      largestGapSeconds = Math.max(largestGapSeconds, gap);
    }
  }

  return {
    count,
    largestGapSeconds,
  };
}

async function historicalCandlesPayload(query) {
  const startedAt = Date.now();
  const symbol = (query.get("symbol") || "SOLUSDT").trim().toUpperCase();
  const timeframe = query.get("timeframe") || query.get("interval") || "15m";
  const provider = query.get("provider") || "binance-futures";
  const maxCandles = Math.max(100, Math.min(Number(query.get("maxCandles") || 90000), 90000));
  const from = query.get("from") ? Math.floor(new Date(query.get("from")).getTime() / 1000) : null;
  const to = query.get("to") ? Math.floor(new Date(query.get("to")).getTime() / 1000) : null;
  const limit = candleLimitForRange({ from, maxCandles, timeframe, to });
  const cacheKey = JSON.stringify({ from, limit, provider, symbol, timeframe, to });
  const cached = historicalCandleCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return {
      ...cached.payload,
      diagnostics: {
        ...cached.payload.diagnostics,
        cache: "hit",
        fetchDurationMs: Date.now() - startedAt,
      },
    };
  }

  const candles = await fetchCandles({
    from,
    limit,
    provider,
    symbol,
    timeframe,
    to,
  });
  const first = candles[0];
  const last = candles.at(-1);
  const availableDays = candles.length * intervalMinutesValue(timeframe) / 1440;
  const gaps = candleGapSummary(candles, timeframe);
  const coveredRequestedStart = !from || (first?.time ?? Infinity) <= from + intervalMinutesValue(timeframe) * 60;
  const coveredRequestedEnd = !to || (last?.time ?? 0) >= to - intervalMinutesValue(timeframe) * 60;
  const providerLimitMessage = coveredRequestedStart && coveredRequestedEnd
    ? `Provider returned the requested range: about ${Math.floor(availableDays)} days.`
    : candles.length < limit
    ? `Provider currently returned ${Math.floor(availableDays)} days. More history requires cached or external historical data.`
    : `Provider returned at least ${Math.floor(availableDays)} days for this request.`;
  const payload = {
    candles,
    diagnostics: {
      availableDays,
      cache: "miss",
      candlesReturned: candles.length,
      fetchDurationMs: Date.now() - startedAt,
      firstCandleTime: first?.time ?? null,
      gaps,
      lastCandleTime: last?.time ?? null,
      limitRequested: limit,
      maxCandles,
      provider,
      providerLimitMessage,
      source: provider,
      symbol,
      timeframe,
    },
  };

  historicalCandleCache.set(cacheKey, {
    expiresAt: Date.now() + 10 * 60_000,
    payload,
  });

  if (historicalCandleCache.size > 12) {
    historicalCandleCache = new Map([...historicalCandleCache.entries()].slice(-8));
  }

  return payload;
}

if (bingxClient.auth.configured) {
  try {
    const bingx = await reconcileBingxState({
      client: bingxClient,
      logger: (message, context = {}) => store.appendLog({ context, message }),
      profiles: store.getProfiles(),
      repairMissingStops: false,
    });
    await store.setState({ bingx });
  } catch (error) {
    await store.setState({
      lastError: error instanceof Error ? error.message : String(error),
    });
  }
}

function extractBalanceAmount(payload) {
  const value = payload?.balance ?? payload;
  const rows = Array.isArray(value) ? value : [value];
  const usdtRow =
    rows.find((row) => String(row?.asset ?? row?.coin ?? row?.currency ?? "").toUpperCase() === "USDT") ??
    rows[0] ??
    {};
  return Number(
    usdtRow.availableMargin ??
      usdtRow.availableBalance ??
      usdtRow.free ??
      usdtRow.equity ??
      usdtRow.balance ??
      0,
  );
}

async function safeBalanceCheck(accountType, endpoint, getter) {
  try {
    const payload = await getter();

    return {
      accountType,
      amount: extractBalanceAmount(payload),
      endpoint,
      ok: true,
      payload,
    };
  } catch (error) {
    return {
      accountType,
      endpoint,
      error: error instanceof Error ? error.message : String(error),
      ok: false,
    };
  }
}

async function runBingxConnectionTest() {
  if (!bingxClient.auth.configured) {
    return {
      configured: false,
      ok: false,
      reason: "BingX API keys are not configured.",
      testedAt: new Date().toISOString(),
    };
  }

  try {
    const [serverTime, fundBalance, spotBalance, futuresBalance] = await Promise.all([
      bingxClient.getServerTime(),
      safeBalanceCheck(
        "Fund",
        "/openApi/spot/v1/account/balance?accountType=FUND",
        () => bingxClient.getFundBalance(),
      ),
      safeBalanceCheck("Spot", "/openApi/spot/v1/account/balance", () =>
        bingxClient.getSpotBalance(),
      ),
      safeBalanceCheck("USDT-M Perpetual / Swap Futures", "/openApi/swap/v2/user/balance", () =>
        bingxClient.getPerpetualFuturesBalance(),
      ),
    ]);
    const balance = futuresBalance.ok ? futuresBalance.payload : null;
    const executionBalance = futuresBalance.ok ? futuresBalance.amount : null;
    const testedAt = new Date().toISOString();
    await store.setState({
      bingx: {
        activeExecutionBalance: executionBalance,
        apiConfigured: true,
        balance,
        balances: {
          fund: fundBalance,
          futures: futuresBalance,
          spot: spotBalance,
        },
        lastSyncAt: testedAt,
        liveReady: futuresBalance.ok && executionBalance > 0,
      },
      lastError: "",
    });
    await store.appendLog({
      context: { hasBalance: Boolean(balance) },
      message: "BingX connection test passed",
    });
    return {
      activeExecutionBalance: executionBalance,
      activeExecutionBalanceAccount: "USDT-M Perpetual / Swap Futures",
      balance,
      balances: {
        fund: fundBalance,
        futures: futuresBalance,
        spot: spotBalance,
      },
      configured: true,
      liveReady: futuresBalance.ok && executionBalance > 0,
      ok: futuresBalance.ok,
      reason: futuresBalance.ok
        ? executionBalance > 0
          ? "Futures balance confirmed."
          : "Futures balance endpoint returned 0 USDT."
        : futuresBalance.error,
      serverTime,
      testedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const testedAt = new Date().toISOString();
    await store.setState({
      bingx: {
        apiConfigured: true,
        lastSyncAt: testedAt,
      },
      lastError: message,
    });
    await store.appendLog({
      context: { message },
      message: "BingX connection test failed",
    });
    return {
      configured: true,
      ok: false,
      reason: message,
      testedAt,
    };
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Headers": "Content-Type,X-Dashboard-Token",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  });
  response.end(JSON.stringify(payload));
}

function requireDashboardToken(request, response) {
  if (!DASHBOARD_TOKEN) return true;

  if (request.headers["x-dashboard-token"] === DASHBOARD_TOKEN) return true;

  sendJson(response, 401, { error: "Dashboard token required" });
  return false;
}

function safePublicCommunication(settings) {
  return {
    ...settings,
    telegramBotToken: settings.telegramBotToken ? "" : "",
    telegramBotTokenConfigured: Boolean(settings.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN),
  };
}

function createApiProfiles() {
  const profiles = new Map();
  const addProfile = ({ id, key, label, secret }) => {
    const normalizedId = String(id).toLowerCase();
    profiles.set(normalizedId, {
      client: createBingxClient({ apiKey: key, apiSecret: secret }),
      id: normalizedId,
      label,
      type: normalizedId === "main" ? "main" : "subaccount",
    });
  };

  addProfile({
    id: "main",
    key: process.env.BINGX_PROFILE_MAIN_KEY || process.env.BINGX_API_KEY,
    label: "Main Account",
    secret: process.env.BINGX_PROFILE_MAIN_SECRET || process.env.BINGX_API_SECRET,
  });

  Object.entries(process.env).forEach(([key, value]) => {
    const match = key.match(/^BINGX_PROFILE_(.+)_KEY$/u);

    if (!match || match[1] === "MAIN") return;

    const profileKey = match[1];
    const secret = process.env[`BINGX_PROFILE_${profileKey}_SECRET`];
    const label = process.env[`BINGX_PROFILE_${profileKey}_LABEL`] ?? `${profileKey.replaceAll("_", " ")} Account`;
    addProfile({
      id: profileKey.toLowerCase().replaceAll("_", "-"),
      key: value,
      label,
      secret,
    });
  });

  return profiles;
}

function getApiProfileClient(profileId = "main") {
  return apiProfiles.get(String(profileId || "main").toLowerCase())?.client ?? bingxClient;
}

async function publicApiProfiles({ fresh = false } = {}) {
  if (!fresh && apiProfilesCache.expiresAt > Date.now() && apiProfilesCache.rows.length > 0) {
    return apiProfilesCache.rows;
  }

  if (apiProfilesPromise) {
    return apiProfilesPromise;
  }

  apiProfilesPromise = loadPublicApiProfiles();

  try {
    return await apiProfilesPromise;
  } finally {
    apiProfilesPromise = null;
  }
}

async function loadPublicApiProfiles() {
  const rows = [];

  for (const profile of apiProfiles.values()) {
    const cached = apiProfilesCache.rows.find((row) => row.id === profile.id);
    const configured = profile.client.auth.configured;
    let futuresBalance = null;
    let lastSyncAt = null;
    let openOrders = [];
    let openPositions = [];
    let status = configured ? "configured" : "missing keys";

    if (configured) {
      try {
        const [balance, positions, orders] = await Promise.all([
          profile.client.getPerpetualFuturesBalance(),
          profile.client.getOpenPositions(),
          profile.client.getOpenOrders(),
        ]);
        futuresBalance = extractBalanceAmount(balance);
        openPositions = normalizeExchangeList(positions).filter((position) => positionAmount(position) > 0);
        openOrders = normalizeExchangeList(orders);
        lastSyncAt = new Date().toISOString();
        status = "connected";
      } catch (error) {
        futuresBalance = cached?.futuresBalance ?? null;
        openPositions = cached?.openPositionItems ?? Array.from({ length: Number(cached?.openPositions ?? 0) });
        openOrders = cached?.openOrderItems ?? Array.from({ length: Number(cached?.openOrders ?? 0) });
        lastSyncAt = cached?.lastSyncAt ?? null;
        status = `sync delayed: ${humanBackendError(error)}`;
      }
    }

    const markPrices = {};
    if (configured && openPositions.length > 0) {
      await Promise.all(
        [...new Set(openPositions.map((position) => compactSymbol(position.symbol)).filter(Boolean))]
          .map(async (symbol) => {
            try {
              markPrices[symbol] = extractMarkPrice(await profile.client.getMarkPrice(symbol));
            } catch {
              markPrices[symbol] = null;
            }
          }),
      );
    }

    rows.push({
      configured,
      futuresBalance,
      id: profile.id,
      label: profile.label,
      lastSyncAt,
      markPrices,
      openOrderItems: openOrders,
      openOrders: openOrders.length,
      openPositionItems: openPositions,
      openPositions: openPositions.length,
      status,
      type: profile.type,
    });
  }

  apiProfilesCache = {
    expiresAt: Date.now() + 15_000,
    rows,
  };

  return rows;
}

function humanBackendError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("API keys")) return "API keys are missing";
  if (message.includes("HTTP 401")) return "BingX rejected the API key";
  if (message.includes("HTTP 429") || message.includes("100410") || message.includes("frequency limit")) {
    return "BingX is cooling down this endpoint. Wait a moment and refresh.";
  }
  return message;
}

function extractMarkPrice(value) {
  const payload = Array.isArray(value) ? value[0] : value;
  const price = Number(
    payload?.markPrice ??
    payload?.lastMarkPrice ??
    payload?.price ??
    payload?.lastPrice ??
    payload?.indexPrice,
  );
  return Number.isFinite(price) && price > 0 ? price : null;
}

function publicStatusPayload() {
  const state = store.getState();
  const trades = store.getTrades();
  const logs = store.getLogs();
  const orders = store.getOrders();
  const profiles = store.getProfiles();
  const executionConfig = store.getExecutionConfig();
  const activeBattleDeck = store
    .getCollection("battleDecks")
    .find((deck) => deck.id === executionConfig.activeBattleDeckId);

  return {
    analytics: calculateAnalytics(trades),
    executionConfig,
    logs: logs.slice(-80),
    orders: orders.slice(-80),
    profiles,
    state: {
      ...state,
      bingx: {
        ...state.bingx,
        apiConfigured: bingxClient.auth.configured,
      },
    },
    summary: {
      activeBattleDeck: activeBattleDeck ?? null,
      backendUrl: "/api",
      botOn: state.botStatus === "LIVE_RUNNING",
      openOrdersCount: state.bingx?.openOrders?.length ?? 0,
      openPosition: state.bingx?.openPositions?.[0] ?? null,
      startedAt: state.runtime?.startedAt ?? null,
      uptimeSeconds: state.runtime?.startedAt
        ? Math.floor((Date.now() - Date.parse(state.runtime.startedAt)) / 1000)
        : null,
    },
    trades: trades.slice(-120),
  };
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const numeric = Number(value);

    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }
  }

  return null;
}

function extractNestedProtectionPrice(value) {
  if (!value || typeof value !== "object") return null;
  return firstFiniteNumber(
    value.stopPrice,
    value.triggerPrice,
    value.price,
    value.entrustPrice,
    value.orderPrice,
  );
}

function positionProtectionPrice(position, kind) {
  if (!position || typeof position !== "object") return null;

  if (kind === "SL") {
    return firstFiniteNumber(
      extractNestedProtectionPrice(position.stopLoss),
      position.stopLossPrice,
      position.stopLoss,
      position.stopLossEntrustPrice,
      position.slPrice,
    );
  }

  return firstFiniteNumber(
    extractNestedProtectionPrice(position.takeProfit),
    position.takeProfitPrice,
    position.takeProfit,
    position.takeProfitEntrustPrice,
    position.tpPrice,
  );
}

function attachedOrdersForPosition(orders, position) {
  const symbol = compactSymbol(position.symbol);
  return orders.filter((order) => compactSymbol(order.symbol) === symbol && isSamePositionOrder(order, position, symbol));
}

function orderPrice(order) {
  if (!order || typeof order !== "object") return null;
  return firstFiniteNumber(
    order.stopPrice,
    order.triggerPrice,
    order.price,
    order.avgPrice,
    order.takeProfit?.stopPrice,
    order.stopLoss?.stopPrice,
  );
}

function findAttachedPrice(orders, matcher) {
  const order = orders.find((item) => matcher(String(item.type ?? item.orderType ?? "").toUpperCase()));
  const price = order ? orderPrice(order) : null;
  return Number.isFinite(price) && price > 0 ? price : null;
}

function findAttachedOrder(orders, matcher) {
  return orders
    .filter(isActiveOrder)
    .slice()
    .sort((left, right) => Number(right.updateTime ?? right.time ?? right.orderId ?? 0) - Number(left.updateTime ?? left.time ?? left.orderId ?? 0))
    .find((item) => matcher(String(item.type ?? item.orderType ?? "").toUpperCase())) ?? null;
}

function positionEntryPrice(position) {
  return Number(position.avgPrice ?? position.entryPrice ?? position.positionAvgPrice ?? position.openPrice ?? 0);
}

function positionMarkPrice(position) {
  return Number(position.__markPrice ?? position.markPrice ?? position.currentPrice ?? position.lastPrice ?? positionEntryPrice(position));
}

function positionLeverage(position) {
  return Number(position.leverage ?? position.marginLeverage ?? 0);
}

function positionMargin(position) {
  return Number(position.margin ?? position.usedMargin ?? position.positionMargin ?? 0);
}

function positionPnl(position) {
  return Number(position.unrealizedProfit ?? position.unrealizedPnl ?? position.pnl ?? 0);
}

function buildLivestreamPayload(apiProfileRows = []) {
  const state = store.getState();
  const battleDecks = store.getCollection("battleDecks");
  const strategyDecks = store.getCollection("strategyDecks");
  const mmDecks = store.getCollection("mmDecks");
  const profiles = store.getProfiles().filter(isLiveExecutionProfile);
  const hasExchangeProfileSync = apiProfileRows.length > 0;
  const liveProfileOrders = apiProfileRows.flatMap((profile) =>
    normalizeExchangeList(profile.openOrderItems).map((order) => ({
      ...order,
      __apiProfileId: profile.id,
      __apiProfileLabel: profile.label,
    })),
  );
  const liveProfilePositions = apiProfileRows.flatMap((profile) =>
    normalizeExchangeList(profile.openPositionItems).map((position) => ({
      ...position,
      __apiProfileId: profile.id,
      __apiProfileLabel: profile.label,
      __markPrice: profile.markPrices?.[compactSymbol(position.symbol)] ?? null,
    })),
  );
  const openOrders = hasExchangeProfileSync
    ? liveProfileOrders
    : normalizeExchangeList(state.bingx?.openOrders);
  const exchangePositions = (hasExchangeProfileSync
    ? liveProfilePositions
    : normalizeExchangeList(state.bingx?.openPositions)).filter(
    (position) => positionAmount(position) > 0,
  );
  const localPositions = profiles
    .filter((profile) => profile.live?.openPosition)
    .map((profile) => ({
      profile,
      position: profile.live.openPosition,
    }));
  const positions = exchangePositions.map((exchangePosition) => {
    const matchingProfile =
      profiles.find((profile) => profileApiId(profile) === exchangePosition.__apiProfileId) ??
      profiles.find((profile) => compactSymbol(profile.symbol) === compactSymbol(exchangePosition.symbol)) ??
      localPositions.find((item) => compactSymbol(item.profile.symbol) === compactSymbol(exchangePosition.symbol))?.profile;
    const battleDeck = battleDecks.find((deck) => `battle-${deck.id}` === matchingProfile?.id);
    const strategyDeck =
      strategyDecks.find((deck) => deck.id === battleDeck?.strategyDeckId) ?? battleDeck?.strategySnapshot;
    const mmDeck = mmDecks.find((deck) => deck.id === battleDeck?.mmDeckId) ?? battleDeck?.mmSnapshot;
    const orders = attachedOrdersForPosition(openOrders, exchangePosition);
    const entryPrice = positionEntryPrice(exchangePosition);
    const markPrice = positionMarkPrice(exchangePosition);
    const quantity = positionAmount(exchangePosition);
    const side = positionSide(exchangePosition);
    const stopLossOrder = findAttachedOrder(orders, (type) => type.includes("STOP") && !type.includes("TAKE"));
    const takeProfitOrder = findAttachedOrder(orders, (type) => type.includes("TAKE_PROFIT") || type.includes("PROFIT"));
    const directStopLoss = positionProtectionPrice(exchangePosition, "SL");
    const directTakeProfit = positionProtectionPrice(exchangePosition, "TP");
    const stopLoss = (stopLossOrder ? orderPrice(stopLossOrder) : null) ?? directStopLoss;
    const takeProfit = (takeProfitOrder ? orderPrice(takeProfitOrder) : null) ?? directTakeProfit;
    const notional = markPrice * quantity;
    const pnl = positionPnl(exchangePosition);
    const openTime = exchangePosition.updateTime ?? exchangePosition.openTime ?? exchangePosition.time ?? null;
    const distanceToSl = stopLoss ? Math.abs(markPrice - stopLoss) : null;
    const distanceToTp = takeProfit ? Math.abs(markPrice - takeProfit) : null;
    const lastAction = String(state.lastExecutionDecision ?? "");

    return {
      apiProfile: profileApiId(matchingProfile),
      apiProfileLabel: exchangePosition.__apiProfileLabel ?? matchingProfile?.account?.label ?? matchingProfile?.account?.apiProfile ?? profileApiId(matchingProfile),
      attachedOrders: orders,
      battleDeckId: battleDeck?.id ?? null,
      battleDeckName: battleDeck?.name ?? "Exchange position",
      botPriority: state.crisisMode ? "manual" : "bot",
      currentPrice: markPrice,
      distanceToSl,
      distanceToSlPercent: stopLoss && markPrice ? distanceToSl / markPrice * 100 : null,
      distanceToTp,
      distanceToTpPercent: takeProfit && markPrice ? distanceToTp / markPrice * 100 : null,
      durationSeconds: openTime ? Math.max(0, Math.floor((Date.now() - Number(openTime)) / 1000)) : null,
      entryPrice,
      lastAction: isPaperish(lastAction) ? null : lastAction || null,
      leverage: positionLeverage(exchangePosition),
      liquidationPrice: Number(exchangePosition.liquidationPrice ?? exchangePosition.liqPrice ?? 0) || null,
      marginUsed: positionMargin(exchangePosition),
      mmDeckName: mmDeck?.name ?? null,
      notionalSize: notional,
      openTime,
      pnlPercent: notional ? pnl / notional * 100 : null,
      positionId: positionIdentifier(exchangePosition),
      positionSide: side,
      protectionSource:
        stopLossOrder || takeProfitOrder
          ? "open orders"
          : directStopLoss || directTakeProfit
            ? "position fields"
            : "none",
      quantity,
      realizedSessionPnl: calculateAnalytics(store.getTrades()).totalPnl,
      side,
      sourceProfileId: matchingProfile?.id ?? null,
      strategyDeckName: strategyDeck?.name ?? null,
      stopLoss,
      stopLossSource: stopLossOrder ? "open orders" : directStopLoss ? "position fields" : "none",
      symbol: compactSymbol(exchangePosition.symbol),
      takeProfit,
      takeProfitSource: takeProfitOrder ? "open orders" : directTakeProfit ? "position fields" : "none",
      timeframe: battleDeck?.timeframe ?? matchingProfile?.timeframe ?? null,
      unrealizedPnl: pnl,
    };
  });
  const totalFuturesBalance = apiProfileRows.length
    ? apiProfileRows.reduce((sum, profile) => sum + Number(profile.futuresBalance ?? 0), 0)
    : Number(state.bingx?.activeExecutionBalance ?? 0);
  const totalUnrealizedPnl = positions.reduce((sum, position) => sum + Number(position.unrealizedPnl ?? 0), 0);
  const totalOpenNotional = positions.reduce((sum, position) => sum + Number(position.notionalSize ?? 0), 0);
  const totalMarginUsed = positions.reduce((sum, position) => sum + Number(position.marginUsed ?? 0), 0);
  const lastBingxSyncAt =
    apiProfileRows
      .map((profile) => profile.lastSyncAt)
      .filter(Boolean)
      .sort()
      .at(-1) ?? state.bingx?.lastSyncAt ?? null;
  const syncAgeSeconds = lastBingxSyncAt
    ? Math.max(0, Math.floor((Date.now() - new Date(lastBingxSyncAt).getTime()) / 1000))
    : null;

  return {
    accountSummary: {
      apiProfiles: apiProfileRows,
      dataAgeSeconds: syncAgeSeconds,
      lastBingxSyncAt,
      lastRefreshAt: new Date().toISOString(),
      source: syncAgeSeconds !== null && syncAgeSeconds <= 20 ? "fresh BingX sync" : apiProfileRows.length ? "backend cache" : "fallback",
      totalCombinedFuturesBalance: totalFuturesBalance,
      totalMarginUsed,
      totalOpenNotional,
      totalOpenPositions: positions.length,
      totalRealizedSessionPnl: calculateAnalytics(store.getTrades()).totalPnl,
      totalUnrealizedPnl,
    },
    openOrders,
    positions,
  };
}

function calculateAnalytics(trades) {
  const closed = trades.filter((trade) => Number.isFinite(Number(trade.pnl ?? trade.netPnl)));
  const pnl = closed.map((trade) => Number(trade.pnl ?? trade.netPnl ?? 0));
  const wins = pnl.filter((value) => value > 0);
  const losses = pnl.filter((value) => value < 0);
  const totalPnl = pnl.reduce((sum, value) => sum + value, 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const bestTrade = pnl.length ? Math.max(...pnl) : 0;
  const worstTrade = pnl.length ? Math.min(...pnl) : 0;

  return {
    averageTrade: pnl.length ? totalPnl / pnl.length : 0,
    bestTrade,
    grossLoss,
    grossProfit,
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? Infinity : 0) : grossProfit / grossLoss,
    totalPnl,
    totalTrades: closed.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
    worstTrade,
    narrative:
      closed.length === 0
        ? "No real bot trades are recorded yet. Analytics will become useful after live positions close."
        : totalPnl >= 0
          ? "The live record is currently positive. Keep watching drawdown and whether wins come from one deck or many."
          : "The live record is currently negative. Review the active Battle Deck and reduce size until performance stabilizes.",
  };
}

async function dataAvailability() {
  if (availabilityCache.expiresAt > Date.now() && availabilityCache.rows.length > 0) {
    return availabilityCache.rows;
  }

  const rows = await Promise.all(TIMEFRAMES.map(async (timeframe) => {
    try {
      const candles = await fetchCandles({
        limit: timeframe.maxCandles,
        symbol: "SOLUSDT",
        timeframe: timeframe.interval,
      });
      const first = candles[0];
      const last = candles.at(-1);
      const availableDays = candles.length * timeframe.minutes / 1440;
      return {
        ...timeframe,
        availableDays,
        candles: candles.length,
        firstCandleTime: first?.time ?? null,
        lastCandleTime: last?.time ?? null,
        note:
          candles.length >= timeframe.maxCandles
            ? `Exchange API currently provides at least ${Math.floor(availableDays)} days at this configured limit. More history can be enabled by raising max candles or adding an external data source.`
            : `Exchange API returned ${Math.floor(availableDays)} days for this timeframe. More history may require an external data source.`,
        ok: true,
      };
    } catch (error) {
      return {
        ...timeframe,
        availableDays: 0,
        candles: 0,
        error: error instanceof Error ? error.message : String(error),
        ok: false,
      };
    }
  }));

  availabilityCache = {
    expiresAt: Date.now() + 5 * 60_000,
    rows,
  };
  return rows;
}

function deckToProfile(battleDeck, existingProfile = {}) {
  const strategy = battleDeck.strategySnapshot ?? {};
  const mm = battleDeck.mmSnapshot ?? {};
  const timeframe = battleDeck.timeframe ?? strategy.timeframe ?? "15m";
  const symbol = battleDeck.symbol ?? strategy.symbol ?? "SOLUSDT";
  const sizingMode = strategy.sizingMode ?? (strategy.atrPositionSizing ? "fixed-risk" : "position-percent");

  return {
    ...existingProfile,
    id: `battle-${battleDeck.id}`,
    account: {
      apiProfile: battleDeck.apiProfile ?? "main",
      exchange: "BingX",
      label: battleDeck.accountLabel ?? "Main Account",
      type: battleDeck.accountType ?? "main",
    },
    enabled: true,
    executionMode: "live",
    locked: true,
    live: existingProfile.live ?? { lastProcessedSetupId: null, openPosition: null, orderLog: [] },
    paper: existingProfile.paper ?? { equity: 0, lastProcessedSetupId: null, openPosition: null, realizedPnl: 0, tradesToday: 0 },
    risk: {
      allowLong: strategy.allowLong !== false,
      allowShort: strategy.allowShort !== false,
      emergencyStop: false,
      fixedNotional: Number(mm.fixedNotional ?? 0),
      leverage: Number(mm.estimatedLeverage ?? mm.leverage ?? 1),
      marginMode: "isolated",
      maxDailyLossPercent: 100,
      maxOpenPositions: 1,
      maxTradesPerDay: 100,
      positionSizeMode:
        mm.mode === "constant"
          ? "fixed-usdt"
          : sizingMode === "fixed-risk"
            ? "risk-based"
            : "percent-move",
      priceMoveRiskPercent: Number(mm.positionPercent ?? mm.onePercentMovePercent ?? 10),
      riskPerTradePercent: Number(mm.riskPercent ?? mm.oneSlPercent ?? 1),
      startingBalance: Number(mm.startingBalance ?? 0),
      takeProfitRr: Number(mm.takeProfitRr ?? 2),
    },
    status: "Live ready",
    strategyDeployed: true,
    strategyParameters: {
      atrLength: Number(strategy.atrLength ?? 14),
      atrMultiplier: Number(strategy.atrMultiplier ?? 1.2),
      bandwidth: Number(strategy.bandwidth ?? 8),
      envelopeMultiplier: Number(strategy.envelopeMultiplier ?? 3),
      maxSameSideFailures: Number(strategy.maxSameSideFailures ?? 2),
      strategySource: strategy.strategySource ?? "pine-ha",
    },
    symbol,
    timeframe,
    version: Number(existingProfile.version ?? 0) + 1,
  };
}

function normalizeSymbol(symbol = "SOLUSDT") {
  return String(symbol || "SOLUSDT").toUpperCase().replace("-", "");
}

function normalizeExchangeList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.positions)) return value.positions;
  if (Array.isArray(value?.orders)) return value.orders;
  if (Array.isArray(value?.data)) return value.data;
  return value ? [value] : [];
}

function compactSymbol(symbol) {
  return String(symbol ?? "").replace("-", "").toUpperCase();
}

function isPaperish(value) {
  return String(value ?? "").toLowerCase().includes("paper");
}

function isLiveExecutionProfile(profile) {
  return (
    profile?.executionMode === "live" &&
    !isPaperish(profile?.id) &&
    !isPaperish(profile?.account?.apiProfile)
  );
}

function profileApiId(profile) {
  const apiId = profile?.account?.apiProfile;
  return apiId && !isPaperish(apiId) ? apiId : "main";
}

function positionAmount(position) {
  return Math.abs(Number(position.positionAmt ?? position.positionAmount ?? position.quantity ?? position.availableAmt ?? 0));
}

function positionSide(position) {
  const side = String(position.positionSide ?? position.side ?? "").toUpperCase();
  if (side.includes("SHORT")) return "SHORT";
  if (side.includes("LONG")) return "LONG";
  return Number(position.positionAmt ?? position.positionAmount ?? 0) < 0 ? "SHORT" : "LONG";
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

function selectManualPosition(positions, body, symbol) {
  const requestedId = body.positionId ? String(body.positionId) : "";
  const requestedSide = String(body.positionSide ?? body.side ?? "").toUpperCase();
  const openPositions = positions.filter(
    (position) => compactSymbol(position.symbol) === compactSymbol(symbol) && positionAmount(position) > 0,
  );

  if (requestedId) {
    const match = openPositions.find((position) => String(positionIdentifier(position)) === requestedId);
    if (match) return match;
  }

  if (requestedSide.includes("LONG") || requestedSide.includes("SHORT")) {
    const side = requestedSide.includes("LONG") ? "LONG" : "SHORT";
    const match = openPositions.find((position) => positionSide(position) === side);
    if (match) return match;
  }

  return openPositions[0] ?? null;
}

function positionDiagnostic(position) {
  if (!position) return null;
  return {
    positionId: positionIdentifier(position),
    positionSide: positionSide(position),
    quantity: positionAmount(position),
    symbol: compactSymbol(position.symbol),
  };
}

function orderIdentifier(order) {
  return order?.orderId ?? order?.orderID ?? order?.id ?? null;
}

function orderClientIdentifier(order) {
  return order?.clientOrderId ?? order?.clientOrderID ?? null;
}

function orderKey(order) {
  const id = orderIdentifier(order) ?? orderClientIdentifier(order);
  return id === null || id === undefined ? "" : String(id);
}

function orderPositionSide(order) {
  const explicitSide = String(order?.positionSide ?? "").toUpperCase();
  if (explicitSide.includes("LONG")) return "LONG";
  if (explicitSide.includes("SHORT")) return "SHORT";

  const side = String(order?.side ?? "").toUpperCase();
  const type = orderType(order);

  if ((type.includes("STOP") || type.includes("PROFIT")) && side === "SELL") return "LONG";
  if ((type.includes("STOP") || type.includes("PROFIT")) && side === "BUY") return "SHORT";
  if (side.includes("LONG")) return "LONG";
  if (side.includes("SHORT")) return "SHORT";
  return null;
}

function orderType(order) {
  return String(order?.type ?? order?.orderType ?? order?.origType ?? "").toUpperCase();
}

function orderDiagnostic(order) {
  if (!order) return null;
  return {
    clientOrderId: orderClientIdentifier(order),
    closePosition: order.closePosition ?? null,
    orderId: orderIdentifier(order),
    positionId: positionIdentifier(order),
    positionSide: orderPositionSide(order),
    price: orderPrice(order),
    side: order.side ?? null,
    status: order.status ?? null,
    symbol: compactSymbol(order.symbol),
    type: orderType(order),
  };
}

function resultDiagnostics(result) {
  return result?._diagnostics ?? null;
}

function resultOrder(result) {
  return result?.order ?? result?.data?.order ?? result;
}

function resultOrderId(result) {
  const order = resultOrder(result);
  return orderIdentifier(order);
}

function isActiveOrder(order) {
  const status = String(order?.status ?? "").toUpperCase();

  if (!status) return Boolean(orderIdentifier(order) || orderClientIdentifier(order));
  return !["CANCELED", "CANCELLED", "EXPIRED", "FILLED", "REJECTED"].includes(status);
}

function isSamePositionOrder(order, position, symbol) {
  if (compactSymbol(order.symbol) !== compactSymbol(symbol)) return false;
  const side = orderPositionSide(order);
  return !side || side === positionSide(position);
}

function isProtectiveOrderForAction(order, action) {
  const type = orderType(order);

  if (action === "MOVE_SL") {
    return type.includes("STOP") && !type.includes("TAKE");
  }

  if (action === "MOVE_TP") {
    return type.includes("TAKE_PROFIT") || type.includes("PROFIT");
  }

  return false;
}

async function cancelExistingProtectiveOrders({ action, client, position, symbol }) {
  const orders = normalizeExchangeList(await client.getOpenOrders(symbol));
  const matchingOrders = orders.filter((order) => {
    if (!isSamePositionOrder(order, position, symbol)) return false;
    return action ? isProtectiveOrderForAction(order, action) : true;
  });
  return cancelMatchedOrders({ client, matchingOrders, symbol });
}

async function cancelMatchedOrders({ client, excludeOrderIds = [], matchingOrders, symbol }) {
  const excluded = new Set(excludeOrderIds.map((item) => String(item)).filter(Boolean));
  const cancelled = [];
  const cancelErrors = [];

  for (const order of matchingOrders) {
    if (excluded.has(orderKey(order))) continue;
    const orderId = orderIdentifier(order);
    const clientOrderId = orderClientIdentifier(order);

    if (!orderId && !clientOrderId) {
      cancelErrors.push({
        error: "Open order had no orderId/clientOrderId.",
        order: orderDiagnostic(order),
      });
      continue;
    }

    try {
      const result = await client.cancelOrder(symbol, { clientOrderId, orderId });
      cancelled.push({
        order: orderDiagnostic(order),
        result,
      });
    } catch (error) {
      cancelErrors.push({
        error: error instanceof Error ? error.message : String(error),
        exchange: error?.bingx ?? null,
        order: orderDiagnostic(order),
      });
    }
  }

  return {
    cancelErrors,
    cancelled,
    excluded: [...excluded],
    matched: matchingOrders.map(orderDiagnostic).filter(Boolean),
  };
}

async function protectionOrderState({ client, placedOrderStatus = null, symbol }) {
  const [positionsResult, openOrdersResult, protectiveOrdersResult] = await Promise.allSettled([
    client.getOpenPositions(symbol),
    client.getOpenOrders(symbol),
    typeof client.getProtectiveOrders === "function" ? client.getProtectiveOrders(symbol) : client.getOpenOrders(symbol),
  ]);
  const openPositions = positionsResult.status === "fulfilled" ? normalizeExchangeList(positionsResult.value) : [];
  const openOrders = openOrdersResult.status === "fulfilled" ? normalizeExchangeList(openOrdersResult.value) : [];
  const protectiveOrders = protectiveOrdersResult.status === "fulfilled" ? normalizeExchangeList(protectiveOrdersResult.value) : [];
  const placedOrderItems = placedOrderStatus?.order ? [placedOrderStatus.order] : [];

  return {
    errors: [
      ...(positionsResult.status === "rejected" ? [{ source: "positions", message: humanBackendError(positionsResult.reason), exchange: positionsResult.reason?.bingx ?? null }] : []),
      ...(openOrdersResult.status === "rejected" ? [{ source: "openOrders", message: humanBackendError(openOrdersResult.reason), exchange: openOrdersResult.reason?.bingx ?? null }] : []),
      ...(protectiveOrdersResult.status === "rejected" ? [{ source: "protectiveOrders", message: humanBackendError(protectiveOrdersResult.reason), exchange: protectiveOrdersResult.reason?.bingx ?? null }] : []),
    ],
    fetchedAt: new Date().toISOString(),
    openOrders,
    openPositions,
    planOrders: protectiveOrders.filter((order) => {
      const type = orderType(order);
      return type.includes("TRIGGER") || type.includes("PLAN");
    }),
    placedOrderItems,
    protectionSourcesChecked: [
      "position fields",
      "open orders",
      "protective orders via openOrders",
      "plan/trigger orders via openOrders",
      "placed order status",
    ],
    protectiveOrders,
    tpslOrders: protectiveOrders.filter((order) => isProtectiveOrderForAction(order, "MOVE_SL") || isProtectiveOrderForAction(order, "MOVE_TP")),
    tpslEndpointNote: "Official normal USD-M futures docs expose STOP_MARKET/TAKE_PROFIT_MARKET protection via /openApi/swap/v2/trade/order and /openApi/swap/v2/trade/openOrders. The copyTrading setTPSL endpoint is not used for regular positions.",
  };
}

async function queryPlacedOrder({ client, result, symbol }) {
  const orderId = resultOrderId(result);

  if (!orderId) {
    return {
      error: "BingX response did not include an order id.",
      order: null,
    };
  }

  try {
    const statusResult = await client.getOrderStatus(orderId, symbol);
    return {
      diagnostics: resultDiagnostics(statusResult),
      order: resultOrder(statusResult),
      orderId,
      raw: statusResult,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      exchange: error?.bingx ?? null,
      orderId,
      order: null,
    };
  }
}

function matchingSnapshotPosition(snapshot, originalPosition, symbol) {
  const originalId = positionIdentifier(originalPosition);
  const originalSide = positionSide(originalPosition);
  const positions = normalizeExchangeList(snapshot?.openPositions);

  if (originalId) {
    const idMatch = positions.find((position) => String(positionIdentifier(position)) === String(originalId));
    if (idMatch) return idMatch;
  }

  return positions.find(
    (position) =>
      compactSymbol(position.symbol) === compactSymbol(symbol) &&
      positionSide(position) === originalSide &&
      positionAmount(position) > 0,
  ) ?? null;
}

function isClosePriceMatch(actual, requested) {
  const actualNumber = Number(actual);
  const requestedNumber = Number(requested);

  if (!Number.isFinite(actualNumber) || !Number.isFinite(requestedNumber) || actualNumber <= 0 || requestedNumber <= 0) {
    return false;
  }

  return Math.abs(actualNumber - requestedNumber) <= Math.max(0.00000001, requestedNumber * 0.001);
}

function verifyProtectiveAction({ action, position, requestedPrice, snapshot, symbol }) {
  const currentPosition = matchingSnapshotPosition(snapshot, position, symbol);

  if (!currentPosition) {
    return {
      confirmed: false,
      message: "Exchange sync completed, but the original position is no longer open.",
      reason: "position_missing_after_sync",
    };
  }

  const directPrice = positionProtectionPrice(currentPosition, action === "MOVE_SL" ? "SL" : "TP");
  const orderSources = [
    { name: "open order", orders: normalizeExchangeList(snapshot?.openOrders) },
    { name: "protective order", orders: normalizeExchangeList(snapshot?.protectiveOrders) },
    { name: "plan order", orders: normalizeExchangeList(snapshot?.planOrders) },
    { name: "TPSL order", orders: normalizeExchangeList(snapshot?.tpslOrders) },
    { name: "placed order status", orders: normalizeExchangeList(snapshot?.placedOrderItems) },
  ];
  const protectiveOrders = orderSources.flatMap(({ name, orders }) =>
    orders
      .filter((order) => isSamePositionOrder(order, currentPosition, symbol) && isProtectiveOrderForAction(order, action))
      .map((order) => ({ order, source: name })),
  );
  const activeProtectiveOrders = protectiveOrders.filter(({ order }) => isActiveOrder(order));
  const matched = activeProtectiveOrders.find(({ order }) => isClosePriceMatch(orderPrice(order), requestedPrice)) ?? null;
  const matchedOrder = matched?.order ?? null;
  const matchedPrice = matchedOrder ? orderPrice(matchedOrder) : null;
  const directMatches = isClosePriceMatch(directPrice, requestedPrice);
  const confirmedPrice = directMatches ? directPrice : matchedPrice;
  const source = matched ? matched.source : directMatches ? "position field" : "not found";

  if (matchedOrder || directMatches) {
    return {
      confirmed: true,
      confirmedPrice,
      directPrice,
      matchedOrder: orderDiagnostic(matchedOrder),
      message: action === "MOVE_SL"
        ? `Protection verified: SL found in ${source} at ${confirmedPrice}.`
        : `Protection verified: TP found in ${source} at ${confirmedPrice}.`,
      priceMatchesRequest: true,
      reason: "protective_order_found_after_sync",
      source,
      sourcesChecked: snapshot?.protectionSourcesChecked ?? [],
    };
  }

  if (activeProtectiveOrders.length > 0 || directPrice) {
    return {
      activeProtection: {
        directPrice,
        orders: activeProtectiveOrders.map(({ order, source }) => ({
          ...orderDiagnostic(order),
          source,
        })).filter(Boolean),
      },
      confirmed: false,
      message: action === "MOVE_SL"
        ? "Request accepted, but the active SL found after sync does not match the requested price."
        : "Request accepted, but the active TP found after sync does not match the requested price.",
      reason: "protective_price_mismatch_after_sync",
      sourcesChecked: snapshot?.protectionSourcesChecked ?? [],
    };
  }

  return {
    confirmed: false,
    message: action === "MOVE_SL"
      ? "Request accepted, but no active SL was found after sync."
      : "Request accepted, but no active TP was found after sync.",
    reason: "protective_order_missing_after_sync",
    sourcesChecked: snapshot?.protectionSourcesChecked ?? [],
  };
}

function sleepMs(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForProtectionVerification({
  action,
  client,
  placedOrderStatus,
  position,
  requestedPrice,
  symbol,
}) {
  let lastSnapshot = null;
  let lastVerification = null;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    lastSnapshot = await protectionOrderState({ client, placedOrderStatus, symbol });
    lastVerification = verifyProtectiveAction({
      action,
      position,
      requestedPrice,
      snapshot: lastSnapshot,
      symbol,
    });

    if (lastVerification.confirmed || attempt === 4) {
      return {
        attempts: attempt,
        snapshot: lastSnapshot,
        verification: lastVerification,
      };
    }

    await sleepMs(900 * attempt);
  }

  return {
    attempts: 0,
    snapshot: lastSnapshot,
    verification: lastVerification,
  };
}

async function executeManualAction(body) {
  const state = store.getState();
  const apiProfile = String(body.apiProfile ?? "main").toLowerCase();
  const client = getApiProfileClient(apiProfile);

  if (!client.auth.configured) {
    return { ok: false, message: "BingX keys are not configured." };
  }

  if (!state.crisisMode) {
    return { ok: false, message: "Turn Crisis Management ON before sending manual exchange actions." };
  }

  const symbol = normalizeSymbol(body.symbol);
  const quantity = Number(body.quantity);
  const stopPrice = Number(body.stopPrice);
  const takeProfitPrice = Number(body.takeProfitPrice);
  const action = String(body.action ?? "").toUpperCase();
  let result;
  let placementMode = null;
  const placementErrors = [];
  let placedOrderStatus = null;
  let protectionManagement = null;
  let selectedPosition = null;
  let fetchedPositions = [];
  let postActionSync = null;
  let verification = null;
  let protectionWait = null;

  async function openPosition() {
    fetchedPositions = normalizeExchangeList(await client.getOpenPositions(symbol));
    selectedPosition = selectManualPosition(fetchedPositions, body, symbol);

    if (!selectedPosition) {
      return null;
    }

    return selectedPosition;
  }

  if (["MARKET_LONG", "MARKET_SHORT"].includes(action)) {
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { ok: false, message: "Enter a valid order quantity first." };
    }
    result = await client.placeMarketOrder(symbol, action === "MARKET_LONG" ? "BUY" : "SELL", quantity);
  } else if (action === "CLOSE_POSITION") {
    const position = await openPosition();

    if (!position) {
      return { ok: false, message: "No open position found on BingX for this symbol." };
    }

    result = await client.closePosition(symbol, {
      position,
      positionId: body.positionId ?? positionIdentifier(position),
      positionSide: positionSide(position),
    });
  } else if (action === "CLOSE_PARTIAL") {
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { ok: false, message: "Enter a valid partial close quantity first." };
    }
    const position = await openPosition();

    if (!position) {
      return { ok: false, message: "No open position found on BingX for this symbol." };
    }

    const closeSide = positionSide(position) === "LONG" ? "SELL" : "BUY";
    result = await client.placeReduceOnlyMarketOrder(symbol, closeSide, quantity, {
      position,
      positionSide: positionSide(position),
    });
  } else if (action === "CANCEL_ALL") {
    result = await client.cancelOpenOrders(symbol);
  } else if (action === "CANCEL_ATTACHED_ORDERS") {
    const position = await openPosition();

    if (!position) {
      return { ok: false, message: "No open position found on BingX for this symbol." };
    }

    protectionManagement = await cancelExistingProtectiveOrders({ client, position, symbol });

    if (protectionManagement.cancelErrors.length > 0) {
      return {
        ok: false,
        message: "BingX could not cancel every attached order for this position.",
        diagnostics: {
          action,
          hedgeMode: "positionSide",
          positionsFound: fetchedPositions.map(positionDiagnostic).filter(Boolean),
          protectionManagement,
          selectedPosition: positionDiagnostic(selectedPosition),
        },
        symbol,
      };
    }

    result = {
      cancelledAttachedOrders: protectionManagement.cancelled,
      ok: true,
      _diagnostics: {
        endpoint: "/openApi/swap/v2/trade/order",
        method: "DELETE",
        payload: {
          cancelledOrderIds: protectionManagement.cancelled.map((item) => orderIdentifier(resultOrder(item.result))).filter(Boolean),
          symbol,
        },
        response: protectionManagement,
      },
    };
  } else if (["MOVE_SL", "MOVE_TP"].includes(action)) {
    const position = await openPosition();

    if (!position) {
      return { ok: false, message: "No open position found on BingX for this symbol." };
    }

    const side = positionSide(position) === "LONG" ? "BUY" : "SELL";
    const protectiveQuantity = positionAmount(position);

    if (!Number.isFinite(protectiveQuantity) || protectiveQuantity <= 0) {
      return { ok: false, message: "BingX returned an open position without a usable quantity." };
    }

    if (action === "MOVE_SL") {
      if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
        return { ok: false, message: "Enter a valid SL price first." };
      }
      placementMode = "position-close-stop";
      try {
        result = await client.placePositionStopLoss(symbol, side, stopPrice, {
          position,
          positionId: body.positionId ?? positionIdentifier(position),
          positionSide: positionSide(position),
          quantity: protectiveQuantity,
        });
      } catch (error) {
        placementErrors.push({
          exchange: error?.bingx ?? null,
          message: error instanceof Error ? error.message : String(error),
          mode: placementMode,
        });
        placementMode = "standard-stop";
        result = await client.placeStopLoss(symbol, side, stopPrice, protectiveQuantity, {
          position,
          positionId: body.positionId ?? positionIdentifier(position),
          positionSide: positionSide(position),
        });
      }
    } else {
      if (!Number.isFinite(takeProfitPrice) || takeProfitPrice <= 0) {
        return { ok: false, message: "Enter a valid TP price first." };
      }
      placementMode = "position-close-take-profit";
      try {
        result = await client.placePositionTakeProfit(symbol, side, takeProfitPrice, {
          position,
          positionId: body.positionId ?? positionIdentifier(position),
          positionSide: positionSide(position),
          quantity: protectiveQuantity,
        });
      } catch (error) {
        placementErrors.push({
          exchange: error?.bingx ?? null,
          message: error instanceof Error ? error.message : String(error),
          mode: placementMode,
        });
        placementMode = "standard-take-profit";
        result = await client.placeTakeProfit(symbol, side, takeProfitPrice, protectiveQuantity, {
          position,
          positionId: body.positionId ?? positionIdentifier(position),
          positionSide: positionSide(position),
        });
      }
    }
  } else {
    return { ok: false, message: "Choose a manual action first." };
  }

  if (result?.ok === false) {
    return {
      ok: false,
      message: result.message ?? "BingX did not accept the manual action.",
      diagnostics: {
          action,
          exchange: resultDiagnostics(result),
          exchangeResponse: resultDiagnostics(result)?.response ?? result,
          hedgeMode: selectedPosition ? "positionSide" : "none",
          placementErrors,
          placedOrderStatus,
          placementMode,
          positionsFound: fetchedPositions.map(positionDiagnostic).filter(Boolean),
        protectionManagement,
        selectedPosition: positionDiagnostic(selectedPosition),
      },
      result,
      symbol,
    };
  }

  if (["MOVE_SL", "MOVE_TP"].includes(action)) {
    placedOrderStatus = await queryPlacedOrder({ client, result, symbol });
    protectionWait = await waitForProtectionVerification({
      action,
      client,
      placedOrderStatus,
      position: selectedPosition,
      requestedPrice: action === "MOVE_SL" ? stopPrice : takeProfitPrice,
      symbol,
    });
    verification = protectionWait.verification;

    if (verification?.confirmed) {
      const keepOrderId = verification.matchedOrder?.orderId ?? resultOrderId(result);
      const staleProtectiveOrders = normalizeExchangeList(protectionWait.snapshot?.openOrders)
        .filter((order) => isSamePositionOrder(order, selectedPosition, symbol) && isProtectiveOrderForAction(order, action));
      protectionManagement = await cancelMatchedOrders({
        client,
        excludeOrderIds: [keepOrderId].filter(Boolean),
        matchingOrders: staleProtectiveOrders,
        symbol,
      });

      if (protectionManagement.cancelled.length || protectionManagement.cancelErrors.length) {
        protectionWait = await waitForProtectionVerification({
          action,
          client,
          placedOrderStatus,
          position: selectedPosition,
          requestedPrice: action === "MOVE_SL" ? stopPrice : takeProfitPrice,
          symbol,
        });
        verification = protectionWait.verification;
      }
    }
  }

  const freshRows = await publicApiProfiles({ fresh: true });
  const profileRow =
    freshRows.find((row) => row.id === apiProfile) ??
    freshRows.find((row) => row.id === "main") ??
    freshRows[0] ??
    null;
  const profileSnapshot = {
    apiProfile,
    balance: profileRow?.futuresBalance ?? null,
    fetchedAt: profileRow?.lastSyncAt ?? new Date().toISOString(),
    openOrders: normalizeExchangeList(profileRow?.openOrderItems),
    openPositions: normalizeExchangeList(profileRow?.openPositionItems),
    placedOrderItems: placedOrderStatus?.order ? [placedOrderStatus.order] : [],
    orderDiagnostics: normalizeExchangeList(profileRow?.openOrderItems).map(orderDiagnostic).filter(Boolean),
    placedOrderDiagnostics: placedOrderStatus?.order ? [orderDiagnostic(placedOrderStatus.order)].filter(Boolean) : [],
    positionDiagnostics: normalizeExchangeList(profileRow?.openPositionItems).map(positionDiagnostic).filter(Boolean),
    source: profileRow?.status === "connected" ? "fresh BingX" : "stale/error",
    status: profileRow?.status ?? "missing profile",
    protectionSourcesChecked: protectionWait?.snapshot?.protectionSourcesChecked ?? [],
    protectiveOrders: normalizeExchangeList(protectionWait?.snapshot?.protectiveOrders),
    planOrders: normalizeExchangeList(protectionWait?.snapshot?.planOrders),
    tpslOrders: normalizeExchangeList(protectionWait?.snapshot?.tpslOrders),
    tpslEndpointNote: protectionWait?.snapshot?.tpslEndpointNote ?? null,
    protectionSyncErrors: protectionWait?.snapshot?.errors ?? [],
  };
  postActionSync = {
    accountProfile: {
      configured: profileRow?.configured ?? false,
      futuresBalance: profileRow?.futuresBalance ?? null,
      id: profileRow?.id ?? apiProfile,
      label: profileRow?.label ?? apiProfile,
      lastSyncAt: profileRow?.lastSyncAt ?? null,
      openOrders: profileRow?.openOrders ?? 0,
      openPositions: profileRow?.openPositions ?? 0,
      status: profileRow?.status ?? "missing profile",
    },
    livestream: buildLivestreamPayload(freshRows),
    snapshot: {
      ...profileSnapshot,
      openOrders: profileSnapshot.orderDiagnostics,
      openPositions: profileSnapshot.positionDiagnostics,
      placedOrder: placedOrderStatus,
    },
  };

  if (action === "CANCEL_ATTACHED_ORDERS") {
    const currentPosition = matchingSnapshotPosition(profileSnapshot, selectedPosition, symbol);
    const remainingOrders = currentPosition
      ? attachedOrdersForPosition(profileSnapshot.openOrders, currentPosition).filter(isActiveOrder)
      : [];

    if (remainingOrders.length > 0) {
      return {
        action,
        ok: false,
        message: "Request accepted, but attached orders are still visible after fresh sync.",
        diagnostics: {
          action,
          parsedSuccess: false,
          postActionSync,
          protectionManagement,
          remainingOrders: remainingOrders.map(orderDiagnostic).filter(Boolean),
          selectedPosition: positionDiagnostic(selectedPosition),
        },
        livestream: postActionSync.livestream,
        result,
        symbol,
      };
    }

    verification = {
      confirmed: true,
      message: "Attached protection/orders cancelled. Fresh sync shows no active attached orders for this position.",
      reason: "attached_orders_cleared_after_sync",
      source: "open orders",
    };
  }

  if (["MOVE_SL", "MOVE_TP"].includes(action)) {
    verification = profileRow?.status === "connected" && verification
      ? verification
      : profileRow?.status === "connected"
        ? verifyProtectiveAction({
            action,
            position: selectedPosition,
            requestedPrice: action === "MOVE_SL" ? stopPrice : takeProfitPrice,
            snapshot: profileSnapshot,
            symbol,
          })
        : {
          confirmed: false,
          message: "BingX accepted the request, but the platform could not complete a fresh sync to confirm it.",
          reason: "fresh_sync_failed",
        };

    if (!verification.confirmed) {
      await store.appendLog({
        context: {
          action,
          exchange: resultDiagnostics(result),
          placementErrors,
          placedOrderStatus,
          placementMode,
          postActionSync,
          result,
          selectedPosition: positionDiagnostic(selectedPosition),
          symbol,
          verification,
        },
        message: action === "MOVE_SL" ? "manual SL move unconfirmed" : "manual TP move unconfirmed",
      });

      return {
        action,
        ok: false,
        message: verification.message,
        diagnostics: {
          action,
          exchange: resultDiagnostics(result),
          exchangeResponse: resultDiagnostics(result)?.response ?? result,
          hedgeMode: selectedPosition ? "positionSide" : "none",
          parsedSuccess: false,
          placementErrors,
          placedOrderStatus,
          placementMode,
          positionsFound: fetchedPositions.map(positionDiagnostic).filter(Boolean),
          protectionWait,
          postActionSync,
          protectionManagement,
          selectedPosition: positionDiagnostic(selectedPosition),
          verification,
        },
        livestream: postActionSync.livestream,
        result,
        symbol,
      };
    }
  }

  await store.appendLog({
    context: {
      action,
      exchange: resultDiagnostics(result),
      placementErrors,
      placedOrderStatus,
      placementMode,
      postActionSync,
      result,
      selectedPosition: positionDiagnostic(selectedPosition),
      symbol,
      verification,
    },
    message: verification?.message ?? "manual exchange action accepted",
  });

  return {
    action,
    ok: true,
    message: verification?.message ?? "Exchange accepted request. Fresh sync completed.",
    status: verification?.confirmed ? "protection_verified" : "exchange_accepted",
    diagnostics: {
      action,
      exchange: resultDiagnostics(result),
      exchangeResponse: resultDiagnostics(result)?.response ?? result,
      hedgeMode: selectedPosition ? "positionSide" : "none",
      parsedSuccess: true,
      placementErrors,
      placedOrderStatus,
      placementMode,
      positionsFound: fetchedPositions.map(positionDiagnostic).filter(Boolean),
      protectionWait,
      postActionSync,
      protectionManagement,
      selectedPosition: positionDiagnostic(selectedPosition),
      verification,
    },
    livestream: postActionSync.livestream,
    result,
    symbol,
  };
}

function sanitizeBacktestRecord(record) {
  if (!record || typeof record !== "object") return record;
  const { sourceCandles, ...rest } = record;

  return {
    ...rest,
    diagnosticEventCount: record.diagnosticEventCount ?? record.diagnosticEvents?.length ?? 0,
    diagnosticEvents: Array.isArray(record.diagnosticEvents)
      ? record.diagnosticEvents.slice(-BACKTEST_EVENT_RESPONSE_LIMIT)
      : [],
    diagnosticSummary: record.diagnosticSummary ?? {},
    eventCount: record.eventCount ?? record.events?.length ?? 0,
    events: Array.isArray(record.events) ? record.events.slice(-BACKTEST_EVENT_RESPONSE_LIMIT) : [],
    setupAuditCount: record.setupAuditCount ?? record.setupAudits?.length ?? 0,
    setupAudits: Array.isArray(record.setupAudits)
      ? record.setupAudits.slice(-BACKTEST_EVENT_RESPONSE_LIMIT)
      : [],
  };
}

async function handleCollectionRoute({ body, method, pathname, response }) {
  for (const [basePath, config] of Object.entries(COLLECTION_ROUTES)) {
    if (pathname === basePath && method === "GET") {
      const rows = store.getCollection(config.name);
      sendJson(response, 200, config.name === "backtests" ? rows.map(sanitizeBacktestRecord) : rows);
      return true;
    }

    if (pathname === basePath && method === "POST") {
      if (!body.name && config.name !== "favorites") {
        sendJson(response, 400, { message: "Please give this item a name before saving." });
        return true;
      }

      const current = store.getCollection(config.name) ?? [];
      if (!body.id && current.length >= config.limit) {
        sendJson(response, 400, { message: `Limit reached. You can keep ${config.limit} items here.` });
        return true;
      }

      sendJson(response, 200, await store.upsertCollectionItem(
        config.name,
        config.name === "backtests" ? sanitizeBacktestRecord(body) : body,
      ));
      return true;
    }

    if (pathname.startsWith(`${basePath}/`) && ["PUT", "DELETE"].includes(method)) {
      const id = decodeURIComponent(pathname.slice(basePath.length + 1));

      if (method === "DELETE") {
        sendJson(response, 200, await store.deleteCollectionItem(config.name, id));
        return true;
      }

      if (!body.name && config.name !== "favorites") {
        sendJson(response, 400, { message: "Please give this item a name before saving." });
        return true;
      }

      const nextBody = { ...body, id };
      sendJson(response, 200, await store.upsertCollectionItem(
        config.name,
        config.name === "backtests" ? sanitizeBacktestRecord(nextBody) : nextBody,
      ));
      return true;
    }
  }

  return false;
}

async function sendTelegramTest(settings) {
  const token = settings.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = settings.telegramChatId || process.env.TELEGRAM_CHAT_ID;

  if (!settings.enabled) {
    return { ok: false, message: "Telegram alerts are turned off. Turn them on and save first." };
  }

  if (!token || !chatId) {
    return {
      ok: false,
      message: "Telegram token or chat id is missing. Add both values and try again.",
    };
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    body: JSON.stringify({
      chat_id: chatId,
      text: "Choromański Trading Platform test alert is working.",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.ok === false) {
    return {
      ok: false,
      message: payload.description || "Telegram did not accept the test message.",
    };
  }

  return {
    ok: true,
    message: "Test alert sent.",
    testedAt: new Date().toISOString(),
  };
}

const aiMemory = createAiMemoryStore({ store });
const copilotMemory = createCopilotMemoryStore({ store });
const aiBuildContext = createAiContextBuilder({
  buildLivestreamPayload,
  calculateAnalytics,
  dataAvailability,
  publicApiProfiles,
  publicStatusPayload,
  store,
});
const aiTools = createAiTools({
  buildAiContext: aiBuildContext,
  buildLivestreamPayload,
  calculateAnalytics,
  copilotMemory,
  dataAvailability,
  memory: aiMemory,
  publicApiProfiles,
  publicStatusPayload,
  store,
});
const aiService = createAiService({
  buildAiContext: aiBuildContext,
  memory: aiMemory,
  provider: process.env.AI_PROVIDER ?? "mock",
  tools: aiTools,
});
const aiAgent = createAgentOrchestrator({
  copilotMemory,
  store,
  tools: aiTools,
});
const sztabRunner = createSztabRunner({
  buildLivestreamPayload,
  getApiProfileClient,
  publicApiProfiles,
  store,
});
await sztabRunner.initialize();

function normalizeSztabInterval(value) {
  const interval = String(value ?? "").toLowerCase();
  return SZTAB_INTERVALS.includes(interval) ? interval : "";
}

async function readBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    sendJson(response, 200, { ok: true });
    return;
  }

  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const pathname = url.pathname.startsWith("/api/")
      ? url.pathname.slice(4)
      : url.pathname === "/api" ? "/" : url.pathname;

    if (request.method === "GET" && pathname === "/health") {
      sendJson(response, 200, { ok: true, service: "choromanski-trading-backend" });
      return;
    }

    if (request.method === "GET" && pathname === "/status") {
      sendJson(response, 200, {
        ...publicStatusPayload(),
        equity: store.getEquity().slice(-200),
      });
      return;
    }

    if (request.method === "GET" && pathname === "/system/status") {
      sendJson(response, 200, {
        ...publicStatusPayload(),
        communication: safePublicCommunication(store.getCollection("communication")),
        dataAvailability: await dataAvailability(),
        equity: store.getEquity().slice(-200),
      });
      return;
    }

    if (request.method === "GET" && pathname === "/data/availability") {
      sendJson(response, 200, await dataAvailability());
      return;
    }

    if (request.method === "GET" && (pathname === "/historical/candles" || pathname === "/data/candles")) {
      sendJson(response, 200, await historicalCandlesPayload(url.searchParams));
      return;
    }

    if (request.method === "GET" && pathname === "/execution/status") {
      sendJson(response, 200, publicStatusPayload());
      return;
    }

    if (request.method === "GET" && pathname === "/accounts/profiles") {
      sendJson(response, 200, await publicApiProfiles({ fresh: url.searchParams.get("fresh") === "1" }));
      return;
    }

    if (request.method === "GET" && pathname === "/livestream") {
      const apiProfileRows = await publicApiProfiles({ fresh: url.searchParams.get("fresh") === "1" });
      const payload = buildLivestreamPayload(apiProfileRows);
      sendJson(response, 200, payload);
      return;
    }

    if (request.method === "GET" && pathname === "/sztab/status") {
      sendJson(response, 200, await sztabRunner.getStatus());
      return;
    }

    if (request.method === "GET" && pathname === "/sztab/config") {
      sendJson(response, 200, await sztabRunner.getConfig());
      return;
    }

    const sztabConfigMatch = pathname.match(/^\/sztab\/config\/([^/]+)$/u);
    if (request.method === "POST" && sztabConfigMatch) {
      if (!requireDashboardToken(request, response)) return;
      const interval = normalizeSztabInterval(sztabConfigMatch[1]);
      const body = await readBody(request);
      const result = interval
        ? await sztabRunner.updateConfig(interval, body)
        : { ok: false, message: "Unsupported Sztab interval." };
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }

    const sztabStartMatch = pathname.match(/^\/sztab\/start\/([^/]+)$/u);
    if (request.method === "POST" && sztabStartMatch) {
      if (!requireDashboardToken(request, response)) return;
      const interval = normalizeSztabInterval(sztabStartMatch[1]);
      const body = await readBody(request);
      const result = interval
        ? await sztabRunner.start(interval, body)
        : { ok: false, status: 400, message: "Unsupported Sztab interval." };
      sendJson(response, result.ok ? 200 : result.status ?? 400, result);
      return;
    }

    const sztabStopMatch = pathname.match(/^\/sztab\/stop\/([^/]+)$/u);
    if (request.method === "POST" && sztabStopMatch) {
      if (!requireDashboardToken(request, response)) return;
      const interval = normalizeSztabInterval(sztabStopMatch[1]);
      const result = interval
        ? await sztabRunner.stop(interval)
        : { ok: false, status: 400, message: "Unsupported Sztab interval." };
      sendJson(response, result.ok ? 200 : result.status ?? 400, result);
      return;
    }

    const sztabRestartMatch = pathname.match(/^\/sztab\/restart\/([^/]+)$/u);
    if (request.method === "POST" && sztabRestartMatch) {
      if (!requireDashboardToken(request, response)) return;
      const interval = normalizeSztabInterval(sztabRestartMatch[1]);
      const body = await readBody(request);
      const result = interval
        ? await sztabRunner.restart(interval, body)
        : { ok: false, status: 400, message: "Unsupported Sztab interval." };
      sendJson(response, result.ok ? 200 : result.status ?? 400, result);
      return;
    }

    const sztabSyncMatch = pathname.match(/^\/sztab\/sync\/([^/]+)$/u);
    if (request.method === "POST" && sztabSyncMatch) {
      if (!requireDashboardToken(request, response)) return;
      const interval = normalizeSztabInterval(sztabSyncMatch[1]);
      const result = interval
        ? await sztabRunner.syncInterval(interval)
        : { ok: false, status: 400, message: "Unsupported Sztab interval." };
      sendJson(response, result.ok ? 200 : result.status ?? 400, result);
      return;
    }

    if (request.method === "POST" && pathname === "/sztab/stop-all") {
      if (!requireDashboardToken(request, response)) return;
      sendJson(response, 200, await sztabRunner.stopAll());
      return;
    }

    if (request.method === "POST" && pathname === "/sztab/sync-all") {
      if (!requireDashboardToken(request, response)) return;
      sendJson(response, 200, await sztabRunner.syncAll());
      return;
    }

    if (request.method === "POST" && pathname === "/execution/start") {
      if (!requireDashboardToken(request, response)) return;
      const body = await readBody(request);
      const battleDecks = store.getCollection("battleDecks");
      const battleDeck =
        battleDecks.find((deck) => deck.id === body.battleDeckId) ??
        battleDecks.find((deck) => deck.id === store.getExecutionConfig().activeBattleDeckId);

      if (!battleDeck) {
        sendJson(response, 400, {
          ok: false,
          message: "Choose a Battle Deck before starting the bot.",
        });
        return;
      }

      const sameSlotProfiles = store.getProfiles().filter(
        (profile) =>
          profile.enabled &&
          profile.executionMode === "live" &&
          profile.id !== `battle-${battleDeck.id}` &&
          profile.symbol === battleDeck.symbol &&
          profile.timeframe === battleDeck.timeframe &&
          profile.account?.apiProfile === (battleDeck.apiProfile ?? "main"),
      );

      if (sameSlotProfiles.length > 0 && body.allowConflict !== true) {
        sendJson(response, 409, {
          ok: false,
          message:
            "Another live deck is already assigned to this account, symbol, and timeframe. Use a separate subaccount or confirm advanced conflict mode.",
        });
        return;
      }

      const existingProfile = store
        .getProfiles()
        .find((profile) => profile.id === `battle-${battleDeck.id}`);
      const nextProfile = deckToProfile(battleDeck, existingProfile);
      const profiles = [
        ...store.getProfiles().filter((profile) => profile.id !== nextProfile.id),
        nextProfile,
      ];
      await store.setProfiles(profiles);
      await store.setExecutionConfig({
        activeBattleDeckId: battleDeck.id,
        activeBattleDeckName: battleDeck.name,
        activeProfileId: nextProfile.id,
      });
      await store.appendLog({
        context: { battleDeckId: battleDeck.id, profileId: nextProfile.id },
        message: "Battle Deck sent to live execution",
      });
      await botRunner.armLive();

      if (store.getState().botStatus !== "LIVE_ARMED") {
        sendJson(response, 200, {
          ok: false,
          message: store.getState().lastError || "The bot could not arm live mode yet.",
          status: publicStatusPayload(),
        });
        return;
      }

      const state = await botRunner.startLive({
        confirmed: body.confirm === "START_LIVE" || body.confirmed === true,
      });
      sendJson(response, 200, {
        ok: state.botStatus === "LIVE_RUNNING",
        message:
          state.botStatus === "LIVE_RUNNING"
            ? "Bot is running live."
            : state.lastError || "Live start needs explicit confirmation.",
        status: publicStatusPayload(),
      });
      return;
    }

    if (request.method === "POST" && pathname === "/execution/pause") {
      if (!requireDashboardToken(request, response)) return;
      await botRunner.stopNewEntries(true);
      await store.setState({ botStatus: "PAUSED", lastError: "" });
      await store.appendLog({ context: {}, message: "bot paused by operator" });
      sendJson(response, 200, {
        ok: true,
        message: "Bot paused. No new entries will be opened.",
        status: publicStatusPayload(),
      });
      return;
    }

    if (request.method === "POST" && pathname === "/execution/resume") {
      if (!requireDashboardToken(request, response)) return;
      await botRunner.stopNewEntries(false);
      await botRunner.armLive();
      const state = await botRunner.startLive({ confirmed: true });
      sendJson(response, 200, {
        ok: state.botStatus === "LIVE_RUNNING",
        message:
          state.botStatus === "LIVE_RUNNING"
            ? "Bot resumed."
            : state.lastError || "The bot could not resume yet.",
        status: publicStatusPayload(),
      });
      return;
    }

    if (request.method === "POST" && pathname === "/execution/stop") {
      if (!requireDashboardToken(request, response)) return;
      const state = await botRunner.stop();
      sendJson(response, 200, {
        ok: true,
        message: "Bot stopped. Existing exchange positions are not closed automatically.",
        state,
      });
      return;
    }

    if (request.method === "POST" && pathname === "/execution/emergency-stop") {
      if (!requireDashboardToken(request, response)) return;
      const body = await readBody(request);
      const state = await botRunner.emergencyStop({ closePositions: body.closePositions === true });
      sendJson(response, 200, {
        ok: true,
        message: body.closePositions
          ? "Emergency stop sent and close-position action was requested."
          : "Emergency stop is active. New entries are blocked.",
        state,
      });
      return;
    }

    if (request.method === "POST" && pathname === "/execution/crisis/on") {
      if (!requireDashboardToken(request, response)) return;
      await botRunner.stopNewEntries(true);
      const state = await store.setState({
        botStatus: "CRISIS",
        crisisMode: true,
        lastError: "",
      });
      await store.appendLog({ context: {}, message: "Crisis Management enabled" });
      sendJson(response, 200, {
        ok: true,
        message: "Crisis Management is ON. Manual control has priority.",
        state,
      });
      return;
    }

    if (request.method === "POST" && pathname === "/execution/crisis/off") {
      if (!requireDashboardToken(request, response)) return;
      const state = await store.setState({
        botStatus: "STOPPED",
        crisisMode: false,
        stopNewEntries: false,
      });
      await store.appendLog({ context: {}, message: "Crisis Management disabled" });
      sendJson(response, 200, {
        ok: true,
        message: "Crisis Management is OFF. Start the bot again when ready.",
        state,
      });
      return;
    }

    if (request.method === "POST" && pathname === "/manual/action") {
      if (!requireDashboardToken(request, response)) return;
      const body = await readBody(request);
      try {
        const result = await executeManualAction(body);
        await botRunner.reconcileNow().catch((error) =>
          store.appendLog({
            context: { message: error instanceof Error ? error.message : String(error) },
            message: "manual action reconciliation failed",
          }),
        );
        sendJson(response, result.ok ? 200 : 400, result);
      } catch (error) {
        const diagnostics = error?.bingx ?? null;
        await store.appendLog({
          context: {
            action: body.action,
            diagnostics,
            message: error instanceof Error ? error.message : String(error),
            symbol: body.symbol,
          },
          message: "manual exchange action failed",
        });
        sendJson(response, 502, {
          ok: false,
          message: `BingX rejected the manual action: ${humanBackendError(error)}`,
          diagnostics,
          rawExchangeResponse: diagnostics?.response ?? error?.payload ?? null,
        });
      }
      return;
    }

	    if (request.method === "GET" && pathname === "/ai/status") {
	      sendJson(response, 200, aiService.status());
	      return;
	    }

	    if (request.method === "GET" && pathname === "/ai/context") {
	      sendJson(response, 200, await aiBuildContext(Object.fromEntries(url.searchParams.entries())));
	      return;
	    }

	    if (request.method === "GET" && pathname === "/ai/code-map") {
	      sendJson(response, 200, await buildCodeMap());
	      return;
	    }

	    if (request.method === "GET" && pathname === "/ai/platform-map") {
	      sendJson(response, 200, await aiTools.getPlatformMap());
	      return;
	    }

	    if (request.method === "POST" && pathname === "/ai/platform/search") {
	      const body = await readBody(request);
	      sendJson(response, 200, await aiTools.searchPlatformCode(body));
	      return;
	    }

	    if (request.method === "POST" && pathname === "/ai/platform/trace") {
	      const body = await readBody(request);
	      sendJson(response, 200, await aiTools.traceAction(body));
	      return;
	    }

	    if (request.method === "POST" && pathname === "/ai/platform/state") {
	      const body = await readBody(request);
	      sendJson(response, 200, await aiTools.getRuntimeState(body));
	      return;
	    }

	    if (request.method === "GET" && pathname === "/ai/copilot/memory") {
	      sendJson(response, 200, { memory: copilotMemory.getMemory(), ok: true });
	      return;
	    }

	    if (request.method === "DELETE" && pathname === "/ai/copilot/memory") {
	      sendJson(response, 200, { memory: await copilotMemory.clearMemory(), ok: true });
	      return;
	    }

	    if (request.method === "POST" && pathname === "/ai/copilot/workspace") {
	      const body = await readBody(request);
	      sendJson(response, 200, await aiTools.getCurrentWorkspaceState(body));
	      return;
	    }

	    if (request.method === "POST" && pathname === "/ai/code-snippet") {
	      const body = await readBody(request);
	      sendJson(response, 200, await readSafeCodeSnippet(body));
	      return;
	    }

	    if (request.method === "POST" && pathname === "/ai/chat") {
	      const body = await readBody(request);
	      sendJson(response, 200, await aiService.chat(body));
	      return;
	    }

	    if (request.method === "POST" && pathname === "/ai/agent/run") {
	      const body = await readBody(request);
	      const result = await aiAgent.startRun(body);
	      sendJson(response, result.statusCode ?? 200, result);
	      return;
	    }

	    if (request.method === "POST" && pathname === "/ai/agent/chat") {
	      const body = await readBody(request);
	      const result = await aiAgent.chat(body);
	      sendJson(response, result.statusCode ?? 200, result);
	      return;
	    }

	    if (request.method === "GET" && pathname === "/ai/agent-os/tools") {
	      sendJson(response, 200, aiAgent.agentOSToolCatalog());
	      return;
	    }

	    if (request.method === "GET" && pathname === "/ai/agent/runs") {
	      sendJson(response, 200, aiAgent.listRuns());
	      return;
	    }

	    if (pathname.startsWith("/ai/agent/runs/")) {
	      const parts = pathname.split("/").filter(Boolean);
	      const runId = decodeURIComponent(parts[3] ?? "");

	      if (request.method === "GET" && parts.length === 4) {
	        const result = aiAgent.getRun(runId);
	        sendJson(response, result.statusCode ?? 200, result);
	        return;
	      }

	      if (request.method === "POST" && parts.length === 5 && parts[4] === "cancel") {
	        const result = await aiAgent.cancelRun(runId);
	        sendJson(response, result.statusCode ?? 200, result);
	        return;
	      }

	      if (request.method === "POST" && parts.length === 5 && parts[4] === "rerun") {
	        const body = await readBody(request);
	        const result = await aiAgent.rerunExact(runId, body);
	        sendJson(response, result.statusCode ?? 200, result);
	        return;
	      }

	      if (request.method === "POST" && parts.length === 5 && parts[4] === "verify") {
	        const body = await readBody(request);
	        const result = await aiAgent.verifyIntegrity(runId, body);
	        sendJson(response, result.statusCode ?? 200, result);
	        return;
	      }

	      if (request.method === "POST" && parts.length === 5 && parts[4] === "compare-backtest") {
	        const body = await readBody(request);
	        const result = await aiAgent.compareAgentResultToBacktest(runId, body);
	        sendJson(response, result.statusCode ?? 200, result);
	        return;
	      }

	      if (request.method === "POST" && parts.length === 5 && parts[4] === "restart") {
	        const result = await aiAgent.restartRun(runId);
	        sendJson(response, result.statusCode ?? 200, result);
	        return;
	      }

	      if (request.method === "GET" && parts.length === 5 && parts[4] === "debug") {
	        const result = aiAgent.getRunDebug(runId);
	        sendJson(response, result.statusCode ?? 200, result);
	        return;
	      }

	      if (request.method === "GET" && parts.length === 5 && parts[4] === "artifacts") {
	        const result = aiAgent.getArtifacts(runId);
	        sendJson(response, result.statusCode ?? 200, result);
	        return;
	      }

	      if (request.method === "POST" && parts.length === 5 && parts[4] === "export") {
	        const body = await readBody(request);
	        const result = aiAgent.exportRun(runId, body);
	        sendJson(response, result.statusCode ?? 200, result);
	        return;
	      }
	    }

	    if (request.method === "POST" && pathname === "/ai/tool") {
	      const body = await readBody(request);
	      const toolName = String(body.toolName ?? "");
	      const tool = aiTools[toolName];

	      if (typeof tool !== "function") {
	        sendJson(response, 400, {
	          ok: false,
	          message: "That AI tool is not available.",
	        });
	        return;
	      }

	      sendJson(response, 200, {
	        ok: true,
	        result: await tool(body.input ?? {}),
	        toolName,
	      });
	      return;
	    }

	    if (request.method === "GET" && pathname === "/ai/reports") {
	      sendJson(response, 200, aiMemory.getReports());
	      return;
	    }

	    if (request.method === "GET" && pathname === "/ai/sessions") {
	      sendJson(response, 200, aiMemory.getSessions());
	      return;
	    }

	    if (request.method === "DELETE" && pathname === "/ai/sessions") {
	      sendJson(response, 200, await aiMemory.clearSessions());
	      return;
	    }

	    if (request.method === "POST" && pathname === "/ai/reports/export") {
	      const body = await readBody(request);
	      const report = body.report ?? aiMemory.getReports().find((item) => item.id === body.reportId);

	      if (!report) {
	        sendJson(response, 400, { message: "Choose a report first." });
	        return;
	      }

	      const format = body.format === "csv" ? "csv" : "json";
	      sendJson(response, 200, {
	        content: format === "csv" ? reportToCsv(report) : JSON.stringify(report, null, 2),
	        fileName: `${String(report.name ?? report.title ?? "ai-report").replace(/[^\w.-]+/g, "-")}.${format}`,
	        format,
	        mime: format === "csv" ? "text/csv" : "application/json",
	      });
	      return;
	    }

	    if (request.method === "GET" && pathname === "/ai/alerts") {
	      sendJson(response, 200, aiMemory.getAlertDrafts());
	      return;
	    }

	    if (request.method === "POST" && pathname === "/ai/alerts") {
	      const body = await readBody(request);
	      sendJson(response, 200, await aiTools.createAlertDraft(body));
	      return;
	    }

    if (request.method === "GET" && pathname === "/analytics") {
      sendJson(response, 200, {
        records: store.getCollection("analytics"),
        summary: calculateAnalytics(store.getTrades()),
        trades: store.getTrades(),
      });
      return;
    }

    if (request.method === "GET" && pathname === "/communication/settings") {
      sendJson(response, 200, safePublicCommunication(store.getCollection("communication")));
      return;
    }

    if (request.method === "PUT" && pathname === "/communication/settings") {
      const body = await readBody(request);
      const current = store.getCollection("communication");
      const nextSettings = {
        ...current,
        ...body,
        telegramBotToken:
          body.telegramBotToken || current.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || "",
        telegramBotTokenConfigured: Boolean(
          body.telegramBotToken || current.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN,
        ),
        updatedAt: new Date().toISOString(),
      };
      await store.setCollection("communication", nextSettings);
      sendJson(response, 200, safePublicCommunication(nextSettings));
      return;
    }

    if (request.method === "POST" && pathname === "/communication/test") {
      const current = store.getCollection("communication");
      const result = await sendTelegramTest(current);
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }

    if (request.method === "POST" && pathname === "/backtests/run") {
      const body = await readBody(request);
      if (!body.name) {
        sendJson(response, 400, { message: "Name this backtest before saving it." });
        return;
      }

      const saved = await store.upsertCollectionItem("backtests", {
        ...body,
        source: "browser-loaded-candles",
      });
      sendJson(response, 200, saved);
      return;
    }

    if (
      Object.keys(COLLECTION_ROUTES).some(
        (route) => pathname === route || pathname.startsWith(`${route}/`),
      )
    ) {
      const body = ["POST", "PUT"].includes(request.method) ? await readBody(request) : {};
      if (await handleCollectionRoute({ body, method: request.method, pathname, response })) {
        return;
      }
    }

    if (request.method === "GET" && pathname === "/profiles") {
      sendJson(response, 200, store.getProfiles());
      return;
    }

    if (request.method === "POST" && pathname === "/profiles") {
      const body = await readBody(request);
      sendJson(response, 200, await store.setProfiles(body.profiles ?? body));
      return;
    }

    if (request.method === "POST" && pathname === "/bot/start") {
      sendJson(response, 400, {
        ok: false,
        message: "Paper trading is not part of the live control center. Create a Battle Deck and use Start Bot.",
      });
      return;
    }

    if (request.method === "POST" && pathname === "/bot/live/arm") {
      if (!requireDashboardToken(request, response)) return;
      sendJson(response, 200, await botRunner.armLive());
      return;
    }

    if (request.method === "POST" && pathname === "/bot/live/start") {
      if (!requireDashboardToken(request, response)) return;
      const body = await readBody(request);
      sendJson(response, 200, await botRunner.startLive({ confirmed: body.confirm === "START_LIVE" }));
      return;
    }

    if (request.method === "POST" && pathname === "/bot/emergency-stop") {
      if (!requireDashboardToken(request, response)) return;
      const body = await readBody(request);
      sendJson(response, 200, await botRunner.emergencyStop({ closePositions: body.closePositions === true }));
      return;
    }

    if (request.method === "POST" && pathname === "/bot/reconcile") {
      if (!requireDashboardToken(request, response)) return;
      sendJson(response, 200, await botRunner.reconcileNow());
      return;
    }

    if (request.method === "POST" && pathname === "/bot/confirm-resume") {
      if (!requireDashboardToken(request, response)) return;
      sendJson(response, 200, await botRunner.confirmResumeAfterReconciliation());
      return;
    }

    if (request.method === "POST" && pathname === "/bot/stop-new-entries") {
      if (!requireDashboardToken(request, response)) return;
      const body = await readBody(request);
      sendJson(response, 200, await botRunner.stopNewEntries(body.enabled !== false));
      return;
    }

    if (request.method === "POST" && pathname === "/paper/close-all") {
      sendJson(response, 400, {
        ok: false,
        message: "Paper controls are no longer exposed in the operator UI.",
      });
      return;
    }

    if (request.method === "POST" && pathname === "/bot/stop") {
      sendJson(response, 200, await botRunner.stop());
      return;
    }

    if (request.method === "GET" && pathname === "/trades") {
      sendJson(response, 200, store.getTrades());
      return;
    }

    if (request.method === "GET" && pathname === "/logs") {
      sendJson(response, 200, store.getLogs());
      return;
    }

    if (request.method === "GET" && pathname === "/orders") {
      sendJson(response, 200, store.getOrders());
      return;
    }

    if (request.method === "GET" && pathname === "/config/export") {
      sendJson(response, 200, {
        executionConfig: store.getExecutionConfig(),
        profiles: store.getProfiles(),
        state: store.getState(),
      });
      return;
    }

    if (request.method === "GET" && pathname === "/state") {
      sendJson(response, 200, store.getState());
      return;
    }

    if ((request.method === "GET" || request.method === "POST") && pathname === "/bingx/test") {
      sendJson(response, 200, await runBingxConnectionTest());
      return;
    }

    sendJson(response, 404, {
      error: "Not found",
      message: "This platform service is not available on the backend yet.",
    });
  } catch (error) {
    await store.appendLog({
      context: { message: error instanceof Error ? error.message : String(error) },
      message: "error",
    });
    sendJson(response, 500, { error: error instanceof Error ? error.message : "Server error" });
  }
});

server.listen(PORT, () => {
  logRuntimeEvent("startup", {
    maxMemoryRestart: process.env.max_memory_restart ?? process.env.PM2_MAX_MEMORY_RESTART ?? "configured-by-pm2",
    port: PORT,
  });
  console.log(`Choromański Trading Platform backend listening on http://127.0.0.1:${PORT}`);
});

import http from "node:http";
import "dotenv/config";
import { createBotRunner } from "./botRunner.js";
import { createBingxClient } from "./exchanges/bingxClient.js";
import { reconcileBingxState } from "./execution/reconciliation.js";
import { createStateStore } from "./state/store.js";
import { fetchCandles } from "./strategy/strategyRunner.js";

const PORT = Number(process.env.PORT || 8787);
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || "";
const store = await createStateStore();
const bingxClient = createBingxClient();
await store.setState({
  bingx: {
    apiConfigured: bingxClient.auth.configured,
  },
  runtime: {
    mode: process.env.NODE_ENV ?? "development",
    processManager: process.env.pm_id !== undefined ? "pm2" : "node",
    startedAt: new Date().toISOString(),
  },
});
const botRunner = createBotRunner({ bingxClient, store });

const TIMEFRAMES = [
  { label: "10m", interval: "10m", minutes: 10, maxCandles: 3000 },
  { label: "15m", interval: "15m", minutes: 15, maxCandles: 3000 },
  { label: "20m", interval: "20m", minutes: 20, maxCandles: 3000 },
  { label: "30m", interval: "30m", minutes: 30, maxCandles: 3000 },
  { label: "1H", interval: "1h", minutes: 60, maxCandles: 3000 },
  { label: "4H", interval: "4h", minutes: 240, maxCandles: 2000 },
];

const COLLECTION_ROUTES = {
  "/decks/strategy": { name: "strategyDecks", limit: 100 },
  "/decks/mm": { name: "mmDecks", limit: 100 },
  "/decks/battle": { name: "battleDecks", limit: 100 },
  "/favorites": { name: "favorites", limit: 500 },
  "/backtests": { name: "backtests", limit: 200 },
};

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
  const rows = [];

  for (const timeframe of TIMEFRAMES) {
    try {
      const candles = await fetchCandles({
        limit: timeframe.maxCandles,
        symbol: "SOLUSDT",
        timeframe: timeframe.interval,
      });
      const first = candles[0];
      const last = candles.at(-1);
      const availableDays = candles.length * timeframe.minutes / 1440;
      rows.push({
        ...timeframe,
        availableDays,
        candles: candles.length,
        firstCandleTime: first?.time ?? null,
        lastCandleTime: last?.time ?? null,
        note: `${timeframe.label} has ${candles.length} candles available, which is about ${Math.floor(availableDays)} days. If you request more, the platform will use the maximum available ${Math.floor(availableDays)} days.`,
        ok: true,
      });
    } catch (error) {
      rows.push({
        ...timeframe,
        availableDays: 0,
        candles: 0,
        error: error instanceof Error ? error.message : String(error),
        ok: false,
      });
    }
  }

  return rows;
}

function deckToProfile(battleDeck, existingProfile = {}) {
  const strategy = battleDeck.strategySnapshot ?? {};
  const mm = battleDeck.mmSnapshot ?? {};
  const timeframe = battleDeck.timeframe ?? strategy.timeframe ?? "15m";
  const symbol = battleDeck.symbol ?? strategy.symbol ?? "SOLUSDT";

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
          : strategy.atrPositionSizing === false
            ? "percent-move"
            : "risk-based",
      priceMoveRiskPercent: Number(mm.onePercentMovePercent ?? 1),
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

function positionAmount(position) {
  return Math.abs(Number(position.positionAmt ?? position.positionAmount ?? position.quantity ?? position.availableAmt ?? 0));
}

function positionSide(position) {
  const side = String(position.positionSide ?? position.side ?? "").toUpperCase();
  if (side.includes("SHORT")) return "SHORT";
  if (side.includes("LONG")) return "LONG";
  return Number(position.positionAmt ?? position.positionAmount ?? 0) < 0 ? "SHORT" : "LONG";
}

async function executeManualAction(body) {
  const state = store.getState();

  if (!bingxClient.auth.configured) {
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

  if (["MARKET_LONG", "MARKET_SHORT"].includes(action)) {
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { ok: false, message: "Enter a valid order quantity first." };
    }
    result = await bingxClient.placeMarketOrder(symbol, action === "MARKET_LONG" ? "BUY" : "SELL", quantity);
  } else if (action === "CLOSE_POSITION") {
    result = await bingxClient.closePosition(symbol);
  } else if (action === "CANCEL_ALL") {
    result = await bingxClient.cancelOpenOrders(symbol);
  } else if (["MOVE_SL", "MOVE_TP"].includes(action)) {
    const positions = normalizeExchangeList(await bingxClient.getOpenPositions(symbol)).filter(
      (position) => compactSymbol(position.symbol) === compactSymbol(symbol) && positionAmount(position) > 0,
    );
    const position = positions[0];

    if (!position) {
      return { ok: false, message: "No open position found on BingX for this symbol." };
    }

    const side = positionSide(position) === "LONG" ? "BUY" : "SELL";
    const inferredQuantity = positionAmount(position);

    if (action === "MOVE_SL") {
      if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
        return { ok: false, message: "Enter a valid SL price first." };
      }
      result = await bingxClient.placeStopLoss(symbol, side, stopPrice, inferredQuantity);
    } else {
      if (!Number.isFinite(takeProfitPrice) || takeProfitPrice <= 0) {
        return { ok: false, message: "Enter a valid TP price first." };
      }
      result = await bingxClient.placeTakeProfit(symbol, side, takeProfitPrice, inferredQuantity);
    }
  } else {
    return { ok: false, message: "Choose a manual action first." };
  }

  await store.appendLog({
    context: { action, result, symbol },
    message: "manual exchange action sent",
  });

  return {
    action,
    ok: true,
    message: "Manual exchange action sent.",
    result,
    symbol,
  };
}

async function handleCollectionRoute({ body, method, pathname, response }) {
  for (const [basePath, config] of Object.entries(COLLECTION_ROUTES)) {
    if (pathname === basePath && method === "GET") {
      sendJson(response, 200, store.getCollection(config.name));
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

      sendJson(response, 200, await store.upsertCollectionItem(config.name, body));
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

      sendJson(response, 200, await store.upsertCollectionItem(config.name, { ...body, id }));
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

    if (request.method === "GET" && pathname === "/execution/status") {
      sendJson(response, 200, publicStatusPayload());
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
      const result = await executeManualAction(body);
      await botRunner.reconcileNow().catch((error) =>
        store.appendLog({
          context: { message: error instanceof Error ? error.message : String(error) },
          message: "manual action reconciliation failed",
        }),
      );
      sendJson(response, result.ok ? 200 : 400, result);
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
  console.log(`Choromański Trading Platform backend listening on http://127.0.0.1:${PORT}`);
});

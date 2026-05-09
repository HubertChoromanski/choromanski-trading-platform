import http from "node:http";
import "dotenv/config";
import { createBotRunner } from "./botRunner.js";
import { createBingxClient } from "./exchanges/bingxClient.js";
import { reconcileBingxState } from "./execution/reconciliation.js";
import { createStateStore } from "./state/store.js";

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
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
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

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true, service: "choromanski-trading-backend" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/status") {
      sendJson(response, 200, {
        logs: store.getLogs().slice(-80),
        orders: store.getOrders().slice(-80),
        profiles: store.getProfiles(),
        state: {
          ...store.getState(),
          bingx: {
            ...store.getState().bingx,
            apiConfigured: bingxClient.auth.configured,
          },
        },
        trades: store.getTrades().slice(-80),
        equity: store.getEquity().slice(-200),
        executionConfig: store.getExecutionConfig(),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/profiles") {
      sendJson(response, 200, store.getProfiles());
      return;
    }

    if (request.method === "POST" && url.pathname === "/profiles") {
      const body = await readBody(request);
      sendJson(response, 200, await store.setProfiles(body.profiles ?? body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/bot/start") {
      sendJson(response, 200, await botRunner.startPaper());
      return;
    }

    if (request.method === "POST" && url.pathname === "/bot/live/arm") {
      if (!requireDashboardToken(request, response)) return;
      sendJson(response, 200, await botRunner.armLive());
      return;
    }

    if (request.method === "POST" && url.pathname === "/bot/live/start") {
      if (!requireDashboardToken(request, response)) return;
      const body = await readBody(request);
      sendJson(response, 200, await botRunner.startLive({ confirmed: body.confirm === "START_LIVE" }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/bot/emergency-stop") {
      if (!requireDashboardToken(request, response)) return;
      const body = await readBody(request);
      sendJson(response, 200, await botRunner.emergencyStop({ closePositions: body.closePositions === true }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/bot/reconcile") {
      if (!requireDashboardToken(request, response)) return;
      sendJson(response, 200, await botRunner.reconcileNow());
      return;
    }

    if (request.method === "POST" && url.pathname === "/bot/confirm-resume") {
      if (!requireDashboardToken(request, response)) return;
      sendJson(response, 200, await botRunner.confirmResumeAfterReconciliation());
      return;
    }

    if (request.method === "POST" && url.pathname === "/bot/stop-new-entries") {
      if (!requireDashboardToken(request, response)) return;
      const body = await readBody(request);
      sendJson(response, 200, await botRunner.stopNewEntries(body.enabled !== false));
      return;
    }

    if (request.method === "POST" && url.pathname === "/paper/close-all") {
      const profiles = store.getProfiles().map((profile) => ({
        ...profile,
        paper: {
          ...profile.paper,
          openPosition: null,
        },
      }));
      await store.setProfiles(profiles);
      await store.appendLog({ context: {}, message: "paper positions closed by operator" });
      sendJson(response, 200, { ok: true, profiles });
      return;
    }

    if (request.method === "POST" && url.pathname === "/bot/stop") {
      sendJson(response, 200, await botRunner.stop());
      return;
    }

    if (request.method === "GET" && url.pathname === "/trades") {
      sendJson(response, 200, store.getTrades());
      return;
    }

    if (request.method === "GET" && url.pathname === "/logs") {
      sendJson(response, 200, store.getLogs());
      return;
    }

    if (request.method === "GET" && url.pathname === "/orders") {
      sendJson(response, 200, store.getOrders());
      return;
    }

    if (request.method === "GET" && url.pathname === "/config/export") {
      sendJson(response, 200, {
        executionConfig: store.getExecutionConfig(),
        profiles: store.getProfiles(),
        state: store.getState(),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/state") {
      sendJson(response, 200, store.getState());
      return;
    }

    if ((request.method === "GET" || request.method === "POST") && url.pathname === "/bingx/test") {
      sendJson(response, 200, await runBingxConnectionTest());
      return;
    }

    sendJson(response, 404, { error: "Not found" });
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

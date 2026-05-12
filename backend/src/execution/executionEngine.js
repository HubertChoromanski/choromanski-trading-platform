import { STRATEGY_EVENT_TYPES } from "../../../hubert-platform/frontend/src/engine/strategyEngine.js";
import { validateOrder } from "../risk/riskManager.js";
import {
  calculatePaperPositionSize,
  closePaperPosition,
  createPaperPosition,
} from "./paperBroker.js";

export async function processProfileExecution({ logger, profile, strategyResult, store }) {
  const stateProfiles = store.getProfiles();
  const profileIndex = stateProfiles.findIndex((item) => item.id === profile.id);

  if (profileIndex < 0 || !profile.enabled) {
    return profile;
  }

  const latestCandle = strategyResult.sourceCandles.at(-1);
  const events = strategyResult.strategy.events;
  let updatedProfile = structuredClone(profile);
  const mode = updatedProfile.executionMode === "live" ? "live" : "paper";
  const accountState = updatedProfile[mode];
  const openPosition = accountState.openPosition;
  const exitEvent = openPosition
    ? events.find(
        (event) =>
          event.type === STRATEGY_EVENT_TYPES.POSITION_EXITED &&
          event.setupId === openPosition.setupId,
      )
    : null;

  if (openPosition && exitEvent) {
    const closed = closePaperPosition({ candle: latestCandle, event: exitEvent, position: openPosition });
    const trade = {
      id: `${openPosition.setupId}-${exitEvent.time}`,
      direction: openPosition.direction,
      entryPrice: openPosition.entryPrice,
      entryTime: openPosition.entryTime,
      exitPrice: closed.exitPrice,
      exitReason: exitEvent.exitReason ?? "EXIT",
      exitTime: exitEvent.time,
      pnl: closed.pnl,
      profileId: profile.id,
      symbol: profile.symbol,
    };
    updatedProfile.paper = {
      ...updatedProfile.paper,
      equity: updatedProfile.paper.equity + closed.pnl,
      openPosition: null,
      realizedPnl: updatedProfile.paper.realizedPnl + closed.pnl,
      tradesToday: updatedProfile.paper.tradesToday + 1,
    };
    await store.upsertTrade(trade);
    await store.appendEquity({
      equity: updatedProfile.paper.equity,
      mode: "paper",
      profileId: profile.id,
    });
    await logger("trade closed", { profileId: profile.id, setupId: openPosition.setupId, pnl: closed.pnl });
  }

  const entryEvent = strategyResult.latestEvent;

  if (
    !entryEvent ||
    accountState.openPosition?.setupId === entryEvent.setupId ||
    accountState.lastProcessedSetupId === entryEvent.setupId
  ) {
    return updatedProfile;
  }

  await logger("signal received", {
    direction: entryEvent.direction,
    profileId: profile.id,
    setupId: entryEvent.setupId,
  });

  const sizing = calculatePaperPositionSize({
    entryPrice: entryEvent.trigger,
    equity: updatedProfile.paper.equity,
    risk: updatedProfile.risk,
    stopLoss: entryEvent.stopLoss,
  });
  await logger("position size calculated", {
    notionalSize: sizing.notionalSize,
    profileId: profile.id,
    riskAmount: sizing.riskAmount,
  });

  const order = {
    ...sizing,
    direction: entryEvent.direction,
    entryPrice: entryEvent.trigger,
    stopLoss: entryEvent.stopLoss,
  };
  const risk = validateOrder({
    dailyLoss: 0,
    openPosition: accountState.openPosition,
    order,
    profile: updatedProfile,
    tradesToday: updatedProfile.paper.tradesToday,
  });

  if (!risk.allowed) {
    await logger("risk blocked", { profileId: profile.id, reason: risk.reason });
    return updatedProfile;
  }

  updatedProfile.paper.openPosition = createPaperPosition({ entryEvent, order });
  updatedProfile.paper.lastProcessedSetupId = entryEvent.setupId;
  await logger("trade opened", {
    direction: entryEvent.direction,
    entryPrice: entryEvent.trigger,
    profileId: profile.id,
    setupId: entryEvent.setupId,
  });
  await logger("SL set", {
    profileId: profile.id,
    setupId: entryEvent.setupId,
    stopLoss: entryEvent.stopLoss,
  });

  return updatedProfile;
}

export async function processLiveProfileExecution({
  bingxClient,
  logger,
  profile,
  strategyResult,
  store,
}) {
  if (!profile.enabled || profile.executionMode !== "live") {
    return profile;
  }

  const latestCandle = strategyResult.sourceCandles.at(-1);
  const events = strategyResult.strategy.events;
  let updatedProfile = structuredClone(profile);
  const openPosition = updatedProfile.live?.openPosition;
  const exitEvent = openPosition
    ? events.find(
        (event) =>
          event.type === STRATEGY_EVENT_TYPES.POSITION_EXITED &&
          event.setupId === openPosition.setupId,
      )
    : null;

  if (openPosition && exitEvent) {
    await bingxClient.closePosition(profile.symbol);
    await bingxClient.cancelOpenOrders(profile.symbol);
    const closed = closePaperPosition({ candle: latestCandle, event: exitEvent, position: openPosition });
    const trade = {
      id: `live-${openPosition.setupId}-${exitEvent.time}`,
      direction: openPosition.direction,
      entryPrice: openPosition.entryPrice,
      entryTime: openPosition.entryTime,
      exitPrice: closed.exitPrice,
      exitReason: exitEvent.exitReason ?? "OPPOSITE_SIGNAL",
      exitTime: exitEvent.time,
      mode: "live",
      pnl: closed.pnl,
      profileId: profile.id,
      symbol: profile.symbol,
    };
    updatedProfile.live.openPosition = null;
    await store.upsertTrade(trade);
    await logger("position closed", { mode: "live", profileId: profile.id, setupId: openPosition.setupId });
  }

  const entryEvent = strategyResult.latestEvent;

  if (
    !entryEvent ||
    updatedProfile.live?.openPosition?.setupId === entryEvent.setupId ||
    updatedProfile.live?.lastProcessedSetupId === entryEvent.setupId
  ) {
    return updatedProfile;
  }

  await logger("signal received", {
    direction: entryEvent.direction,
    mode: "live",
    profileId: profile.id,
    setupId: entryEvent.setupId,
  });

  const balancePayload = await bingxClient.getPerpetualFuturesBalance();
  const availableBalance = getAvailableBalance(balancePayload);
  const sizing = calculatePaperPositionSize({
    entryPrice: entryEvent.trigger,
    equity: availableBalance,
    risk: updatedProfile.risk,
    stopLoss: entryEvent.stopLoss,
  });
  const quantity = Number(sizing.quantity.toFixed(3));
  await logger("size calculated", {
    marginRequired: sizing.marginRequired,
    mode: "live",
    notionalSize: sizing.notionalSize,
    profileId: profile.id,
    quantity,
    riskAmount: sizing.riskAmount,
  });

  const order = {
    ...sizing,
    direction: entryEvent.direction,
    entryPrice: entryEvent.trigger,
    quantity,
    stopLoss: entryEvent.stopLoss,
    takeProfit: calculateTakeProfit({
      direction: entryEvent.direction,
      entryPrice: entryEvent.trigger,
      rr: updatedProfile.risk.takeProfitRr,
      stopLoss: entryEvent.stopLoss,
    }),
  };
  const risk = validateOrder({
    apiConfigured: bingxClient.auth.configured,
    availableBalance,
    liveModeEnabled: profile.liveModeEnabled === true || store.getState().botStatus === "LIVE_RUNNING",
    openPosition: updatedProfile.live?.openPosition,
    order,
    profile: updatedProfile,
    tradesToday: updatedProfile.paper.tradesToday,
  });

  if (!risk.allowed) {
    await logger("risk blocked", { mode: "live", profileId: profile.id, reason: risk.reason });
    return updatedProfile;
  }

  await logger("risk approved", { mode: "live", profileId: profile.id, setupId: entryEvent.setupId });
  const side = entryEvent.direction === "LONG" ? "BUY" : "SELL";
  await bingxClient.setMarginMode(profile.symbol, updatedProfile.risk.marginMode ?? "isolated");
  await bingxClient.setLeverage(profile.symbol, sizing.leverage, "LONG");
  await bingxClient.setLeverage(profile.symbol, sizing.leverage, "SHORT");
  const marketOrder = await bingxClient.placeMarketOrder(profile.symbol, side, quantity);
  await logger("order sent", { mode: "live", order: marketOrder, profileId: profile.id });
  await store.upsertOrder({
    id: String(marketOrder.orderId ?? marketOrder.order?.orderId ?? `${entryEvent.setupId}-market`),
    mode: "live",
    profileId: profile.id,
    raw: marketOrder,
    setupId: entryEvent.setupId,
    side,
    status: "SENT",
    symbol: profile.symbol,
    type: "MARKET",
  });

  try {
    const stopOrder = await bingxClient.placeStopLoss(
      profile.symbol,
      side,
      entryEvent.stopLoss,
      quantity,
    );
    await logger("SL placed", { mode: "live", order: stopOrder, profileId: profile.id });
    await store.upsertOrder({
      id: String(stopOrder.orderId ?? stopOrder.order?.orderId ?? `${entryEvent.setupId}-sl`),
      mode: "live",
      profileId: profile.id,
      raw: stopOrder,
      setupId: entryEvent.setupId,
      side: side === "BUY" ? "SELL" : "BUY",
      status: "SENT",
      symbol: profile.symbol,
      type: "STOP_MARKET",
    });
    const takeProfitOrder = order.takeProfit
      ? await bingxClient.placeTakeProfit(profile.symbol, side, order.takeProfit, quantity)
      : null;

    if (takeProfitOrder) {
      await logger("TP placed", { mode: "live", order: takeProfitOrder, profileId: profile.id });
      await store.upsertOrder({
        id: String(takeProfitOrder.orderId ?? takeProfitOrder.order?.orderId ?? `${entryEvent.setupId}-tp`),
        mode: "live",
        profileId: profile.id,
        raw: takeProfitOrder,
        setupId: entryEvent.setupId,
        side: side === "BUY" ? "SELL" : "BUY",
        status: "SENT",
        symbol: profile.symbol,
        type: "TAKE_PROFIT_MARKET",
      });
    }

    updatedProfile.live.openPosition = createPaperPosition({ entryEvent, order });
    updatedProfile.live.lastProcessedSetupId = entryEvent.setupId;
    updatedProfile.live.orderLog = [
      ...(updatedProfile.live.orderLog ?? []),
      { marketOrder, stopOrder, takeProfitOrder, time: new Date().toISOString() },
    ];
  } catch (error) {
    await logger("SL failed", {
      message: error instanceof Error ? error.message : String(error),
      mode: "live",
      profileId: profile.id,
    });
    await bingxClient.closePosition(profile.symbol);
    await store.setState({
      botStatus: "ERROR",
      lastError: "Stop loss placement failed. Position close was requested.",
    });
    throw error;
  }

  return updatedProfile;
}

function calculateTakeProfit({ direction, entryPrice, rr = 2, stopLoss }) {
  const riskDistance = Math.abs(entryPrice - stopLoss);

  if (!Number.isFinite(rr) || rr <= 0 || !Number.isFinite(riskDistance) || riskDistance <= 0) {
    return null;
  }

  return direction === "LONG"
    ? entryPrice + riskDistance * rr
    : entryPrice - riskDistance * rr;
}

function getAvailableBalance(payload) {
  const balance = Array.isArray(payload) ? payload[0] : payload?.balance ?? payload;
  return Number(
    balance?.availableMargin ??
      balance?.availableBalance ??
      balance?.available ??
      balance?.balance ??
      0,
  );
}

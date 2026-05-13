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
  updatedProfile.live = {
    lastProcessedSetupId: null,
    openPosition: null,
    orderLog: [],
    setupOrderJournal: [],
    ...(updatedProfile.live ?? {}),
  };
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

  updatedProfile = await syncPendingTriggerFill({
    bingxClient,
    logger,
    profile: updatedProfile,
    store,
  });

  if (updatedProfile.live?.openPosition) {
    return updatedProfile;
  }

  const activeSetupEvent = setupEventForTriggerOrder(strategyResult);
  const pendingTriggerOrder = activePendingTriggerOrder(updatedProfile.live?.pendingTriggerOrder);

  if (!activeSetupEvent) {
    return updatedProfile;
  }

  if (updatedProfile.live?.lastProcessedSetupId === activeSetupEvent.setupId) {
    return updatedProfile;
  }

  if (
    updatedProfile.live?.pendingTriggerOrder?.setupId === activeSetupEvent.setupId &&
    nonRetryPendingStatuses().includes(String(updatedProfile.live.pendingTriggerOrder.status ?? "").toLowerCase())
  ) {
    return updatedProfile;
  }

  if (pendingTriggerOrder?.setupId === activeSetupEvent.setupId) {
    await logger("trigger order already armed", {
      mode: "live",
      orderId: pendingTriggerOrder.orderId,
      profileId: profile.id,
      setupId: activeSetupEvent.setupId,
    });
    return updatedProfile;
  }

  if (pendingTriggerOrder && pendingTriggerOrder.setupId !== activeSetupEvent.setupId) {
    updatedProfile = await cancelLivePendingTriggerOrder({
      bingxClient,
      logger,
      profile: updatedProfile,
      reason: "new_setup_replaced_pending_trigger",
      supersededBySetupId: activeSetupEvent.setupId,
    });
  }

  await logger("setup received; arming trigger-market order", {
    direction: activeSetupEvent.direction,
    mode: "live",
    profileId: profile.id,
    setupId: activeSetupEvent.setupId,
    trigger: activeSetupEvent.trigger,
  });

  const balancePayload = await bingxClient.getPerpetualFuturesBalance();
  const availableBalance = getAvailableBalance(balancePayload);
  const startingBalance = Number(updatedProfile.risk?.startingBalance);
  updatedProfile.risk = {
    ...(updatedProfile.risk ?? {}),
    startingBalance: Number.isFinite(startingBalance) && startingBalance > 0
      ? startingBalance
      : availableBalance,
  };
  const sizing = calculatePaperPositionSize({
    entryPrice: activeSetupEvent.trigger,
    equity: availableBalance,
    risk: updatedProfile.risk,
    stopLoss: activeSetupEvent.stopLoss,
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
    direction: activeSetupEvent.direction,
    entryPrice: activeSetupEvent.trigger,
    quantity,
    stopLoss: activeSetupEvent.stopLoss,
    takeProfit: calculateTakeProfit({
      direction: activeSetupEvent.direction,
      entryPrice: activeSetupEvent.trigger,
      rr: updatedProfile.risk.takeProfitRr,
      stopLoss: activeSetupEvent.stopLoss,
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
    updatedProfile.live.pendingTriggerOrder = {
      direction: activeSetupEvent.direction,
      orderLifecycle: [{
        message: `Risk blocked: ${risk.reason}`,
        status: "risk_blocked",
        time: new Date().toISOString(),
      }],
      quantity,
      risk,
      setupId: activeSetupEvent.setupId,
      side: sideForDirection(activeSetupEvent.direction),
      status: "risk_blocked",
      stopLoss: activeSetupEvent.stopLoss,
      triggerPrice: activeSetupEvent.trigger,
      updatedAt: new Date().toISOString(),
    };
    appendSetupOrderJournal(updatedProfile, {
      event: "risk_blocked",
      interval: updatedProfile.timeframe,
      reason: risk.reason,
      setupId: activeSetupEvent.setupId,
      side: sideForDirection(activeSetupEvent.direction),
      triggerPrice: activeSetupEvent.trigger,
      quantity,
    });
    await logger("risk blocked", { mode: "live", profileId: profile.id, reason: risk.reason });
    return updatedProfile;
  }

  await logger("risk approved; placing trigger-market entry order", {
    mode: "live",
    profileId: profile.id,
    setupId: activeSetupEvent.setupId,
  });
  const side = sideForDirection(activeSetupEvent.direction);
  const positionSide = activeSetupEvent.direction === "LONG" ? "LONG" : "SHORT";
  await bingxClient.setMarginMode(profile.symbol, updatedProfile.risk.marginMode ?? "isolated");
  await bingxClient.setLeverage(profile.symbol, sizing.leverage, "LONG");
  await bingxClient.setLeverage(profile.symbol, sizing.leverage, "SHORT");

  try {
    const triggerOrder = await bingxClient.placeTriggerMarketOrder(
      profile.symbol,
      side,
      activeSetupEvent.trigger,
      quantity,
      {
        positionSide,
        workingType: "MARK_PRICE",
      },
    );
    const triggerOrderId = resultOrderId(triggerOrder) ?? `${activeSetupEvent.setupId}-trigger`;
    await logger("trigger-market order sent", { mode: "live", order: triggerOrder, profileId: profile.id });
    await store.upsertOrder({
      id: String(triggerOrderId),
      mode: "live",
      profileId: profile.id,
      raw: triggerOrder,
      setupId: activeSetupEvent.setupId,
      side,
      status: "SENT",
      symbol: profile.symbol,
      type: "TRIGGER_MARKET",
    });

    updatedProfile.live.pendingTriggerOrder = {
      acceptedAt: new Date().toISOString(),
      direction: activeSetupEvent.direction,
      entryEvent: activeSetupEvent,
      exchangeResponse: triggerOrder,
      order,
      orderId: triggerOrderId,
      orderLifecycle: [{
        exchangeResponse: triggerOrder,
        message: "Exchange accepted trigger-market entry order.",
        status: "accepted",
        time: new Date().toISOString(),
      }],
      positionSide,
      quantity,
      risk,
      setupId: activeSetupEvent.setupId,
      side,
      status: "accepted",
      stopLoss: activeSetupEvent.stopLoss,
      takeProfit: order.takeProfit,
      triggerPrice: activeSetupEvent.trigger,
      updatedAt: new Date().toISOString(),
      workingType: "MARK_PRICE",
    };
    appendSetupOrderJournal(updatedProfile, {
      event: "order_accepted",
      exchangeResponseSummary: summarizeExchangeResponse(triggerOrder),
      interval: updatedProfile.timeframe,
      orderAccepted: true,
      orderId: triggerOrderId,
      quantity,
      setupId: activeSetupEvent.setupId,
      side,
      status: "accepted",
      triggerPrice: activeSetupEvent.trigger,
    });
    updatedProfile.live.orderLog = [
      ...(updatedProfile.live.orderLog ?? []),
      { setup: activeSetupEvent, triggerOrder, time: new Date().toISOString() },
    ];
  } catch (error) {
    updatedProfile.live.pendingTriggerOrder = {
      direction: activeSetupEvent.direction,
      error: error instanceof Error ? error.message : String(error),
      exchangeResponse: error?.bingx ?? null,
      orderLifecycle: [{
        exchangeResponse: error?.bingx ?? null,
        message: error instanceof Error ? error.message : String(error),
        status: "trigger_order_rejected",
        time: new Date().toISOString(),
      }],
      quantity,
      risk,
      setupId: activeSetupEvent.setupId,
      side,
      status: "trigger_order_rejected",
      stopLoss: activeSetupEvent.stopLoss,
      triggerPrice: activeSetupEvent.trigger,
      updatedAt: new Date().toISOString(),
    };
    appendSetupOrderJournal(updatedProfile, {
      event: "order_rejected",
      exchangeResponseSummary: summarizeExchangeResponse(error?.bingx ?? null),
      failureClassification: "trigger_order_rejected_exchange",
      interval: updatedProfile.timeframe,
      orderAccepted: false,
      quantity,
      reason: error instanceof Error ? error.message : String(error),
      setupId: activeSetupEvent.setupId,
      side,
      status: "trigger_order_rejected",
      triggerPrice: activeSetupEvent.trigger,
    });
    await logger("trigger-market order rejected", {
      message: error instanceof Error ? error.message : String(error),
      mode: "live",
      profileId: profile.id,
      setupId: activeSetupEvent.setupId,
    });
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

function setupEventForTriggerOrder(strategyResult) {
  const setupEvent = strategyResult.latestSetupEvent;

  if (
    !setupEvent ||
    ![STRATEGY_EVENT_TYPES.SETUP_ACTIVE, STRATEGY_EVENT_TYPES.BENCHMARK_CONFIRMED].includes(setupEvent.type) ||
    !Number.isFinite(Number(setupEvent.trigger)) ||
    !Number.isFinite(Number(setupEvent.stopLoss))
  ) {
    return null;
  }

  const alreadyTriggered = (strategyResult.strategy?.events ?? []).some(
    (event) =>
      event.type === STRATEGY_EVENT_TYPES.ENTRY_TRIGGERED &&
      event.setupId === setupEvent.setupId,
  );

  return alreadyTriggered ? null : setupEvent;
}

function activePendingTriggerOrder(order) {
  if (!order) return null;
  return ["accepted", "placed", "new", "partially_filled"].includes(String(order.status ?? "").toLowerCase())
    ? order
    : null;
}

function nonRetryPendingStatuses() {
  return [
    "canceled",
    "cancelled",
    "cancel_failed",
    "expired",
    "filled_but_position_missing",
    "missing",
    "rejected",
    "risk_blocked",
    "terminal_canceled",
    "terminal_cancelled",
    "terminal_expired",
    "terminal_failed",
    "terminal_rejected",
    "trigger_order_rejected",
  ];
}

function sideForDirection(direction) {
  return direction === "LONG" ? "BUY" : "SELL";
}

function closeSideForPositionSide(positionSide) {
  return positionSideFromPosition(positionSide) === "LONG" ? "SELL" : "BUY";
}

function compactSymbol(symbol) {
  return String(symbol ?? "").replace("-", "").toUpperCase();
}

function normalizeExchangeList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.positions)) return value.positions;
  if (Array.isArray(value?.orders)) return value.orders;
  if (Array.isArray(value?.data)) return value.data;
  return value ? [value] : [];
}

function positionSideFromPosition(position) {
  const raw = typeof position === "string"
    ? position
    : position?.positionSide ?? position?.side ?? "";
  const side = String(raw).toUpperCase();
  if (side.includes("LONG")) return "LONG";
  if (side.includes("SHORT")) return "SHORT";
  const amount = Number(position?.positionAmt ?? position?.positionAmount ?? position?.quantity ?? 0);
  return amount < 0 ? "SHORT" : "LONG";
}

function positionAmount(position) {
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

function positionIdentifier(position) {
  return position?.positionId ?? position?.positionID ?? position?.id ?? position?.position_id ?? null;
}

function resultOrder(value) {
  return value?.order ?? value?.data?.order ?? value?.data ?? value;
}

function resultOrderId(value) {
  const order = resultOrder(value);
  return order?.orderId ?? order?.orderID ?? order?.id ?? value?.orderId ?? value?.orderID ?? null;
}

function orderStatus(value) {
  return String(resultOrder(value)?.status ?? value?.status ?? "").toLowerCase();
}

function orderExecutedQty(value) {
  const order = resultOrder(value);
  const raw = order?.executedQty ??
    order?.executedQuantity ??
    order?.filledQty ??
    order?.filledQuantity ??
    value?.executedQty ??
    0;
  const qty = Number(raw);
  return Number.isFinite(qty) ? qty : 0;
}

function responseText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return [
    value.message,
    value.msg,
    value.error,
    value.code,
    value.data?.message,
    value.data?.msg,
    value.data?.code,
  ].filter(Boolean).join(" ");
}

function isOrderMissingResponse(value) {
  return /order\s*(not\s*)?exist|order\s*does\s*not\s*exist|not\s*found/i.test(responseText(value));
}

function classifyTriggerOrderStatus(value) {
  const status = orderStatus(value).toUpperCase();
  const executedQty = orderExecutedQty(value);
  const missing = isOrderMissingResponse(value);

  if (missing) {
    return {
      canArmNextSetup: true,
      executedQty,
      failureClassification: "trigger_order_missing_exchange",
      filled: false,
      reason: "trigger_order_missing_exchange",
      status: "missing",
      statusText: status || "ORDER_NOT_EXIST",
      terminal: true,
    };
  }

  if (status === "FILLED" || executedQty > 0) {
    return {
      canArmNextSetup: false,
      executedQty,
      failureClassification: "",
      filled: true,
      reason: "",
      status: "filled",
      statusText: status || "FILLED",
      terminal: true,
    };
  }

  const terminalMap = {
    FAILED: ["terminal_failed", "trigger_order_failed_exchange"],
    CANCELED: ["canceled", "trigger_order_canceled_exchange"],
    CANCELLED: ["canceled", "trigger_order_canceled_exchange"],
    EXPIRED: ["expired", "trigger_order_expired_exchange"],
    REJECTED: ["rejected", "trigger_order_rejected_exchange"],
  };
  if (terminalMap[status]) {
    const [nextStatus, reason] = terminalMap[status];
    return {
      canArmNextSetup: true,
      executedQty,
      failureClassification: reason,
      filled: false,
      reason,
      status: nextStatus,
      statusText: status,
      terminal: true,
    };
  }

  return {
    canArmNextSetup: false,
    executedQty,
    failureClassification: "",
    filled: false,
    reason: "",
    status: "pending_sync",
    statusText: status || "UNKNOWN",
    terminal: false,
  };
}

function summarizeExchangeResponse(value) {
  if (!value) return null;
  const order = resultOrder(value);
  return {
    code: value?.code ?? value?.data?.code ?? null,
    executedQty: orderExecutedQty(value),
    message: value?.message ?? value?.msg ?? value?.data?.message ?? value?.data?.msg ?? null,
    orderId: resultOrderId(value),
    status: order?.status ?? value?.status ?? null,
  };
}

function appendSetupOrderJournal(profile, entry) {
  profile.live = {
    lastProcessedSetupId: null,
    openPosition: null,
    orderLog: [],
    setupOrderJournal: [],
    ...(profile.live ?? {}),
  };
  profile.live.setupOrderJournal = [
    ...(profile.live.setupOrderJournal ?? []),
    {
      timestamp: new Date().toISOString(),
      symbol: profile.symbol,
      profileId: profile.id,
      ...entry,
    },
  ].slice(-100);
}

function matchingExchangePosition(positions, { positionSide, symbol }) {
  return normalizeExchangeList(positions).find((position) => {
    if (compactSymbol(position.symbol) !== compactSymbol(symbol)) return false;
    if (positionAmount(position) <= 0) return false;
    return positionSideFromPosition(position) === positionSide;
  }) ?? null;
}

export async function cancelLivePendingTriggerOrder({
  bingxClient,
  logger = async () => {},
  profile,
  reason = "cancelled",
  supersededBySetupId = null,
}) {
  const updatedProfile = structuredClone(profile);
  const pending = activePendingTriggerOrder(updatedProfile.live?.pendingTriggerOrder);

  if (!pending) return updatedProfile;

  let cancelResponse = null;
  let status = "cancelled";
  let terminalReason = reason === "new_setup_replaced_pending_trigger"
    ? "trigger_order_canceled_replaced"
    : "trigger_order_canceled_local";
  let failureClassification = terminalReason;
  try {
    if (pending.orderId) {
      cancelResponse = await bingxClient.cancelOrder(updatedProfile.symbol, { orderId: pending.orderId });
    }
    await logger("pending trigger order cancelled", {
      mode: "live",
      orderId: pending.orderId ?? null,
      profileId: updatedProfile.id,
      reason,
      setupId: pending.setupId,
    });
  } catch (error) {
    cancelResponse = error?.bingx ?? { message: error instanceof Error ? error.message : String(error) };
    if (isOrderMissingResponse(cancelResponse)) {
      status = "missing";
      terminalReason = "trigger_order_missing_exchange";
      failureClassification = terminalReason;
      await logger("pending trigger order missing during cancel", {
        mode: "live",
        orderId: pending.orderId ?? null,
        profileId: updatedProfile.id,
        reason,
        setupId: pending.setupId,
      });
    } else {
      status = "cancel_failed";
      terminalReason = "trigger_order_cancel_failed";
      failureClassification = terminalReason;
    }
    await logger("pending trigger order cancel failed", {
      error: error instanceof Error ? error.message : String(error),
      mode: "live",
      orderId: pending.orderId ?? null,
      profileId: updatedProfile.id,
      reason,
      setupId: pending.setupId,
    });
  }

  updatedProfile.live.pendingTriggerOrder = {
    ...pending,
    canArmNextSetup: true,
    cancelReason: reason,
    cancelResponse,
    exchangeTerminalStatus: status === "cancelled" ? "CANCELED" : status === "missing" ? "ORDER_NOT_EXIST" : "CANCEL_FAILED",
    failureClassification,
    lastExchangeStatus: status === "cancelled" ? "CANCELED" : status === "missing" ? "ORDER_NOT_EXIST" : "CANCEL_FAILED",
    orderLifecycle: [
      ...(pending.orderLifecycle ?? []),
      {
        exchangeResponse: cancelResponse,
        message: status === "cancelled"
          ? `Pending trigger order cancelled: ${reason}.`
          : status === "missing"
            ? `Pending trigger order missing on exchange: ${reason}.`
            : `Pending trigger cancel failed: ${reason}.`,
        status,
        time: new Date().toISOString(),
      },
    ],
    status,
    supersededBySetupId,
    terminal: status !== "cancel_failed",
    terminalReason,
    updatedAt: new Date().toISOString(),
  };
  appendSetupOrderJournal(updatedProfile, {
    event: status === "cancel_failed" ? "cancel_failed" : status === "missing" ? "order_missing" : "order_canceled",
    exchangeResponseSummary: summarizeExchangeResponse(cancelResponse),
    failureClassification,
    interval: updatedProfile.timeframe,
    orderId: pending.orderId ?? null,
    reason,
    setupId: pending.setupId,
    side: pending.side,
    status,
    supersededBySetupId,
    triggerPrice: pending.triggerPrice,
  });

  return updatedProfile;
}

async function syncPendingTriggerFill({
  bingxClient,
  logger,
  profile,
  store,
}) {
  let updatedProfile = structuredClone(profile);
  const pending = activePendingTriggerOrder(updatedProfile.live?.pendingTriggerOrder);

  if (!pending) return updatedProfile;

  let placedOrderStatus = null;
  try {
    if (pending.orderId) {
      placedOrderStatus = await bingxClient.getOrderStatus(pending.orderId, updatedProfile.symbol);
    }
  } catch (error) {
    placedOrderStatus = error?.bingx ?? { message: error instanceof Error ? error.message : String(error) };
  }

  const positions = normalizeExchangeList(await bingxClient.getOpenPositions(updatedProfile.symbol));
  const position = matchingExchangePosition(positions, {
    positionSide: pending.positionSide,
    symbol: updatedProfile.symbol,
  });
  const classification = classifyTriggerOrderStatus(placedOrderStatus);

  if (!position) {
    if (classification.filled) {
      updatedProfile.live.pendingTriggerOrder = {
        ...pending,
        canArmNextSetup: true,
        critical: "filled_but_position_missing",
        executedQty: classification.executedQty,
        exchangeTerminalStatus: classification.statusText,
        failureClassification: "filled_but_position_missing",
        fillDetectedAt: new Date().toISOString(),
        lastExchangeStatus: classification.statusText,
        lastOrderStatus: placedOrderStatus,
        lastStatusCheckAt: new Date().toISOString(),
        orderLifecycle: [
          ...(pending.orderLifecycle ?? []),
          {
            exchangeResponse: placedOrderStatus,
            message: "Trigger order reported filled, but no matching live position was found after fresh sync.",
            status: "filled_but_position_missing",
            time: new Date().toISOString(),
          },
        ].slice(-20),
        status: "filled_but_position_missing",
        terminal: true,
        terminalReason: "filled_but_position_missing",
        updatedAt: new Date().toISOString(),
      };
      appendSetupOrderJournal(updatedProfile, {
        event: "filled_but_position_missing",
        exchangeResponseSummary: summarizeExchangeResponse(placedOrderStatus),
        failureClassification: "filled_but_position_missing",
        interval: updatedProfile.timeframe,
        orderId: pending.orderId ?? null,
        quantity: pending.quantity,
        setupId: pending.setupId,
        side: pending.side,
        status: "filled_but_position_missing",
        triggerPrice: pending.triggerPrice,
      });
      await logger("trigger order filled but position missing", {
        mode: "live",
        orderId: pending.orderId,
        profileId: updatedProfile.id,
        setupId: pending.setupId,
      });
      return updatedProfile;
    }

    if (classification.terminal) {
      updatedProfile.live.pendingTriggerOrder = {
        ...pending,
        canArmNextSetup: true,
        executedQty: classification.executedQty,
        exchangeTerminalStatus: classification.statusText,
        failureClassification: classification.failureClassification,
        lastExchangeStatus: classification.statusText,
        lastOrderStatus: placedOrderStatus,
        lastStatusCheckAt: new Date().toISOString(),
        orderLifecycle: [
          ...(pending.orderLifecycle ?? []),
          {
            exchangeResponse: placedOrderStatus,
            message: `Trigger order terminal on exchange: ${classification.reason}.`,
            status: classification.status,
            time: new Date().toISOString(),
          },
        ].slice(-20),
        status: classification.status,
        terminal: true,
        terminalReason: classification.reason,
        updatedAt: new Date().toISOString(),
      };
      appendSetupOrderJournal(updatedProfile, {
        event: "order_terminal",
        exchangeResponseSummary: summarizeExchangeResponse(placedOrderStatus),
        executedQty: classification.executedQty,
        failureClassification: classification.failureClassification,
        interval: updatedProfile.timeframe,
        orderId: pending.orderId ?? null,
        quantity: pending.quantity,
        reason: classification.reason,
        setupId: pending.setupId,
        side: pending.side,
        status: classification.status,
        triggerPrice: pending.triggerPrice,
      });
      await logger("pending trigger order terminal on exchange", {
        exchangeStatus: classification.statusText,
        mode: "live",
        orderId: pending.orderId,
        profileId: updatedProfile.id,
        reason: classification.reason,
        setupId: pending.setupId,
      });
      return updatedProfile;
    }

    updatedProfile.live.pendingTriggerOrder = {
      ...pending,
      canArmNextSetup: false,
      executedQty: classification.executedQty,
      lastExchangeStatus: classification.statusText,
      lastOrderStatus: placedOrderStatus,
      lastStatusCheckAt: new Date().toISOString(),
      orderLifecycle: [
        ...(pending.orderLifecycle ?? []),
        ...(placedOrderStatus
          ? [{
              exchangeResponse: placedOrderStatus,
              message: `Trigger order still pending (${classification.statusText || "unknown"}).`,
              status: "pending_sync",
              time: new Date().toISOString(),
            }]
          : []),
      ].slice(-20),
      updatedAt: new Date().toISOString(),
    };
    return updatedProfile;
  }

  const protectiveQuantity = positionAmount(position) || pending.quantity;
  const side = pending.side;
  let stopOrder = null;
  let takeProfitOrder = null;
  let critical = "";

  try {
    try {
      stopOrder = await bingxClient.placePositionStopLoss(updatedProfile.symbol, side, pending.stopLoss, {
        position,
        positionId: positionIdentifier(position),
        positionSide: pending.positionSide,
        quantity: protectiveQuantity,
      });
    } catch {
      stopOrder = await bingxClient.placeStopLoss(updatedProfile.symbol, side, pending.stopLoss, protectiveQuantity, {
        position,
        positionId: positionIdentifier(position),
        positionSide: pending.positionSide,
      });
    }

    if (pending.takeProfit) {
      try {
        takeProfitOrder = await bingxClient.placePositionTakeProfit(updatedProfile.symbol, side, pending.takeProfit, {
          position,
          positionId: positionIdentifier(position),
          positionSide: pending.positionSide,
          quantity: protectiveQuantity,
        });
      } catch {
        takeProfitOrder = await bingxClient.placeTakeProfit(updatedProfile.symbol, side, pending.takeProfit, protectiveQuantity, {
          position,
          positionId: positionIdentifier(position),
          positionSide: pending.positionSide,
        });
      }
    }
  } catch (error) {
    critical = error instanceof Error ? error.message : String(error);
    await logger("SL placement after trigger fill failed", {
      error: critical,
      mode: "live",
      orderId: pending.orderId,
      profileId: updatedProfile.id,
      setupId: pending.setupId,
    });
  }

  const fillTime = Math.floor(Date.now() / 1000);
  const entryEvent = {
    ...(pending.entryEvent ?? {}),
    direction: pending.direction,
    setupId: pending.setupId,
    stopLoss: pending.stopLoss,
    time: fillTime,
    trigger: pending.triggerPrice,
  };

  if (!critical) {
    await logger("trigger order fill detected and SL attached", {
      mode: "live",
      orderId: pending.orderId,
      profileId: updatedProfile.id,
      setupId: pending.setupId,
      stopOrder,
    });
    if (stopOrder) {
      await store.upsertOrder({
        id: String(resultOrderId(stopOrder) ?? `${pending.setupId}-sl`),
        mode: "live",
        profileId: updatedProfile.id,
        raw: stopOrder,
        setupId: pending.setupId,
        side: closeSideForPositionSide(pending.positionSide),
        status: "SENT",
        symbol: updatedProfile.symbol,
        type: "STOP_MARKET",
      });
    }
    if (takeProfitOrder) {
      await store.upsertOrder({
        id: String(resultOrderId(takeProfitOrder) ?? `${pending.setupId}-tp`),
        mode: "live",
        profileId: updatedProfile.id,
        raw: takeProfitOrder,
        setupId: pending.setupId,
        side: closeSideForPositionSide(pending.positionSide),
        status: "SENT",
        symbol: updatedProfile.symbol,
        type: "TAKE_PROFIT_MARKET",
      });
    }
  }

  updatedProfile.live.openPosition = createPaperPosition({
    entryEvent,
    order: {
      ...(pending.order ?? {}),
      direction: pending.direction,
      entryPrice: pending.triggerPrice,
      quantity: protectiveQuantity,
      stopLoss: pending.stopLoss,
      takeProfit: pending.takeProfit ?? null,
    },
  });
  updatedProfile.live.lastProcessedSetupId = pending.setupId;
  updatedProfile.live.pendingTriggerOrder = {
    ...pending,
    canArmNextSetup: false,
    executedQty: classification.executedQty,
    exchangeTerminalStatus: classification.statusText,
    critical,
    fillDetectedAt: new Date().toISOString(),
    filledPosition: {
      positionId: positionIdentifier(position),
      positionSide: pending.positionSide,
      quantity: protectiveQuantity,
    },
    lastExchangeStatus: classification.statusText,
    lastOrderStatus: placedOrderStatus,
    lastStatusCheckAt: new Date().toISOString(),
    orderLifecycle: [
      ...(pending.orderLifecycle ?? []),
      {
        exchangeResponse: {
          orderStatus: placedOrderStatus,
          position,
          stopOrder,
          takeProfitOrder,
        },
        message: critical
          ? `Trigger filled, but SL placement failed: ${critical}`
          : "Trigger filled; SL protection placement requested.",
        status: critical ? "filled_sl_failed" : "filled_protected",
        time: new Date().toISOString(),
      },
    ].slice(-20),
    position,
    status: critical ? "filled_sl_failed" : "filled_protected",
    stopOrder,
    takeProfitOrder,
    updatedAt: new Date().toISOString(),
  };
  appendSetupOrderJournal(updatedProfile, {
    event: critical ? "fill_detected_sl_failed" : "fill_detected_sl_placed",
    exchangeResponseSummary: summarizeExchangeResponse(placedOrderStatus),
    executedQty: classification.executedQty,
    interval: updatedProfile.timeframe,
    orderId: pending.orderId ?? null,
    quantity: protectiveQuantity,
    setupId: pending.setupId,
    side: pending.side,
    slPlaced: !critical,
    status: critical ? "filled_sl_failed" : "filled_protected",
    triggerPrice: pending.triggerPrice,
  });
  updatedProfile.live.orderLog = [
    ...(updatedProfile.live.orderLog ?? []),
    {
      filledPosition: position,
      orderStatus: placedOrderStatus,
      stopOrder,
      takeProfitOrder,
      time: new Date().toISOString(),
      triggerOrder: pending.exchangeResponse,
    },
  ];

  return updatedProfile;
}

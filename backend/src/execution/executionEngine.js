import { STRATEGY_EVENT_TYPES } from "../../../hubert-platform/frontend/src/engine/strategyEngine.js";
import { validateOrder } from "../risk/riskManager.js";
import { buildSetupFingerprint, sameSetupFingerprint, withSetupFingerprint } from "./setupFingerprint.js";
import {
  isSetupActionable,
  timeValueMs,
  triggerEligibilityDiagnostics,
  triggerEligibilityForSetup,
} from "./setupActionability.js";
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
  priceService = null,
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
    lastProcessedSetupFingerprint: null,
    lastProcessedSetupId: null,
    openPosition: null,
    orderLog: [],
    setupOrderJournal: [],
    ...(updatedProfile.live ?? {}),
  };
  const executionMode = sztabExecutionMode();
  let openPosition = updatedProfile.live?.openPosition;
  const exitEvent = openPosition
    ? events.find(
        (event) =>
          event.type === STRATEGY_EVENT_TYPES.POSITION_EXITED &&
          event.setupId === openPosition.setupId,
      )
    : null;
  const exitEventIsReversal = String(exitEvent?.exitReason ?? "").toUpperCase() === "REVERSAL";

  if (openPosition && exitEvent && !exitEventIsReversal) {
    await bingxClient.closePosition(profile.symbol);
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
    const cleanup = await cleanupOpenOrdersBestEffort({
      bingxClient,
      logger,
      profile: updatedProfile,
      reason: "position_exit_cleanup",
      setupId: openPosition.setupId,
    });
    if (!cleanup.ok) {
      updatedProfile.live.lastCleanupWarning = cleanup;
    }
    await store.upsertTrade(trade);
    await logger("position closed", { mode: "live", profileId: profile.id, setupId: openPosition.setupId });
  } else if (openPosition && exitEventIsReversal) {
    await logger("core reversal exit observed; live Sztab will execute paired opposite entry event", {
      exitReason: exitEvent.exitReason,
      mode: "live",
      profileId: profile.id,
      setupId: openPosition.setupId,
    });
  }

  updatedProfile = await cancelPendingTriggerIfInvalidated({
    bingxClient,
    logger,
    priceService,
    profile: updatedProfile,
    strategyResult,
  });

  updatedProfile = await syncPendingTriggerFill({
    bingxClient,
    logger,
    priceService,
    profile: updatedProfile,
    store,
  });

  const rawActiveSetupEvent = setupEventForTriggerOrder(strategyResult, updatedProfile);
  const activeSetupEvent = rawActiveSetupEvent
    ? rawActiveSetupEvent.setupFingerprint
      ? rawActiveSetupEvent
      : buildLiveSetupEvent(rawActiveSetupEvent, updatedProfile)
    : null;
  if (activeSetupEvent) {
    const setupActionability = isSetupActionable(activeSetupEvent, updatedProfile.timeframe, Date.now());
    if (!setupActionability.actionable) {
      const existingPrematurePending = activePendingTriggerOrder(updatedProfile.live?.pendingTriggerOrder);
      if (existingPrematurePending && pendingOrderMatchesSetup(existingPrematurePending, activeSetupEvent)) {
        if (
          existingPrematurePending.orderId &&
          String(existingPrematurePending.executionMode ?? "").toLowerCase() !== "platform_market_trigger"
        ) {
          updatedProfile = await cancelLivePendingTriggerOrder({
            bingxClient,
            extraJournal: {
              triggerEligibleFrom: setupActionability.triggerEligibleFrom,
              triggerEligibleFromIso: setupActionability.triggerEligibleFromIso,
            },
            extraPending: {
              triggerEligibleFrom: setupActionability.triggerEligibleFrom,
              triggerEligibleFromIso: setupActionability.triggerEligibleFromIso,
            },
            failureClassification: "benchmark_candle_not_closed",
            journalEvent: "setup_waiting_benchmark_close",
            logger,
            profile: updatedProfile,
            reason: "benchmark_candle_not_closed",
            terminalReason: "benchmark_candle_not_closed",
            terminalStatus: "waiting_benchmark_close",
          });
        } else {
          updatedProfile.live.pendingTriggerOrder = {
            ...existingPrematurePending,
            canArmNextSetup: true,
            orderLifecycle: [
              ...(existingPrematurePending.orderLifecycle ?? []),
              {
                diagnostics: setupActionability,
                message: "Setup candidate is waiting for benchmark candle close; local trigger is not actionable yet.",
                status: "waiting_benchmark_close",
                time: new Date().toISOString(),
              },
            ].slice(-20),
            status: "waiting_benchmark_close",
            terminal: true,
            terminalReason: "benchmark_candle_not_closed",
            triggerEligibleFrom: setupActionability.triggerEligibleFrom,
            triggerEligibleFromIso: setupActionability.triggerEligibleFromIso,
            updatedAt: new Date().toISOString(),
          };
          appendSetupOrderJournal(updatedProfile, {
            event: "setup_waiting_benchmark_close",
            interval: updatedProfile.timeframe,
            reason: "benchmark_candle_not_closed",
            setupFingerprint: activeSetupEvent.setupFingerprint,
            setupFingerprintShort: activeSetupEvent.setupFingerprintShort,
            setupId: activeSetupEvent.setupId,
            side: sideForDirection(activeSetupEvent.direction),
            status: "waiting_benchmark_close",
            triggerEligibleFrom: setupActionability.triggerEligibleFrom,
            triggerEligibleFromIso: setupActionability.triggerEligibleFromIso,
            triggerPrice: activeSetupEvent.trigger,
          });
        }
      }
      updatedProfile.live.formingSetupCandidate = {
        ...activeSetupEvent,
        actionable: false,
        reason: setupActionability.reason,
        triggerEligibleFrom: setupActionability.triggerEligibleFrom,
        triggerEligibleFromIso: setupActionability.triggerEligibleFromIso,
        waitingForBenchmarkClose: true,
      };
      updatedProfile.live.latestSetupEventActionable = false;
      await logger("setup candidate waiting for benchmark candle close", {
        direction: activeSetupEvent.direction,
        fingerprint: activeSetupEvent.setupFingerprint,
        mode: "live",
        profileId: updatedProfile.id,
        setupId: activeSetupEvent.setupId,
        triggerEligibleFrom: setupActionability.triggerEligibleFromIso,
      });
      return updatedProfile;
    }
    updatedProfile.live.formingSetupCandidate = null;
    updatedProfile.live.latestSetupEventActionable = true;
  }
  const pendingTriggerOrder = activePendingTriggerOrder(updatedProfile.live?.pendingTriggerOrder);
  openPosition = updatedProfile.live?.openPosition;
  const activeSetupDirection = activeSetupEvent?.direction ?? "";
  const activePositionDirection = livePositionDirection(openPosition);
  const isReversalSetup = Boolean(
    openPosition &&
      activeSetupEvent &&
      executionMode === "platform_market_trigger" &&
      isOppositeDirection(activePositionDirection, activeSetupDirection),
  );

  if (!activeSetupEvent) {
    if (isPlatformMarketTriggerPending(pendingTriggerOrder)) {
      return processPlatformMarketTrigger({
        bingxClient,
        logger,
        priceService,
        profile: updatedProfile,
        store,
      });
    }
    return updatedProfile;
  }

  if (openPosition && !isReversalSetup) {
    return updatedProfile;
  }

  if (
    updatedProfile.live?.lastProcessedSetupFingerprint &&
    updatedProfile.live.lastProcessedSetupFingerprint === activeSetupEvent.setupFingerprint
  ) {
    return updatedProfile;
  }

  if (
    activeSetupEvent.strategyEventFingerprint &&
    updatedProfile.live?.lastProcessedStrategyEventFingerprint === activeSetupEvent.strategyEventFingerprint
  ) {
    return updatedProfile;
  }

  if (
    pendingOrderMatchesSetup(updatedProfile.live?.pendingTriggerOrder, activeSetupEvent) &&
    nonRetryPendingStatuses().includes(String(updatedProfile.live.pendingTriggerOrder.status ?? "").toLowerCase())
  ) {
    return updatedProfile;
  }

  if (pendingOrderMatchesSetup(pendingTriggerOrder, activeSetupEvent)) {
    if (
      executionMode === "platform_market_trigger" &&
      activeSetupEvent.strategyEventTrigger === true &&
      isPlatformMarketTriggerPending(pendingTriggerOrder)
    ) {
      updatedProfile.live.pendingTriggerOrder = {
        ...pendingTriggerOrder,
        lastStatusCheckAt: new Date().toISOString(),
        priceSource: sztabStrategyPriceSource(),
        strategyEventFingerprint: activeSetupEvent.strategyEventFingerprint ?? pendingTriggerOrder.strategyEventFingerprint ?? null,
        strategyEventTime: activeSetupEvent.strategyEventTime ?? activeSetupEvent.time ?? pendingTriggerOrder.strategyEventTime ?? null,
        strategyEventTrigger: true,
        triggerTruthSource: "strategy_event_closed_candle",
        updatedAt: new Date().toISOString(),
      };
      return processPlatformMarketTrigger({
        bingxClient,
        logger,
        priceService,
        profile: updatedProfile,
        store,
      });
    }
    if (activeSetupEvent.staleEntryIgnoredReason) {
      updatedProfile.live.pendingTriggerOrder = {
        ...pendingTriggerOrder,
        lastStatusCheckAt: new Date().toISOString(),
        platformTriggerDiagnostics: {
          ...(pendingTriggerOrder.platformTriggerDiagnostics ?? {}),
          staleEntryIgnoredReason: activeSetupEvent.staleEntryIgnoredReason,
          staleLatestEntryFingerprint: activeSetupEvent.staleLatestEntryFingerprint ?? null,
        },
        staleEntryIgnoredReason: activeSetupEvent.staleEntryIgnoredReason,
        staleLatestEntryFingerprint: activeSetupEvent.staleLatestEntryFingerprint ?? null,
        updatedAt: new Date().toISOString(),
      };
    }
    await logger("trigger order already armed", {
      fingerprint: activeSetupEvent.setupFingerprint,
      mode: "live",
      orderId: pendingTriggerOrder.orderId,
      profileId: profile.id,
      setupId: activeSetupEvent.setupId,
    });
    return updatedProfile;
  }

  if (pendingTriggerOrder && !pendingOrderMatchesSetup(pendingTriggerOrder, activeSetupEvent)) {
    updatedProfile = await cancelLivePendingTriggerOrder({
      bingxClient,
      logger,
      profile: updatedProfile,
      reason: "new_setup_replaced_pending_trigger",
      supersededBySetupFingerprint: activeSetupEvent.setupFingerprint,
      supersededBySetupId: activeSetupEvent.setupId,
    });
  }

  await logger("setup received; preparing live trigger execution", {
    direction: activeSetupEvent.direction,
    executionMode,
    fingerprint: activeSetupEvent.setupFingerprint,
    mode: "live",
    profileId: profile.id,
    setupId: activeSetupEvent.setupId,
    trigger: activeSetupEvent.trigger,
  });

  const balancePayload = await bingxClient.getPerpetualFuturesBalance();
  const accountBalanceUsed = getAvailableBalance(balancePayload);
  const availableMargin = availableMarginForExecution(balancePayload, accountBalanceUsed);
  const startingBalance = Number(updatedProfile.risk?.startingBalance);
  updatedProfile.risk = {
    ...(updatedProfile.risk ?? {}),
    startingBalance: Number.isFinite(startingBalance) && startingBalance > 0
      ? startingBalance
      : accountBalanceUsed,
  };
  const sizing = calculatePaperPositionSize({
    entryPrice: activeSetupEvent.trigger,
    equity: accountBalanceUsed,
    risk: updatedProfile.risk,
    stopLoss: activeSetupEvent.stopLoss,
  });
  const marginSafety = applyLiveMarginSafetyBuffer({
    availableMargin,
    entryPrice: activeSetupEvent.trigger,
    minNotional: Number(process.env.SZTAB_MIN_ORDER_NOTIONAL_USDT || 5),
    minQuantity: Number(process.env.SZTAB_MIN_ORDER_QTY || 0.001),
    riskBasis: accountBalanceUsed,
    riskPercent: updatedProfile.risk.riskPerTradePercent,
    sizing,
  });
  const finalSizing = marginSafety.sizing;
  const quantity = Number(finalSizing.quantity.toFixed(3));
  const desiredQuantity = Number(sizing.quantity.toFixed(3));
  const notionalSize = Number.isFinite(Number(finalSizing.notionalSize))
    ? Number(finalSizing.notionalSize)
    : quantity * Number(activeSetupEvent.trigger);
  const desiredNotionalSize = Number.isFinite(Number(sizing.notionalSize))
    ? Number(sizing.notionalSize)
    : desiredQuantity * Number(activeSetupEvent.trigger);
  await logger("size calculated", {
    desiredQuantity,
    marginCapApplied: marginSafety.capApplied,
    marginRequired: finalSizing.marginRequired,
    marginSafety,
    mode: "live",
    notionalSize,
    profileId: profile.id,
    quantity,
    riskAmount: finalSizing.riskAmount,
  });

  const order = {
    ...finalSizing,
    desiredMarginRequired: sizing.marginRequired,
    desiredNotionalSize,
    desiredQuantity,
    direction: activeSetupEvent.direction,
    entryPrice: activeSetupEvent.trigger,
    marginSafety,
    quantity,
    setupFingerprint: activeSetupEvent.setupFingerprint,
    setupFingerprintShort: activeSetupEvent.setupFingerprintShort,
    stopLoss: activeSetupEvent.stopLoss,
    takeProfit: calculatedLiveTakeProfit({
      direction: activeSetupEvent.direction,
      entryPrice: activeSetupEvent.trigger,
      profile: updatedProfile,
      stopLoss: activeSetupEvent.stopLoss,
    }),
    takeProfitEnabled: liveTakeProfitEnabled(updatedProfile),
  };
  if (!marginSafety.allowed) {
  updatedProfile.live.pendingTriggerOrder = {
      direction: activeSetupEvent.direction,
      marginSafety,
      orderLifecycle: [{
        diagnostics: marginSafety,
        message: `Risk blocked: ${marginSafety.reason}`,
        status: "risk_blocked",
        time: new Date().toISOString(),
      }],
      quantity,
      risk: { allowed: false, reason: marginSafety.reason },
      setupFingerprint: activeSetupEvent.setupFingerprint,
      setupFingerprintInput: activeSetupEvent.setupFingerprintInput,
      setupFingerprintShort: activeSetupEvent.setupFingerprintShort,
      setupId: activeSetupEvent.setupId,
      side: sideForDirection(activeSetupEvent.direction),
      status: "risk_blocked",
      stopLoss: activeSetupEvent.stopLoss,
      triggerPrice: activeSetupEvent.trigger,
      updatedAt: new Date().toISOString(),
    };
    appendSetupOrderJournal(updatedProfile, {
      desiredQuantity,
      event: "risk_blocked",
      finalQuantity: quantity,
      interval: updatedProfile.timeframe,
      marginSafety,
      quantity,
      reason: marginSafety.reason,
      setupFingerprint: activeSetupEvent.setupFingerprint,
      setupFingerprintShort: activeSetupEvent.setupFingerprintShort,
      setupId: activeSetupEvent.setupId,
      side: sideForDirection(activeSetupEvent.direction),
      triggerPrice: activeSetupEvent.trigger,
    });
    await logger("risk blocked", { marginSafety, mode: "live", profileId: profile.id, reason: marginSafety.reason });
    return updatedProfile;
  }
  const risk = validateOrder({
    apiConfigured: bingxClient.auth.configured,
    availableBalance: availableMargin,
    liveModeEnabled: profile.liveModeEnabled === true || store.getState().botStatus === "LIVE_RUNNING",
    openPosition: isReversalSetup ? null : updatedProfile.live?.openPosition,
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
      marginSafety,
      quantity,
      risk,
      setupFingerprint: activeSetupEvent.setupFingerprint,
      setupFingerprintInput: activeSetupEvent.setupFingerprintInput,
      setupFingerprintShort: activeSetupEvent.setupFingerprintShort,
      setupId: activeSetupEvent.setupId,
      side: sideForDirection(activeSetupEvent.direction),
      status: "risk_blocked",
      stopLoss: activeSetupEvent.stopLoss,
      triggerPrice: activeSetupEvent.trigger,
      updatedAt: new Date().toISOString(),
    };
    appendSetupOrderJournal(updatedProfile, {
      event: "risk_blocked",
      desiredQuantity,
      finalQuantity: quantity,
      interval: updatedProfile.timeframe,
      marginSafety,
      reason: risk.reason,
      setupFingerprint: activeSetupEvent.setupFingerprint,
      setupFingerprintShort: activeSetupEvent.setupFingerprintShort,
      setupId: activeSetupEvent.setupId,
      side: sideForDirection(activeSetupEvent.direction),
      triggerPrice: activeSetupEvent.trigger,
      quantity,
    });
    await logger("risk blocked", { mode: "live", profileId: profile.id, reason: risk.reason });
    return updatedProfile;
  }

  const side = sideForDirection(activeSetupEvent.direction);
  const positionSide = activeSetupEvent.direction === "LONG" ? "LONG" : "SHORT";

  if (executionMode === "platform_market_trigger") {
    const armedProfile = await armPlatformMarketTrigger({
      activeSetupEvent,
      desiredQuantity,
      finalSizing,
      logger,
      marginSafety,
      notionalSize,
      order,
      positionSide,
      quantity,
      risk,
      reversalFromPosition: isReversalSetup ? openPosition : null,
      side,
      updatedProfile,
    });
    warmStrategyPriceFeed({ bingxClient, priceService, symbol: armedProfile.symbol });
    if (activeSetupEvent.strategyEventTrigger === true) {
      return processPlatformMarketTrigger({
        bingxClient,
        logger,
        priceService,
        profile: armedProfile,
        store,
      });
    }
    return armedProfile;
  }

  await logger("risk approved; placing trigger-market entry order", {
    mode: "live",
    profileId: profile.id,
    setupId: activeSetupEvent.setupId,
  });
  await bingxClient.setMarginMode(profile.symbol, updatedProfile.risk.marginMode ?? "isolated");
  await bingxClient.setLeverage(profile.symbol, finalSizing.leverage, "LONG");
  await bingxClient.setLeverage(profile.symbol, finalSizing.leverage, "SHORT");
  const triggerPayload = {
    positionSide,
    quantity,
    side,
    stopPrice: activeSetupEvent.trigger,
    symbol: profile.symbol.includes("-") ? profile.symbol : profile.symbol.replace(/USDT$/u, "-USDT"),
    type: "TRIGGER_MARKET",
    workingType: "MARK_PRICE",
  };
  const placementDiagnostics = {
    ...(await collectTriggerDiagnostics({
      balancePayload,
      bingxClient,
      direction: activeSetupEvent.direction,
      includeExchangeState: false,
      leverage: finalSizing.leverage,
      marginRequired: finalSizing.marginRequired,
      marginMode: updatedProfile.risk.marginMode ?? "isolated",
      notional: notionalSize,
      payload: triggerPayload,
      priceService,
      quantity,
      setupFingerprint: activeSetupEvent.setupFingerprint,
      symbol: profile.symbol,
      triggerPrice: activeSetupEvent.trigger,
    })),
    apiProfile: profile.account?.apiProfile ?? profile.account?.id ?? null,
    marginSafety,
    profileId: profile.id,
    subaccount: profile.account?.label ?? profile.account?.apiProfile ?? null,
  };

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
    await logger("trigger-market order sent", {
      diagnostics: placementDiagnostics,
      fingerprint: activeSetupEvent.setupFingerprint,
      mode: "live",
      order: triggerOrder,
      profileId: profile.id,
    });
    await store.upsertOrder({
      id: String(triggerOrderId),
      mode: "live",
      profileId: profile.id,
      raw: triggerOrder,
      setupFingerprint: activeSetupEvent.setupFingerprint,
      setupFingerprintShort: activeSetupEvent.setupFingerprintShort,
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
      marginSafety,
      order,
      orderId: triggerOrderId,
      orderLifecycle: [{
        diagnostics: placementDiagnostics,
        exchangeResponse: triggerOrder,
        message: "Exchange accepted trigger-market entry order.",
        status: "accepted",
        time: new Date().toISOString(),
      }],
      positionSide,
      placementDiagnostics,
      quantity,
      risk,
      benchmarkTime: activeSetupEvent.benchmarkTime ?? activeSetupEvent.time ?? null,
      invalidationPrice: activeSetupEvent.stopLoss,
      setupFingerprint: activeSetupEvent.setupFingerprint,
      setupFingerprintInput: activeSetupEvent.setupFingerprintInput,
      setupFingerprintShort: activeSetupEvent.setupFingerprintShort,
      strategyParamsHash: activeSetupEvent.strategyParamsHash,
      setupId: activeSetupEvent.setupId,
      signalTime: activeSetupEvent.signalTime ?? null,
      side,
      status: "accepted",
      stopLoss: activeSetupEvent.stopLoss,
      takeProfit: order.takeProfit,
      takeProfitEnabled: order.takeProfitEnabled,
      triggerPrice: activeSetupEvent.trigger,
      updatedAt: new Date().toISOString(),
      workingType: "MARK_PRICE",
    };
    appendSetupOrderJournal(updatedProfile, {
      event: "order_accepted",
      desiredQuantity,
      exchangeResponseSummary: summarizeExchangeResponse(triggerOrder),
      finalQuantity: quantity,
      interval: updatedProfile.timeframe,
      marginSafety,
      orderAccepted: true,
      orderId: triggerOrderId,
      placementDiagnostics,
      quantity,
      setupFingerprint: activeSetupEvent.setupFingerprint,
      setupFingerprintShort: activeSetupEvent.setupFingerprintShort,
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
      marginSafety,
      placementDiagnostics,
      orderLifecycle: [{
        diagnostics: placementDiagnostics,
        exchangeResponse: error?.bingx ?? null,
        message: error instanceof Error ? error.message : String(error),
        status: "trigger_order_rejected",
        time: new Date().toISOString(),
      }],
      quantity,
      risk,
      setupFingerprint: activeSetupEvent.setupFingerprint,
      setupFingerprintInput: activeSetupEvent.setupFingerprintInput,
      setupFingerprintShort: activeSetupEvent.setupFingerprintShort,
      setupId: activeSetupEvent.setupId,
      side,
      status: "trigger_order_rejected",
      stopLoss: activeSetupEvent.stopLoss,
      triggerPrice: activeSetupEvent.trigger,
      updatedAt: new Date().toISOString(),
    };
    appendSetupOrderJournal(updatedProfile, {
      event: "order_rejected",
      desiredQuantity,
      exchangeResponseSummary: summarizeExchangeResponse(error?.bingx ?? null),
      failureClassification: "trigger_order_rejected_exchange",
      finalQuantity: quantity,
      interval: updatedProfile.timeframe,
      marginSafety,
      orderAccepted: false,
      placementDiagnostics,
      quantity,
      reason: error instanceof Error ? error.message : String(error),
      setupFingerprint: activeSetupEvent.setupFingerprint,
      setupFingerprintShort: activeSetupEvent.setupFingerprintShort,
      setupId: activeSetupEvent.setupId,
      side,
      status: "trigger_order_rejected",
      triggerPrice: activeSetupEvent.trigger,
    });
    await logger("trigger-market order rejected", {
      fingerprint: activeSetupEvent.setupFingerprint,
      message: error instanceof Error ? error.message : String(error),
      mode: "live",
      profileId: profile.id,
      setupId: activeSetupEvent.setupId,
    });
  }

  return updatedProfile;
}

async function armPlatformMarketTrigger({
  activeSetupEvent,
  desiredQuantity,
  finalSizing,
  logger = async () => {},
  marginSafety,
  notionalSize,
  order,
  positionSide,
  quantity,
  risk,
  reversalFromPosition = null,
  side,
  updatedProfile,
}) {
  const armedAt = new Date().toISOString();
  const priceSource = sztabStrategyPriceSource();
  const maxSlippagePct = maxTriggerSlippagePct();
  const strategyEventTrigger = activeSetupEvent.strategyEventTrigger === true ||
    activeSetupEvent.type === STRATEGY_EVENT_TYPES.ENTRY_TRIGGERED;
  const reversalFromDirection = livePositionDirection(reversalFromPosition);
  const triggerEligibility = triggerEligibilityForSetup(activeSetupEvent, updatedProfile);
  const setupActionability = isSetupActionable(activeSetupEvent, updatedProfile.timeframe, Date.now());
  if (!setupActionability.actionable) {
    updatedProfile.live.formingSetupCandidate = {
      ...activeSetupEvent,
      actionable: false,
      reason: setupActionability.reason,
      triggerEligibleFrom: setupActionability.triggerEligibleFrom,
      triggerEligibleFromIso: setupActionability.triggerEligibleFromIso,
      waitingForBenchmarkClose: true,
    };
    updatedProfile.live.latestSetupEventActionable = false;
    appendSetupOrderJournal(updatedProfile, {
      event: "setup_waiting_benchmark_close",
      interval: updatedProfile.timeframe,
      reason: "benchmark_candle_not_closed",
      setupFingerprint: activeSetupEvent.setupFingerprint,
      setupFingerprintShort: activeSetupEvent.setupFingerprintShort,
      setupId: activeSetupEvent.setupId,
      side,
      status: "waiting_benchmark_close",
      triggerEligibleFrom: setupActionability.triggerEligibleFrom,
      triggerEligibleFromIso: setupActionability.triggerEligibleFromIso,
      triggerPrice: activeSetupEvent.trigger,
    });
    await logger("setup candidate waiting for benchmark candle close; platform trigger not armed", {
      direction: activeSetupEvent.direction,
      fingerprint: activeSetupEvent.setupFingerprint,
      mode: "live",
      profileId: updatedProfile.id,
      setupId: activeSetupEvent.setupId,
      triggerEligibleFrom: setupActionability.triggerEligibleFromIso,
    });
    return updatedProfile;
  }
  const isReversal = Boolean(
    reversalFromPosition &&
      isOppositeDirection(reversalFromDirection, activeSetupEvent.direction),
  );
  const placementDiagnostics = {
    direction: activeSetupEvent.direction,
    executionMode: "platform_market_trigger",
    isReversal,
    leverage: finalSizing.leverage,
    marginRequired: finalSizing.marginRequired,
    marginSafety,
    maxSlippagePct,
    notional: notionalSize,
    payload: {
      action: "ARM_PLATFORM_MARKET_TRIGGER",
      priceSource,
      strategyEventTrigger,
      triggerPrice: activeSetupEvent.trigger,
      type: "LOCAL_PLATFORM_TRIGGER",
    },
    priceSource,
    quantity,
    setupFingerprint: activeSetupEvent.setupFingerprint,
    triggerPrice: activeSetupEvent.trigger,
  };

    updatedProfile.live.pendingTriggerOrder = {
    armedAt,
    benchmarkTime: activeSetupEvent.benchmarkTime ?? activeSetupEvent.time ?? null,
    canArmNextSetup: false,
    direction: activeSetupEvent.direction,
    entryEvent: activeSetupEvent,
    executionMode: "platform_market_trigger",
    invalidationPrice: activeSetupEvent.stopLoss,
    isReversal,
    marginSafety,
    maxSlippagePct,
    order,
    orderLifecycle: [{
      diagnostics: placementDiagnostics,
      message: isReversal
        ? strategyEventTrigger
          ? "Strategia potwierdziła przeciwny trigger; przygotowuję reversal MARKET przez BingX."
          : "Live position is active; platform armed opposite trigger watcher for reversal."
        : strategyEventTrigger
          ? "Strategia potwierdziła trigger; przygotowuję MARKET przez BingX."
          : "Platform armed local trigger watcher; no BingX trigger order was placed.",
      status: "platform_armed",
      time: armedAt,
    }],
    placementDiagnostics,
    positionSide,
    priceSource,
    quantity,
    risk,
    reversalFromDirection: isReversal ? reversalFromDirection : "",
    reversalFromPosition: isReversal
      ? {
          direction: reversalFromDirection,
          entryPrice: reversalFromPosition.entryPrice ?? null,
          entryTime: reversalFromPosition.entryTime ?? null,
          quantity: reversalFromPosition.quantity ?? null,
          setupFingerprint: reversalFromPosition.setupFingerprint ?? null,
          setupId: reversalFromPosition.setupId ?? null,
          stopLoss: reversalFromPosition.stopLoss ?? null,
        }
      : null,
    reversalReason: isReversal ? "waiting_for_opposite_trigger" : "",
    reversalStatus: isReversal ? "waiting_opposite_trigger" : "",
    setupFingerprint: activeSetupEvent.setupFingerprint,
    setupFingerprintInput: activeSetupEvent.setupFingerprintInput,
    setupFingerprintShort: activeSetupEvent.setupFingerprintShort,
    setupId: activeSetupEvent.setupId,
    side,
    signalTime: activeSetupEvent.signalTime ?? null,
    status: "platform_armed",
    stopLoss: activeSetupEvent.stopLoss,
    strategyEventFingerprint: activeSetupEvent.strategyEventFingerprint ?? null,
    strategyEventTime: activeSetupEvent.strategyEventTime ?? activeSetupEvent.time ?? null,
    strategyEventTrigger,
    strategyParamsHash: activeSetupEvent.strategyParamsHash,
    takeProfit: order.takeProfit,
    takeProfitEnabled: order.takeProfitEnabled,
    setupCandleCloseTime: triggerEligibility.setupCandleCloseTime,
    triggerTruthSource: strategyEventTrigger ? "strategy_event_closed_candle" : "binance_futures_live_price",
    triggerEligibleFrom: triggerEligibility.triggerEligibleFrom,
    triggerEligibleFromIso: triggerEligibility.triggerEligibleFromIso,
    triggerPrice: activeSetupEvent.trigger,
    updatedAt: armedAt,
  };
  appendSetupOrderJournal(updatedProfile, {
    desiredQuantity,
    event: isReversal ? "platform_reversal_trigger_armed" : "platform_trigger_armed",
    finalQuantity: quantity,
    interval: updatedProfile.timeframe,
    marginSafety,
    maxSlippagePct,
    orderAccepted: false,
    placementDiagnostics,
    priceSource,
    quantity,
    reason: strategyEventTrigger
      ? "strategy_entry_event_triggered"
      : isReversal
        ? "waiting_for_opposite_trigger"
        : "platform_market_trigger_armed",
    reversalFromDirection: isReversal ? reversalFromDirection : "",
    setupFingerprint: activeSetupEvent.setupFingerprint,
    setupFingerprintShort: activeSetupEvent.setupFingerprintShort,
    setupId: activeSetupEvent.setupId,
    side,
    status: "platform_armed",
    triggerPrice: activeSetupEvent.trigger,
  });
  await logger("platform-side market trigger armed", {
    direction: activeSetupEvent.direction,
    fingerprint: activeSetupEvent.setupFingerprint,
    isReversal,
    mode: "live",
    priceSource,
    profileId: updatedProfile.id,
    setupId: activeSetupEvent.setupId,
    strategyEventTrigger,
    trigger: activeSetupEvent.trigger,
  });
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

function isSztabProfile(profile = {}) {
  return profile?.runner === "sztab" || String(profile?.id ?? "").startsWith("sztab-");
}

function liveTakeProfitEnabled(profile = {}, pending = {}) {
  if (!isSztabProfile(profile)) return true;
  return Boolean(
    profile?.risk?.takeProfitEnabled === true ||
      pending?.takeProfitEnabled === true ||
      pending?.explicitTakeProfitEnabled === true,
  );
}

function calculatedLiveTakeProfit({ direction, entryPrice, profile = {}, stopLoss }) {
  if (!liveTakeProfitEnabled(profile)) return null;
  return calculateTakeProfit({
    direction,
    entryPrice,
    rr: profile.risk?.takeProfitRr,
    stopLoss,
  });
}

async function placeLiveTakeProfitIfEnabled({
  bingxClient,
  logger = async () => {},
  pending = {},
  position = null,
  profile,
  protectiveQuantity,
  side,
}) {
  if (!pending.takeProfit) return null;
  if (!liveTakeProfitEnabled(profile, pending)) {
    appendSetupOrderJournal(profile, {
      event: "sztab_tp_blocked_not_enabled",
      failureClassification: "sztab_tp_blocked_not_enabled",
      interval: profile.timeframe,
      quantity: protectiveQuantity,
      reason: "sztab_tp_blocked_not_enabled",
      setupFingerprint: pending.setupFingerprint,
      setupFingerprintShort: pending.setupFingerprintShort,
      setupId: pending.setupId,
      side,
      status: "tp_blocked",
      takeProfit: pending.takeProfit,
      triggerPrice: pending.triggerPrice,
    });
    await logger("sztab_tp_blocked_not_enabled", {
      mode: "live",
      profileId: profile.id,
      setupFingerprint: pending.setupFingerprint,
      setupId: pending.setupId,
      takeProfit: pending.takeProfit,
    });
    return null;
  }

  try {
    return await bingxClient.placePositionTakeProfit(profile.symbol, side, pending.takeProfit, {
      position,
      positionId: positionIdentifier(position),
      positionSide: pending.positionSide,
      quantity: protectiveQuantity,
    });
  } catch {
    return bingxClient.placeTakeProfit(profile.symbol, side, pending.takeProfit, protectiveQuantity, {
      position,
      positionId: positionIdentifier(position),
      positionSide: pending.positionSide,
    });
  }
}

function slProtectionRetryCount() {
  const configured = Number(process.env.SZTAB_SL_PROTECTION_RETRIES ?? 1);
  return Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : 1;
}

function slProtectionRetryDelayMs() {
  const configured = Number(process.env.SZTAB_SL_PROTECTION_RETRY_MS ?? 250);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 250;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function orderIdentifier(order = {}) {
  const normalized = resultOrder(order);
  return normalized?.orderId ?? normalized?.orderID ?? normalized?.id ?? order?.orderId ?? order?.orderID ?? order?.id ?? null;
}

function orderSymbol(order = {}) {
  const normalized = resultOrder(order);
  return compactSymbol(normalized?.symbol ?? order?.symbol ?? "");
}

function orderPositionSide(order = {}) {
  const normalized = resultOrder(order);
  return positionSideFromPosition(normalized?.positionSide ?? order?.positionSide ?? order);
}

function isActiveExchangeOrder(order = {}) {
  const status = String(resultOrder(order)?.status ?? order?.status ?? "").toUpperCase();
  return !["CANCELED", "CANCELLED", "EXPIRED", "FAILED", "FILLED", "REJECTED"].includes(status);
}

function isStopProtectionOrder(order = {}, { positionSide = "", stopOrder = null, symbol = "" } = {}) {
  const normalized = resultOrder(order);
  const type = String(normalized?.type ?? order?.type ?? "").toUpperCase();
  if (!type.includes("STOP") || type.includes("TAKE")) return false;
  if (!isActiveExchangeOrder(order)) return false;

  const expectedSymbol = compactSymbol(symbol);
  if (expectedSymbol && orderSymbol(order) && orderSymbol(order) !== expectedSymbol) return false;

  const expectedSide = positionSide ? String(positionSide).toUpperCase() : "";
  if (expectedSide && orderPositionSide(order) !== expectedSide) return false;

  const placedOrderId = orderIdentifier(stopOrder);
  if (!placedOrderId) return true;
  return orderIdentifier(order) === placedOrderId || !orderIdentifier(order);
}

async function confirmStopProtection({
  bingxClient,
  position = null,
  positionSide = "",
  stopOrder = null,
  symbol,
}) {
  if (typeof bingxClient?.getOpenOrders !== "function") {
    return {
      confirmed: false,
      openOrders: [],
      protectionOrder: null,
      protectionOrderId: null,
      protectionSource: "open_orders_unavailable",
      reason: "open_orders_endpoint_unavailable",
    };
  }

  try {
    const openOrders = normalizeExchangeList(await bingxClient.getOpenOrders(symbol));
    const side = positionSide || positionSideFromPosition(position);
    const protectionOrder = openOrders.find((order) =>
      isStopProtectionOrder(order, { positionSide: side, stopOrder, symbol }));
    return {
      confirmed: Boolean(protectionOrder),
      openOrders,
      protectionOrder,
      protectionOrderId: orderIdentifier(protectionOrder),
      protectionSource: protectionOrder ? "bingx_order" : "missing",
      reason: protectionOrder ? "stop_order_found_after_fresh_sync" : "stop_order_missing_after_fresh_sync",
    };
  } catch (error) {
    return {
      confirmed: false,
      error: error?.bingx ?? { message: error instanceof Error ? error.message : String(error) },
      openOrders: [],
      protectionOrder: null,
      protectionOrderId: null,
      protectionSource: "sync_error",
      reason: "open_orders_sync_failed",
    };
  }
}

async function placeStopLossOnce({
  bingxClient,
  pending = {},
  position = null,
  profile,
  protectiveQuantity,
  side,
}) {
  try {
    return await bingxClient.placePositionStopLoss(profile.symbol, side, pending.stopLoss, {
      position,
      positionId: positionIdentifier(position),
      positionSide: pending.positionSide,
      quantity: protectiveQuantity,
    });
  } catch (error) {
    if (typeof bingxClient?.placeStopLoss !== "function") throw error;
    return bingxClient.placeStopLoss(profile.symbol, side, pending.stopLoss, protectiveQuantity, {
      position,
      positionId: positionIdentifier(position),
      positionSide: pending.positionSide,
    });
  }
}

async function emergencyClosePosition({
  bingxClient,
  position = null,
  positionSide = "",
  profile,
}) {
  let closeResponse = null;
  try {
    closeResponse = await bingxClient.closePosition(profile.symbol, {
      position,
      positionSide: positionSide || positionSideFromPosition(position),
    });
  } catch (error) {
    return {
      closeError: error?.bingx ?? { message: error instanceof Error ? error.message : String(error) },
      closeResponse: error?.bingx ?? null,
      emergencyClosed: false,
      positionsAfterClose: [],
      positionStillOpen: true,
    };
  }

  let positionsAfterClose = [];
  let positionStillOpen = false;
  try {
    positionsAfterClose = normalizeExchangeList(await bingxClient.getOpenPositions(profile.symbol));
    positionStillOpen = Boolean(matchingExchangePosition(positionsAfterClose, {
      positionSide: positionSide || positionSideFromPosition(position),
      symbol: profile.symbol,
    }));
  } catch (error) {
    return {
      closeError: error?.bingx ?? { message: error instanceof Error ? error.message : String(error) },
      closeResponse,
      emergencyClosed: false,
      positionsAfterClose,
      positionStillOpen: true,
    };
  }

  return {
    closeError: null,
    closeResponse,
    emergencyClosed: !positionStillOpen,
    positionsAfterClose,
    positionStillOpen,
  };
}

async function protectLivePositionOrEmergencyClose({
  bingxClient,
  logger = async () => {},
  pending = {},
  position = null,
  profile,
  protectiveQuantity,
  side,
}) {
  const protectionAttempts = [];
  const totalAttempts = Math.max(1, 1 + slProtectionRetryCount());
  const stopLoss = numericValue(pending.stopLoss);
  const positionSide = pending.positionSide || positionSideFromPosition(position);

  if (stopLoss !== null && stopLoss > 0) {
    let lastPlacedStopOrder = null;
    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      let stopOrder = lastPlacedStopOrder;
      let placementError = null;
      if (!stopOrder) {
        try {
          stopOrder = await placeStopLossOnce({
            bingxClient,
            pending,
            position,
            profile,
            protectiveQuantity,
            side,
          });
          lastPlacedStopOrder = stopOrder;
        } catch (error) {
          placementError = error?.bingx ?? { message: error instanceof Error ? error.message : String(error) };
        }
      }

      const confirmation = placementError
        ? { confirmed: false, reason: "sl_place_failed", error: placementError }
        : await confirmStopProtection({
          bingxClient,
          position,
          positionSide,
          stopOrder,
          symbol: profile.symbol,
        });

      protectionAttempts.push({
        attempt,
        confirmation,
        placedOrderId: resultOrderId(stopOrder),
        placementError,
        stopOrder,
        time: new Date().toISOString(),
      });

      if (confirmation.confirmed) {
        let takeProfitOrder = null;
        try {
          takeProfitOrder = await placeLiveTakeProfitIfEnabled({
            bingxClient,
            logger,
            pending,
            position,
            profile,
            protectiveQuantity,
            side,
          });
        } catch (error) {
          appendSetupOrderJournal(profile, {
            event: "take_profit_failed_after_sl_confirmed",
            exchangeResponseSummary: summarizeExchangeResponse(error?.bingx ?? null),
            failureClassification: "take_profit_failed_after_sl_confirmed",
            interval: profile.timeframe,
            quantity: protectiveQuantity,
            reason: error instanceof Error ? error.message : String(error),
            setupFingerprint: pending.setupFingerprint,
            setupFingerprintShort: pending.setupFingerprintShort,
            setupId: pending.setupId,
            side,
            status: "tp_failed_after_sl_confirmed",
            triggerPrice: pending.triggerPrice,
          });
          await logger("take profit placement failed after SL confirmation", {
            error: error instanceof Error ? error.message : String(error),
            mode: "live",
            profileId: profile.id,
            setupFingerprint: pending.setupFingerprint,
            setupId: pending.setupId,
          });
        }
        appendSetupOrderJournal(profile, {
          event: "sl_protection_confirmed",
          interval: profile.timeframe,
          orderId: resultOrderId(stopOrder),
          protectionOrderId: confirmation.protectionOrderId,
          protectionSource: confirmation.protectionSource,
          quantity: protectiveQuantity,
          setupFingerprint: pending.setupFingerprint,
          setupFingerprintShort: pending.setupFingerprintShort,
          setupId: pending.setupId,
          side,
          slPlaced: true,
          status: "sl_confirmed",
          stopLoss,
          triggerPrice: pending.triggerPrice,
        });
        return {
          critical: "",
          emergencyClose: null,
          emergencyClosed: false,
          protectionAttempts,
          protectionConfirmed: true,
          protectionOrderId: confirmation.protectionOrderId,
          protectionSource: confirmation.protectionSource,
          stopOrder,
          stopOrderVerification: confirmation,
          takeProfitOrder,
        };
      }

      await logger("SL protection attempt not confirmed", {
        attempt,
        mode: "live",
        profileId: profile.id,
        reason: confirmation.reason,
        setupFingerprint: pending.setupFingerprint,
        setupId: pending.setupId,
      });

      if (attempt < totalAttempts && slProtectionRetryDelayMs() > 0) {
        await sleep(slProtectionRetryDelayMs());
      }
    }
  } else {
    protectionAttempts.push({
      attempt: 0,
      confirmation: { confirmed: false, reason: "missing_stop_loss" },
      placementError: "missing_stop_loss",
      stopOrder: null,
      time: new Date().toISOString(),
    });
  }

  const emergencyClose = await emergencyClosePosition({
    bingxClient,
    position,
    positionSide,
    profile,
  });
  const status = emergencyClose.emergencyClosed
    ? "sl_protection_failed_emergency_closed"
    : "sl_protection_failed_emergency_close_failed";
  appendSetupOrderJournal(profile, {
    emergencyCloseResponse: summarizeExchangeResponse(emergencyClose.closeResponse),
    event: status,
    failureClassification: status,
    interval: profile.timeframe,
    positionStillOpen: emergencyClose.positionStillOpen,
    protectionAttempts: protectionAttempts.map((attempt) => ({
      attempt: attempt.attempt,
      confirmed: Boolean(attempt.confirmation?.confirmed),
      placedOrderId: attempt.placedOrderId ?? null,
      reason: attempt.confirmation?.reason ?? attempt.placementError?.message ?? attempt.placementError ?? "",
    })),
    quantity: protectiveQuantity,
    reason: status,
    setupFingerprint: pending.setupFingerprint,
    setupFingerprintShort: pending.setupFingerprintShort,
    setupId: pending.setupId,
    side,
    slPlaced: false,
    status,
    stopLoss,
    triggerPrice: pending.triggerPrice,
  });
  await logger("SL protection failed; emergency close attempted", {
    emergencyClosed: emergencyClose.emergencyClosed,
    mode: "live",
    positionStillOpen: emergencyClose.positionStillOpen,
    profileId: profile.id,
    setupFingerprint: pending.setupFingerprint,
    setupId: pending.setupId,
  });

  return {
    critical: status,
    emergencyClose,
    emergencyClosed: emergencyClose.emergencyClosed,
    protectionAttempts,
    protectionConfirmed: false,
    protectionOrderId: null,
    protectionSource: emergencyClose.emergencyClosed ? "emergency_closed" : "unprotected_close_failed",
    stopOrder: null,
    stopOrderVerification: protectionAttempts.at(-1)?.confirmation ?? null,
    takeProfitOrder: null,
  };
}

export async function ensureLiveExchangePositionProtectedOrClosed({
  bingxClient,
  logger = async () => {},
  position = null,
  profile,
  setupContext = {},
  store = null,
}) {
  if (!position || !profile) {
    return { action: "none", profile, reason: "position_or_profile_missing" };
  }

  const positionSide = positionSideFromPosition(position);
  const side = sideForDirection(positionSide);
  const stopLoss = numericValue(
    setupContext.stopLoss ??
      setupContext.invalidationPrice ??
      profile.live?.pendingTriggerOrder?.stopLoss ??
      profile.live?.openPosition?.stopLoss,
  );
  const existingProtection = await confirmStopProtection({
    bingxClient,
    position,
    positionSide,
    stopOrder: null,
    symbol: profile.symbol,
  });

  if (existingProtection.confirmed) {
    return {
      action: "already_protected",
      profile,
      protectionConfirmed: true,
      protectionOrderId: existingProtection.protectionOrderId,
      protectionSource: existingProtection.protectionSource,
    };
  }

  const pseudoPending = {
    direction: positionSide,
    entryEvent: setupContext.entryEvent ?? null,
    positionSide,
    setupFingerprint: setupContext.setupFingerprint ?? profile.live?.pendingTriggerOrder?.setupFingerprint ?? null,
    setupFingerprintShort: setupContext.setupFingerprintShort ?? profile.live?.pendingTriggerOrder?.setupFingerprintShort ?? null,
    setupId: setupContext.setupId ?? profile.live?.pendingTriggerOrder?.setupId ?? "startup-reconcile",
    side,
    status: "startup_protection_reconcile",
    stopLoss,
    triggerPrice: setupContext.triggerPrice ?? positionEntryPrice(position) ?? null,
  };
  const protectiveQuantity = positionAmount(position);

  const result = await protectLivePositionOrEmergencyClose({
    bingxClient,
    logger,
    pending: pseudoPending,
    position,
    profile,
    protectiveQuantity,
    side,
  });

  if (result.protectionConfirmed && store && result.stopOrder) {
    await store.upsertOrder({
      id: String(result.protectionOrderId ?? resultOrderId(result.stopOrder) ?? `${pseudoPending.setupId}-startup-sl`),
      mode: "live",
      profileId: profile.id,
      raw: result.stopOrder,
      setupFingerprint: pseudoPending.setupFingerprint,
      setupFingerprintShort: pseudoPending.setupFingerprintShort,
      setupId: pseudoPending.setupId,
      side: closeSideForPositionSide(positionSide),
      status: "SENT",
      symbol: profile.symbol,
      type: "STOP_MARKET",
    });
  }

  return {
    action: result.protectionConfirmed
      ? "sl_placed"
      : result.emergencyClosed
        ? "emergency_closed"
        : "emergency_close_failed",
    ...result,
    profile,
  };
}

function sztabExecutionMode() {
  const value = String(process.env.SZTAB_EXECUTION_MODE ?? "platform_market_trigger").toLowerCase();
  return value === "exchange_trigger" ? "exchange_trigger" : "platform_market_trigger";
}

function sztabPriceSource() {
  const value = String(process.env.SZTAB_PRICE_SOURCE ?? "bingx_mark").toLowerCase();
  return ["bingx_mark", "bingx_last", "binance_futures"].includes(value) ? value : "bingx_mark";
}

function sztabStrategyPriceSource() {
  // Strategic trigger truth must stay on the Binance Futures side; BingX is only the execution venue.
  return "binance_futures";
}

function warmStrategyPriceFeed({ bingxClient, priceService = null, symbol }) {
  if (typeof priceService?.getPrice !== "function") return;
  priceService.getPrice({
    client: bingxClient,
    source: sztabStrategyPriceSource(),
    symbol,
  }).catch(() => {});
}

function maxTriggerSlippagePct() {
  const value = Number(process.env.SZTAB_MAX_TRIGGER_SLIPPAGE_PCT ?? 0.05);
  if (!Number.isFinite(value) || value < 0) return 0.05;
  return value;
}

function normalizedMarginUsageCap() {
  const value = Number(process.env.SZTAB_MARGIN_USAGE_CAP ?? 0.8);
  if (!Number.isFinite(value) || value <= 0) return 0.8;
  return Math.min(1, value);
}

function marginFeeBufferMultiplier() {
  const percent = Number(process.env.SZTAB_MARGIN_FEE_BUFFER_PCT ?? 0.1);
  return 1 + (Number.isFinite(percent) && percent > 0 ? percent / 100 : 0);
}

function floorQuantity(value, decimals = 3) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  const factor = 10 ** decimals;
  return Math.floor(numeric * factor) / factor;
}

function applyLiveMarginSafetyBuffer({
  availableMargin,
  entryPrice,
  minNotional = 5,
  minQuantity = 0.001,
  riskBasis = null,
  riskPercent = null,
  sizing = {},
} = {}) {
  const marginUsageCap = normalizedMarginUsageCap();
  const feeBufferMultiplier = marginFeeBufferMultiplier();
  const available = numericValue(availableMargin);
  const entry = numericValue(entryPrice);
  const leverage = Math.max(1, Number(sizing.leverage ?? 1));
  const desiredQuantity = floorQuantity(sizing.quantity);
  const desiredNotional = Number.isFinite(Number(sizing.notionalSize))
    ? Number(sizing.notionalSize)
    : desiredQuantity * Number(entryPrice);
  const desiredMarginRequired = desiredNotional / leverage;
  const desiredEstimatedRequiredMargin = desiredMarginRequired * feeBufferMultiplier;
  const maxAllowedRequiredMargin = available !== null ? available * marginUsageCap : null;
  const capApplied = maxAllowedRequiredMargin !== null && desiredEstimatedRequiredMargin > maxAllowedRequiredMargin;
  const cappedNotional = capApplied
    ? (maxAllowedRequiredMargin / feeBufferMultiplier) * leverage
    : desiredNotional;
  const cappedQuantity = floorQuantity(cappedNotional / Number(entryPrice));
  const finalNotional = cappedQuantity * Number(entryPrice);
  const finalMarginRequired = finalNotional / leverage;
  const finalEstimatedRequiredMargin = finalMarginRequired * feeBufferMultiplier;
  const slDistancePercent = Number(sizing.slDistancePercent ?? 0);
  const slDistance = entry !== null ? entry * slDistancePercent : null;
  const finalRiskAmount = finalNotional * slDistancePercent;
  const requestedRiskAmount = numericValue(sizing.riskAmount);
  const riskBasisValue = numericValue(riskBasis);
  const configuredRiskPercent = numericValue(riskPercent);
  const actualRiskPercentAfterCap = riskBasisValue !== null && riskBasisValue > 0
    ? finalRiskAmount / riskBasisValue * 100
    : null;
  const marginHeadroomAfterCap = available !== null ? available - finalEstimatedRequiredMargin : null;
  const capHeadroomAfterCap = maxAllowedRequiredMargin !== null ? maxAllowedRequiredMargin - finalEstimatedRequiredMargin : null;
  const minQty = Number(minQuantity);
  const minNotionalValue = Number(minNotional);
  const allowed = cappedQuantity > 0 &&
    (!Number.isFinite(minQty) || cappedQuantity >= minQty) &&
    (!Number.isFinite(minNotionalValue) || finalNotional >= minNotionalValue);

  return {
    allowed,
    accountBalanceUsed: riskBasisValue,
    accountRiskAmount: requestedRiskAmount,
    availableMargin: available,
    capApplied,
    capHeadroomAfterCap: numericValue(capHeadroomAfterCap),
    cappedQtyReason: capApplied
      ? "margin_safety_cap_applied"
      : allowed
        ? "account_risk_quantity_allowed"
        : "margin_safety_cap_below_min_order_size",
    desiredEstimatedRequiredMargin: numericValue(desiredEstimatedRequiredMargin),
    desiredMarginRequired: numericValue(desiredMarginRequired),
    desiredNotional: numericValue(desiredNotional),
    desiredQuantity,
    estimatedRequiredMarginAfterCap: numericValue(finalEstimatedRequiredMargin),
    feeBufferMultiplier,
    finalMarginRequired: numericValue(finalMarginRequired),
    finalNotional: numericValue(finalNotional),
    finalQuantity: cappedQuantity,
    finalQty: cappedQuantity,
    finalRiskAtSL: numericValue(finalRiskAmount),
    finalRiskAtSLPercentOfAccount: numericValue(actualRiskPercentAfterCap),
    marginHeadroomAfterCap: numericValue(marginHeadroomAfterCap),
    marginUsageCap,
    maxAllowedRequiredMargin: numericValue(maxAllowedRequiredMargin),
    minNotional: Number.isFinite(minNotionalValue) ? minNotionalValue : null,
    minQuantity: Number.isFinite(minQty) ? minQty : null,
    reason: allowed
      ? capApplied ? "margin_safety_cap_applied" : "margin_safety_cap_not_needed"
      : "margin_safety_cap_below_min_order_size",
    requestedRiskAmount,
    requestedRiskPercent: configuredRiskPercent,
    riskAmountAfterCap: numericValue(finalRiskAmount),
    riskBasis: riskBasisValue,
    riskPercentAfterCap: numericValue(actualRiskPercentAfterCap),
    rawQtyFromAccountRisk: desiredQuantity,
    sizing: {
      ...sizing,
      marginRequired: finalMarginRequired,
      notionalSize: finalNotional,
      quantity: cappedQuantity,
      riskAmount: finalRiskAmount,
    },
    slDistance: numericValue(slDistance),
  };
}

function buildLiveSetupEvent(setupEvent, profile) {
  const takeProfit = calculatedLiveTakeProfit({
    direction: setupEvent.direction,
    entryPrice: setupEvent.trigger,
    profile,
    stopLoss: setupEvent.stopLoss,
  });
  return withSetupFingerprint(
    {
      ...setupEvent,
      interval: profile.timeframe,
      symbol: profile.symbol,
      takeProfit,
    },
    {
      interval: profile.timeframe,
      strategyParameters: profile.strategyParameters,
      symbol: profile.symbol,
      takeProfit,
    },
  );
}

function getAvailableBalance(payload) {
  const balance = Array.isArray(payload) ? payload[0] : payload?.balance ?? payload;
  return Number(
    balance?.equity ??
      balance?.totalEquity ??
      balance?.totalMarginBalance ??
      balance?.balance ??
      balance?.availableBalance ??
      balance?.available ??
      balance?.availableMargin ??
      0,
  );
}

function balanceSnapshot(payload) {
  const balance = Array.isArray(payload) ? payload[0] : payload?.balance ?? payload ?? {};
  return {
    availableBalance: numericValue(balance?.availableBalance ?? balance?.available ?? balance?.balance),
    availableMargin: numericValue(balance?.availableMargin ?? balance?.availableBalance ?? balance?.available),
    balance: numericValue(balance?.balance),
    equity: numericValue(balance?.equity ?? balance?.totalEquity ?? balance?.totalMarginBalance),
    marginAsset: balance?.asset ?? balance?.currency ?? "USDT",
    raw: balance,
    usedMargin: numericValue(balance?.usedMargin ?? balance?.used ?? balance?.lockedMargin ?? balance?.freezedMargin),
  };
}

function availableMarginForExecution(payload, fallback = null) {
  const snapshot = balanceSnapshot(payload);
  return snapshot.availableMargin ?? snapshot.availableBalance ?? fallback ?? snapshot.equity ?? snapshot.balance ?? 0;
}

function triggerDistance({ direction, markPrice, triggerPrice }) {
  const mark = numericValue(markPrice);
  const trigger = numericValue(triggerPrice);
  if (mark === null || mark <= 0 || trigger === null) {
    return {
      distancePct: null,
      triggerAlreadyCrossed: false,
      triggerTooCloseToMark: false,
    };
  }
  const normalizedDirection = String(direction ?? "").toUpperCase();
  const distancePct = normalizedDirection === "SHORT"
    ? ((mark - trigger) / mark) * 100
    : ((trigger - mark) / mark) * 100;
  const triggerAlreadyCrossed = distancePct <= 0;
  const tooCloseThresholdPct = Number(process.env.BINGX_TRIGGER_TOO_CLOSE_PCT || 0.02);
  return {
    distancePct: Number(distancePct.toFixed(4)),
    triggerAlreadyCrossed,
    triggerTooCloseToMark: Math.abs(distancePct) <= tooCloseThresholdPct,
  };
}

async function safeDiagnosticCall(fn) {
  try {
    return {
      ok: true,
      value: await fn(),
    };
  } catch (error) {
    return {
      error: error?.bingx ?? { message: error instanceof Error ? error.message : String(error) },
      ok: false,
      value: null,
    };
  }
}

async function collectTriggerDiagnostics({
  balancePayload = null,
  bingxClient,
  direction,
  includeExchangeState = false,
  leverage = null,
  marginRequired = null,
  marginMode = null,
  notional = null,
  orderId = null,
  payload = null,
  priceService = null,
  quantity = null,
  setupFingerprint = "",
  symbol,
  triggerPrice,
} = {}) {
  const [markResult, lastResult, balanceResult] = await Promise.all([
    priceService
      ? safeDiagnosticCall(() => priceService.getPrice({ client: bingxClient, source: "bingx_mark", symbol }))
      : typeof bingxClient.getMarkPrice === "function"
        ? safeDiagnosticCall(() => bingxClient.getMarkPrice(symbol))
      : Promise.resolve({ ok: false, error: { message: "Mark price endpoint is not available in this client." }, value: null }),
    priceService
      ? safeDiagnosticCall(() => priceService.getPrice({ client: bingxClient, source: "bingx_last", symbol }))
      : typeof bingxClient.getLastPrice === "function"
        ? safeDiagnosticCall(() => bingxClient.getLastPrice(symbol))
      : Promise.resolve({ ok: false, error: { message: "Last price endpoint is not available in this client." }, value: null }),
    balancePayload
      ? Promise.resolve({ ok: true, value: balancePayload })
      : safeDiagnosticCall(() => bingxClient.getPerpetualFuturesBalance()),
  ]);
  const markPrice = extractMarketPrice(markResult.value);
  const lastPrice = extractMarketPrice(lastResult.value);
  const distance = triggerDistance({ direction, markPrice, triggerPrice });
  const available = balanceSnapshot(balanceResult.value);
  const requiredMargin = numericValue(marginRequired);
  const availableMargin = available.availableMargin;
  const marginHeadroom = availableMargin !== null && requiredMargin !== null
    ? availableMargin - requiredMargin
    : null;
  const marginHeadroomPct = availableMargin !== null && availableMargin > 0 && marginHeadroom !== null
    ? (marginHeadroom / availableMargin) * 100
    : null;
  const marginDiagnosticBufferPct = Number(process.env.SZTAB_MARGIN_DIAGNOSTIC_BUFFER_PCT || 2);
  const estimatedRequiredMarginWithBuffer = requiredMargin !== null
    ? requiredMargin * (1 + marginDiagnosticBufferPct / 100)
    : null;
  const warnings = [];
  if (distance.triggerAlreadyCrossed) warnings.push("trigger_already_crossed_before_order_send");
  if (distance.triggerTooCloseToMark) warnings.push("trigger_too_close_to_mark");
  if (availableMargin !== null && requiredMargin !== null && requiredMargin > availableMargin) {
    warnings.push("order_too_large_for_available_margin");
  } else if (availableMargin !== null && estimatedRequiredMarginWithBuffer !== null && estimatedRequiredMarginWithBuffer > availableMargin) {
    warnings.push("margin_headroom_below_diagnostic_buffer");
  }

  const diagnostics = {
    available,
    direction,
    distanceFromMarkToTriggerPct: distance.distancePct,
    estimatedRequiredMarginWithBuffer: numericValue(estimatedRequiredMarginWithBuffer),
    lastPrice,
    lastPriceRaw: lastResult.ok ? lastResult.value : lastResult.error,
    leverage,
    marginDiagnosticBufferPct,
    marginHeadroom: numericValue(marginHeadroom),
    marginHeadroomPct: numericValue(marginHeadroomPct),
    marginMode,
    marginRequired: requiredMargin,
    markPrice,
    markPriceRaw: markResult.ok ? markResult.value : markResult.error,
    notional: numericValue(notional),
    payload,
    quantity: numericValue(quantity),
    setupFingerprint,
    triggerAlreadyCrossed: distance.triggerAlreadyCrossed,
    triggerPrice: numericValue(triggerPrice),
    triggerTooCloseToMark: distance.triggerTooCloseToMark,
    orderTooLargeForAvailableMargin: availableMargin !== null && requiredMargin !== null && requiredMargin > availableMargin,
    warnings,
  };

  if (!includeExchangeState) return diagnostics;

  const [openOrders, positions, history] = await Promise.all([
    typeof bingxClient.getOpenOrders === "function"
      ? safeDiagnosticCall(() => bingxClient.getOpenOrders(symbol))
      : Promise.resolve({ ok: false, error: { message: "Open orders endpoint is not available in this client." }, value: null }),
    typeof bingxClient.getOpenPositions === "function"
      ? safeDiagnosticCall(() => bingxClient.getOpenPositions(symbol))
      : Promise.resolve({ ok: false, error: { message: "Positions endpoint is not available in this client." }, value: null }),
    typeof bingxClient.getOrderHistory === "function"
      ? safeDiagnosticCall(() => bingxClient.getOrderHistory(symbol, { orderId }))
      : Promise.resolve({ ok: false, error: { message: "Order history endpoint is not available in this client." }, value: null }),
  ]);

  return {
    ...diagnostics,
    orderHistoryLookup: history,
    openOrdersSnapshot: openOrders,
    positionsSnapshot: positions,
  };
}

function setupEventForTriggerOrder(strategyResult, profile = null) {
  const latestEntryEvent = strategyResult.latestEvent;
  const setupEvent = strategyResult.latestSetupEvent;
  const latestSetupContext = setupEvent && profile ? buildLiveSetupEvent(setupEvent, profile) : setupEvent;
  const setupCandidate = setupEventForPendingTrigger(strategyResult, profile);
  if (
    latestEntryEvent &&
    latestEntryEvent.type === STRATEGY_EVENT_TYPES.ENTRY_TRIGGERED &&
    Number.isFinite(Number(latestEntryEvent.trigger)) &&
    Number.isFinite(Number(latestEntryEvent.stopLoss))
  ) {
    const entryCandidate = profile ? buildLiveSetupEvent(latestEntryEvent, profile) : latestEntryEvent;
    const entryWithTriggerMetadata = {
      ...entryCandidate,
      strategyEventFingerprint: [
        STRATEGY_EVENT_TYPES.ENTRY_TRIGGERED,
        latestEntryEvent.setupId ?? "",
        latestEntryEvent.time ?? "",
        latestEntryEvent.trigger ?? "",
      ].join(":"),
      strategyEventTime: latestEntryEvent.time ?? null,
      strategyEventTrigger: true,
      triggerTruthSource: "strategy_event_closed_candle",
    };

    const setupContextIsSameOrNewer = timeValueMs(latestSetupContext?.time) === null ||
      timeValueMs(entryCandidate.time) === null ||
      timeValueMs(latestSetupContext?.time) >= timeValueMs(entryCandidate.time);
    if (
      latestSetupContext?.setupFingerprint &&
      entryCandidate.setupFingerprint &&
      entryCandidate.setupFingerprint !== latestSetupContext.setupFingerprint &&
      setupContextIsSameOrNewer
    ) {
      if (!setupCandidate) return null;
      return {
        ...setupCandidate,
        staleEntryIgnoredReason: "latest_entry_fingerprint_mismatch_with_current_setup",
        staleLatestEntryFingerprint: entryCandidate.setupFingerprint,
      };
    }

    return entryWithTriggerMetadata;
  }

  return setupCandidate;
}

function setupEventForPendingTrigger(strategyResult, profile = null) {
  const setupEvent = strategyResult.latestSetupEvent;
  if (
    !setupEvent ||
    ![STRATEGY_EVENT_TYPES.SETUP_ACTIVE, STRATEGY_EVENT_TYPES.BENCHMARK_CONFIRMED].includes(setupEvent.type) ||
    !Number.isFinite(Number(setupEvent.trigger)) ||
    !Number.isFinite(Number(setupEvent.stopLoss))
  ) {
    return null;
  }

  const fingerprintedSetup = profile ? buildLiveSetupEvent(setupEvent, profile) : setupEvent;
  const alreadyTriggered = (strategyResult.strategy?.events ?? []).some((event) => {
    if (event.type !== STRATEGY_EVENT_TYPES.ENTRY_TRIGGERED) return false;
    if (profile) {
      const fingerprintedEntry = buildLiveSetupEvent(event, profile);
      return Boolean(fingerprintedEntry.setupFingerprint && fingerprintedEntry.setupFingerprint === fingerprintedSetup.setupFingerprint);
    }
    return event.setupId === setupEvent.setupId;
  });

  if (alreadyTriggered) return null;
  return fingerprintedSetup;
}

function activePendingTriggerOrder(order) {
  if (!order) return null;
  return ["accepted", "placed", "new", "partially_filled", "pending_sync", "platform_armed"].includes(String(order.status ?? "").toLowerCase())
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
    "invalidated_before_fill",
    "market_sent_position_missing",
    "missing",
    "platform_blocked_existing_position",
    "platform_market_order_rejected",
    "rejected",
    "reversal_close_failed",
    "reversal_close_succeeded_entry_failed",
    "risk_blocked",
    "setup_invalidated_before_platform_trigger",
    "sl_protection_failed_emergency_closed",
    "sl_protection_failed_emergency_close_failed",
    "terminal_canceled",
    "terminal_cancelled",
    "terminal_expired",
    "terminal_failed",
    "terminal_rejected",
    "trigger_crossed_but_price_too_far",
    "trigger_order_rejected",
  ];
}

function numericValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function nearlyEqual(left, right, tolerance = 1e-6) {
  const a = numericValue(left);
  const b = numericValue(right);
  if (a === null || b === null) return false;
  return Math.abs(a - b) <= tolerance;
}

function pendingDirection(order = {}) {
  return String(order.direction ?? order.positionSide ?? order.side ?? "").toUpperCase().includes("SHORT")
    || String(order.side ?? "").toUpperCase() === "SELL"
    ? "SHORT"
    : "LONG";
}

function livePositionDirection(position = {}) {
  if (!position) return "";
  const raw = String(position.direction ?? position.positionSide ?? position.side ?? "").toUpperCase();
  if (raw.includes("SHORT") || raw === "SELL") return "SHORT";
  if (raw.includes("LONG") || raw === "BUY") return "LONG";
  return positionSideFromPosition(position);
}

function isOppositeDirection(left, right) {
  const normalizedLeft = String(left ?? "").toUpperCase();
  const normalizedRight = String(right ?? "").toUpperCase();
  return ["LONG", "SHORT"].includes(normalizedLeft) &&
    ["LONG", "SHORT"].includes(normalizedRight) &&
    normalizedLeft !== normalizedRight;
}

function pendingInvalidationPrice(order = {}) {
  return numericValue(order.invalidationPrice ?? order.stopLoss ?? order.entryEvent?.stopLoss);
}

function pendingTriggerPrice(order = {}) {
  return numericValue(order.triggerPrice ?? order.entryEvent?.trigger);
}

function pendingBenchmarkTime(order = {}) {
  return numericValue(order.benchmarkTime ?? order.entryEvent?.benchmarkTime ?? order.entryEvent?.time);
}

function eventFingerprintFromPendingContext(event = {}, pending = {}) {
  if (!event || !pending?.setupFingerprintInput) return null;
  return buildSetupFingerprint({
    interval: pending.setupFingerprintInput.interval,
    setup: {
      ...event,
      takeProfit: pending.setupFingerprintInput.takeProfit,
    },
    strategyParamsHash: pending.setupFingerprintInput.strategyParamsHash,
    symbol: pending.setupFingerprintInput.symbol,
    takeProfit: pending.setupFingerprintInput.takeProfit,
  }).id;
}

function pendingOrderMatchesSetup(pending = {}, setup = {}) {
  if (!pending || !setup) return false;
  if (pending.setupFingerprint || setup.setupFingerprint) {
    return sameSetupFingerprint(pending, setup);
  }
  return eventMatchesPendingSetup(setup, pending);
}

function eventMatchesPendingSetup(event = {}, pending = {}) {
  if (!event || !pending) return false;
  if (event.setupFingerprint || pending.setupFingerprint) {
    if (sameSetupFingerprint(event, pending)) return true;
    const eventFingerprint = eventFingerprintFromPendingContext(event, pending);
    return Boolean(eventFingerprint && pending.setupFingerprint && eventFingerprint === pending.setupFingerprint);
  }

  const direction = String(event.direction ?? "").toUpperCase();
  if (direction !== pendingDirection(pending)) return false;
  if (!nearlyEqual(event.trigger, pendingTriggerPrice(pending))) return false;
  if (!nearlyEqual(event.stopLoss, pendingInvalidationPrice(pending))) return false;

  const pendingTime = pendingBenchmarkTime(pending);
  const eventTime = numericValue(event.benchmarkTime ?? event.time);
  if (pendingTime !== null && eventTime !== null) {
    return Math.abs(eventTime - pendingTime) <= 60;
  }

  return true;
}

function pendingInvalidationEvent(strategyResult = {}, pending = {}) {
  return (strategyResult.strategy?.events ?? []).find(
    (event) =>
      event.type === STRATEGY_EVENT_TYPES.SETUP_INVALIDATED &&
      eventMatchesPendingSetup(event, pending),
  ) ?? null;
}

function extractMarketPrice(payload) {
  const candidates = [
    payload?.markPrice,
    payload?.indexPrice,
    payload?.price,
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

async function getPlatformTriggerPrice({ bingxClient, priceService = null, source = sztabPriceSource(), symbol }) {
  if (priceService) {
    const sample = await priceService.getPrice({ client: bingxClient, source, symbol });
    return {
      ageMs: sample.ageMs ?? null,
      degraded: Boolean(sample.degraded),
      lastError: sample.lastError ?? null,
      mode: sample.mode ?? "rest",
      price: numericValue(sample.price),
      raw: sample.raw,
      rateLimitCount: sample.rateLimitCount ?? 0,
      recentHigh: sample.recentHigh ?? null,
      recentLow: sample.recentLow ?? null,
      recentTicks: Array.isArray(sample.recentTicks) ? sample.recentTicks : [],
      source: sample.source ?? source,
      stale: Boolean(sample.stale),
      status: sample.status ?? "ok",
      time: sample.time ?? new Date().toISOString(),
      fallbackActive: Boolean(sample.fallbackActive),
      lastWebsocketTickAt: sample.lastWebsocketTickAt ?? null,
      websocketAgeMs: sample.websocketAgeMs ?? null,
      websocketConfigReason: sample.websocketConfigReason ?? "",
      websocketDisabledReason: sample.websocketDisabledReason ?? "",
      websocketError: sample.websocketError ?? "",
      websocketStatus: sample.websocketStatus ?? "unknown",
    };
  }

  if (source === "bingx_last") {
    const raw = await bingxClient.getLastPrice(symbol);
    return {
      price: extractMarketPrice(raw),
      raw,
      source,
      time: new Date().toISOString(),
    };
  }

  if (source === "binance_futures") {
    const params = new URLSearchParams({ symbol: compactSymbol(symbol) });
    const response = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?${params.toString()}`);
    const raw = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(raw?.msg || `Binance futures price request failed: ${response.status}`);
    }
    return {
      price: extractMarketPrice(raw),
      raw,
      source,
      time: new Date().toISOString(),
    };
  }

  const raw = await bingxClient.getMarkPrice(symbol);
  return {
    price: extractMarketPrice(raw),
    raw,
    source: "bingx_mark",
    time: new Date().toISOString(),
  };
}

function invalidationTouchedByPrice(pending = {}, price) {
  const marketPrice = numericValue(price);
  const invalidationPrice = pendingInvalidationPrice(pending);
  if (marketPrice === null || invalidationPrice === null) return false;
  return pendingDirection(pending) === "LONG"
    ? marketPrice <= invalidationPrice
    : marketPrice >= invalidationPrice;
}

function triggerTouchedByPrice(pending = {}, price) {
  const marketPrice = numericValue(price);
  const triggerPrice = pendingTriggerPrice(pending);
  if (marketPrice === null || triggerPrice === null) return false;
  return pendingDirection(pending) === "LONG"
    ? marketPrice >= triggerPrice
    : marketPrice <= triggerPrice;
}

function triggerTouchedByRecentTicks(pending = {}, ticks = []) {
  if (!Array.isArray(ticks) || ticks.length === 0) {
    return {
      ignoredPreEligibilityTriggerTicks: 0,
      touched: false,
      touchedAt: null,
    };
  }
  const armedAtMs = Date.parse(pending.armedAt ?? pending.updatedAt ?? 0);
  const eligibleFromMs = timeValueMs(pending.triggerEligibleFrom ?? pending.triggerEligibleFromIso ?? pending.setupCandleCloseTime);
  let ignoredPreEligibilityTriggerTicks = 0;
  let touchedAt = null;
  const touched = ticks.some((tick) => {
    const tickTime = Date.parse(tick?.time ?? 0);
    if (Number.isFinite(armedAtMs) && Number.isFinite(tickTime) && tickTime < armedAtMs) return false;
    const tickTouchesTrigger = triggerTouchedByPrice(pending, tick?.price);
    if (
      tickTouchesTrigger &&
      eligibleFromMs !== null &&
      Number.isFinite(tickTime) &&
      tickTime < eligibleFromMs
    ) {
      ignoredPreEligibilityTriggerTicks += 1;
      return false;
    }
    if (tickTouchesTrigger) {
      touchedAt = tick?.time ?? null;
      return true;
    }
    return false;
  });
  return {
    ignoredPreEligibilityTriggerTicks,
    touched,
    touchedAt,
  };
}

function triggerSlippagePct(pending = {}, price) {
  const marketPrice = numericValue(price);
  const triggerPrice = pendingTriggerPrice(pending);
  if (marketPrice === null || triggerPrice === null || triggerPrice <= 0) return null;
  return Math.abs(marketPrice - triggerPrice) / triggerPrice * 100;
}

async function cancelPendingTriggerIfInvalidated({
  bingxClient,
  logger = async () => {},
  priceService = null,
  profile,
  strategyResult,
}) {
  let updatedProfile = structuredClone(profile);
  let pending = activePendingTriggerOrder(updatedProfile.live?.pendingTriggerOrder);
  if (!pending) return updatedProfile;

  const platformMode = String(pending.executionMode ?? "").toLowerCase() === "platform_market_trigger";
  const strategyInvalidation = pendingInvalidationEvent(strategyResult, pending);
  if (platformMode && !strategyInvalidation && String(pending.invalidationSource ?? "").toLowerCase() === "mark_price") {
    updatedProfile.live.pendingTriggerOrder = {
      ...pending,
      invalidationSource: "ignored_legacy_mark_price",
      legacyMarkPriceInvalidationIgnoredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await logger("ignored legacy mark_price invalidation in platform_market_trigger mode", {
      fingerprint: pending.setupFingerprint,
      mode: "live",
      profileId: updatedProfile.id,
      setupId: pending.setupId,
    });
    return updatedProfile;
  }

  const invalidation = strategyInvalidation
    ? {
        event: strategyInvalidation,
        invalidationPrice: numericValue(strategyInvalidation.stopLoss),
        invalidationSource: "strategy_closed_candle",
        invalidationTime: strategyInvalidation.time ?? null,
        markPrice: null,
        raw: null,
      }
    : null;

  if (!invalidation) return updatedProfile;

  await logger("pending trigger invalidated before fill", {
    fingerprint: pending.setupFingerprint,
    invalidationPrice: invalidation.invalidationPrice,
    invalidationSource: invalidation.invalidationSource,
    invalidationTime: invalidation.invalidationTime,
    markPrice: invalidation.markPrice,
    mode: "live",
    orderId: pending.orderId ?? null,
    profileId: updatedProfile.id,
    setupId: pending.setupId,
  });

  const terminalStatus = platformMode ? "setup_invalidated_before_platform_trigger" : "invalidated_before_fill";
  const terminalReason = platformMode ? "setup_invalidated_before_platform_trigger" : "setup_invalidated_before_fill";

  updatedProfile = await cancelLivePendingTriggerOrder({
    bingxClient,
    extraJournal: {
      invalidationPrice: invalidation.invalidationPrice,
      invalidationSource: invalidation.invalidationSource,
      invalidationTime: invalidation.invalidationTime,
      markPrice: invalidation.markPrice,
      setupFingerprint: pending.setupFingerprint,
      setupFingerprintShort: pending.setupFingerprintShort,
    },
    extraPending: {
      invalidatedAt: new Date().toISOString(),
      invalidationEvent: invalidation.event,
      invalidationPrice: invalidation.invalidationPrice,
      invalidationSource: invalidation.invalidationSource,
      invalidationTime: invalidation.invalidationTime,
      markPriceAtInvalidation: invalidation.markPrice,
    },
    failureClassification: terminalReason,
    journalEvent: platformMode ? "setup_invalidated_by_strategy" : "setup_invalidated_before_fill",
    logger,
    profile: updatedProfile,
    reason: terminalReason,
    terminalReason,
    terminalStatus,
  });

  return updatedProfile;
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
  if (Array.isArray(value?.data?.positions)) return value.data.positions;
  if (Array.isArray(value?.data?.orders)) return value.data.orders;
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

function diagnosticText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function classifyTriggerFailureCandidate({ failureDiagnostics = {}, pending = {}, statusResponse = null } = {}) {
  const combinedText = [
    diagnosticText(statusResponse),
    diagnosticText(failureDiagnostics.orderHistoryLookup?.value),
    diagnosticText(failureDiagnostics.orderHistoryLookup?.error),
  ].join(" ").toLowerCase();

  if (/insufficient|insuffisant|marge|margin|101204|not enough|risk forbidden|80020/u.test(combinedText)) {
    return "margin_unavailable";
  }
  if (pending.placementDiagnostics?.triggerAlreadyCrossed || failureDiagnostics.triggerAlreadyCrossed) {
    return "trigger_price_invalid_or_crossed";
  }
  if (/minimum|min nominal|min(?:imum)?\s+(?:qty|quantity|notional)|order size|invalid\s+(?:qty|quantity|precision|tick)|precision error|tick size|101400/u.test(combinedText)) {
    return "precision_or_min_qty";
  }
  const distance = Math.abs(Number(failureDiagnostics.distanceFromMarkToTriggerPct));
  const movedTooFarThreshold = Number(process.env.BINGX_TRIGGER_FAIL_MOVED_TOO_FAR_PCT || 2);
  if (Number.isFinite(distance) && distance >= movedTooFarThreshold) {
    return "market_moved_too_far";
  }
  return "unknown_exchange_failed";
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

function isPlatformMarketTriggerPending(order = {}) {
  return String(order?.executionMode ?? "").toLowerCase() === "platform_market_trigger" &&
    String(order?.status ?? "").toLowerCase() === "platform_armed";
}

function positionEntryPrice(position = {}) {
  const candidates = [
    position.avgPrice,
    position.averagePrice,
    position.entryPrice,
    position.positionAvgPrice,
    position.price,
  ];
  for (const candidate of candidates) {
    const value = numericValue(candidate);
    if (value !== null && value > 0) return value;
  }
  return null;
}

function platformTriggerTerminalUpdate(pending = {}, patch = {}) {
  return {
    ...pending,
    canArmNextSetup: patch.canArmNextSetup ?? true,
    orderLifecycle: [
      ...(pending.orderLifecycle ?? []),
      {
        diagnostics: patch.diagnostics ?? null,
        exchangeResponse: patch.exchangeResponse ?? null,
        message: patch.message,
        status: patch.status,
        time: new Date().toISOString(),
      },
    ].slice(-20),
    status: patch.status,
    terminal: patch.terminal ?? true,
    terminalReason: patch.terminalReason ?? patch.reason ?? patch.status,
    updatedAt: new Date().toISOString(),
    ...patch.extraPending,
  };
}

function classifyCancelOpenOrdersFailure(error) {
  const text = [
    error instanceof Error ? error.message : String(error ?? ""),
    responseText(error?.bingx),
    responseText(error?.payload),
  ].join(" ").toLowerCase();
  if (/correct request method|request method.*delete|method.*delete/u.test(text)) {
    return "cancel_open_orders_method_error";
  }
  if (/429|too many requests|rate limit|timeout|abort|network|temporar|econnreset|etimedout/u.test(text)) {
    return "cancel_open_orders_failed_transient";
  }
  return "cancel_open_orders_failed_exchange";
}

async function cleanupOpenOrdersBestEffort({
  bingxClient,
  logger = async () => {},
  profile,
  reason = "cleanup",
  setupId = null,
}) {
  try {
    const response = await bingxClient.cancelOpenOrders(profile.symbol);
    return {
      classification: "cancel_open_orders_ok",
      ok: true,
      reason,
      response,
      time: new Date().toISOString(),
    };
  } catch (error) {
    const classification = classifyCancelOpenOrdersFailure(error);
    const exchangeResponse = error?.bingx ?? error?.payload ?? { message: error instanceof Error ? error.message : String(error) };
    const warning = {
      classification,
      exchangeResponse,
      message: "Nie udało się anulować starych zleceń na BingX — runner działa dalej / wymaga kontroli",
      ok: false,
      reason,
      setupId,
      time: new Date().toISOString(),
    };
    profile.live = {
      orderLog: [],
      setupOrderJournal: [],
      ...(profile.live ?? {}),
      lastCleanupWarning: warning,
      lastCleanupWarningAt: warning.time,
    };
    appendSetupOrderJournal(profile, {
      event: "cancel_open_orders_cleanup_failed",
      exchangeResponseSummary: summarizeExchangeResponse(exchangeResponse),
      failureClassification: classification,
      interval: profile.timeframe,
      reason,
      setupId,
      status: classification,
    });
    await logger("cancel open orders cleanup failed; runner continues", {
      classification,
      exchangeResponse,
      mode: "live",
      profileId: profile.id,
      reason,
      setupId,
    });
    return warning;
  }
}

function pendingReversalContext(pending = {}, profile = {}) {
  if (!pending?.isReversal) return null;
  const sourcePosition = pending.reversalFromPosition ?? profile.live?.openPosition ?? null;
  const fromDirection = livePositionDirection(sourcePosition) || pending.reversalFromDirection;
  const toDirection = pendingDirection(pending);
  if (!isOppositeDirection(fromDirection, toDirection)) return null;
  return {
    fromDirection,
    sourcePosition,
    toDirection,
  };
}

async function closeLivePositionForReversal({
  baseDiagnostics = {},
  bingxClient,
  logger = async () => {},
  markPrice = null,
  pending = {},
  positionsBefore = [],
  priceSource = "",
  profile,
  sample = {},
  store,
}) {
  let updatedProfile = structuredClone(profile);
  const context = pendingReversalContext(pending, updatedProfile);
  if (!context) {
    return { closed: false, profile: updatedProfile, reason: "reversal_context_missing" };
  }

  const oldExchangePosition = matchingExchangePosition(positionsBefore, {
    positionSide: context.fromDirection,
    symbol: updatedProfile.symbol,
  });

  if (!oldExchangePosition) {
    updatedProfile.live.pendingTriggerOrder = platformTriggerTerminalUpdate(pending, {
      diagnostics: { ...baseDiagnostics, positionsBefore },
      extraPending: {
        canArmNextSetup: true,
        critical: "reversal_close_failed",
        platformTriggerDiagnostics: baseDiagnostics,
        reversalReason: "live_reversal_trigger_crossed",
        reversalStatus: "close_failed_position_missing",
        skippedReason: "reversal_close_failed",
        triggerCrossed: true,
        triggerCrossedAt: sample.time,
      },
      message: "Opposite trigger crossed, but the existing live position was not found on BingX; reversal was not opened.",
      reason: "reversal_close_failed",
      status: "reversal_close_failed",
    });
    appendSetupOrderJournal(updatedProfile, {
      event: "reversal_close_failed",
      failureClassification: "reversal_position_missing_before_close",
      interval: updatedProfile.timeframe,
      markPrice,
      priceSource,
      quantity: pending.quantity,
      reason: "reversal_position_missing_before_close",
      reversalFromDirection: context.fromDirection,
      setupFingerprint: pending.setupFingerprint,
      setupFingerprintShort: pending.setupFingerprintShort,
      setupId: pending.setupId,
      side: pending.side,
      status: "reversal_close_failed",
      triggerPrice: pending.triggerPrice,
    });
    await logger("reversal close failed; existing position missing", {
      fingerprint: pending.setupFingerprint,
      mode: "live",
      profileId: updatedProfile.id,
      setupId: pending.setupId,
    });
    return { closed: false, profile: updatedProfile, reason: "reversal_position_missing_before_close" };
  }

  let closeResponse = null;
  try {
    closeResponse = await bingxClient.closePosition(updatedProfile.symbol, {
      position: oldExchangePosition,
      positionSide: context.fromDirection,
    });
  } catch (error) {
    closeResponse = error?.bingx ?? { message: error instanceof Error ? error.message : String(error) };
    updatedProfile.live.pendingTriggerOrder = platformTriggerTerminalUpdate(pending, {
      diagnostics: { ...baseDiagnostics, closeResponse, oldExchangePosition },
      exchangeResponse: closeResponse,
      extraPending: {
        canArmNextSetup: true,
        critical: "reversal_close_failed",
        platformTriggerDiagnostics: baseDiagnostics,
        reversalCloseResponse: closeResponse,
        reversalReason: "live_reversal_trigger_crossed",
        reversalStatus: "close_failed",
        skippedReason: "reversal_close_failed",
        triggerCrossed: true,
        triggerCrossedAt: sample.time,
      },
      message: "Opposite trigger crossed, but closing the existing live position failed. New position was not opened.",
      reason: "reversal_close_failed",
      status: "reversal_close_failed",
    });
    appendSetupOrderJournal(updatedProfile, {
      event: "reversal_close_failed",
      exchangeResponseSummary: summarizeExchangeResponse(closeResponse),
      interval: updatedProfile.timeframe,
      markPrice,
      priceSource,
      quantity: pending.quantity,
      reason: "reversal_close_failed",
      reversalFromDirection: context.fromDirection,
      setupFingerprint: pending.setupFingerprint,
      setupFingerprintShort: pending.setupFingerprintShort,
      setupId: pending.setupId,
      side: pending.side,
      status: "reversal_close_failed",
      triggerPrice: pending.triggerPrice,
    });
    await logger("reversal close failed", {
      error: error instanceof Error ? error.message : String(error),
      fingerprint: pending.setupFingerprint,
      mode: "live",
      profileId: updatedProfile.id,
      setupId: pending.setupId,
    });
    return { closed: false, closeResponse, profile: updatedProfile, reason: "reversal_close_failed" };
  }

  const positionsAfterClose = normalizeExchangeList(await bingxClient.getOpenPositions(updatedProfile.symbol));
  const remainingOldPosition = matchingExchangePosition(positionsAfterClose, {
    positionSide: context.fromDirection,
    symbol: updatedProfile.symbol,
  });

  if (remainingOldPosition) {
    updatedProfile.live.pendingTriggerOrder = platformTriggerTerminalUpdate(pending, {
      diagnostics: { ...baseDiagnostics, closeResponse, remainingOldPosition },
      exchangeResponse: closeResponse,
      extraPending: {
        canArmNextSetup: true,
        critical: "reversal_close_failed",
        platformTriggerDiagnostics: baseDiagnostics,
        reversalCloseResponse: closeResponse,
        reversalReason: "live_reversal_trigger_crossed",
        reversalStatus: "close_not_confirmed",
        skippedReason: "reversal_close_failed",
        triggerCrossed: true,
        triggerCrossedAt: sample.time,
      },
      message: "Opposite trigger crossed, but fresh BingX sync still shows the old position. New position was not opened.",
      reason: "reversal_close_failed",
      status: "reversal_close_failed",
    });
    appendSetupOrderJournal(updatedProfile, {
      event: "reversal_close_failed",
      exchangeResponseSummary: summarizeExchangeResponse(closeResponse),
      interval: updatedProfile.timeframe,
      markPrice,
      priceSource,
      quantity: pending.quantity,
      reason: "reversal_close_not_confirmed",
      reversalFromDirection: context.fromDirection,
      setupFingerprint: pending.setupFingerprint,
      setupFingerprintShort: pending.setupFingerprintShort,
      setupId: pending.setupId,
      side: pending.side,
      status: "reversal_close_failed",
      triggerPrice: pending.triggerPrice,
    });
    return { closed: false, closeResponse, profile: updatedProfile, reason: "reversal_close_not_confirmed" };
  }

  const now = new Date().toISOString();
  const exitTime = Math.floor(Date.now() / 1000);
  const exitPrice = numericValue(markPrice) ?? numericValue(pending.triggerPrice) ?? context.sourcePosition?.entryPrice ?? 0;
  if (context.sourcePosition) {
    const closed = closePaperPosition({
      candle: { close: exitPrice },
      event: {
        exitPrice,
        exitReason: "REVERSAL",
        time: exitTime,
      },
      position: context.sourcePosition,
    });
    await store.upsertTrade({
      id: `live-${context.sourcePosition.setupId ?? "position"}-${exitTime}-reversal`,
      direction: context.sourcePosition.direction ?? context.fromDirection,
      entryPrice: context.sourcePosition.entryPrice,
      entryTime: context.sourcePosition.entryTime,
      exitPrice: closed.exitPrice,
      exitReason: "REVERSAL",
      exitTime,
      mode: "live",
      pnl: closed.pnl,
      profileId: updatedProfile.id,
      symbol: updatedProfile.symbol,
    });
  }

  const protectionCleanup = await cleanupOpenOrdersBestEffort({
    bingxClient,
    logger,
    profile: updatedProfile,
    reason: "reversal_old_protection_cleanup",
    setupId: pending.setupId,
  });
  const protectionCancelResponse = protectionCleanup.response ?? protectionCleanup.exchangeResponse ?? null;
  const protectionCancelError = protectionCleanup.ok ? "" : protectionCleanup.classification;

  updatedProfile.live.openPosition = null;
  updatedProfile.live.pendingTriggerOrder = {
    ...pending,
    lastMarkPrice: markPrice,
    lastPriceRaw: sample.raw,
    lastPriceSource: priceSource,
    lastPriceTime: sample.time,
    orderLifecycle: [
      ...(pending.orderLifecycle ?? []),
      {
        diagnostics: { ...baseDiagnostics, closeResponse, protectionCancelError, protectionCancelResponse, protectionCleanup },
        exchangeResponse: closeResponse,
        message: "Przeciwny trigger przebity — zamykam starą pozycję przed otwarciem nowej.",
        status: "live_reversal_trigger_crossed",
        time: now,
      },
    ].slice(-20),
    platformTriggerDiagnostics: baseDiagnostics,
    reversalCloseConfirmedAt: now,
    reversalCloseResponse: closeResponse,
    reversalProtectionCleanup: protectionCleanup,
    reversalProtectionCancelError: protectionCancelError,
    reversalProtectionCancelResponse: protectionCancelResponse,
    reversalReason: "live_reversal_trigger_crossed",
    reversalStatus: "old_position_closed",
    triggerCrossed: true,
    triggerCrossedAt: sample.time,
    updatedAt: now,
  };
  appendSetupOrderJournal(updatedProfile, {
    event: "live_reversal_trigger_crossed",
    exchangeResponseSummary: summarizeExchangeResponse(closeResponse),
    interval: updatedProfile.timeframe,
    markPrice,
    priceSource,
    quantity: pending.quantity,
    reason: "live_reversal_trigger_crossed",
    reversalFromDirection: context.fromDirection,
    setupFingerprint: pending.setupFingerprint,
    setupFingerprintShort: pending.setupFingerprintShort,
    setupId: pending.setupId,
    side: pending.side,
    status: "old_position_closed",
    triggerPrice: pending.triggerPrice,
  });
  await logger("live reversal old position closed", {
    fingerprint: pending.setupFingerprint,
    fromDirection: context.fromDirection,
    mode: "live",
    profileId: updatedProfile.id,
    setupId: pending.setupId,
    toDirection: context.toDirection,
  });

  return {
    closed: true,
    closeResponse,
    fromDirection: context.fromDirection,
    oldExchangePosition,
    profile: updatedProfile,
    protectionCancelError,
    protectionCancelResponse,
  };
}

export async function cancelLivePendingTriggerOrder({
  bingxClient,
  extraJournal = {},
  extraPending = {},
  failureClassification: requestedFailureClassification = "",
  journalEvent = "",
  logger = async () => {},
  profile,
  reason = "cancelled",
  supersededBySetupFingerprint = null,
  supersededBySetupId = null,
  terminalReason: requestedTerminalReason = "",
  terminalStatus = "",
}) {
  const updatedProfile = structuredClone(profile);
  let pending = activePendingTriggerOrder(updatedProfile.live?.pendingTriggerOrder);

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

  const cancelSucceeded = status === "cancelled";
  const finalStatus = cancelSucceeded && terminalStatus ? terminalStatus : status;
  const finalTerminalReason = cancelSucceeded && requestedTerminalReason ? requestedTerminalReason : terminalReason;
  const finalFailureClassification = cancelSucceeded && requestedFailureClassification ? requestedFailureClassification : failureClassification;
  const finalJournalEvent = cancelSucceeded && journalEvent
    ? journalEvent
    : status === "cancel_failed"
      ? "cancel_failed"
      : status === "missing"
        ? "order_missing"
        : "order_canceled";

  updatedProfile.live.pendingTriggerOrder = {
    ...pending,
    canArmNextSetup: true,
    cancelReason: reason,
    cancelResponse,
    exchangeTerminalStatus: status === "cancelled" ? "CANCELED" : status === "missing" ? "ORDER_NOT_EXIST" : "CANCEL_FAILED",
    failureClassification: finalFailureClassification,
    lastExchangeStatus: status === "cancelled" ? "CANCELED" : status === "missing" ? "ORDER_NOT_EXIST" : "CANCEL_FAILED",
    orderLifecycle: [
      ...(pending.orderLifecycle ?? []),
      {
        exchangeResponse: cancelResponse,
        message: finalStatus === "invalidated_before_fill"
          ? "Pending trigger order cancelled because setup invalidated before fill."
          : status === "cancelled"
            ? `Pending trigger order cancelled: ${reason}.`
            : status === "missing"
              ? `Pending trigger order missing on exchange: ${reason}.`
              : `Pending trigger cancel failed: ${reason}.`,
        status: finalStatus,
        time: new Date().toISOString(),
      },
    ],
    status: finalStatus,
    supersededBySetupFingerprint,
    supersededBySetupId,
    terminal: status !== "cancel_failed",
    terminalReason: finalTerminalReason,
    updatedAt: new Date().toISOString(),
    ...extraPending,
  };
  appendSetupOrderJournal(updatedProfile, {
    event: finalJournalEvent,
    exchangeResponseSummary: summarizeExchangeResponse(cancelResponse),
    failureClassification: finalFailureClassification,
    interval: updatedProfile.timeframe,
    orderId: pending.orderId ?? null,
    reason,
    setupFingerprint: pending.setupFingerprint,
    setupFingerprintShort: pending.setupFingerprintShort,
    setupId: pending.setupId,
    side: pending.side,
    status: finalStatus,
    supersededBySetupFingerprint,
    supersededBySetupId,
    triggerPrice: pending.triggerPrice,
    ...extraJournal,
  });

  return updatedProfile;
}

async function processPlatformMarketTrigger({
  bingxClient,
  logger = async () => {},
  priceService = null,
  profile,
  store,
}) {
  let updatedProfile = structuredClone(profile);
  let pending = activePendingTriggerOrder(updatedProfile.live?.pendingTriggerOrder);
  if (!isPlatformMarketTriggerPending(pending)) return updatedProfile;

  const priceSource = pending.priceSource ?? sztabStrategyPriceSource();
  const strategyEventTrigger = pending.strategyEventTrigger === true ||
    pending.triggerTruthSource === "strategy_event_closed_candle";
  let sample = null;
  try {
    sample = await getPlatformTriggerPrice({
      bingxClient,
      priceService,
      source: priceSource,
      symbol: updatedProfile.symbol,
    });
  } catch (error) {
    if (strategyEventTrigger) {
      sample = {
        ageMs: null,
        degraded: false,
        lastError: null,
        mode: "strategy_event",
        price: pendingTriggerPrice(pending),
        raw: { reason: "strategy_event_triggered_price_fallback" },
        rateLimitCount: 0,
        source: "strategy_event_closed_candle",
        stale: false,
        status: "ok",
        time: new Date().toISOString(),
        websocketStatus: "not_required",
      };
    } else {
      const message = error instanceof Error ? error.message : String(error);
      updatedProfile.live.pendingTriggerOrder = {
        ...pending,
        lastPriceError: message,
        platformTriggerDiagnostics: {
          ...(pending.platformTriggerDiagnostics ?? {}),
          error: error?.details ?? { message },
          priceFeedStatus: "degraded",
          priceSource,
        },
        lastStatusCheckAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await logger("platform trigger price sample failed", {
        error: message,
        mode: "live",
        priceSource,
        profileId: updatedProfile.id,
        setupId: pending.setupId,
      });
      return updatedProfile;
    }
  }

  const markPrice = numericValue(sample.price);
  const priceFeed = {
    ageMs: sample.ageMs ?? null,
    degraded: Boolean(sample.degraded),
    fallbackActive: Boolean(sample.fallbackActive),
    lastError: sample.lastError ?? null,
    lastWebsocketTickAt: sample.lastWebsocketTickAt ?? null,
    mode: sample.mode ?? "rest",
    rateLimitCount: sample.rateLimitCount ?? 0,
    stale: Boolean(sample.stale),
    status: sample.status ?? (sample.degraded ? "degraded" : "ok"),
    websocketAgeMs: sample.websocketAgeMs ?? null,
    websocketConfigReason: sample.websocketConfigReason ?? "",
    websocketDisabledReason: sample.websocketDisabledReason ?? "",
    websocketError: sample.websocketError ?? "",
    websocketStatus: sample.websocketStatus ?? "unknown",
  };
  const maxStaleMs = Number(process.env.SZTAB_PRICE_MAX_STALE_MS || 3_000);
  const diagnosticInvalidationTouched = invalidationTouchedByPrice(pending, markPrice);
  const touchedInvalidation = false;
  const triggerEligibility = triggerEligibilityDiagnostics(pending, sample);
  const recentTickTrigger = triggerTouchedByRecentTicks(pending, sample.recentTicks);
  const currentPriceTriggerTouched = triggerEligibility.sampleEligible && triggerTouchedByPrice(pending, markPrice);
  const preEligibilitySampleTriggerTouched = !triggerEligibility.sampleEligible && triggerTouchedByPrice(pending, markPrice);
  const recentTickTriggerTouched = recentTickTrigger.touched;
  const ignoredPreEligibilityTriggerTicks = recentTickTrigger.ignoredPreEligibilityTriggerTicks +
    (preEligibilitySampleTriggerTouched ? 1 : 0);
  const touchedTrigger = strategyEventTrigger || currentPriceTriggerTouched || recentTickTriggerTouched;
  const slippagePct = triggerSlippagePct(pending, markPrice);
  const maxSlippagePct = Number(pending.maxSlippagePct ?? maxTriggerSlippagePct());
  const baseDiagnostics = {
    executionMode: "platform_market_trigger",
    ignoredPreEligibilityTriggerTicks,
    invalidationPrice: pendingInvalidationPrice(pending),
    markPrice,
    maxSlippagePct,
    priceRaw: sample.raw,
    recentHigh: sample.recentHigh ?? null,
    recentLow: sample.recentLow ?? null,
    priceFeed,
    priceSource: sample.source,
    priceTime: sample.time,
    slippagePct: numericValue(slippagePct),
    strategyEventFingerprint: pending.strategyEventFingerprint ?? null,
    strategyEventTrigger,
    triggerEligibleFrom: triggerEligibility.triggerEligibleFrom,
    triggerEligibleFromIso: triggerEligibility.triggerEligibleFromIso,
    triggerSampleEligible: triggerEligibility.sampleEligible,
    triggerTruthSource: strategyEventTrigger ? "strategy_event_closed_candle" : "binance_futures_live_price",
    diagnosticInvalidationTouched,
    recentTickTriggerTouched,
    recentTickTriggerTouchedAt: recentTickTrigger.touchedAt,
    touchedInvalidation,
    touchedTrigger,
    triggerPrice: pendingTriggerPrice(pending),
  };

  if (sample.stale || (priceFeed.ageMs !== null && priceFeed.ageMs > maxStaleMs)) {
    updatedProfile.live.pendingTriggerOrder = {
      ...pending,
      lastMarkPrice: markPrice,
      lastPriceError: priceFeed.lastError?.message ?? "",
      lastPriceRaw: sample.raw,
      lastPriceSource: sample.source,
      lastPriceTime: sample.time,
      lastStatusCheckAt: new Date().toISOString(),
      platformTriggerDiagnostics: {
        ...baseDiagnostics,
        skippedReason: "price_feed_degraded",
      },
      skippedReason: "price_feed_degraded",
      updatedAt: new Date().toISOString(),
    };
    await logger("platform trigger price feed degraded; waiting for fresh price", {
      ageMs: priceFeed.ageMs,
      fingerprint: pending.setupFingerprint,
      mode: "live",
      priceSource,
      profileId: updatedProfile.id,
      rateLimitCount: priceFeed.rateLimitCount,
      setupId: pending.setupId,
    });
    return updatedProfile;
  }

  if (!touchedTrigger) {
    updatedProfile.live.pendingTriggerOrder = {
      ...pending,
      lastMarkPrice: markPrice,
      lastPriceRaw: sample.raw,
      lastPriceSource: sample.source,
      lastPriceTime: sample.time,
      lastStatusCheckAt: new Date().toISOString(),
      platformTriggerDiagnostics: baseDiagnostics,
      ignoredPreEligibilityTriggerTicks,
      triggerCrossed: false,
      updatedAt: new Date().toISOString(),
    };
    return updatedProfile;
  }

  if (!strategyEventTrigger && slippagePct !== null && slippagePct > maxSlippagePct) {
    updatedProfile.live.pendingTriggerOrder = platformTriggerTerminalUpdate(pending, {
      diagnostics: baseDiagnostics,
      extraPending: {
        canArmNextSetup: true,
        lastMarkPrice: markPrice,
        lastPriceRaw: sample.raw,
        lastPriceSource: sample.source,
        lastPriceTime: sample.time,
        platformTriggerDiagnostics: baseDiagnostics,
        skippedReason: "trigger_crossed_but_price_too_far",
        triggerCrossed: true,
        triggerCrossedAt: sample.time,
        triggerSlippagePct: numericValue(slippagePct),
      },
      message: "Platform trigger crossed, but price moved too far from trigger; market entry skipped.",
      reason: "trigger_crossed_but_price_too_far",
      status: "trigger_crossed_but_price_too_far",
    });
    appendSetupOrderJournal(updatedProfile, {
      event: "trigger_crossed_but_price_too_far",
      failureClassification: "trigger_crossed_but_price_too_far",
      interval: updatedProfile.timeframe,
      markPrice,
      maxSlippagePct,
      priceSource: sample.source,
      quantity: pending.quantity,
      reason: "trigger_crossed_but_price_too_far",
      setupFingerprint: pending.setupFingerprint,
      setupFingerprintShort: pending.setupFingerprintShort,
      setupId: pending.setupId,
      side: pending.side,
      slippagePct,
      status: "trigger_crossed_but_price_too_far",
      triggerPrice: pending.triggerPrice,
    });
    await logger("platform trigger crossed but skipped by slippage", {
      fingerprint: pending.setupFingerprint,
      markPrice,
      maxSlippagePct,
      mode: "live",
      priceSource: sample.source,
      profileId: updatedProfile.id,
      setupId: pending.setupId,
      slippagePct,
    });
    return updatedProfile;
  }

  const reversalContext = pendingReversalContext(pending, updatedProfile);
  const positionsBefore = normalizeExchangeList(await bingxClient.getOpenPositions(updatedProfile.symbol));
  const existingPosition = matchingExchangePosition(positionsBefore, {
    positionSide: pending.positionSide,
    symbol: updatedProfile.symbol,
  });
  if (existingPosition) {
    updatedProfile.live.pendingTriggerOrder = platformTriggerTerminalUpdate(pending, {
      diagnostics: { ...baseDiagnostics, position: existingPosition },
      extraPending: {
        canArmNextSetup: false,
        platformTriggerDiagnostics: baseDiagnostics,
        skippedReason: "live_position_exists_before_platform_market",
      },
      message: "Platform trigger crossed, but a matching live position already exists; market entry skipped.",
      reason: "live_position_exists_before_platform_market",
      status: "platform_blocked_existing_position",
    });
    appendSetupOrderJournal(updatedProfile, {
      event: "platform_blocked_existing_position",
      interval: updatedProfile.timeframe,
      markPrice,
      priceSource: sample.source,
      reason: "live_position_exists_before_platform_market",
      setupFingerprint: pending.setupFingerprint,
      setupFingerprintShort: pending.setupFingerprintShort,
      setupId: pending.setupId,
      side: pending.side,
      status: "platform_blocked_existing_position",
      triggerPrice: pending.triggerPrice,
    });
    return updatedProfile;
  }

  const balancePayload = await bingxClient.getPerpetualFuturesBalance();
  const accountBalanceUsed = getAvailableBalance(balancePayload);
  const availableMargin = availableMarginForExecution(balancePayload, accountBalanceUsed);
  const sizing = calculatePaperPositionSize({
    entryPrice: pending.triggerPrice,
    equity: accountBalanceUsed,
    risk: updatedProfile.risk,
    stopLoss: pending.stopLoss,
  });
  const marginSafety = applyLiveMarginSafetyBuffer({
    availableMargin,
    entryPrice: markPrice ?? pending.triggerPrice,
    minNotional: Number(process.env.SZTAB_MIN_ORDER_NOTIONAL_USDT || 5),
    minQuantity: Number(process.env.SZTAB_MIN_ORDER_QTY || 0.001),
    riskBasis: accountBalanceUsed,
    riskPercent: updatedProfile.risk?.riskPerTradePercent,
    sizing,
  });
  const finalSizing = marginSafety.sizing;
  const quantity = Number(finalSizing.quantity.toFixed(3));
  const order = {
    ...finalSizing,
    desiredMarginRequired: sizing.marginRequired,
    desiredNotionalSize: sizing.notionalSize,
    desiredQuantity: Number(sizing.quantity.toFixed(3)),
    direction: pending.direction,
    entryPrice: pending.triggerPrice,
    marginSafety,
    quantity,
    setupFingerprint: pending.setupFingerprint,
    setupFingerprintShort: pending.setupFingerprintShort,
    stopLoss: pending.stopLoss,
    takeProfit: pending.takeProfit ?? null,
  };

  if (!marginSafety.allowed) {
    updatedProfile.live.pendingTriggerOrder = platformTriggerTerminalUpdate(pending, {
      diagnostics: { ...baseDiagnostics, marginSafety },
      extraPending: {
        canArmNextSetup: true,
        marginSafety,
        platformTriggerDiagnostics: baseDiagnostics,
        skippedReason: marginSafety.reason,
        triggerCrossed: true,
        triggerCrossedAt: sample.time,
      },
      message: `Platform trigger crossed, but risk sizing was blocked: ${marginSafety.reason}.`,
      reason: marginSafety.reason,
      status: "risk_blocked",
    });
    appendSetupOrderJournal(updatedProfile, {
      event: "risk_blocked",
      interval: updatedProfile.timeframe,
      marginSafety,
      markPrice,
      priceSource: sample.source,
      quantity,
      reason: marginSafety.reason,
      setupFingerprint: pending.setupFingerprint,
      setupFingerprintShort: pending.setupFingerprintShort,
      setupId: pending.setupId,
      side: pending.side,
      status: "risk_blocked",
      triggerPrice: pending.triggerPrice,
    });
    return updatedProfile;
  }

  const risk = validateOrder({
    apiConfigured: bingxClient.auth.configured,
    availableBalance: availableMargin,
    liveModeEnabled: profile.liveModeEnabled === true || store.getState().botStatus === "LIVE_RUNNING",
    openPosition: reversalContext ? null : updatedProfile.live?.openPosition,
    order,
    profile: updatedProfile,
    tradesToday: updatedProfile.paper.tradesToday,
  });

  if (!risk.allowed) {
    updatedProfile.live.pendingTriggerOrder = platformTriggerTerminalUpdate(pending, {
      diagnostics: { ...baseDiagnostics, marginSafety, risk },
      extraPending: {
        canArmNextSetup: true,
        marginSafety,
        platformTriggerDiagnostics: baseDiagnostics,
        risk,
        skippedReason: risk.reason,
        triggerCrossed: true,
        triggerCrossedAt: sample.time,
      },
      message: `Platform trigger crossed, but risk validation blocked the order: ${risk.reason}.`,
      reason: risk.reason,
      status: "risk_blocked",
    });
    appendSetupOrderJournal(updatedProfile, {
      event: "risk_blocked",
      interval: updatedProfile.timeframe,
      marginSafety,
      markPrice,
      priceSource: sample.source,
      quantity,
      reason: risk.reason,
      setupFingerprint: pending.setupFingerprint,
      setupFingerprintShort: pending.setupFingerprintShort,
      setupId: pending.setupId,
      side: pending.side,
      status: "risk_blocked",
      triggerPrice: pending.triggerPrice,
    });
    return updatedProfile;
  }

  let reversalClose = null;
  if (reversalContext) {
    reversalClose = await closeLivePositionForReversal({
      baseDiagnostics,
      bingxClient,
      logger,
      markPrice,
      pending,
      positionsBefore,
      priceSource: sample.source,
      profile: updatedProfile,
      sample,
      store,
    });
    updatedProfile = reversalClose.profile;
    if (!reversalClose.closed) {
      return updatedProfile;
    }
    pending = updatedProfile.live?.pendingTriggerOrder ?? pending;
  }

  await bingxClient.setMarginMode(updatedProfile.symbol, updatedProfile.risk.marginMode ?? "isolated");
  await bingxClient.setLeverage(updatedProfile.symbol, finalSizing.leverage, "LONG");
  await bingxClient.setLeverage(updatedProfile.symbol, finalSizing.leverage, "SHORT");

  let marketOrder = null;
  try {
    marketOrder = await bingxClient.placeMarketOrder(updatedProfile.symbol, pending.side, quantity);
  } catch (error) {
    const exchangeResponse = error?.bingx ?? { message: error instanceof Error ? error.message : String(error) };
    const status = reversalContext ? "reversal_close_succeeded_entry_failed" : "platform_market_order_rejected";
    const message = reversalContext
      ? "Reversal close succeeded, but BingX rejected the opposite MARKET entry."
      : "Platform trigger crossed, but BingX rejected the MARKET entry.";
    updatedProfile.live.pendingTriggerOrder = platformTriggerTerminalUpdate(pending, {
      diagnostics: { ...baseDiagnostics, marginSafety, reversalClose, risk },
      exchangeResponse,
      extraPending: {
        canArmNextSetup: true,
        critical: reversalContext ? "reversal_close_succeeded_entry_failed" : undefined,
        error: error instanceof Error ? error.message : String(error),
        exchangeResponse,
        marginSafety,
        platformTriggerDiagnostics: baseDiagnostics,
        reversalClose,
        reversalReason: reversalContext ? "live_reversal_trigger_crossed" : "",
        reversalStatus: reversalContext ? "entry_failed_after_close" : "",
        risk,
        skippedReason: status,
        triggerCrossed: true,
        triggerCrossedAt: sample.time,
        triggerSlippagePct: numericValue(slippagePct),
      },
      message,
      reason: status,
      status,
    });
    appendSetupOrderJournal(updatedProfile, {
      event: status,
      exchangeResponseSummary: summarizeExchangeResponse(exchangeResponse),
      interval: updatedProfile.timeframe,
      marginSafety,
      markPrice,
      priceSource: sample.source,
      quantity,
      reason: status,
      reversalFromDirection: reversalContext?.fromDirection ?? "",
      setupFingerprint: pending.setupFingerprint,
      setupFingerprintShort: pending.setupFingerprintShort,
      setupId: pending.setupId,
      side: pending.side,
      slippagePct,
      status,
      triggerPrice: pending.triggerPrice,
    });
    return updatedProfile;
  }

  await store.upsertOrder({
    id: String(resultOrderId(marketOrder) ?? `${pending.setupId}-platform-market`),
    mode: "live",
    profileId: updatedProfile.id,
    raw: marketOrder,
    setupFingerprint: pending.setupFingerprint,
    setupFingerprintShort: pending.setupFingerprintShort,
    setupId: pending.setupId,
    side: pending.side,
    status: "SENT",
    symbol: updatedProfile.symbol,
    type: "MARKET",
  });

  const positionsAfter = normalizeExchangeList(await bingxClient.getOpenPositions(updatedProfile.symbol));
  const position = matchingExchangePosition(positionsAfter, {
    positionSide: pending.positionSide,
    symbol: updatedProfile.symbol,
  });

  if (!position) {
    const status = reversalContext ? "reversal_close_succeeded_entry_failed" : "market_sent_position_missing";
    updatedProfile.live.pendingTriggerOrder = platformTriggerTerminalUpdate(pending, {
      diagnostics: { ...baseDiagnostics, marketOrder, reversalClose },
      exchangeResponse: marketOrder,
      extraPending: {
        canArmNextSetup: true,
        critical: status,
        marketOrder,
        marketOrderSent: true,
        marketSentAt: new Date().toISOString(),
        platformTriggerDiagnostics: baseDiagnostics,
        reversalClose,
        reversalReason: reversalContext ? "live_reversal_trigger_crossed" : "",
        reversalStatus: reversalContext ? "entry_missing_after_close" : "",
        triggerCrossed: true,
        triggerCrossedAt: sample.time,
        triggerSlippagePct: numericValue(slippagePct),
      },
      message: reversalContext
        ? "Reversal close succeeded and MARKET was sent, but no opposite live position was found after fresh sync."
        : "Platform MARKET was sent, but no matching live position was found after fresh sync.",
      reason: status,
      status,
    });
    appendSetupOrderJournal(updatedProfile, {
      event: status,
      exchangeResponseSummary: summarizeExchangeResponse(marketOrder),
      interval: updatedProfile.timeframe,
      markPrice,
      orderId: resultOrderId(marketOrder),
      priceSource: sample.source,
      quantity,
      reason: status,
      reversalFromDirection: reversalContext?.fromDirection ?? "",
      setupFingerprint: pending.setupFingerprint,
      setupFingerprintShort: pending.setupFingerprintShort,
      setupId: pending.setupId,
      side: pending.side,
      status,
      triggerPrice: pending.triggerPrice,
    });
    return updatedProfile;
  }

  const protectiveQuantity = positionAmount(position) || quantity;
  const protection = await protectLivePositionOrEmergencyClose({
    bingxClient,
    logger,
    pending,
    position,
    profile: updatedProfile,
    protectiveQuantity,
    side: pending.side,
  });
  const stopOrder = protection.stopOrder;
  const takeProfitOrder = protection.takeProfitOrder;
  const critical = protection.critical;
  const protectionConfirmed = protection.protectionConfirmed === true;
  const terminalUnprotectedStatus = critical || "sl_protection_failed_emergency_close_failed";

  const executionPrice = positionEntryPrice(position) ?? markPrice ?? pending.triggerPrice;
  const fillTime = Math.floor(Date.now() / 1000);
  const entryEvent = {
    ...(pending.entryEvent ?? {}),
    direction: pending.direction,
    setupId: pending.setupId,
    stopLoss: pending.stopLoss,
    time: fillTime,
    trigger: executionPrice,
  };

  if (protectionConfirmed && stopOrder) {
    await store.upsertOrder({
      id: String(protection.protectionOrderId ?? resultOrderId(stopOrder) ?? `${pending.setupId}-sl`),
      mode: "live",
      profileId: updatedProfile.id,
      raw: stopOrder,
      setupFingerprint: pending.setupFingerprint,
      setupFingerprintShort: pending.setupFingerprintShort,
      setupId: pending.setupId,
      side: closeSideForPositionSide(pending.positionSide),
      status: "SENT",
      symbol: updatedProfile.symbol,
      type: "STOP_MARKET",
    });
  }
  if (protectionConfirmed && takeProfitOrder) {
    await store.upsertOrder({
      id: String(resultOrderId(takeProfitOrder) ?? `${pending.setupId}-tp`),
      mode: "live",
      profileId: updatedProfile.id,
      raw: takeProfitOrder,
      setupFingerprint: pending.setupFingerprint,
      setupFingerprintShort: pending.setupFingerprintShort,
      setupId: pending.setupId,
      side: closeSideForPositionSide(pending.positionSide),
      status: "SENT",
      symbol: updatedProfile.symbol,
      type: "TAKE_PROFIT_MARKET",
    });
  }

  updatedProfile.live.openPosition = protectionConfirmed || !protection.emergencyClosed
    ? createPaperPosition({
        entryEvent,
        order: {
          ...order,
          direction: pending.direction,
          entryPrice: executionPrice,
          protectionMissing: !protectionConfirmed,
          quantity: protectiveQuantity,
          stopLoss: pending.stopLoss,
          takeProfit: liveTakeProfitEnabled(updatedProfile, pending) ? pending.takeProfit ?? null : null,
        },
      })
    : null;
  updatedProfile.live.liveProtectionConfirmed = protectionConfirmed;
  updatedProfile.live.protectionOrderId = protection.protectionOrderId;
  updatedProfile.live.protectionSource = protection.protectionSource;
  updatedProfile.live.lastProcessedSetupId = pending.setupId;
  updatedProfile.live.lastProcessedSetupFingerprint = pending.setupFingerprint ?? null;
  updatedProfile.live.lastProcessedStrategyEventFingerprint = pending.strategyEventFingerprint ?? null;
  updatedProfile.live.pendingTriggerOrder = {
    ...pending,
    canArmNextSetup: protection.emergencyClosed === true,
    critical,
    emergencyClose: protection.emergencyClose,
    emergencyClosed: protection.emergencyClosed,
    executionPrice,
    fillDetectedAt: new Date().toISOString(),
    filledPosition: {
      positionId: positionIdentifier(position),
      positionSide: pending.positionSide,
      quantity: protectiveQuantity,
    },
    lastExchangeStatus: "MARKET_SENT",
    lastMarkPrice: markPrice,
    lastPriceRaw: sample.raw,
    lastPriceSource: sample.source,
    lastPriceTime: sample.time,
    marketOrder,
    marketOrderSent: true,
    marketSentAt: new Date().toISOString(),
    orderId: resultOrderId(marketOrder) ?? null,
    orderLifecycle: [
      ...(pending.orderLifecycle ?? []),
      {
        diagnostics: { ...baseDiagnostics, executionPrice, marginSafety, reversalClose, risk, slippagePct },
        exchangeResponse: {
          reversalClose,
          marketOrder,
          position,
          stopOrder,
          takeProfitOrder,
          protection,
        },
        message: reversalContext
          ? protectionConfirmed
            ? "Reversal wykonany. Stara pozycja zamknięta, nowa pozycja otwarta i SL potwierdzony na BingX."
            : protection.emergencyClosed
              ? "Reversal otworzył nową pozycję, ale SL nie został potwierdzony; backend zamknął pozycję awaryjnie MARKET."
              : "Reversal otworzył nową pozycję, SL nie został potwierdzony i awaryjne zamknięcie nie zostało potwierdzone."
          : protectionConfirmed
            ? "Platform trigger crossed; MARKET sent and SL protection confirmed on BingX."
            : protection.emergencyClosed
              ? "Platform trigger crossed; MARKET sent, SL was not confirmed, so backend emergency-closed the position."
              : "Platform trigger crossed; MARKET sent, SL was not confirmed and emergency close was not confirmed.",
        status: protectionConfirmed ? "filled_protected" : terminalUnprotectedStatus,
        time: new Date().toISOString(),
      },
    ].slice(-20),
    platformTriggerDiagnostics: { ...baseDiagnostics, executionPrice, slippagePct },
    position,
    protectionAttempts: protection.protectionAttempts,
    protectionConfirmed,
    protectionOrderId: protection.protectionOrderId,
    protectionSource: protection.protectionSource,
    stopOrderVerification: protection.stopOrderVerification,
    reversalClose,
    reversalReason: reversalContext ? "live_reversal_trigger_crossed" : "",
    reversalStatus: reversalContext
      ? protectionConfirmed ? "completed" : protection.emergencyClosed ? "entry_emergency_closed_after_sl_failure" : "entry_unprotected_close_failed"
      : "",
    status: protectionConfirmed ? "filled_protected" : terminalUnprotectedStatus,
    stopOrder,
    terminal: !protectionConfirmed,
    terminalReason: protectionConfirmed ? "" : terminalUnprotectedStatus,
    takeProfit: liveTakeProfitEnabled(updatedProfile, pending) ? pending.takeProfit ?? null : null,
    takeProfitOrder,
    triggerCrossed: true,
    triggerCrossedAt: sample.time,
    triggerSlippagePct: numericValue(slippagePct),
    updatedAt: new Date().toISOString(),
  };
  appendSetupOrderJournal(updatedProfile, {
    event: reversalContext
      ? protectionConfirmed ? "live_reversal_completed" : terminalUnprotectedStatus
      : protectionConfirmed ? "platform_market_entry_sl_confirmed" : terminalUnprotectedStatus,
    exchangeResponseSummary: summarizeExchangeResponse(marketOrder),
    executionPrice,
    interval: updatedProfile.timeframe,
    markPrice,
    orderId: resultOrderId(marketOrder),
    priceSource: sample.source,
    quantity: protectiveQuantity,
    reason: reversalContext ? "live_reversal_trigger_crossed" : undefined,
    reversalFromDirection: reversalContext?.fromDirection ?? "",
    setupFingerprint: pending.setupFingerprint,
    setupFingerprintShort: pending.setupFingerprintShort,
    setupId: pending.setupId,
    side: pending.side,
    slPlaced: protectionConfirmed,
    emergencyClosed: protection.emergencyClosed,
    protectionOrderId: protection.protectionOrderId,
    protectionSource: protection.protectionSource,
    slippagePct,
    status: protectionConfirmed ? "filled_protected" : terminalUnprotectedStatus,
    triggerPrice: pending.triggerPrice,
  });
  updatedProfile.live.orderLog = [
    ...(updatedProfile.live.orderLog ?? []),
    {
      executionMode: "platform_market_trigger",
      filledPosition: position,
      marketOrder,
      stopOrder,
      takeProfitOrder,
      time: new Date().toISOString(),
    },
  ];

  await logger("platform trigger crossed and market entry processed", {
    critical,
    executionPrice,
    fingerprint: pending.setupFingerprint,
    isReversal: Boolean(reversalContext),
    mode: "live",
    priceSource: sample.source,
    profileId: updatedProfile.id,
    setupId: pending.setupId,
    slippagePct,
  });
  return updatedProfile;
}

async function syncPendingTriggerFill({
  bingxClient,
  logger,
  priceService = null,
  profile,
  store,
}) {
  let updatedProfile = structuredClone(profile);
  const pending = activePendingTriggerOrder(updatedProfile.live?.pendingTriggerOrder);

  if (!pending) return updatedProfile;
  if (isPlatformMarketTriggerPending(pending)) {
    return processPlatformMarketTrigger({
      bingxClient,
      logger,
      priceService,
      profile: updatedProfile,
      store,
    });
  }

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
        setupFingerprint: pending.setupFingerprint,
        setupFingerprintShort: pending.setupFingerprintShort,
        setupId: pending.setupId,
        side: pending.side,
        status: "filled_but_position_missing",
        triggerPrice: pending.triggerPrice,
      });
      await logger("trigger order filled but position missing", {
        fingerprint: pending.setupFingerprint,
        mode: "live",
        orderId: pending.orderId,
        profileId: updatedProfile.id,
        setupId: pending.setupId,
      });
      return updatedProfile;
    }

    if (classification.terminal) {
      const failureDiagnostics = {
        ...(await collectTriggerDiagnostics({
          bingxClient,
          direction: pending.direction,
          includeExchangeState: true,
          leverage: pending.order?.leverage ?? pending.placementDiagnostics?.leverage ?? null,
          marginRequired: pending.order?.marginRequired ?? pending.placementDiagnostics?.marginRequired ?? null,
          marginMode: pending.placementDiagnostics?.marginMode ?? updatedProfile.risk?.marginMode ?? "isolated",
          notional: pending.order?.notionalSize ?? pending.placementDiagnostics?.notional ?? null,
          orderId: pending.orderId,
          payload: pending.placementDiagnostics?.payload ?? null,
          priceService,
          quantity: pending.quantity,
          setupFingerprint: pending.setupFingerprint,
          symbol: updatedProfile.symbol,
          triggerPrice: pending.triggerPrice,
        })),
        apiProfile: updatedProfile.account?.apiProfile ?? updatedProfile.account?.id ?? null,
        marginSafety: pending.marginSafety ?? pending.placementDiagnostics?.marginSafety ?? null,
        profileId: updatedProfile.id,
        subaccount: updatedProfile.account?.label ?? updatedProfile.account?.apiProfile ?? null,
      };
      const failureCandidate = classification.status === "terminal_failed" && classification.executedQty === 0
        ? classifyTriggerFailureCandidate({ failureDiagnostics, pending, statusResponse: placedOrderStatus })
        : classification.failureClassification;
      updatedProfile.live.pendingTriggerOrder = {
	        ...pending,
	        canArmNextSetup: true,
	        executedQty: classification.executedQty,
	        exchangeTerminalStatus: classification.statusText,
	        failureCandidate,
	        failureDiagnostics,
	        failureClassification: classification.failureClassification,
	        lastExchangeStatus: classification.statusText,
	        lastOrderStatus: placedOrderStatus,
	        lastStatusCheckAt: new Date().toISOString(),
        orderLifecycle: [
          ...(pending.orderLifecycle ?? []),
          {
            diagnostics: failureDiagnostics,
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
        failureCandidate,
        failureDiagnostics,
        failureClassification: classification.failureClassification,
        interval: updatedProfile.timeframe,
        orderId: pending.orderId ?? null,
        quantity: pending.quantity,
        reason: classification.reason,
        setupFingerprint: pending.setupFingerprint,
        setupFingerprintShort: pending.setupFingerprintShort,
        setupId: pending.setupId,
        side: pending.side,
        status: classification.status,
        triggerPrice: pending.triggerPrice,
      });
      await logger("pending trigger order terminal on exchange", {
        exchangeStatus: classification.statusText,
        failureCandidate,
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
  const protection = await protectLivePositionOrEmergencyClose({
    bingxClient,
    logger,
    pending,
    position,
    profile: updatedProfile,
    protectiveQuantity,
    side,
  });
  const stopOrder = protection.stopOrder;
  const takeProfitOrder = protection.takeProfitOrder;
  const critical = protection.critical;
  const protectionConfirmed = protection.protectionConfirmed === true;
  const terminalUnprotectedStatus = critical || "sl_protection_failed_emergency_close_failed";

  const fillTime = Math.floor(Date.now() / 1000);
  const entryEvent = {
    ...(pending.entryEvent ?? {}),
    direction: pending.direction,
    setupId: pending.setupId,
    stopLoss: pending.stopLoss,
    time: fillTime,
    trigger: pending.triggerPrice,
  };

  if (protectionConfirmed) {
    await logger("trigger order fill detected and SL attached", {
      mode: "live",
      orderId: pending.orderId,
      profileId: updatedProfile.id,
      setupId: pending.setupId,
      stopOrder,
    });
    if (stopOrder) {
      await store.upsertOrder({
        id: String(protection.protectionOrderId ?? resultOrderId(stopOrder) ?? `${pending.setupId}-sl`),
        mode: "live",
        profileId: updatedProfile.id,
        raw: stopOrder,
        setupFingerprint: pending.setupFingerprint,
        setupFingerprintShort: pending.setupFingerprintShort,
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
        setupFingerprint: pending.setupFingerprint,
        setupFingerprintShort: pending.setupFingerprintShort,
        setupId: pending.setupId,
        side: closeSideForPositionSide(pending.positionSide),
        status: "SENT",
        symbol: updatedProfile.symbol,
        type: "TAKE_PROFIT_MARKET",
      });
    }
  }

  updatedProfile.live.openPosition = protectionConfirmed || !protection.emergencyClosed
    ? createPaperPosition({
        entryEvent,
        order: {
          ...(pending.order ?? {}),
          direction: pending.direction,
          entryPrice: pending.triggerPrice,
          protectionMissing: !protectionConfirmed,
          quantity: protectiveQuantity,
          stopLoss: pending.stopLoss,
          takeProfit: liveTakeProfitEnabled(updatedProfile, pending) ? pending.takeProfit ?? null : null,
        },
      })
    : null;
  updatedProfile.live.liveProtectionConfirmed = protectionConfirmed;
  updatedProfile.live.protectionOrderId = protection.protectionOrderId;
  updatedProfile.live.protectionSource = protection.protectionSource;
  updatedProfile.live.lastProcessedSetupId = pending.setupId;
  updatedProfile.live.lastProcessedSetupFingerprint = pending.setupFingerprint ?? null;
  updatedProfile.live.pendingTriggerOrder = {
    ...pending,
    canArmNextSetup: protection.emergencyClosed === true,
    executedQty: classification.executedQty,
    exchangeTerminalStatus: classification.statusText,
    critical,
    emergencyClose: protection.emergencyClose,
    emergencyClosed: protection.emergencyClosed,
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
          protection,
        },
        message: protectionConfirmed
          ? "Trigger filled; SL protection confirmed on BingX."
          : protection.emergencyClosed
            ? "Trigger filled, SL was not confirmed, so backend emergency-closed the position."
            : "Trigger filled, SL was not confirmed and emergency close was not confirmed.",
        status: protectionConfirmed ? "filled_protected" : terminalUnprotectedStatus,
        time: new Date().toISOString(),
      },
    ].slice(-20),
    position,
    protectionAttempts: protection.protectionAttempts,
    protectionConfirmed,
    protectionOrderId: protection.protectionOrderId,
    protectionSource: protection.protectionSource,
    status: protectionConfirmed ? "filled_protected" : terminalUnprotectedStatus,
    stopOrder,
    stopOrderVerification: protection.stopOrderVerification,
    terminal: !protectionConfirmed,
    terminalReason: protectionConfirmed ? "" : terminalUnprotectedStatus,
    takeProfit: liveTakeProfitEnabled(updatedProfile, pending) ? pending.takeProfit ?? null : null,
    takeProfitOrder,
    updatedAt: new Date().toISOString(),
  };
  appendSetupOrderJournal(updatedProfile, {
    event: protectionConfirmed ? "fill_detected_sl_confirmed" : terminalUnprotectedStatus,
    exchangeResponseSummary: summarizeExchangeResponse(placedOrderStatus),
    executedQty: classification.executedQty,
    interval: updatedProfile.timeframe,
    orderId: pending.orderId ?? null,
    quantity: protectiveQuantity,
    setupFingerprint: pending.setupFingerprint,
    setupFingerprintShort: pending.setupFingerprintShort,
    setupId: pending.setupId,
    side: pending.side,
    slPlaced: protectionConfirmed,
    emergencyClosed: protection.emergencyClosed,
    protectionOrderId: protection.protectionOrderId,
    protectionSource: protection.protectionSource,
    status: protectionConfirmed ? "filled_protected" : terminalUnprotectedStatus,
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

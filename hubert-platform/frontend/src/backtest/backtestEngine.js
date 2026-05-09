import { STRATEGY_EVENT_TYPES, SETUP_STATUSES, evaluateChoromanskiStrategy } from "../engine/strategyEngine";
import { toHeikenAshi } from "../indicators/heikenAshi";
import { calculateNadarayaEnvelope } from "../indicators/nadaraya";
import { calculateBacktestMetrics } from "./metrics";

export const defaultBacktestConfig = {
  commissionPercent: 0.04,
  positionSizePercent: 100,
  slippagePercent: 0,
  startingBalance: 10000,
};

function sourceFromSettings(rawCandles, settings) {
  const closedRaw = rawCandles.filter((candle) => candle.isClosed !== false);

  if (settings.strategySource === "raw-exchange") {
    return closedRaw;
  }

  return toHeikenAshi(closedRaw);
}

function applySlippage(price, direction, side, slippagePercent) {
  const adjustment = price * (slippagePercent / 100);
  const adverse =
    (direction === "LONG" && side === "entry") ||
    (direction === "SHORT" && side === "exit");

  return adverse ? price + adjustment : price - adjustment;
}

function closePosition({ candle, equity, exitPrice, position, reason, slippagePercent }) {
  const slippedExit = applySlippage(exitPrice, position.direction, "exit", slippagePercent);
  const grossPnl =
    position.direction === "LONG"
      ? (slippedExit - position.entryPrice) * position.quantity
      : (position.entryPrice - slippedExit) * position.quantity;
  const exitValue = slippedExit * position.quantity;
  const exitCommission = exitValue * position.commissionRate;
  const netPnl = grossPnl - position.entryCommission - exitCommission;
  const nextEquity = equity + netPnl;

  return {
    equity: nextEquity,
    trade: {
      direction: position.direction,
      durationBars: position.entryIndex === null ? 0 : candle.index - position.entryIndex,
      entryIndex: position.entryIndex,
      entryPrice: position.entryPrice,
      entryTime: position.entryTime,
      exitIndex: candle.index,
      exitPrice: slippedExit,
      exitReason: reason,
      exitTime: candle.time,
      grossPnl,
      assumedLeverage: position.assumedLeverage,
      netPnl,
      marginRequired: position.marginRequired,
      returnPercent: position.notional === 0 ? 0 : (netPnl / position.notional) * 100,
      riskAmount: position.riskAmount,
      setupId: position.setupId,
      slDistancePercent: position.slDistancePercent,
      size: position.notional,
    },
  };
}

function openPosition({ candle, config, direction, equity, event }) {
  const rawEntry = event.trigger ?? candle.close;
  const entryPrice = applySlippage(rawEntry, direction, "entry", config.slippagePercent);
  const slDistancePercent = Math.abs(entryPrice - event.stopLoss) / entryPrice;
  const mmDeck = config.mmDeck;
  const atrSizing = config.atrPositionSizing !== false;
  const notional =
    mmDeck?.mode === "constant"
      ? Number(mmDeck.fixedNotional ?? 0)
      : mmDeck && atrSizing
        ? slDistancePercent > 0
          ? (equity * (Number(mmDeck.oneSlPercent ?? mmDeck.riskPerSlPercent ?? 1) / 100)) / slDistancePercent
          : 0
        : mmDeck
          ? equity * (Number(mmDeck.positionPercent ?? mmDeck.onePercentMovePercent ?? 10) / 100)
          : equity * (config.positionSizePercent / 100);
  const quantity = entryPrice === 0 ? 0 : notional / entryPrice;
  const entryCommission = notional * (config.commissionPercent / 100);
  const assumedLeverage = equity > 0 && notional > 0 ? Math.max(1, Math.ceil(notional / equity)) : 1;
  const riskAmount = mmDeck && atrSizing ? equity * (Number(mmDeck.oneSlPercent ?? mmDeck.riskPerSlPercent ?? 1) / 100) : slDistancePercent * notional;

  return {
    assumedLeverage,
    commissionRate: config.commissionPercent / 100,
    direction,
    entryCommission,
    entryIndex: event.index,
    entryPrice,
    entryTime: event.time,
    marginRequired: notional / assumedLeverage,
    notional,
    quantity,
    riskAmount,
    setupId: event.setupId,
    slDistancePercent,
    stopLoss: event.stopLoss,
  };
}

function mapEventsByIndex(events) {
  return events.reduce((eventsByIndex, event) => {
    if (!eventsByIndex.has(event.index)) {
      eventsByIndex.set(event.index, []);
    }

    eventsByIndex.get(event.index).push(event);
    return eventsByIndex;
  }, new Map());
}

export function runBacktest({ rawCandles, settings, backtestConfig = {} }) {
  const config = {
    ...defaultBacktestConfig,
    ...backtestConfig,
  };
  const sourceCandles = sourceFromSettings(rawCandles, settings);
  const envelope = calculateNadarayaEnvelope(sourceCandles, {
    bandwidth: settings.bandwidth,
    multiplier: settings.envelopeMultiplier,
  });
  const strategy = evaluateChoromanskiStrategy({
    sourceCandles,
    envelope,
    inputs: {
      atrLength: settings.atrLength,
      atrMultiplier: settings.atrMultiplier,
      maxSameSideFailures: settings.maxSameSideFailures,
    },
  });
  const tradeEvents = strategy.events.filter(
    (event) =>
      event.type === STRATEGY_EVENT_TYPES.ENTRY_TRIGGERED ||
      event.type === STRATEGY_EVENT_TYPES.POSITION_EXITED,
  );
  const eventsByIndex = mapEventsByIndex(tradeEvents);
  const setupAudits = strategy.setupAudits.map((audit) => ({ ...audit }));
  const auditBySetupId = new Map(setupAudits.map((audit) => [audit.setupId, audit]));
  const diagnosticEvents = [...(strategy.diagnosticEvents ?? [])];
  const diagnosticSummary = {
    ...(strategy.diagnosticSummary ?? {}),
  };

  function updateSetupAudit(setupId, patch) {
    const audit = auditBySetupId.get(setupId);

    if (audit) {
      Object.assign(audit, patch);
    }
  }

  let equity = config.startingBalance;
  let position = null;
  const trades = [];
  const equityCurve = [{ time: sourceCandles[0]?.time ?? 0, equity }];
  const lifecycleEvents = [...strategy.events];

  sourceCandles.forEach((candle, index) => {
    const indexedCandle = { ...candle, index };
    const events = eventsByIndex.get(index) ?? [];

    events.forEach((event) => {
      if (event.type === STRATEGY_EVENT_TYPES.POSITION_EXITED) {
        if (position && position.setupId === event.setupId) {
          const closed = closePosition({
            candle: indexedCandle,
            equity,
            exitPrice: event.exitPrice ?? position.stopLoss,
            position,
            reason: event.exitReason ?? "EXIT",
            slippagePercent: config.slippagePercent,
          });
          equity = closed.equity;
          trades.push(closed.trade);
          updateSetupAudit(position.setupId, {
            exitIndex: index,
            exitTime: candle.time,
            exitReason: event.exitReason ?? "EXIT",
            status: SETUP_STATUSES.CLOSED,
          });
          position = null;
        }

        return;
      }

      if (event.type !== STRATEGY_EVENT_TYPES.ENTRY_TRIGGERED) {
        return;
      }

      if (position && position.direction !== event.direction) {
        const closed = closePosition({
          candle: indexedCandle,
          equity,
          exitPrice: event.trigger,
          position,
          reason: "REVERSAL",
          slippagePercent: config.slippagePercent,
        });
        equity = closed.equity;
        trades.push(closed.trade);
        updateSetupAudit(position.setupId, {
          exitIndex: index,
          exitTime: candle.time,
          exitReason: "REVERSAL",
          status: SETUP_STATUSES.CLOSED,
        });
        position = null;
      }

      if (!position) {
        const nextPosition = openPosition({
          candle,
          config,
          direction: event.direction,
          equity,
          event,
        });
        const invalidSizing =
          !Number.isFinite(nextPosition.notional) ||
          !Number.isFinite(nextPosition.quantity) ||
          nextPosition.notional <= 0 ||
          nextPosition.quantity <= 0 ||
          !Number.isFinite(nextPosition.entryPrice) ||
          nextPosition.entryPrice <= 0;

        if (invalidSizing) {
          diagnosticSummary.skippedBySizingMm = (diagnosticSummary.skippedBySizingMm ?? 0) + 1;
          diagnosticEvents.push({
            atrReady: true,
            bandTouchCondition: false,
            candleTime: candle.time,
            currentLongSlStreak: null,
            currentShortSlStreak: null,
            index,
            limiterBlockingLong: null,
            limiterBlockingShort: null,
            positionState: position?.direction ?? "NEUTRAL",
            reason: "MM/sizing invalid",
            setupId: event.setupId,
            setupValid: true,
            side: event.direction,
            tradeOpened: false,
            haConfirmationCondition: true,
          });
        }

        position = nextPosition;
        updateSetupAudit(event.setupId, {
          entryIndex: index,
          entryTime: candle.time,
          status: SETUP_STATUSES.ENTERED,
        });
      }
    });

    equityCurve.push({ time: candle.time, equity });
  });

  const lastCandle = sourceCandles[sourceCandles.length - 1];

  if (position && lastCandle) {
    const closed = closePosition({
      candle: { ...lastCandle, index: sourceCandles.length - 1 },
      equity,
      exitPrice: lastCandle.close,
      position,
      reason: "END",
      slippagePercent: config.slippagePercent,
    });
    equity = closed.equity;
    trades.push(closed.trade);
    updateSetupAudit(position.setupId, {
      exitIndex: sourceCandles.length - 1,
      exitTime: lastCandle.time,
      exitReason: "END",
      status: SETUP_STATUSES.CLOSED,
    });
    lifecycleEvents.push({
      type: STRATEGY_EVENT_TYPES.POSITION_EXITED,
      direction: position.direction,
      setupId: position.setupId,
      index: sourceCandles.length - 1,
      time: lastCandle.time,
      exitPrice: lastCandle.close,
      exitReason: "END",
      status: SETUP_STATUSES.CLOSED,
    });
    equityCurve.push({ time: lastCandle.time, equity });
  }

  return {
    config,
    diagnosticEvents,
    diagnosticSummary,
    equityCurve,
    events: lifecycleEvents,
    metrics: calculateBacktestMetrics({
      equityCurve,
      startingBalance: config.startingBalance,
      trades,
    }),
    setupAudits,
    sourceCandles,
    trades,
  };
}

export function toBacktestMarkers(trades) {
  return trades.flatMap((trade, index) => [
    {
      color: trade.direction === "LONG" ? "#f5f5f5" : "#050505",
      id: `bt-entry-${index}`,
      position: trade.direction === "LONG" ? "belowBar" : "aboveBar",
      shape: trade.direction === "LONG" ? "arrowUp" : "arrowDown",
      size: 1.15,
      text: trade.direction === "LONG" ? "BT L" : "BT S",
      time: trade.entryTime,
    },
    {
      color: "rgba(110, 20, 20, 0.78)",
      id: `bt-exit-${index}`,
      position: trade.direction === "LONG" ? "aboveBar" : "belowBar",
      shape: "square",
      size: 0.68,
      text: trade.exitReason,
      time: trade.exitTime,
    },
  ]);
}

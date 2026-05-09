import { STRATEGY_EVENT_TYPES } from "../engine/strategyEngine.js";
import { calculatePositionSize } from "./positionSizing.js";
import { validateOrder } from "./riskManager.js";

function dayKey(time) {
  return new Date(time * 1000).toISOString().slice(0, 10);
}

function groupEvents(events) {
  return events.reduce((grouped, event) => {
    if (
      event.type !== STRATEGY_EVENT_TYPES.ENTRY_TRIGGERED &&
      event.type !== STRATEGY_EVENT_TYPES.POSITION_EXITED
    ) {
      return grouped;
    }

    if (!grouped.has(event.index)) {
      grouped.set(event.index, []);
    }

    grouped.get(event.index).push(event);
    return grouped;
  }, new Map());
}

function closePaperPosition({ equity, event, exitPrice, position }) {
  const pnl =
    position.direction === "LONG"
      ? (exitPrice - position.entryPrice) * position.quantity
      : (position.entryPrice - exitPrice) * position.quantity;

  return {
    equity: equity + pnl,
    trade: {
      direction: position.direction,
      entryPrice: position.entryPrice,
      entryTime: position.entryTime,
      exitPrice,
      exitReason: event.exitReason ?? "EXIT",
      exitTime: event.time,
      notionalSize: position.notionalSize,
      pnl,
      setupId: position.setupId,
    },
  };
}

export function runPaperBroker({ config, events, sourceCandles }) {
  let equity = config.startingBalance;
  let position = null;
  const eventMap = groupEvents(events);
  const trades = [];
  const orders = [];
  const skipped = [];
  const dailyPnl = new Map();
  const tradesByDay = new Map();
  const equityCurve = [{ equity, time: sourceCandles[0]?.time ?? 0 }];

  sourceCandles.forEach((candle, index) => {
    const currentEvents = eventMap.get(index) ?? [];

    currentEvents.forEach((event) => {
      if (event.type === STRATEGY_EVENT_TYPES.POSITION_EXITED) {
        if (!position || position.setupId !== event.setupId) {
          return;
        }

        const closed = closePaperPosition({
          equity,
          event,
          exitPrice: event.exitPrice ?? position.stopLoss,
          position,
        });
        equity = closed.equity;
        trades.push(closed.trade);
        dailyPnl.set(
          dayKey(event.time),
          (dailyPnl.get(dayKey(event.time)) ?? 0) + closed.trade.pnl,
        );
        position = null;
        return;
      }

      if (event.type !== STRATEGY_EVENT_TYPES.ENTRY_TRIGGERED) {
        return;
      }

      const fillCandle =
        config.entryPriceMode === "next-open"
          ? sourceCandles[index + 1]
          : candle;
      const entryPrice =
        config.entryPriceMode === "next-open"
          ? fillCandle?.open
          : event.trigger;

      if (!fillCandle || !Number.isFinite(entryPrice)) {
        skipped.push({ event, reason: "Missing fill candle" });
        return;
      }

      const sizing = calculatePositionSize({
        entryPrice,
        equity,
        fixedUsdt: config.fixedUsdt,
        leverage: config.leverage,
        mode: config.positionSizeMode,
        riskPercent: config.riskPerTradePercent,
        stopLoss: event.stopLoss,
        equityPercent: config.equityPercent,
      });
      const order = {
        ...sizing,
        direction: event.direction,
        entryPrice,
        setupId: event.setupId,
        stopLoss: event.stopLoss,
        symbol: config.symbol,
      };
      const key = dayKey(fillCandle.time);
      const risk = validateOrder({
        config,
        dailyLoss: Math.min(0, dailyPnl.get(key) ?? 0),
        openPositions: position ? [position] : [],
        order,
        tradesToday: tradesByDay.get(key) ?? 0,
      });

      if (!risk.allowed) {
        skipped.push({ event, reason: risk.reason });
        return;
      }

      orders.push({
        ...order,
        marginMode: config.marginMode,
        mode: config.mode,
        status: "FILLED",
        time: fillCandle.time,
      });
      position = {
        ...order,
        entryTime: fillCandle.time,
      };
      tradesByDay.set(key, (tradesByDay.get(key) ?? 0) + 1);
    });

    equityCurve.push({ equity, time: candle.time });
  });

  const lastCandle = sourceCandles[sourceCandles.length - 1];

  if (position && lastCandle) {
    const closed = closePaperPosition({
      equity,
      event: { exitReason: "END", time: lastCandle.time },
      exitPrice: lastCandle.close,
      position,
    });
    equity = closed.equity;
    trades.push(closed.trade);
    equityCurve.push({ equity, time: lastCandle.time });
  }

  return {
    endingEquity: equity,
    equityCurve,
    orders,
    skipped,
    trades,
  };
}

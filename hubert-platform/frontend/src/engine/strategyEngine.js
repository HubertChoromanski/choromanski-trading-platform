import { calculateAtr } from "./atr.js";

export const STRATEGY_STATES = {
  NEUTRAL: "NEUTRAL",
  LONG_ACTIVE: "LONG_ACTIVE",
  SHORT_ACTIVE: "SHORT_ACTIVE",
};

export const STRATEGY_EVENT_TYPES = {
  BAND_SIGNAL: "BAND_SIGNAL",
  BENCHMARK_CONFIRMED: "BENCHMARK_CONFIRMED",
  SETUP_ACTIVE: "SETUP_ACTIVE",
  SETUP_BLOCKED: "SETUP_BLOCKED",
  SETUP_INVALIDATED: "SETUP_INVALIDATED",
  ENTRY_TRIGGERED: "ENTRY_TRIGGERED",
  POSITION_ACTIVE: "POSITION_ACTIVE",
  POSITION_EXITED: "POSITION_EXITED",
};

export const SETUP_STATUSES = {
  PENDING: "PENDING",
  INVALIDATED: "INVALIDATED",
  ENTERED: "ENTERED",
  CLOSED: "CLOSED",
};

const DEFAULT_INPUTS = {
  atrLength: 14,
  atrMultiplier: 1.2,
  maxSameSideFailures: 2,
};

function isFiniteBand(band) {
  return Number.isFinite(band?.upper) && Number.isFinite(band?.lower);
}

function crossunder(currentValue, currentBand, previousValue, previousBand) {
  return previousValue >= previousBand && currentValue < currentBand;
}

function crossover(currentValue, currentBand, previousValue, previousBand) {
  return previousValue <= previousBand && currentValue > currentBand;
}

function eventPrice(direction, candle) {
  return direction === "LONG" ? candle.low : candle.high;
}

function makeSetupId(sequence) {
  return `CTP-${String(sequence).padStart(4, "0")}`;
}

function makeEvent(type, setup, index, candle, extra = {}) {
  return {
    type,
    direction: setup.direction,
    setupId: setup.setupId,
    index,
    time: candle.time,
    price: eventPrice(setup.direction, candle),
    signalIndex: setup.signalIndex ?? null,
    signalTime: setup.signalTime ?? null,
    benchmarkIndex: setup.benchmarkIndex ?? null,
    benchmarkTime: setup.benchmarkTime ?? null,
    trigger: setup.trigger ?? null,
    stopLoss: setup.stopLoss ?? null,
    ...extra,
  };
}

function makeSignal(direction, setupId, index, candle) {
  return {
    direction,
    setupId,
    signalIndex: index,
    signalTime: candle.time,
  };
}

function makeSetup(signal, index, candle, atrValue, atrMultiplier) {
  const midpoint = (candle.open + candle.close) / 2;
  const trigger = signal.direction === "LONG" ? candle.high : candle.low;
  const stopLoss =
    signal.direction === "LONG"
      ? midpoint - atrValue * atrMultiplier
      : midpoint + atrValue * atrMultiplier;

  return {
    ...signal,
    benchmarkIndex: index,
    benchmarkTime: candle.time,
    trigger,
    stopLoss,
    invalidated: false,
  };
}

function makeSetupAudit(signal) {
  return {
    setupId: signal.setupId,
    direction: signal.direction,
    bandSignalIndex: signal.signalIndex,
    bandSignalTime: signal.signalTime,
    benchmarkIndex: null,
    benchmarkTime: null,
    triggerPrice: null,
    slPrice: null,
    invalidationIndex: null,
    invalidationTime: null,
    entryIndex: null,
    entryTime: null,
    exitIndex: null,
    exitTime: null,
    exitReason: "",
    status: SETUP_STATUSES.PENDING,
  };
}

function updateAudit(auditBySetupId, setupId, patch) {
  const audit = auditBySetupId.get(setupId);

  if (audit) {
    Object.assign(audit, patch);
  }
}

function hasPendingSetup(waitingBenchmark, activeSetup) {
  return Boolean(waitingBenchmark || activeSetup);
}

function canStartSetup(direction, position, waitingBenchmark, activeSetup) {
  if (hasPendingSetup(waitingBenchmark, activeSetup)) {
    return false;
  }

  if (direction === "LONG") {
    return position !== STRATEGY_STATES.LONG_ACTIVE;
  }

  return position !== STRATEGY_STATES.SHORT_ACTIVE;
}

function failureCountForDirection(direction, longFailures, shortFailures) {
  return direction === "LONG" ? longFailures : shortFailures;
}

function isDirectionBlocked(direction, longFailures, shortFailures, maxFailures) {
  if (!Number.isFinite(maxFailures) || maxFailures <= 0) {
    return false;
  }

  return failureCountForDirection(direction, longFailures, shortFailures) >= maxFailures;
}

function createDebugRow(candle, band, flags) {
  return {
    time: candle.time,
    close: candle.close,
    upper: band?.upper ?? null,
    lower: band?.lower ?? null,
    setupId: flags.setupId ?? "",
    lifecycle: flags.lifecycle.join("|"),
    blocked: flags.blocked ?? "",
    longSignal: Boolean(flags.longSignal),
    shortSignal: Boolean(flags.shortSignal),
    benchmark: flags.benchmark ?? "",
    entry: flags.entry ?? "",
  };
}

function isBullish(candle) {
  return candle.close > candle.open;
}

function isBearish(candle) {
  return candle.close < candle.open;
}

function setupTriggered(setup, candle) {
  return setup.direction === "LONG"
    ? candle.high >= setup.trigger
    : candle.low <= setup.trigger;
}

function setupInvalidated(setup, candle) {
  return setup.direction === "LONG"
    ? candle.low <= setup.stopLoss
    : candle.high >= setup.stopLoss;
}

function positionStopped(position, candle) {
  return position.direction === "LONG"
    ? candle.low <= position.stopLoss
    : candle.high >= position.stopLoss;
}

function stateFromDirection(direction) {
  return direction === "LONG" ? STRATEGY_STATES.LONG_ACTIVE : STRATEGY_STATES.SHORT_ACTIVE;
}

function addLifecycle(debug, event) {
  debug.lifecycle.push(event.type);
  debug.setupId = event.setupId;
}

function makeBlockedEvent(direction, index, candle, longFailures, shortFailures, maxFailures) {
  return makeEvent(
    STRATEGY_EVENT_TYPES.SETUP_BLOCKED,
    makeSignal(direction, `BLOCK-${direction}-${candle.time}`, index, candle),
    index,
    candle,
    {
      failureCount: failureCountForDirection(direction, longFailures, shortFailures),
      maxSameSideFailures: maxFailures,
      status: "BLOCKED",
    },
  );
}

export function evaluateChoromanskiStrategy({
  sourceCandles,
  envelope,
  inputs = {},
}) {
  const config = {
    ...DEFAULT_INPUTS,
    ...inputs,
  };
  const atr = calculateAtr(sourceCandles, config.atrLength);
  const events = [];
  const setupAudits = [];
  const auditBySetupId = new Map();
  const debugRows = [];
  let position = STRATEGY_STATES.NEUTRAL;
  let activePosition = null;
  let waitingBenchmark = null;
  let activeSetup = null;
  let setupSequence = 0;
  let consecutiveLongFailures = 0;
  let consecutiveShortFailures = 0;
  const blockedDirections = new Set();

  for (let index = 1; index < sourceCandles.length; index += 1) {
    const candle = sourceCandles[index];
    const previousCandle = sourceCandles[index - 1];
    const band = envelope[index];
    const previousBand = envelope[index - 1];
    const debug = {
      longSignal: false,
      shortSignal: false,
      benchmark: "",
      entry: "",
      lifecycle: [],
      setupId: "",
    };

    if (activePosition && index > activePosition.entryIndex && positionStopped(activePosition, candle)) {
      const exitEvent = makeEvent(
        STRATEGY_EVENT_TYPES.POSITION_EXITED,
        activePosition,
        index,
        candle,
        {
          exitPrice: activePosition.stopLoss,
          exitReason: "SL",
          status: SETUP_STATUSES.CLOSED,
        },
      );
      events.push(exitEvent);
      addLifecycle(debug, exitEvent);
      if (activePosition.direction === "LONG") {
        consecutiveLongFailures += 1;
      } else {
        consecutiveShortFailures += 1;
      }
      updateAudit(auditBySetupId, activePosition.setupId, {
        exitIndex: index,
        exitTime: candle.time,
        exitReason: "SL",
        status: SETUP_STATUSES.CLOSED,
      });
      activePosition = null;
      position = STRATEGY_STATES.NEUTRAL;
    }

    if (!isFiniteBand(band) || !isFiniteBand(previousBand)) {
      debugRows.push(createDebugRow(candle, band, debug));
      continue;
    }

    const longSignal = crossunder(candle.close, band.lower, previousCandle.close, previousBand.lower);
    const shortSignal = crossover(candle.close, band.upper, previousCandle.close, previousBand.upper);
    debug.longSignal = longSignal;
    debug.shortSignal = shortSignal;

    if (longSignal && canStartSetup("LONG", position, waitingBenchmark, activeSetup)) {
      if (
        isDirectionBlocked(
          "LONG",
          consecutiveLongFailures,
          consecutiveShortFailures,
          config.maxSameSideFailures,
        )
      ) {
        if (!blockedDirections.has("LONG")) {
          const blockedEvent = makeBlockedEvent(
            "LONG",
            index,
            candle,
            consecutiveLongFailures,
            consecutiveShortFailures,
            config.maxSameSideFailures,
          );
          events.push(blockedEvent);
          addLifecycle(debug, blockedEvent);
          debug.blocked = "LONG";
          blockedDirections.add("LONG");
        }
      } else {
        setupSequence += 1;
        waitingBenchmark = makeSignal("LONG", makeSetupId(setupSequence), index, candle);
        const audit = makeSetupAudit(waitingBenchmark);
        setupAudits.push(audit);
        auditBySetupId.set(waitingBenchmark.setupId, audit);

        const bandEvent = makeEvent(
          STRATEGY_EVENT_TYPES.BAND_SIGNAL,
          waitingBenchmark,
          index,
          candle,
          {
            status: SETUP_STATUSES.PENDING,
          },
        );
        events.push(bandEvent);
        addLifecycle(debug, bandEvent);
      }
    }

    if (shortSignal && canStartSetup("SHORT", position, waitingBenchmark, activeSetup)) {
      if (
        isDirectionBlocked(
          "SHORT",
          consecutiveLongFailures,
          consecutiveShortFailures,
          config.maxSameSideFailures,
        )
      ) {
        if (!blockedDirections.has("SHORT")) {
          const blockedEvent = makeBlockedEvent(
            "SHORT",
            index,
            candle,
            consecutiveLongFailures,
            consecutiveShortFailures,
            config.maxSameSideFailures,
          );
          events.push(blockedEvent);
          addLifecycle(debug, blockedEvent);
          debug.blocked = debug.blocked ? `${debug.blocked},SHORT` : "SHORT";
          blockedDirections.add("SHORT");
        }
      } else {
        setupSequence += 1;
        waitingBenchmark = makeSignal("SHORT", makeSetupId(setupSequence), index, candle);
        const audit = makeSetupAudit(waitingBenchmark);
        setupAudits.push(audit);
        auditBySetupId.set(waitingBenchmark.setupId, audit);

        const bandEvent = makeEvent(
          STRATEGY_EVENT_TYPES.BAND_SIGNAL,
          waitingBenchmark,
          index,
          candle,
          {
            status: SETUP_STATUSES.PENDING,
          },
        );
        events.push(bandEvent);
        addLifecycle(debug, bandEvent);
      }
    }

    const benchmarkConfirmed =
      waitingBenchmark &&
      Number.isFinite(atr[index]) &&
      ((waitingBenchmark.direction === "LONG" && isBullish(candle)) ||
        (waitingBenchmark.direction === "SHORT" && isBearish(candle)));

    if (benchmarkConfirmed) {
      activeSetup = makeSetup(waitingBenchmark, index, candle, atr[index], config.atrMultiplier);
      waitingBenchmark = null;
      debug.benchmark = activeSetup.direction;
      updateAudit(auditBySetupId, activeSetup.setupId, {
        benchmarkIndex: index,
        benchmarkTime: candle.time,
        triggerPrice: activeSetup.trigger,
        slPrice: activeSetup.stopLoss,
        status: SETUP_STATUSES.PENDING,
      });

      const benchmarkEvent = makeEvent(
        STRATEGY_EVENT_TYPES.BENCHMARK_CONFIRMED,
        activeSetup,
        index,
        candle,
        {
          status: SETUP_STATUSES.PENDING,
        },
      );
      const setupActiveEvent = makeEvent(
        STRATEGY_EVENT_TYPES.SETUP_ACTIVE,
        activeSetup,
        index,
        candle,
        {
          status: SETUP_STATUSES.PENDING,
        },
      );
      events.push(benchmarkEvent, setupActiveEvent);
      addLifecycle(debug, benchmarkEvent);
      addLifecycle(debug, setupActiveEvent);
    }

    if (activeSetup && index > activeSetup.benchmarkIndex) {
      const invalidated = setupInvalidated(activeSetup, candle);
      const triggered = setupTriggered(activeSetup, candle);

      if (invalidated) {
        const invalidatedEvent = makeEvent(
          STRATEGY_EVENT_TYPES.SETUP_INVALIDATED,
          activeSetup,
          index,
          candle,
          {
            status: SETUP_STATUSES.INVALIDATED,
            triggerTouched: triggered,
          },
        );
        events.push(invalidatedEvent);
        addLifecycle(debug, invalidatedEvent);
        if (activeSetup.direction === "LONG") {
          consecutiveLongFailures += 1;
        } else {
          consecutiveShortFailures += 1;
        }
        updateAudit(auditBySetupId, activeSetup.setupId, {
          invalidationIndex: index,
          invalidationTime: candle.time,
          status: SETUP_STATUSES.INVALIDATED,
        });
        activeSetup = null;
      } else if (triggered) {
        if (activePosition && activePosition.direction !== activeSetup.direction) {
          const exitEvent = makeEvent(
            STRATEGY_EVENT_TYPES.POSITION_EXITED,
            activePosition,
            index,
            candle,
            {
              exitPrice: activeSetup.trigger,
              exitReason: "REVERSAL",
              status: SETUP_STATUSES.CLOSED,
            },
          );
          events.push(exitEvent);
          addLifecycle(debug, exitEvent);
          updateAudit(auditBySetupId, activePosition.setupId, {
            exitIndex: index,
            exitTime: candle.time,
            exitReason: "REVERSAL",
            status: SETUP_STATUSES.CLOSED,
          });
        }

        const entryEvent = makeEvent(
          STRATEGY_EVENT_TYPES.ENTRY_TRIGGERED,
          activeSetup,
          index,
          candle,
          {
            status: SETUP_STATUSES.ENTERED,
          },
        );
        const activeEvent = makeEvent(
          STRATEGY_EVENT_TYPES.POSITION_ACTIVE,
          activeSetup,
          index,
          candle,
          {
            entryIndex: index,
            entryTime: candle.time,
            status: SETUP_STATUSES.ENTERED,
          },
        );
        events.push(entryEvent, activeEvent);
        addLifecycle(debug, entryEvent);
        addLifecycle(debug, activeEvent);
        debug.entry = activeSetup.direction;
        if (activeSetup.direction === "LONG") {
          consecutiveShortFailures = 0;
          blockedDirections.delete("SHORT");
        } else {
          consecutiveLongFailures = 0;
          blockedDirections.delete("LONG");
        }
        updateAudit(auditBySetupId, activeSetup.setupId, {
          entryIndex: index,
          entryTime: candle.time,
          status: SETUP_STATUSES.ENTERED,
        });
        activePosition = {
          ...activeSetup,
          entryIndex: index,
          entryTime: candle.time,
        };
        position = stateFromDirection(activeSetup.direction);
        activeSetup = null;
      }
    }

    debugRows.push(createDebugRow(candle, band, debug));
  }

  return {
    debugRows,
    events,
    setupAudits,
    state: position,
  };
}

export function filterStrategyEvents(events, display) {
  return events.filter((event) => {
    if (event.type === STRATEGY_EVENT_TYPES.ENTRY_TRIGGERED) {
      return display.showEntries;
    }

    if (event.type === STRATEGY_EVENT_TYPES.BENCHMARK_CONFIRMED) {
      return display.showBenchmarks;
    }

    if (event.type === STRATEGY_EVENT_TYPES.SETUP_INVALIDATED) {
      return display.showNegated;
    }

    if (event.type === STRATEGY_EVENT_TYPES.SETUP_BLOCKED) {
      return display.showBenchmarks || display.showNegated;
    }

    return false;
  });
}

export function toStrategyMarkers(events) {
  return events.map((event) => {
    if (
      event.type === STRATEGY_EVENT_TYPES.BENCHMARK_CONFIRMED &&
      event.direction === "LONG"
    ) {
      return {
        id: `benchmark-long-${event.setupId}`,
        time: event.time,
        position: "belowBar",
        shape: "circle",
        color: "#f5f5f5",
        text: "L",
        size: 0.62,
      };
    }

    if (
      event.type === STRATEGY_EVENT_TYPES.BENCHMARK_CONFIRMED &&
      event.direction === "SHORT"
    ) {
      return {
        id: `benchmark-short-${event.setupId}`,
        time: event.time,
        position: "aboveBar",
        shape: "circle",
        color: "#050505",
        text: "S",
        size: 0.62,
      };
    }

    if (event.type === STRATEGY_EVENT_TYPES.ENTRY_TRIGGERED && event.direction === "LONG") {
      return {
        id: `entry-long-${event.setupId}`,
        time: event.time,
        position: "belowBar",
        shape: "arrowUp",
        color: "#f5f5f5",
        text: "LONG",
        size: 1,
      };
    }

    if (event.type === STRATEGY_EVENT_TYPES.ENTRY_TRIGGERED && event.direction === "SHORT") {
      return {
        id: `entry-short-${event.setupId}`,
        time: event.time,
        position: "aboveBar",
        shape: "arrowDown",
        color: "#050505",
        text: "SHORT",
        size: 1,
      };
    }

    return {
      id: `${event.type.toLowerCase()}-${event.setupId}`,
      time: event.time,
      position: event.direction === "LONG" ? "belowBar" : "aboveBar",
      shape: "square",
      color: "rgba(120, 24, 24, 0.68)",
      text: event.type === STRATEGY_EVENT_TYPES.SETUP_BLOCKED
        ? `${event.direction} BLOCKED`
        : "X",
      size: 0.58,
    };
  });
}

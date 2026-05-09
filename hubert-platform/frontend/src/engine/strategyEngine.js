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

const DEBUG_REASONS = {
  ALREADY_IN_POSITION: "already in position",
  BAND_MISSING: "no band touch",
  HA_MISSING: "HA confirmation missing",
  HISTORY_MISSING: "missing candle/history",
  OTHER_FILTER: "other filter",
  SL_LIMITER: "SL limiter blocked",
  SIZING_INVALID: "MM/sizing invalid",
};

function createDiagnosticSummary() {
  return {
    openedLongTrades: 0,
    openedShortTrades: 0,
    skippedByAlreadyInPosition: 0,
    skippedByBandMissing: 0,
    skippedByFilters: 0,
    skippedByHaMissing: 0,
    skippedByHistory: 0,
    skippedByLimiter: 0,
    skippedBySizingMm: 0,
    skippedLongByLimiter: 0,
    skippedShortByLimiter: 0,
    totalEvaluatedCandles: 0,
    validLongSetups: 0,
    validShortSetups: 0,
  };
}

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

function reasonForBlockedStart(direction, position, waitingBenchmark, activeSetup) {
  if (direction === "LONG" && position === STRATEGY_STATES.LONG_ACTIVE) {
    return DEBUG_REASONS.ALREADY_IN_POSITION;
  }

  if (direction === "SHORT" && position === STRATEGY_STATES.SHORT_ACTIVE) {
    return DEBUG_REASONS.ALREADY_IN_POSITION;
  }

  if (waitingBenchmark || activeSetup) {
    return DEBUG_REASONS.OTHER_FILTER;
  }

  return DEBUG_REASONS.OTHER_FILTER;
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

function makeDiagnosticEvent({
  activeSetup,
  atrReady = true,
  bandTouchCondition,
  candle,
  config,
  direction,
  haConfirmationCondition,
  index,
  longFailures,
  position,
  reason,
  setupId = "",
  setupValid = false,
  shortFailures,
  tradeOpened = false,
}) {
  return {
    atrReady,
    bandTouchCondition: Boolean(bandTouchCondition),
    candleTime: candle.time,
    currentLongSlStreak: longFailures,
    currentShortSlStreak: shortFailures,
    index,
    limiterBlockingLong: isDirectionBlocked("LONG", longFailures, shortFailures, config.maxSameSideFailures),
    limiterBlockingShort: isDirectionBlocked("SHORT", longFailures, shortFailures, config.maxSameSideFailures),
    positionState: position,
    reason,
    setupId: setupId || activeSetup?.setupId || "",
    setupValid: Boolean(setupValid),
    side: direction,
    tradeOpened: Boolean(tradeOpened),
    haConfirmationCondition: Boolean(haConfirmationCondition),
  };
}

function incrementDiagnosticReason(summary, reason, direction) {
  if (reason === DEBUG_REASONS.BAND_MISSING) {
    summary.skippedByBandMissing += 1;
    return;
  }

  if (reason === DEBUG_REASONS.HISTORY_MISSING) {
    summary.skippedByHistory += 1;
    return;
  }

  if (reason === DEBUG_REASONS.HA_MISSING) {
    summary.skippedByHaMissing += 1;
    return;
  }

  if (reason === DEBUG_REASONS.ALREADY_IN_POSITION) {
    summary.skippedByAlreadyInPosition += 1;
    return;
  }

  if (reason === DEBUG_REASONS.SL_LIMITER) {
    summary.skippedByLimiter += 1;
    if (direction === "LONG") {
      summary.skippedLongByLimiter += 1;
    } else {
      summary.skippedShortByLimiter += 1;
    }
    return;
  }

  if (reason === DEBUG_REASONS.SIZING_INVALID) {
    summary.skippedBySizingMm += 1;
    return;
  }

  if (reason) {
    summary.skippedByFilters += 1;
  }
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
  const diagnosticEvents = [];
  const diagnosticSummary = createDiagnosticSummary();
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
    diagnosticSummary.totalEvaluatedCandles += 1;

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
      diagnosticSummary.skippedByHistory += 2;
      debugRows.push(createDebugRow(candle, band, debug));
      continue;
    }

    const longSignal = crossunder(candle.close, band.lower, previousCandle.close, previousBand.lower);
    const shortSignal = crossover(candle.close, band.upper, previousCandle.close, previousBand.upper);
    const longHaConfirmation = isBullish(candle);
    const shortHaConfirmation = isBearish(candle);
    debug.longSignal = longSignal;
    debug.shortSignal = shortSignal;

    if (!longSignal) {
      diagnosticSummary.skippedByBandMissing += 1;
    }

    if (!shortSignal) {
      diagnosticSummary.skippedByBandMissing += 1;
    }

    if (longSignal && canStartSetup("LONG", position, waitingBenchmark, activeSetup)) {
      if (
        isDirectionBlocked(
          "LONG",
          consecutiveLongFailures,
          consecutiveShortFailures,
          config.maxSameSideFailures,
          )
      ) {
        diagnosticEvents.push(makeDiagnosticEvent({
          bandTouchCondition: true,
          candle,
          config,
          direction: "LONG",
          haConfirmationCondition: longHaConfirmation,
          index,
          longFailures: consecutiveLongFailures,
          position,
          reason: DEBUG_REASONS.SL_LIMITER,
          setupValid: false,
          shortFailures: consecutiveShortFailures,
        }));
        incrementDiagnosticReason(diagnosticSummary, DEBUG_REASONS.SL_LIMITER, "LONG");
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
        if (!longHaConfirmation) {
          diagnosticEvents.push(makeDiagnosticEvent({
            bandTouchCondition: true,
            candle,
            config,
            direction: "LONG",
            haConfirmationCondition: false,
            index,
            longFailures: consecutiveLongFailures,
            position,
            reason: DEBUG_REASONS.HA_MISSING,
            setupValid: false,
            shortFailures: consecutiveShortFailures,
          }));
          incrementDiagnosticReason(diagnosticSummary, DEBUG_REASONS.HA_MISSING, "LONG");
        }
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
    } else if (longSignal) {
      const reason = reasonForBlockedStart("LONG", position, waitingBenchmark, activeSetup);
      diagnosticEvents.push(makeDiagnosticEvent({
        activeSetup,
        bandTouchCondition: true,
        candle,
        config,
        direction: "LONG",
        haConfirmationCondition: longHaConfirmation,
        index,
        longFailures: consecutiveLongFailures,
        position,
        reason,
        setupValid: false,
        shortFailures: consecutiveShortFailures,
      }));
      incrementDiagnosticReason(diagnosticSummary, reason, "LONG");
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
        diagnosticEvents.push(makeDiagnosticEvent({
          bandTouchCondition: true,
          candle,
          config,
          direction: "SHORT",
          haConfirmationCondition: shortHaConfirmation,
          index,
          longFailures: consecutiveLongFailures,
          position,
          reason: DEBUG_REASONS.SL_LIMITER,
          setupValid: false,
          shortFailures: consecutiveShortFailures,
        }));
        incrementDiagnosticReason(diagnosticSummary, DEBUG_REASONS.SL_LIMITER, "SHORT");
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
        if (!shortHaConfirmation) {
          diagnosticEvents.push(makeDiagnosticEvent({
            bandTouchCondition: true,
            candle,
            config,
            direction: "SHORT",
            haConfirmationCondition: false,
            index,
            longFailures: consecutiveLongFailures,
            position,
            reason: DEBUG_REASONS.HA_MISSING,
            setupValid: false,
            shortFailures: consecutiveShortFailures,
          }));
          incrementDiagnosticReason(diagnosticSummary, DEBUG_REASONS.HA_MISSING, "SHORT");
        }
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
    } else if (shortSignal) {
      const reason = reasonForBlockedStart("SHORT", position, waitingBenchmark, activeSetup);
      diagnosticEvents.push(makeDiagnosticEvent({
        activeSetup,
        bandTouchCondition: true,
        candle,
        config,
        direction: "SHORT",
        haConfirmationCondition: shortHaConfirmation,
        index,
        longFailures: consecutiveLongFailures,
        position,
        reason,
        setupValid: false,
        shortFailures: consecutiveShortFailures,
      }));
      incrementDiagnosticReason(diagnosticSummary, reason, "SHORT");
    }

    const benchmarkConfirmed =
      waitingBenchmark &&
      Number.isFinite(atr[index]) &&
      ((waitingBenchmark.direction === "LONG" && isBullish(candle)) ||
        (waitingBenchmark.direction === "SHORT" && isBearish(candle)));

    if (benchmarkConfirmed) {
      activeSetup = makeSetup(waitingBenchmark, index, candle, atr[index], config.atrMultiplier);
      if (activeSetup.direction === "LONG") {
        diagnosticSummary.validLongSetups += 1;
      } else {
        diagnosticSummary.validShortSetups += 1;
      }
      diagnosticEvents.push(makeDiagnosticEvent({
        bandTouchCondition: activeSetup.signalIndex === index,
        candle,
        config,
        direction: activeSetup.direction,
        haConfirmationCondition: true,
        index,
        longFailures: consecutiveLongFailures,
        position,
        reason: DEBUG_REASONS.OTHER_FILTER,
        setupId: activeSetup.setupId,
        setupValid: true,
        shortFailures: consecutiveShortFailures,
      }));
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
    } else if (waitingBenchmark && Number.isFinite(atr[index])) {
      const haConfirmation =
        waitingBenchmark.direction === "LONG" ? longHaConfirmation : shortHaConfirmation;

      if (!haConfirmation && waitingBenchmark.signalIndex !== index) {
        diagnosticEvents.push(makeDiagnosticEvent({
          bandTouchCondition: waitingBenchmark.signalIndex === index,
          candle,
          config,
          direction: waitingBenchmark.direction,
          haConfirmationCondition: false,
          index,
          longFailures: consecutiveLongFailures,
          position,
          reason: DEBUG_REASONS.HA_MISSING,
          setupId: waitingBenchmark.setupId,
          setupValid: false,
          shortFailures: consecutiveShortFailures,
        }));
        incrementDiagnosticReason(diagnosticSummary, DEBUG_REASONS.HA_MISSING, waitingBenchmark.direction);
      }
    } else if (waitingBenchmark && waitingBenchmark.signalIndex !== index) {
      diagnosticEvents.push(makeDiagnosticEvent({
        atrReady: false,
        bandTouchCondition: waitingBenchmark.signalIndex === index,
        candle,
        config,
        direction: waitingBenchmark.direction,
        haConfirmationCondition: waitingBenchmark.direction === "LONG" ? longHaConfirmation : shortHaConfirmation,
        index,
        longFailures: consecutiveLongFailures,
        position,
        reason: DEBUG_REASONS.HISTORY_MISSING,
        setupId: waitingBenchmark.setupId,
        setupValid: false,
        shortFailures: consecutiveShortFailures,
      }));
      incrementDiagnosticReason(diagnosticSummary, DEBUG_REASONS.HISTORY_MISSING, waitingBenchmark.direction);
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
        diagnosticEvents.push(makeDiagnosticEvent({
          activeSetup,
          bandTouchCondition: false,
          candle,
          config,
          direction: activeSetup.direction,
          haConfirmationCondition: activeSetup.direction === "LONG" ? longHaConfirmation : shortHaConfirmation,
          index,
          longFailures: consecutiveLongFailures,
          position,
          reason: DEBUG_REASONS.OTHER_FILTER,
          setupId: activeSetup.setupId,
          setupValid: false,
          shortFailures: consecutiveShortFailures,
        }));
        incrementDiagnosticReason(diagnosticSummary, DEBUG_REASONS.OTHER_FILTER, activeSetup.direction);
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
          diagnosticSummary.openedLongTrades += 1;
        } else {
          diagnosticSummary.openedShortTrades += 1;
        }
        diagnosticEvents.push(makeDiagnosticEvent({
          activeSetup,
          bandTouchCondition: false,
          candle,
          config,
          direction: activeSetup.direction,
          haConfirmationCondition: activeSetup.direction === "LONG" ? longHaConfirmation : shortHaConfirmation,
          index,
          longFailures: consecutiveLongFailures,
          position,
          reason: "",
          setupId: activeSetup.setupId,
          setupValid: true,
          shortFailures: consecutiveShortFailures,
          tradeOpened: true,
        }));
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
    diagnosticEvents,
    diagnosticSummary,
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

export const LIVE_EXECUTION_STATES = Object.freeze({
  IDLE: "IDLE",
  SETUP_DETECTED: "SETUP_DETECTED",
  SETUP_ACTIONABLE: "SETUP_ACTIONABLE",
  TRIGGER_ARMED: "TRIGGER_ARMED",
  TRIGGER_CROSSED: "TRIGGER_CROSSED",
  ENTRY_SENT: "ENTRY_SENT",
  ENTRY_CONFIRMED: "ENTRY_CONFIRMED",
  SL_SENT: "SL_SENT",
  SL_CONFIRMED: "SL_CONFIRMED",
  POSITION_OPEN: "POSITION_OPEN",
  POSITION_CLOSED: "POSITION_CLOSED",
  SETUP_INVALIDATED: "SETUP_INVALIDATED",
  SETUP_SKIPPED: "SETUP_SKIPPED",
  ERROR: "ERROR",
});

export const ALLOWED_LIVE_EXECUTION_STATES = new Set(Object.values(LIVE_EXECUTION_STATES));

const TERMINAL_PENDING_STATUSES = new Set([
  "cancel_failed",
  "canceled",
  "cancelled",
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
  "waiting_benchmark_close",
]);

const ACTIVE_PENDING_STATUSES = new Set([
  "accepted",
  "new",
  "partially_filled",
  "pending_sync",
  "placed",
  "platform_armed",
]);

function nowIso() {
  return new Date().toISOString();
}

export function ensureLiveExecutionRuntime(profile) {
  profile.live = {
    currentExecution: null,
    currentExecutionReason: "idle",
    currentExecutionState: LIVE_EXECUTION_STATES.IDLE,
    currentOrderId: null,
    currentSetupFingerprint: "",
    executionTransitionLog: [],
    lastTransitionAt: null,
    ...(profile.live ?? {}),
  };
  if (!profile.live.currentExecutionState) {
    profile.live.currentExecutionState = LIVE_EXECUTION_STATES.IDLE;
  }
  if (!Array.isArray(profile.live.executionTransitionLog)) {
    profile.live.executionTransitionLog = [];
  }
  return profile;
}

export function transitionLiveExecution(profile, transition = {}) {
  ensureLiveExecutionRuntime(profile);
  const state = ALLOWED_LIVE_EXECUTION_STATES.has(transition.state)
    ? transition.state
    : LIVE_EXECUTION_STATES.ERROR;
  const time = transition.timestamp ?? nowIso();
  const setupFingerprint = transition.setupFingerprint ??
    transition.pending?.setupFingerprint ??
    profile.live.currentSetupFingerprint ??
    "";
  const entry = {
    details: transition.details ?? null,
    orderId: transition.orderId ?? transition.pending?.orderId ?? null,
    reasonCode: transition.reasonCode ?? transition.reason ?? state.toLowerCase(),
    setupFingerprint,
    setupFingerprintShort: transition.setupFingerprintShort ??
      transition.pending?.setupFingerprintShort ??
      setupFingerprint.replace(/^sf_|^cf_/u, "").slice(0, 8).toUpperCase(),
    setupId: transition.setupId ?? transition.pending?.setupId ?? null,
    side: transition.side ?? transition.pending?.direction ?? transition.pending?.positionSide ?? transition.pending?.side ?? "",
    source: transition.source ?? "runtime",
    state,
    timestamp: time,
  };

  const previous = profile.live.currentExecution ?? null;
  const duplicate = previous &&
    previous.state === entry.state &&
    previous.reasonCode === entry.reasonCode &&
    previous.setupFingerprint === entry.setupFingerprint &&
    previous.orderId === entry.orderId;

  profile.live.currentExecution = entry;
  profile.live.currentExecutionState = entry.state;
  profile.live.currentExecutionReason = entry.reasonCode;
  profile.live.currentSetupFingerprint = entry.setupFingerprint;
  profile.live.currentOrderId = entry.orderId;
  profile.live.lastTransitionAt = time;

  if (!duplicate) {
    profile.live.executionTransitionLog = [
      ...(profile.live.executionTransitionLog ?? []),
      entry,
    ].slice(-200);
  }

  return profile;
}

export function transitionLiveExecutionMany(profile, transitions = []) {
  for (const transition of transitions.filter(Boolean)) {
    transitionLiveExecution(profile, transition);
  }
  return profile;
}

export function resetLiveExecutionForNewSetup(profile, setup = {}, reasonCode = "new_setup_started") {
  ensureLiveExecutionRuntime(profile);
  const currentFingerprint = profile.live.currentSetupFingerprint ?? "";
  const nextFingerprint = setup.setupFingerprint ?? "";
  if (nextFingerprint && currentFingerprint && currentFingerprint !== nextFingerprint) {
    transitionLiveExecution(profile, {
      reasonCode,
      setupFingerprint: nextFingerprint,
      setupFingerprintShort: setup.setupFingerprintShort,
      setupId: setup.setupId,
      side: setup.direction,
      source: "setup",
      state: LIVE_EXECUTION_STATES.SETUP_DETECTED,
    });
  }
  return profile;
}

export function executionStateFromPending(pending = {}, profile = {}) {
  const status = String(pending?.status ?? "").toLowerCase();
  if (!pending || !status) {
    return profile.live?.openPosition
      ? { reasonCode: "live_position_detected", state: LIVE_EXECUTION_STATES.POSITION_OPEN }
      : { reasonCode: "idle", state: LIVE_EXECUTION_STATES.IDLE };
  }
  if (status === "platform_armed" || ACTIVE_PENDING_STATUSES.has(status)) {
    return { reasonCode: status, state: LIVE_EXECUTION_STATES.TRIGGER_ARMED };
  }
  if (status === "filled_protected") {
    return { reasonCode: "sl_confirmed", state: LIVE_EXECUTION_STATES.POSITION_OPEN };
  }
  if (status.includes("invalidated")) {
    return { reasonCode: status, state: LIVE_EXECUTION_STATES.SETUP_INVALIDATED };
  }
  if (status.includes("risk_blocked") || status.includes("price_too_far") || status.includes("blocked")) {
    return { reasonCode: status, state: LIVE_EXECUTION_STATES.SETUP_SKIPPED };
  }
  if (status.includes("sl_protection_failed") || status.includes("missing") || status.includes("rejected") || status.includes("failed")) {
    return { reasonCode: status, state: LIVE_EXECUTION_STATES.ERROR };
  }
  if (TERMINAL_PENDING_STATUSES.has(status)) {
    return { reasonCode: status, state: LIVE_EXECUTION_STATES.SETUP_SKIPPED };
  }
  return { reasonCode: status, state: LIVE_EXECUTION_STATES.SETUP_SKIPPED };
}

export function syncExecutionStateFromPending(profile, pending = null, source = "pending_sync") {
  ensureLiveExecutionRuntime(profile);
  const derived = executionStateFromPending(pending, profile);
  return transitionLiveExecution(profile, {
    orderId: pending?.orderId ?? null,
    pending,
    reasonCode: derived.reasonCode,
    setupFingerprint: pending?.setupFingerprint ?? profile.live.currentSetupFingerprint ?? "",
    setupFingerprintShort: pending?.setupFingerprintShort,
    setupId: pending?.setupId ?? null,
    side: pending?.direction ?? pending?.positionSide ?? pending?.side ?? "",
    source,
    state: derived.state,
  });
}

export function pendingAgeMs(pending = {}, nowMs = Date.now()) {
  const candidates = [
    pending.lastStatusCheckAt,
    pending.acceptedAt,
    pending.armedAt,
    pending.updatedAt,
    pending.createdAt,
  ];
  for (const candidate of candidates) {
    const parsed = Date.parse(candidate ?? "");
    if (Number.isFinite(parsed)) return Math.max(0, nowMs - parsed);
  }
  return null;
}

export function isAcceptedExchangePendingTooOld(pending = {}, nowMs = Date.now()) {
  const mode = String(pending.executionMode ?? "").toLowerCase();
  if (mode === "platform_market_trigger") return false;
  const status = String(pending.status ?? "").toLowerCase();
  if (!["accepted", "new", "partially_filled", "pending_sync", "placed"].includes(status)) return false;
  const timeoutMs = Number(process.env.SZTAB_EXCHANGE_TRIGGER_ACCEPTED_TIMEOUT_MS ?? 15 * 60 * 1000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return false;
  const age = pendingAgeMs(pending, nowMs);
  return age !== null && age > timeoutMs;
}

export function terminalPendingCanBlockNewSetup(pending = {}) {
  const status = String(pending?.status ?? "").toLowerCase();
  if (!status) return false;
  if (ACTIVE_PENDING_STATUSES.has(status)) return true;
  return false;
}


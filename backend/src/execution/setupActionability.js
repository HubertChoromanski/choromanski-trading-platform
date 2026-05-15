export function timeValueMs(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" || (typeof value === "string" && /^-?\d+(\.\d+)?$/u.test(value.trim()))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return numeric > 10_000_000_000 ? Math.round(numeric) : Math.round(numeric * 1000);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function numericTimeSeconds(value) {
  const ms = timeValueMs(value);
  return ms === null ? null : Math.floor(ms / 1000);
}

export function intervalSeconds(interval) {
  const normalized = String(interval ?? "").trim().toLowerCase();
  const numeric = Number.parseFloat(normalized);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  if (normalized.endsWith("h")) return Math.round(numeric * 60 * 60);
  if (normalized.endsWith("d")) return Math.round(numeric * 24 * 60 * 60);
  return Math.round(numeric * 60);
}

export function triggerEligibilityForSetup(setup = {}, profileOrInterval = {}) {
  const interval = typeof profileOrInterval === "string"
    ? profileOrInterval
    : setup.interval ?? setup.timeframe ?? profileOrInterval.timeframe;
  const benchmarkSeconds = numericTimeSeconds(setup.benchmarkTime ?? setup.setupCandleTime ?? setup.time);
  const seconds = intervalSeconds(interval);
  if (benchmarkSeconds === null || seconds === null) {
    return {
      actionable: true,
      setupCandleCloseTime: null,
      triggerEligibleFrom: null,
      triggerEligibleFromIso: null,
      triggerEligibleFromMs: null,
    };
  }
  const eligibleFrom = benchmarkSeconds + seconds;
  return {
    actionable: false,
    setupCandleCloseTime: eligibleFrom,
    triggerEligibleFrom: eligibleFrom,
    triggerEligibleFromIso: new Date(eligibleFrom * 1000).toISOString(),
    triggerEligibleFromMs: eligibleFrom * 1000,
  };
}

export function isSetupActionable(setup = {}, intervalOrProfile = {}, nowOrTickTime = Date.now()) {
  const eligibility = triggerEligibilityForSetup(setup, intervalOrProfile);
  if (eligibility.triggerEligibleFromMs === null) {
    return {
      ...eligibility,
      actionable: true,
      nowMs: timeValueMs(nowOrTickTime) ?? Date.now(),
      reason: "",
      waitingForBenchmarkClose: false,
    };
  }
  const nowMs = timeValueMs(nowOrTickTime) ?? Date.now();
  const actionable = nowMs >= eligibility.triggerEligibleFromMs;
  return {
    ...eligibility,
    actionable,
    nowMs,
    reason: actionable ? "" : "waiting_for_benchmark_candle_close",
    waitingForBenchmarkClose: !actionable,
  };
}

export function triggerEligibilityDiagnostics(pending = {}, sample = {}) {
  const eligibleFromMs = timeValueMs(pending.triggerEligibleFrom ?? pending.triggerEligibleFromIso ?? pending.setupCandleCloseTime);
  const sampleTimeMs = timeValueMs(sample.time);
  return {
    sampleEligible: eligibleFromMs === null || sampleTimeMs === null || sampleTimeMs >= eligibleFromMs,
    sampleTimeMs,
    triggerEligibleFrom: pending.triggerEligibleFrom ?? null,
    triggerEligibleFromIso: pending.triggerEligibleFromIso ?? null,
    triggerEligibleFromMs: eligibleFromMs,
  };
}

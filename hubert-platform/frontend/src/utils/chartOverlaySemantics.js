import { isRecord, safeObjectRows, setupFingerprintShort } from "./sztabRuntimeGuards.js";

const ENTRY_TRIGGERED = "ENTRY_TRIGGERED";
const BENCHMARK_CONFIRMED = "BENCHMARK_CONFIRMED";
const SETUP_ACTIVE = "SETUP_ACTIVE";
const SETUP_INVALIDATED = "SETUP_INVALIDATED";

export function canonicalOverlayDirection(...values) {
  for (const value of values) {
    const side = String(value || "").toUpperCase();
    if (side.includes("LONG") || side === "BUY") return "LONG";
    if (side.includes("SHORT") || side === "SELL") return "SHORT";
  }
  return "";
}

export function strategyMarkerId(event = {}) {
  const direction = canonicalOverlayDirection(event.direction, event.positionSide, event.side);
  const setupId = event.setupId ?? "";
  if (event.type === BENCHMARK_CONFIRMED && direction === "LONG") return `benchmark-long-${setupId}`;
  if (event.type === BENCHMARK_CONFIRMED && direction === "SHORT") return `benchmark-short-${setupId}`;
  if (event.type === ENTRY_TRIGGERED && direction === "LONG") return `entry-long-${setupId}`;
  if (event.type === ENTRY_TRIGGERED && direction === "SHORT") return `entry-short-${setupId}`;
  return `${String(event.type ?? "event").toLowerCase()}-${setupId}`;
}

export function normalizeOverlayTimeSeconds(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" || (typeof value === "string" && /^-?\d+(\.\d+)?$/u.test(value.trim()))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return numeric > 10_000_000_000 ? Math.round(numeric / 1000) : Math.round(numeric);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.round(parsed / 1000) : null;
}

function normalizedFingerprint(value) {
  return value ? String(value).trim() : "";
}

function normalizedSetupId(value) {
  return value ? String(value).trim() : "";
}

function firstSetupFingerprint(row = {}) {
  return normalizedFingerprint(
    row.setupFingerprint ??
      row.activeSetupFingerprint ??
      row.currentSetupFingerprint ??
      row.latestSetupFingerprint ??
      row.fingerprint,
  );
}

function firstSetupId(row = {}) {
  return normalizedSetupId(row.setupId ?? row.activeSetupId ?? row.failedSetupId ?? row.id);
}

function firstSetupTime(row = {}) {
  return normalizeOverlayTimeSeconds(
    row.time ??
      row.timestamp ??
      row.setupTime ??
      row.benchmarkTime ??
      row.setupCandleTime ??
      row.triggerEligibleFrom,
  );
}

function runtimeRows(runtime = {}) {
  if (!isRecord(runtime)) return [];
  return [
    runtime.latestSetupEvent,
    runtime.latestEntryEvent,
    runtime.pendingTriggerOrder,
    ...safeObjectRows(runtime.currentSetupOrderJournal),
    ...safeObjectRows(runtime.currentDecisionTimeline),
  ].filter(isRecord);
}

export function runtimeMatchesStrategyEvent(runtime = {}, event = {}, interval = "15m") {
  const rows = runtimeRows(runtime);
  const eventFingerprint = firstSetupFingerprint(event);
  if (eventFingerprint && rows.some((row) => firstSetupFingerprint(row) === eventFingerprint)) {
    return true;
  }

  const eventSetupId = firstSetupId(event);
  if (!eventSetupId) return false;

  const eventTime = firstSetupTime(event);
  const intervalTolerance = Math.min(120, Math.max(30, intervalToSeconds(interval) / 20));
  return rows.some((row) => {
    if (firstSetupId(row) !== eventSetupId) return false;
    const rowTime = firstSetupTime(row);
    if (rowTime === null || eventTime === null) return false;
    return Math.abs(rowTime - eventTime) <= intervalTolerance;
  });
}

function intervalToSeconds(interval = "15m") {
  const text = String(interval || "15m").toLowerCase();
  if (text.endsWith("h")) return Math.max(1, Number.parseInt(text, 10) || 1) * 3600;
  if (text.endsWith("m")) return Math.max(1, Number.parseInt(text, 10) || 15) * 60;
  return 15 * 60;
}

export function markerPrefixForOverlay({ mode = "live", historical = false } = {}) {
  if (historical) return "HISTORIA WYKRESU";
  if (mode === "debug") return "DEBUG WYKRES";
  if (mode === "history") return "HISTORIA WYKRESU";
  return "WYKRES";
}

export function buildStrategyOverlayMetadata({
  actionability = {},
  event = {},
  historical = false,
  interval = "15m",
  mode = "live",
  runtime = {},
} = {}) {
  const direction = canonicalOverlayDirection(event.direction, event.positionSide, event.side);
  const chartActionable = actionability.actionable !== false;
  const runtimeMatched = runtimeMatchesStrategyEvent(runtime, event, interval);
  const setupFingerprint = firstSetupFingerprint(event);
  const setupId = firstSetupId(event);
  const source = historical
    ? "historyczne okno wykresu"
    : runtimeMatched
      ? "wykres + zdarzenie Sztabu"
      : "lokalna symulacja wykresu";

  return {
    actionable: chartActionable && runtimeMatched,
    chartActionable,
    direction,
    eventType: event.type ?? "",
    hiddenInModeReason: hiddenReasonForMode({ chartActionable, historical, mode, runtimeMatched }),
    interval,
    runtimeMatched,
    setupFingerprint,
    setupFingerprintShort: setupFingerprintShort(setupFingerprint),
    setupId,
    source,
    triggerEligibleFrom: actionability.triggerEligibleFrom ?? null,
    triggerEligibleFromIso: actionability.triggerEligibleFromIso ?? "",
  };
}

function hiddenReasonForMode({ chartActionable, historical, mode, runtimeMatched }) {
  if (mode === "live") return "LIVE ONLY ukrywa markery wykresu; pokazuje tylko live pozycję, SL i trigger.";
  if (historical) return "Marker jest historyczny i nie jest aktualnym zdarzeniem live.";
  if (!chartActionable) return "Marker jest kandydatem przed zamknięciem świecy benchmarkowej.";
  if (!runtimeMatched) return "Marker istnieje w lokalnej symulacji wykresu, ale nie ma pasującego zdarzenia w osi Sztabu.";
  return "";
}

export function markerMetadataSummary(metadata = {}) {
  const parts = [
    metadata.interval,
    metadata.eventType,
    metadata.direction,
    metadata.setupId,
    metadata.setupFingerprintShort ? `fp:${metadata.setupFingerprintShort}` : "",
    metadata.source,
    metadata.chartActionable ? "świeca zamknięta" : "formujący",
    metadata.runtimeMatched ? "Sztab:tak" : "Sztab:nie",
    metadata.triggerEligibleFromIso ? `aktywny od ${metadata.triggerEligibleFromIso}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

export function applyDebugMetadataToMarker(marker = {}, metadata = {}, mode = "live") {
  if (mode !== "debug") return marker;
  return {
    ...marker,
    text: `${marker.text ?? ""} · ${markerMetadataSummary(metadata)}`.trim(),
  };
}

export function strategyLineTitles(event = {}, metadata = {}, { historical = false, mode = "live" } = {}) {
  const direction = metadata.direction || canonicalOverlayDirection(event.direction, event.positionSide, event.side);
  const suffix = direction ? ` — ${direction}` : "";

  if (event.type === SETUP_INVALIDATED) {
    return {
      slTitle: `HISTORYCZNY SL ANULOWANEGO SETUPU${suffix}`,
      triggerTitle: historical
        ? `HISTORYCZNY ANULOWANY TRIGGER WYKRESU${suffix}`
        : `ANULOWANY SETUP Z WYKRESU${suffix}`,
    };
  }

  if (event.type === SETUP_ACTIVE && !metadata.chartActionable) {
    return {
      slTitle: `POZIOM NEGACJI KANDYDATA${suffix}`,
      triggerTitle: `KANDYDAT SETUPU — CZEKA NA ZAMKNIĘCIE ŚWIECY${suffix}`,
    };
  }

  if (historical) {
    return {
      slTitle: `HISTORYCZNY SL WYKRESU${suffix}`,
      triggerTitle: `HISTORYCZNY TRIGGER WYKRESU${suffix}`,
    };
  }

  if (metadata.runtimeMatched) {
    return {
      slTitle: `POZIOM NEGACJI SETUPU POTWIERDZONEGO W SZTABIE${suffix}`,
      triggerTitle: `TRIGGER STRATEGII POTWIERDZONY W SZTABIE${suffix}`,
    };
  }

  if (mode === "debug") {
    const summary = markerMetadataSummary(metadata);
    return {
      slTitle: `SL/NEGACJA Z WYKRESU — ${summary}`,
      triggerTitle: `TRIGGER Z WYKRESU — ${summary}`,
    };
  }

  return {
    slTitle: `POZIOM NEGACJI Z WYKRESU — BRAK ZDARZENIA W SZTABIE${suffix}`,
    triggerTitle: `TRIGGER Z WYKRESU — BRAK ZDARZENIA W SZTABIE${suffix}`,
  };
}

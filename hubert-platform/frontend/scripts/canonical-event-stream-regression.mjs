import {
  CANONICAL_EVENT_SOURCES,
  CANONICAL_EVENT_TYPES,
  canonicalEventsFromRuntime,
  canonicalEventsFromStrategyEvents,
  canonicalVisibilityInvariants,
  filterCanonicalEventsForMode,
  mergeCanonicalEventStreams,
} from "../src/events/canonicalEventStream.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const chartOnlySetup = {
  benchmarkTime: 1778846400,
  direction: "LONG",
  setupId: "H1-chart-only",
  stopLoss: 94.5,
  time: 1778846400,
  trigger: 95.25,
  type: CANONICAL_EVENT_TYPES.SETUP_ACTIVE,
};
const chartEvents = canonicalEventsFromStrategyEvents([chartOnlySetup], {
  interval: "1h",
  source: CANONICAL_EVENT_SOURCES.CHART_SIMULATION,
  symbol: "SOLUSDT",
});
const liveOnlyVisible = filterCanonicalEventsForMode(chartEvents, "live");
assert(liveOnlyVisible.length === 0, "Chart-only setup must not appear in LIVE ONLY mode.");

const runtimeEvents = canonicalEventsFromRuntime({
  latestSetupEvent: {
    ...chartOnlySetup,
    setupFingerprint: "sf_h1liveactionable",
    setupFingerprintShort: "H1LIVEAC",
  },
  latestSetupEventActionable: true,
}, {
  interval: "1h",
  symbol: "SOLUSDT",
});
const merged = mergeCanonicalEventStreams(chartEvents, runtimeEvents);
const visibleLive = filterCanonicalEventsForMode(merged, "live");
assert(visibleLive.length === 1, "Actionable live Sztab setup should be visible in LIVE ONLY.");
assert(visibleLive[0].source === CANONICAL_EVENT_SOURCES.LIVE_SZTAB, "LIVE ONLY event source must be live_sztab.");
assert(visibleLive[0].actionable === true, "LIVE ONLY setup must be actionable.");
assert(canonicalVisibilityInvariants(merged, visibleLive, "live").length === 0, "Canonical live visibility invariants failed.");

const operationalWithoutRuntime = filterCanonicalEventsForMode(chartEvents, "operational");
assert(operationalWithoutRuntime.length === 1, "Operational mode should explain newest chart-only context when Sztab has no live event.");
assert(operationalWithoutRuntime[0].actionable === false, "Operational chart-only context must remain non-actionable.");

console.log("Canonical event stream regression passed");

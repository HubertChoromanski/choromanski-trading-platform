import {
  buildStrategyOverlayMetadata,
  markerMetadataSummary,
  markerPrefixForOverlay,
  runtimeMatchesStrategyEvent,
  strategyLineTitles,
  strategyMarkerId,
} from "../src/utils/chartOverlaySemantics.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const h1ChartLongSetup = {
  benchmarkTime: 1778846400,
  direction: "LONG",
  setupId: "CTP-0659",
  time: 1778846400,
  trigger: 95.27,
  type: "SETUP_ACTIVE",
};

const noMatchingH1Runtime = {
  currentSetupOrderJournal: [],
  latestSetupEvent: null,
  pendingTriggerOrder: null,
};

const chartOnlyMetadata = buildStrategyOverlayMetadata({
  actionability: { actionable: true, triggerEligibleFrom: 1778850000, triggerEligibleFromIso: "2026-05-15T18:20:00.000Z" },
  event: h1ChartLongSetup,
  historical: false,
  interval: "1h",
  mode: "operational",
  runtime: noMatchingH1Runtime,
});

assert(chartOnlyMetadata.runtimeMatched === false, "Chart-only H1 setup should not match empty Sztab runtime.");
assert(chartOnlyMetadata.actionable === false, "Chart-only setup must not be treated as live-actionable without Sztab match.");
assert(
  strategyLineTitles(h1ChartLongSetup, chartOnlyMetadata, { mode: "operational" }).triggerTitle.includes("BRAK ZDARZENIA W SZTABIE"),
  "Operational line must say there is no matching Sztab event.",
);
assert(markerPrefixForOverlay({ mode: "operational" }) === "WYKRES", "Operational chart markers must be labeled as chart markers.");

const matchingRuntime = {
  currentSetupOrderJournal: [{ setupId: "CTP-0659", time: 1778846400 }],
  latestSetupEvent: { setupId: "CTP-0659", time: 1778846400 },
};
assert(runtimeMatchesStrategyEvent(matchingRuntime, h1ChartLongSetup, "1h"), "Same setup id and timestamp should match runtime.");

const matchedMetadata = buildStrategyOverlayMetadata({
  actionability: { actionable: true },
  event: h1ChartLongSetup,
  interval: "1h",
  mode: "operational",
  runtime: matchingRuntime,
});
assert(matchedMetadata.actionable === true, "Matched closed setup should be considered live-actionable.");
assert(
  strategyLineTitles(h1ChartLongSetup, matchedMetadata, { mode: "operational" }).triggerTitle.includes("POTWIERDZONY W SZTABIE"),
  "Matched setup should be labeled as confirmed in Sztab.",
);

const reusedIdDifferentTimeRuntime = {
  latestSetupEvent: { setupId: "CTP-0659", time: 1778799600 },
};
assert(
  runtimeMatchesStrategyEvent(reusedIdDifferentTimeRuntime, h1ChartLongSetup, "1h") === false,
  "Reused setup id at a different H1 timestamp must not match.",
);
assert(
  runtimeMatchesStrategyEvent({ latestSetupEvent: { setupId: "CTP-0659", time: 1778842800 } }, h1ChartLongSetup, "1h") === false,
  "Reused setup id one H1 candle earlier must not match current chart marker.",
);

const markerId = strategyMarkerId({ direction: "LONG", setupId: "CTP-0659", type: "ENTRY_TRIGGERED" });
assert(markerId === "entry-long-CTP-0659", "Strategy marker id mapping must match toStrategyMarkers ids.");

const debugSummary = markerMetadataSummary(chartOnlyMetadata);
assert(debugSummary.includes("1h"), "Debug summary should include interval.");
assert(debugSummary.includes("SETUP_ACTIVE"), "Debug summary should include event type.");
assert(debugSummary.includes("Sztab:nie"), "Debug summary should show missing Sztab match.");

console.log("Chart overlay semantics regression passed");

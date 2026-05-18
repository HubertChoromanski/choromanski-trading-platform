import assert from "node:assert/strict";
import {
  DEFAULT_SHOW_DEBUG_OVERLAYS,
  lifecycleHistoryRows,
  limitActiveOverlayLines,
  selectVisibleChartEvents,
} from "../src/utils/sztabOperationalUi.js";

const liveEvents = Array.from({ length: 5 }, (_, index) => ({
  actionable: true,
  candleOpenTime: 1000 + index,
  eventTime: 1000 + index,
  eventType: index % 2 === 0 ? "SETUP_ACTIVE" : "LIVE_PENDING_TRIGGER",
  id: `event-${index}`,
  source: "live_sztab",
  trigger: 90 + index,
}));

assert.equal(DEFAULT_SHOW_DEBUG_OVERLAYS, false, "debug overlays default disabled");
assert.equal(selectVisibleChartEvents(liveEvents, "live", false).length, 1, "LIVE renders max one current event");
assert.equal(selectVisibleChartEvents(liveEvents, "debug", false).length, 0, "DEBUG chart overlays are hidden by default");
assert.equal(selectVisibleChartEvents(liveEvents, "history", false).length, 0, "History chart overlays are hidden by default");
assert.equal(selectVisibleChartEvents(liveEvents, "debug", true).length, 5, "Debug overlays can be explicitly enabled");

const noisyLines = [
  { state: "active_live", type: "trigger", value: 91 },
  { state: "active_live", type: "trigger", value: 92 },
  { state: "current_setup", type: "sl", value: 93 },
  { state: "current_setup", type: "sl", value: 94 },
  { state: "historical", type: "trigger", value: 95 },
];
const limitedLines = limitActiveOverlayLines(noisyLines, "live", false);
assert.equal(limitedLines.filter((line) => line.type === "trigger").length, 1, "LIVE renders max one trigger line");
assert.equal(limitedLines.filter((line) => line.type === "sl").length, 1, "LIVE renders max one SL/invalidation line");

const runtime = {
  executionTransitionLog: Array.from({ length: 25 }, (_, index) => ({
    reasonCode: index % 3 === 0 ? "setup_invalidated_before_fill" : "platform_market_trigger_crossed",
    setupId: `CTP-${String(index).padStart(4, "0")}`,
    side: index % 2 === 0 ? "LONG" : "SHORT",
    state: index % 3 === 0 ? "SETUP_INVALIDATED" : "ENTRY_SENT",
    timestamp: 1770000000 + index,
  })),
};
const historyRows = lifecycleHistoryRows(runtime);
assert.equal(historyRows.length, 20, "History mode keeps the latest 20 lifecycle rows");
assert.equal(historyRows[0].setupId, "CTP-0024", "History mode is newest-first");

console.log("sztab operational UI regressions passed");

import { deriveCurrentRuntimeContext } from "../src/sztab/sztabRunner.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const runnerStartedAt = "2026-05-15T10:00:00.000Z";
const currentFingerprint = "sf_current_h1_setup";
const oldFingerprint = "sf_old_trigger_order_mode";

const context = deriveCurrentRuntimeContext({
  latestSetupEvent: {
    direction: "LONG",
    setupFingerprint: currentFingerprint,
    setupFingerprintShort: "CURRENT1",
    setupId: "CTP-H1-CURRENT",
    time: 1778846400,
    trigger: 95,
    type: "SETUP_ACTIVE",
  },
  pending: {
    armedAt: "2026-05-15T10:01:00.000Z",
    direction: "LONG",
    setupFingerprint: currentFingerprint,
    setupFingerprintShort: "CURRENT1",
    setupId: "CTP-H1-CURRENT",
    status: "platform_armed",
    triggerEligibleFromIso: "2026-05-15T11:00:00.000Z",
    triggerPrice: 95,
    updatedAt: "2026-05-15T10:01:00.000Z",
  },
  runtime: {
    lastDecision: "No fresh entry signal on latest closed candle.",
    lastDecisionReason: "no_entry_signal",
    lastTickAt: "2026-05-15T10:05:00.000Z",
    setupOrderJournal: [
      {
        event: "platform_market_entry_sl_placed",
        setupFingerprint: oldFingerprint,
        setupFingerprintShort: "OLDMODE1",
        setupId: "CTP-H1-OLD",
        status: "filled_protected",
        timestamp: "2026-05-14T09:00:00.000Z",
      },
      {
        event: "platform_trigger_armed",
        setupFingerprint: currentFingerprint,
        setupFingerprintShort: "CURRENT1",
        setupId: "CTP-H1-CURRENT",
        status: "platform_armed",
        timestamp: "2026-05-15T10:01:00.000Z",
      },
    ],
    startedAt: runnerStartedAt,
    status: "running",
  },
});

assert(context.currentRunnerStartedAt === runnerStartedAt, "Runner start timestamp was not carried into current context.");
assert(context.currentSetupFingerprint === currentFingerprint, "Current setup fingerprint was not selected.");
assert(context.currentSetupOrderJournal.length === 1, "Current lifecycle should include only the current setup row.");
assert(context.currentSetupOrderJournal[0].status === "platform_armed", "Current lifecycle included the wrong row.");
assert(context.historicalSetupOrderJournal.length === 1, "Old filled_protected row should be historical.");
assert(context.historicalSetupOrderJournal[0].status === "filled_protected", "Historical journal did not retain old filled_protected row.");
assert(context.historicalSetupOrderJournal[0].staleHistoricalReason === "different_setup_fingerprint", "Old row did not get a stale reason.");
assert(
  !context.currentDecisionTimeline.some((item) => item.event === "position_confirmed"),
  "Old filled_protected row appeared as current active lifecycle.",
);
assert(
  context.currentDecisionTimeline.some((item) => item.event === "trigger_not_crossed" || item.event === "trigger_waiting"),
  "Current decision timeline does not explain why no new entry was opened.",
);

console.log("Sztab runtime journal regression passed");

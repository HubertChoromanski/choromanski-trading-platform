import {
  safeObjectRows,
  safeOrderId,
  safeStringRows,
  setupFingerprintShort,
} from "../src/utils/sztabRuntimeGuards.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const runtime = {
  currentDecisionTimeline: [null, undefined, { event: "waiting_for_setup", text: "ok", time: 1 }],
  currentLifecycleOrderIds: [null, "order-1", undefined, 123],
  currentSetupOrderJournal: [
    null,
    undefined,
    { event: "trigger_waiting", setupFingerprint: "sf_abcdef123456", setupId: "setup-no-order" },
    { event: "market_order_sent", orderId: "order-2", setupId: "setup-with-order" },
  ],
  historicalSetupOrderJournal: [null, { historical: true, setupId: "old-setup" }],
};

const currentRows = safeObjectRows(runtime.currentSetupOrderJournal);
assert(currentRows.length === 2, "Null setup/order journal rows were not filtered.");
assert(safeOrderId(currentRows[0]) === null, "Missing orderId should normalize to null.");
assert(safeOrderId(currentRows[1]) === "order-2", "Existing orderId was not preserved.");
assert(setupFingerprintShort(currentRows[0].setupFingerprint) === "ABCDEF12", "Setup fingerprint short format changed.");

const decisionRows = safeObjectRows(runtime.currentDecisionTimeline);
assert(decisionRows.length === 1, "Null decision timeline rows were not filtered.");

const orderIds = safeStringRows(runtime.currentLifecycleOrderIds);
assert(orderIds.join(",") === "order-1,123", "Lifecycle order ids should filter nulls and stringify valid ids.");

const renderedLikeRows = currentRows.map((item, index) => ({
  key: `${item.timestamp ?? index}-${safeOrderId(item) ?? item.setupId ?? index}`,
  order: safeOrderId(item) ?? "--",
  setup: item.setupId ?? "--",
}));
assert(renderedLikeRows[0].order === "--", "Missing orderId should render as no active order placeholder.");
assert(renderedLikeRows[0].setup === "setup-no-order", "Row without orderId should still render setup context.");

console.log("Sztab runtime guard regression passed");

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function safeObjectRows(value) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function safeStringRows(value) {
  return Array.isArray(value)
    ? value.filter((item) => item !== null && item !== undefined && item !== "").map((item) => String(item))
    : [];
}

export function safeOrderId(order) {
  if (!isRecord(order)) return null;
  return order.orderId ?? order.orderID ?? order.id ?? order.clientOrderId ?? order.clientOrderID ?? null;
}

export function setupFingerprintShort(value) {
  return value ? String(value).replace(/^sf_/u, "").slice(0, 8).toUpperCase() : "";
}

function iso(date) {
  return date.toISOString();
}

export function splitIntoPeriods(range = {}, maxPeriods = 4) {
  const from = new Date(range.from);
  const to = new Date(range.to);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from) {
    const now = new Date();
    return [{ from: iso(new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000)), label: "recent", to: iso(now) }];
  }

  const span = to.getTime() - from.getTime();
  const periods = [];
  const count = Math.max(1, Math.min(maxPeriods, Math.ceil(span / (30 * 24 * 60 * 60 * 1000))));

  for (let index = 0; index < count; index += 1) {
    const start = new Date(from.getTime() + (span / count) * index);
    const end = new Date(from.getTime() + (span / count) * (index + 1));
    periods.push({
      from: iso(start),
      label: `Period ${index + 1}`,
      to: iso(end),
    });
  }

  return periods;
}

export function summarizePeriods(rows = []) {
  const sorted = rows.slice().sort((left, right) => Number(right.metrics?.netProfit ?? right.netProfit ?? 0) - Number(left.metrics?.netProfit ?? left.netProfit ?? 0));
  return {
    profitablePeriods: rows.filter((row) => Number(row.metrics?.netProfit ?? row.netProfit ?? 0) > 0).length,
    strongestPeriods: sorted.slice(0, 3).map((row) => row.label ?? row.periodLabel),
    weakestPeriods: sorted.slice(-3).map((row) => row.label ?? row.periodLabel),
  };
}

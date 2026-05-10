export function analyzeRegimeFromPeriods(periodRows = []) {
  const positive = periodRows.filter((row) => Number(row.metrics?.netProfit ?? row.netProfit ?? 0) > 0);
  const negative = periodRows.filter((row) => Number(row.metrics?.netProfit ?? row.netProfit ?? 0) <= 0);

  return {
    likelyDependency: positive.length && negative.length
      ? "regime dependent"
      : positive.length === periodRows.length
        ? "broadly stable in tested periods"
        : "weak across tested periods",
    notes: [
      `${positive.length}/${periodRows.length} periods were profitable.`,
      negative.length ? "Losses cluster in specific periods; inspect market regime before deployment." : "No losing validation period was detected in this sample.",
    ],
  };
}

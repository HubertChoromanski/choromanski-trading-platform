const REQUIRED_METRICS = [
  "netPnl",
  "profitFactor",
  "maxDrawdown",
  "winRate",
  "trades",
  "candlesUsed",
];

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== "" && Number.isFinite(Number(value));
}

function pickMetric(row = {}, key, aliases = []) {
  const sources = [
    ["metrics", row.metrics?.[key]],
    ["canonical", row.canonical?.metrics?.[key]],
    ["topLevel", row[key]],
    ...aliases.map((alias) => ["alias", row.metrics?.[alias] ?? row.canonical?.metrics?.[alias] ?? row[alias]]),
  ];
  const found = sources.find(([, value]) => hasValue(value));
  return {
    origin: found?.[0] ?? null,
    present: Boolean(found),
    value: found ? finiteOrNull(found[1]) : null,
  };
}

function normalizeRange(row = {}, plan = {}) {
  return {
    from: row.provenance?.from ?? row.canonical?.range?.from ?? plan.range?.from ?? null,
    to: row.provenance?.to ?? row.canonical?.range?.to ?? plan.range?.to ?? null,
  };
}

function validationCount(row = {}) {
  const validation = row.validation ?? row.canonical?.validation ?? {};
  return (
    (validation.periods?.length ?? 0) +
    (validation.timeframes?.length ?? 0) +
    (validation.legacy ? 1 : 0) +
    (validation.conservative ? 1 : 0)
  );
}

function qualityGate({ canonical, row }) {
  const missing = canonical.dataCompleteness.missingFields;
  const trades = canonical.metrics.trades ?? 0;
  const validationChecks = validationCount(row);
  const reasons = [];

  if (missing.length) reasons.push(`Missing fields: ${missing.join(", ")}.`);
  if (trades < 30) reasons.push(`Trade count below research gate (${trades}/30).`);
  if (!validationChecks) reasons.push("No validation checks are attached.");
  if (canonical.metrics.profitFactor === null) reasons.push("PF unavailable.");
  if (canonical.metrics.maxDrawdown === null) reasons.push("Drawdown unavailable.");

  if (reasons.length) {
    return {
      label: trades === 0 ? "insufficient evidence" : missing.length ? "incomplete metrics" : "exploratory only",
      passed: false,
      reasons,
    };
  }

  return {
    label: row.research?.label ?? "research candidate",
    passed: true,
    reasons: ["Minimum metric and validation gates passed."],
  };
}

export function normalizeResearchResult(row = {}, { index = 0, output = {}, plan = {}, run = {} } = {}) {
  const net = pickMetric(row, "netProfit", ["netPnl", "totalPnl"]);
  const grossProfit = pickMetric(row, "grossProfit");
  const grossLoss = pickMetric(row, "grossLoss");
  const profitFactor = pickMetric(row, "profitFactor");
  const expectancy = pickMetric(row, "expectancy", ["averageTrade"]);
  const maxDrawdown = pickMetric(row, "maxDrawdown", ["drawdown"]);
  const pickedRrr = pickMetric(row, "rrr", ["rewardRiskRatio"]);
  const rrrSourceText = String(row.rrrSource ?? row.metrics?.rrrSource ?? "").toLowerCase();
  const rrr = rrrSourceText.includes("r multiple")
    ? { origin: null, present: false, value: null }
    : pickedRrr;
  const avgR = pickMetric(row, "avgR", ["averageR", "avgRPerTrade"]);
  const winRate = pickMetric(row, "winRate");
  const trades = pickMetric(row, "totalTrades", ["trades"]);
  const candlesUsed = pickMetric(row, "candlesUsed");
  const combinationCount = finiteOrNull(
    output.processedCombinations ??
    output.testedCombinations ??
    output.totalCombinations ??
    run.resultSummary?.executedCombinations ??
    run.progress?.completed,
  );

  const canonical = {
    candlesUsed: candlesUsed.value,
    computedAt: new Date().toISOString(),
    configId: row.id ?? `canonical-result-${index + 1}`,
    dataCompleteness: {
      hasDrawdown: maxDrawdown.present,
      hasMetrics: Boolean(row.metrics || row.canonical?.metrics),
      hasPf: profitFactor.present,
      hasTrades: trades.present,
      hasValidation: validationCount(row) > 0,
      missingFields: [],
    },
    fillMode: row.params?.fillMode ?? row.fillMode ?? row.provenance?.fillMode ?? plan.fillMode ?? "legacy",
    metrics: {
      expectancy: expectancy.value,
      grossLoss: grossLoss.value,
      grossProfit: grossProfit.value,
      maxDrawdown: maxDrawdown.value,
      netPnl: net.value,
      profitFactor: profitFactor.value,
      rrr: rrr.value,
      avgR: avgR.value,
      trades: trades.value,
      winRate: winRate.value,
    },
    metricOrigin: {
      candlesUsed: candlesUsed.origin,
      expectancy: expectancy.origin,
      grossLoss: grossLoss.origin,
      grossProfit: grossProfit.origin,
      maxDrawdown: maxDrawdown.origin,
      netPnl: net.origin,
      profitFactor: profitFactor.origin,
      rrr: rrr.origin,
      avgR: avgR.origin,
      trades: trades.origin,
      winRate: winRate.origin,
    },
    params: row.params ?? row.settings ?? {},
    provider: row.provenance?.provider ?? plan.provider ?? "binance-futures",
    range: normalizeRange(row, plan),
    rerunVerified: Boolean(row.integrity?.rerunVerified),
    runId: run.id ?? row.canonical?.runId ?? null,
    sizingMode: row.params?.sizingMode ?? row.provenance?.sizingMode ?? plan.sizingMode ?? "position-percent",
    status: "complete",
    symbol: row.symbol ?? row.provenance?.symbol ?? plan.symbol ?? "SOLUSDT",
    timeframe: row.timeframe ?? row.provenance?.timeframe ?? plan.timeframe ?? "15m",
    validation: row.validation ?? {},
  };

  REQUIRED_METRICS.forEach((field) => {
    const value = field === "netPnl"
      ? canonical.metrics.netPnl
      : field === "trades"
        ? canonical.metrics.trades
        : field === "candlesUsed"
          ? canonical.candlesUsed
          : canonical.metrics[field];
    if (value === null || value === undefined) canonical.dataCompleteness.missingFields.push(field);
  });

  if (canonical.dataCompleteness.missingFields.length || (canonical.metrics.trades ?? 0) === 0) {
    canonical.status = (canonical.metrics.trades ?? 0) === 0 ? "empty" : "incomplete";
  }

  const gate = qualityGate({ canonical, row });
  const integrityWarnings = [
    ...canonical.dataCompleteness.missingFields.map((field) => `${field} unavailable`),
    ...(!canonical.dataCompleteness.hasValidation ? ["Validation incomplete"] : []),
    ...(!gate.passed ? gate.reasons : []),
  ];
  const integrityScore = Math.max(0, Math.round(
    100 -
    canonical.dataCompleteness.missingFields.length * 12 -
    (!canonical.dataCompleteness.hasValidation ? 20 : 0) -
    ((canonical.metrics.trades ?? 0) < 30 ? 20 : 0),
  ));
  const research = row.research ? {
    ...row.research,
    label: gate.passed ? row.research.label : gate.label,
  } : {
    label: gate.label,
  };

  return {
    ...row,
    candlesUsed: canonical.candlesUsed,
    canonical,
    dataCompleteness: canonical.dataCompleteness,
    integrity: {
      candidateGate: gate,
      metricOrigin: canonical.metricOrigin,
      rerunVerified: canonical.rerunVerified,
      score: integrityScore,
      status: canonical.status,
      warnings: [...new Set(integrityWarnings)],
    },
    maxDrawdown: canonical.metrics.maxDrawdown,
    metrics: {
      ...(row.metrics ?? {}),
      expectancy: canonical.metrics.expectancy,
      grossLoss: canonical.metrics.grossLoss,
      grossProfit: canonical.metrics.grossProfit,
      maxDrawdown: canonical.metrics.maxDrawdown,
      netProfit: canonical.metrics.netPnl,
      profitFactor: canonical.metrics.profitFactor,
      totalTrades: canonical.metrics.trades,
      winRate: canonical.metrics.winRate,
    },
    netProfit: canonical.metrics.netPnl,
    profitFactor: canonical.metrics.profitFactor,
    research,
    totalTrades: canonical.metrics.trades,
    winRate: canonical.metrics.winRate,
  };
}

export function normalizeResearchRows(rows = [], context = {}) {
  return rows.map((row, index) => normalizeResearchResult(row, { ...context, index }));
}

export function summarizeIntegrity(rows = [], output = {}) {
  const normalized = rows.map((row, index) => normalizeResearchResult(row, { index, output }));
  const warnings = normalized.flatMap((row) => row.integrity?.warnings ?? []);
  const completeRows = normalized.filter((row) => row.canonical?.status === "complete").length;

  return {
    completeRows,
    incompleteRows: normalized.length - completeRows,
    ok: normalized.length > 0 && normalized.every((row) => row.canonical?.status === "complete"),
    score: normalized.length
      ? Math.round(normalized.reduce((sum, row) => sum + Number(row.integrity?.score ?? 0), 0) / normalized.length)
      : 0,
    warnings: [...new Set(warnings)].slice(0, 12),
  };
}

export function metricDiff(left = {}, right = {}) {
  const leftCanonical = left.canonical ?? normalizeResearchResult(left).canonical;
  const rightCanonical = right.canonical ?? normalizeResearchResult(right).canonical;
  const fields = ["netPnl", "profitFactor", "maxDrawdown", "trades", "winRate"];

  return Object.fromEntries(fields.map((field) => {
    const leftValue = leftCanonical.metrics[field];
    const rightValue = rightCanonical.metrics[field];
    return [field, {
      delta: leftValue !== null && rightValue !== null ? Number((rightValue - leftValue).toFixed(8)) : null,
      left: leftValue,
      match: leftValue === rightValue || (leftValue !== null && rightValue !== null && Math.abs(leftValue - rightValue) < 0.000001),
      right: rightValue,
    }];
  }));
}

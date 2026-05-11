function stripDiacritics(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function normalizeText(value = "") {
  return stripDiacritics(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function toIso(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function safeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pickRange(backtest = {}) {
  const from =
    backtest.analysisRange?.from ??
    backtest.range?.from ??
    backtest.sweepParams?.range?.from ??
    backtest.sourceCandles?.[0]?.time ??
    backtest.equityCurve?.[0]?.time ??
    backtest.trades?.[0]?.entryTime ??
    null;
  const to =
    backtest.analysisRange?.to ??
    backtest.range?.to ??
    backtest.sweepParams?.range?.to ??
    backtest.sourceCandles?.at?.(-1)?.time ??
    backtest.equityCurve?.at?.(-1)?.time ??
    backtest.trades?.at?.(-1)?.exitTime ??
    null;

  return {
    from: toIso(from),
    rawFrom: from ?? null,
    rawTo: to ?? null,
    to: toIso(to),
  };
}

function summarizeEquityCurve(curve = []) {
  if (!Array.isArray(curve) || !curve.length) {
    return {
      endingEquity: null,
      firstTime: null,
      lastTime: null,
      maxEquity: null,
      minEquity: null,
      points: 0,
      startingEquity: null,
    };
  }

  const equities = curve.map((point) => safeNumber(point.equity)).filter((value) => value !== null);
  return {
    endingEquity: equities.at(-1) ?? null,
    firstTime: toIso(curve[0]?.time),
    lastTime: toIso(curve.at(-1)?.time),
    maxEquity: equities.length ? Math.max(...equities) : null,
    minEquity: equities.length ? Math.min(...equities) : null,
    points: curve.length,
    startingEquity: equities[0] ?? null,
  };
}

function monthKey(value) {
  const iso = toIso(value);
  return iso ? iso.slice(0, 7) : "unknown";
}

function monthlyBreakdown(trades = []) {
  const map = new Map();
  for (const trade of Array.isArray(trades) ? trades : []) {
    const key = monthKey(trade.exitTime ?? trade.entryTime);
    const current = map.get(key) ?? {
      grossPnl: 0,
      losses: 0,
      month: key,
      netPnl: 0,
      trades: 0,
      wins: 0,
    };
    const pnl = Number(trade.netPnl ?? trade.pnl ?? 0);
    current.trades += 1;
    current.netPnl += Number.isFinite(pnl) ? pnl : 0;
    current.grossPnl += Number(trade.grossPnl ?? pnl ?? 0) || 0;
    if (pnl > 0) current.wins += 1;
    if (pnl < 0) current.losses += 1;
    map.set(key, current);
  }

  return [...map.values()]
    .sort((left, right) => left.month.localeCompare(right.month))
    .map((item) => ({
      ...item,
      netPnl: Number(item.netPnl.toFixed(8)),
      winRate: item.trades ? Number(((item.wins / item.trades) * 100).toFixed(4)) : 0,
    }));
}

function backtestMetrics(backtest = {}) {
  const metrics = backtest.metrics ?? {};
  return {
    averageTrade: safeNumber(metrics.averageTrade ?? metrics.expectancy),
    expectancy: safeNumber(metrics.expectancy ?? metrics.averageTrade),
    grossLoss: safeNumber(metrics.grossLoss),
    grossProfit: safeNumber(metrics.grossProfit),
    maxDrawdown: safeNumber(metrics.maxDrawdown),
    netProfit: safeNumber(metrics.netProfit ?? metrics.netPnl),
    profitFactor: safeNumber(metrics.profitFactor),
    totalTrades: safeNumber(metrics.totalTrades ?? backtest.trades?.length),
    winRate: safeNumber(metrics.winRate),
  };
}

function strategyParams(backtest = {}) {
  const settings = backtest.analysisSettings ?? backtest.sweepParams?.strategy ?? backtest.strategySnapshot ?? {};
  return {
    atrLength: safeNumber(settings.atrLength),
    atrMultiplier: safeNumber(settings.atrMultiplier),
    bandwidth: safeNumber(settings.bandwidth),
    envelopeMultiplier: safeNumber(settings.envelopeMultiplier ?? settings.nweMultiplier),
    maxSameSideFailures: safeNumber(settings.maxSameSideFailures),
    strategySource: settings.strategySource ?? "pine-ha",
  };
}

function sizingSummary(backtest = {}) {
  const config = backtest.config ?? {};
  const mmDeck = config.mmDeck ?? {};
  const sizingMode = config.sizingMode ?? (config.atrPositionSizing ? "fixed-risk" : "position-percent");
  const sizingValue = sizingMode === "fixed-risk"
    ? safeNumber(mmDeck.oneSlPercent ?? config.riskPercent)
    : safeNumber(mmDeck.positionPercent ?? config.positionSizePercent);

  return {
    fillMode: backtest.fillMode ?? config.fillMode ?? "legacy",
    mmDeck: {
      id: mmDeck.id ?? backtest.mmDeckId ?? null,
      mode: mmDeck.mode ?? null,
      name: mmDeck.name ?? backtest.mmDeckName ?? null,
      oneSlPercent: safeNumber(mmDeck.oneSlPercent),
      positionPercent: safeNumber(mmDeck.positionPercent),
    },
    sizingMode,
    sizingValue,
  };
}

function matchScore(candidate, normalizedQuery) {
  const normalizedName = normalizeText(candidate.name);
  const normalizedId = normalizeText(candidate.id);
  if (!normalizedQuery) return 0;
  if (normalizedId === normalizedQuery || normalizedName === normalizedQuery) return 1;
  if (normalizedName.startsWith(normalizedQuery)) return 0.88;
  if (normalizedName.includes(normalizedQuery)) return 0.74;
  if (normalizedId.includes(normalizedQuery)) return 0.7;
  return 0;
}

function categoryToType(category = "") {
  const normalized = normalizeText(category);
  if (normalized.includes("backtest")) return "backtest";
  if (normalized.includes("strategy")) return "strategyDeck";
  if (normalized.includes("mm") || normalized.includes("money")) return "mmDeck";
  if (normalized.includes("battle")) return "battleDeck";
  return "favorite";
}

function collectionNameForType(type) {
  return {
    backtest: "backtests",
    battleDeck: "battleDecks",
    mmDeck: "mmDecks",
    strategyDeck: "strategyDecks",
  }[type] ?? null;
}

function redactSecrets(value, depth = 0) {
  if (depth > 7) return "[trimmed]";
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactSecrets(item, depth + 1));
  if (!value || typeof value !== "object") {
    return typeof value === "string" && /(secret|token|api[-_]?key|password|authorization)/iu.test(value)
      ? "[redacted]"
      : value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    /(secret|token|api[-_]?key|password|authorization)/iu.test(key) ? "[redacted]" : redactSecrets(entry, depth + 1),
  ]));
}

export function createAiLibraryTools({ store }) {
  function collection(name) {
    return Array.isArray(store.getCollection(name)) ? store.getCollection(name) : [];
  }

  function allCandidates() {
    const favorites = collection("favorites").map((favorite) => ({
      favorite,
      id: favorite.itemId ?? favorite.id,
      name: favorite.name ?? favorite.itemId ?? favorite.id,
      source: "favorite",
      type: categoryToType(favorite.category),
    }));
    const saved = [
      ...collection("backtests").map((item) => ({ id: item.id, item, name: item.name ?? item.id, source: "saved-backtest", type: "backtest" })),
      ...collection("strategyDecks").map((item) => ({ id: item.id, item, name: item.name ?? item.id, source: "strategy-deck", type: "strategyDeck" })),
      ...collection("mmDecks").map((item) => ({ id: item.id, item, name: item.name ?? item.id, source: "mm-deck", type: "mmDeck" })),
      ...collection("battleDecks").map((item) => ({ id: item.id, item, name: item.name ?? item.id, source: "battle-deck", type: "battleDeck" })),
    ];
    return [...favorites, ...saved];
  }

  function resolveLibraryItem(query, { includeItem = false } = {}) {
    const rawQuery = typeof query === "object" && query !== null
      ? query.query ?? query.id ?? query.name ?? ""
      : query;
    const normalizedQuery = normalizeText(rawQuery);
    const matches = allCandidates()
      .map((candidate) => ({
        ...candidate,
        confidence: matchScore(candidate, normalizedQuery),
      }))
      .filter((candidate) => candidate.confidence > 0)
      .sort((left, right) => right.confidence - left.confidence || String(left.name).localeCompare(String(right.name)));

    if (!matches.length) {
      return {
        ambiguity: [],
        confidence: 0,
        ok: false,
        query: rawQuery,
        message: `No saved library item matched "${rawQuery}".`,
      };
    }

    const best = matches[0];
    const targetCollection = collectionNameForType(best.type);
    const target = best.item ?? (targetCollection ? collection(targetCollection).find((item) => item.id === best.id) : null);
    const ambiguity = matches.slice(0, 8).map((match) => ({
      confidence: Number(match.confidence.toFixed(2)),
      id: match.id,
      name: match.name,
      source: match.source,
      type: match.type,
    }));

    return {
      ambiguity,
      confidence: Number(best.confidence.toFixed(2)),
      id: target?.id ?? best.id,
      ...(includeItem ? { item: target ?? null } : {}),
      name: target?.name ?? best.name,
      ok: true,
      query: rawQuery,
      source: best.source,
      type: best.type,
      warning: matches[1]?.confidence === best.confidence ? "Multiple saved items matched equally. Use a direct id if this is not the intended item." : "",
    };
  }

  function getBacktestDetail(idOrName, options = {}) {
    const resolved = resolveLibraryItem(idOrName, { includeItem: true });
    if (!resolved.ok) return resolved;
    if (resolved.type !== "backtest") {
      return {
        ...resolved,
        ok: false,
        message: `"${resolved.name}" resolved to ${resolved.type}, not a saved backtest.`,
      };
    }

    const backtest = resolved.item ?? collection("backtests").find((item) => item.id === resolved.id);
    if (!backtest) {
      return {
        ...resolved,
        ok: false,
        message: `Backtest "${resolved.name}" was referenced but the saved record was not found.`,
      };
    }

    const tradeLimit = Math.max(1, Math.min(Number(options.tradeLimit ?? 500), 5000));
    const range = pickRange(backtest);
    const sizing = sizingSummary(backtest);
    const metrics = backtestMetrics(backtest);
    const trades = Array.isArray(backtest.trades) ? backtest.trades : [];

    return {
      id: backtest.id,
      name: backtest.name ?? resolved.name,
      ok: true,
      provenance: {
        candlesUsed: safeNumber(backtest.candlesUsed ?? backtest.sourceCandles?.length),
        createdAt: backtest.createdAt ?? null,
        dataDiagnostics: backtest.dataDiagnostics ?? null,
        favoriteName: resolved.source === "favorite" ? resolved.name : null,
        provider: backtest.provider ?? backtest.dataDiagnostics?.provider ?? "unknown",
        range,
        source: resolved.source,
        updatedAt: backtest.updatedAt ?? null,
      },
      range,
      metrics,
      strategyParams: strategyParams(backtest),
      sizingMode: sizing.sizingMode,
      sizingValue: sizing.sizingValue,
      fillMode: sizing.fillMode,
      mm: sizing.mmDeck,
      symbol: backtest.analysisSettings?.symbol ?? backtest.sweepParams?.symbol ?? backtest.symbol ?? "SOLUSDT",
      timeframe: backtest.timeframe ?? backtest.analysisSettings?.timeframe ?? "unknown",
      tradesCount: metrics.totalTrades ?? trades.length,
      trades: trades.slice(0, tradeLimit),
      tradesCapped: trades.length > tradeLimit,
      equityCurveSummary: summarizeEquityCurve(backtest.equityCurve),
      monthlyBreakdown: monthlyBreakdown(trades),
      dataCompleteness: {
        hasEquityCurve: Array.isArray(backtest.equityCurve) && backtest.equityCurve.length > 0,
        hasMetrics: Boolean(backtest.metrics),
        hasStrategyParams: Object.values(strategyParams(backtest)).some((value) => value !== null && value !== undefined),
        hasTrades: trades.length > 0,
        missing: [
          ...(!backtest.metrics ? ["metrics"] : []),
          ...(!trades.length ? ["trades"] : []),
          ...(!range.from || !range.to ? ["range"] : []),
          ...(!backtest.provider ? ["provider"] : []),
        ],
      },
      resolved: {
        ambiguity: resolved.ambiguity,
        confidence: resolved.confidence,
        query: resolved.query,
        source: resolved.source,
      },
    };
  }

  function getLibraryItemDetail(idOrName) {
    const resolved = resolveLibraryItem(idOrName, { includeItem: true });
    if (!resolved.ok) return resolved;
    if (resolved.type === "backtest") return getBacktestDetail(idOrName);
    return {
      id: resolved.id,
      item: redactSecrets(resolved.item ?? {}),
      name: resolved.name,
      ok: true,
      resolved: {
        ambiguity: resolved.ambiguity,
        confidence: resolved.confidence,
        query: resolved.query,
        source: resolved.source,
      },
      source: resolved.source,
      type: resolved.type,
    };
  }

  return {
    getBacktestDetail,
    getLibraryItemDetail,
    resolveLibraryItem,
  };
}

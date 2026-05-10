const SECRET_KEY_PATTERN = /(secret|token|password|authorization|api[-_]?key|private)/iu;
const SECRET_VALUE_PATTERN = /(?:sk-[a-z0-9_-]+|api[_-]?secret|api[_-]?key|secret=|token=)/iu;

function sanitizeForAi(value, depth = 0) {
  if (depth > 7) return "[trimmed]";
  if (Array.isArray(value)) {
    return value.slice(0, 60).map((item) => sanitizeForAi(item, depth + 1));
  }

  if (!value || typeof value !== "object") {
    if (typeof value === "string" && SECRET_VALUE_PATTERN.test(value)) {
      return "[redacted]";
    }

    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (SECRET_KEY_PATTERN.test(key)) {
        return [key, "[redacted]"];
      }

      return [key, sanitizeForAi(entry, depth + 1)];
    }),
  );
}

function compactDeck(deck) {
  if (!deck) return null;
  return sanitizeForAi({
    allowLong: deck.allowLong,
    allowShort: deck.allowShort,
    atrLength: deck.atrLength,
    atrMultiplier: deck.atrMultiplier,
    bandwidth: deck.bandwidth,
    envelopeMultiplier: deck.envelopeMultiplier,
    id: deck.id,
    maxSameSideFailures: deck.maxSameSideFailures,
    mode: deck.mode,
    name: deck.name,
    positionPercent: deck.positionPercent,
    sizingMode: deck.sizingMode,
    strategySource: deck.strategySource,
    symbol: deck.symbol,
    timeframe: deck.timeframe,
  });
}

function compactBacktest(backtest) {
  if (!backtest) return null;
  return sanitizeForAi({
    candlesUsed: backtest.candlesUsed,
    createdAt: backtest.createdAt,
    id: backtest.id,
    metrics: backtest.metrics,
    mmDeckName: backtest.mmDeckName,
    name: backtest.name,
    provider: backtest.provider,
    range: backtest.range,
    strategyDeckName: backtest.strategyDeckName,
    timeframe: backtest.timeframe,
    tradeCount: backtest.trades?.length ?? backtest.metrics?.totalTrades ?? 0,
  });
}

export function createAiContextBuilder({
  buildLivestreamPayload,
  calculateAnalytics,
  dataAvailability,
  publicApiProfiles,
  publicStatusPayload,
  store,
}) {
  return async function buildAiContext(flags = {}) {
    const include = {
      analytics: flags.includeAnalytics !== false,
      backtests: flags.includeBacktests !== false,
      codeMap: flags.includeCodeMap === true,
      decks: flags.includeDecks !== false,
      errors: flags.includeErrors !== false,
      livePositions: flags.includeLivePositions !== false,
      systemStatus: flags.includeSystemStatus !== false,
    };
    const executionConfig = store.getExecutionConfig();
    const battleDecks = store.getCollection("battleDecks") ?? [];
    const strategyDecks = store.getCollection("strategyDecks") ?? [];
    const mmDecks = store.getCollection("mmDecks") ?? [];
    const selectedBattleDeck =
      battleDecks.find((deck) => deck.id === executionConfig.activeBattleDeckId) ??
      battleDecks.at(-1) ??
      null;
    const selectedStrategyDeck =
      strategyDecks.find((deck) => deck.id === selectedBattleDeck?.strategyDeckId) ??
      selectedBattleDeck?.strategySnapshot ??
      strategyDecks.at(-1) ??
      null;
    const selectedMmDeck =
      mmDecks.find((deck) => deck.id === selectedBattleDeck?.mmDeckId) ??
      selectedBattleDeck?.mmSnapshot ??
      mmDecks.at(-1) ??
      null;
    const recentLogs = store.getLogs().slice(-80);
    const errors = recentLogs.filter((log) => {
      const text = `${log.message ?? ""} ${JSON.stringify(log.context ?? {})}`.toLowerCase();
      return text.includes("error") || text.includes("failed") || text.includes("reject") || text.includes("warning");
    });
    const apiProfiles = include.livePositions ? await publicApiProfiles().catch(() => []) : [];
    const system = include.systemStatus ? publicStatusPayload() : null;
    const availability = include.systemStatus ? await dataAvailability().catch(() => []) : [];
    const live = include.livePositions ? buildLivestreamPayload(apiProfiles) : null;
    const backtests = store.getCollection("backtests") ?? [];

    return sanitizeForAi({
      app: {
        generatedAt: new Date().toISOString(),
        name: "Choromański Trading Platform",
        version: "0.1.0",
      },
      chart: {
        currentSymbol: selectedBattleDeck?.symbol ?? selectedStrategyDeck?.symbol ?? "SOLUSDT",
        selectedTimeframe: selectedBattleDeck?.timeframe ?? selectedStrategyDeck?.timeframe ?? "15m",
      },
      dataAvailability: availability,
      featureFlags: {
        aiCanTrade: false,
        externalLlmConnected: false,
        mockProvider: true,
      },
      latestBacktest: include.backtests ? compactBacktest(backtests.at(-1)) : undefined,
      live: live
        ? {
            accountSummary: live.accountSummary,
            openOrdersCount: live.openOrders?.length ?? 0,
            positions: live.positions,
          }
        : undefined,
      recentBacktests: include.backtests ? backtests.slice(-10).map(compactBacktest) : undefined,
      recentErrors: include.errors ? errors.slice(-20) : undefined,
      selectedSetup: include.decks
        ? {
            battleDeck: compactDeck(selectedBattleDeck),
            mmDeck: compactDeck(selectedMmDeck),
            sizingMode: selectedStrategyDeck?.sizingMode ?? (selectedStrategyDeck?.atrPositionSizing ? "fixed-risk" : "position-percent"),
            strategyDeck: compactDeck(selectedStrategyDeck),
          }
        : undefined,
      system: system
        ? {
            analytics: include.analytics ? calculateAnalytics(store.getTrades()) : undefined,
            backend: system.summary,
            botStatus: system.state?.botStatus,
            bingx: system.state?.bingx,
            safety: system.state?.safety,
          }
        : undefined,
    });
  };
}

export { sanitizeForAi };

export function summarizeWorkspaceForAgentOS(workspaceContext = {}) {
  return {
    activeBacktest: workspaceContext.activeBacktest ?? null,
    activePanel: workspaceContext.activePanel ?? null,
    chart: {
      provider: workspaceContext.chart?.provider ?? "binance-futures",
      renderedCandles: workspaceContext.chart?.renderedCandles ?? null,
      symbol: workspaceContext.chart?.symbol ?? "SOLUSDT",
      timeframe: workspaceContext.chart?.timeframe ?? "15m",
      visibleRange: workspaceContext.chart?.visibleRange ?? null,
    },
    live: {
      openPositions: workspaceContext.live?.openPositions ?? workspaceContext.live?.positions?.length ?? 0,
      source: workspaceContext.live?.source ?? "unknown",
      syncAgeSeconds: workspaceContext.live?.syncAgeSeconds ?? null,
    },
    selectedDecks: workspaceContext.selectedDecks ?? {},
  };
}

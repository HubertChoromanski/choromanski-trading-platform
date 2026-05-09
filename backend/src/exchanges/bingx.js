function liveDisabled() {
  throw new Error("BingX live trading is disabled until backend credentials and safety checks are implemented.");
}

export function createBingxClient() {
  return {
    cancelOrders: liveDisabled,
    closePosition: liveDisabled,
    getBalance: liveDisabled,
    getOpenPositions: liveDisabled,
    placeMarketOrder: liveDisabled,
    placeStopLoss: liveDisabled,
    setLeverage: liveDisabled,
  };
}

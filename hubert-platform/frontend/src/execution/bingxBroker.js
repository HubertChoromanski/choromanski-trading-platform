function liveDisabled() {
  throw new Error("Live BingX execution is disabled. Paper mode is the only active execution mode.");
}

export const bingxBroker = {
  cancelOrders: liveDisabled,
  closePosition: liveDisabled,
  getBalance: liveDisabled,
  getOpenPositions: liveDisabled,
  placeMarketOrder: liveDisabled,
  placeStopLoss: liveDisabled,
  setLeverage: liveDisabled,
};

function round(value) {
  return Number(value.toFixed(4));
}

export function toHeikenAshi(candles) {
  let previousOpen = null;
  let previousClose = null;

  return candles.map((candle) => {
    const close = (candle.open + candle.high + candle.low + candle.close) / 4;
    const open =
      previousOpen === null || previousClose === null
        ? (candle.open + candle.close) / 2
        : (previousOpen + previousClose) / 2;
    const high = Math.max(candle.high, open, close);
    const low = Math.min(candle.low, open, close);

    previousOpen = open;
    previousClose = close;

    return {
      time: candle.time,
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
    };
  });
}

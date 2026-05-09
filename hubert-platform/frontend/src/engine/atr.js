export function calculateTrueRange(candles) {
  return candles.map((candle, index) => {
    if (index === 0) {
      return candle.high - candle.low;
    }

    const previousClose = candles[index - 1].close;

    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
}

export function calculateAtr(candles, length = 14) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return [];
  }

  const trueRanges = calculateTrueRange(candles);
  const atr = Array(candles.length).fill(null);

  for (let index = 0; index < trueRanges.length; index += 1) {
    if (index === length - 1) {
      const seed = trueRanges
        .slice(0, length)
        .reduce((total, value) => total + value, 0);

      atr[index] = seed / length;
    } else if (index >= length) {
      atr[index] = (atr[index - 1] * (length - 1) + trueRanges[index]) / length;
    }
  }

  return atr;
}

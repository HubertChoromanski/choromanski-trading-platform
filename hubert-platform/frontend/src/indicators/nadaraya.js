const DEFAULT_BANDWIDTH = 8;
const DEFAULT_MULTIPLIER = 3;
const DEFAULT_LOOKBACK = 500;
const DEFAULT_MAE_LENGTH = 499;

function gaussian(distance, bandwidth) {
  return Math.exp(-(distance * distance) / (bandwidth * bandwidth * 2));
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : null;
}

function buildWeights(bandwidth, lookback) {
  return Array.from({ length: lookback }, (_, index) => gaussian(index, bandwidth));
}

function sma(values, index, length) {
  if (index < length - 1) {
    return null;
  }

  let sum = 0;

  for (let cursor = index - length + 1; cursor <= index; cursor += 1) {
    if (!Number.isFinite(values[cursor])) {
      return null;
    }

    sum += values[cursor];
  }

  return sum / length;
}

export function calculateNadarayaEnvelope(
  candles,
  {
    bandwidth = DEFAULT_BANDWIDTH,
    multiplier = DEFAULT_MULTIPLIER,
    lookback = DEFAULT_LOOKBACK,
    maeLength = DEFAULT_MAE_LENGTH,
  } = {},
) {
  const closes = candles.map((candle) => candle.close);
  const weights = buildWeights(bandwidth, lookback);
  const denominator = weights.reduce((total, weight) => total + weight, 0);
  const basis = closes.map((_, index) => {
    if (index < lookback - 1) {
      return null;
    }

    let weightedSum = 0;

    for (let offset = 0; offset < lookback; offset += 1) {
      weightedSum += closes[index - offset] * weights[offset];
    }

    return weightedSum / denominator;
  });
  const absoluteErrors = closes.map((close, index) => {
    if (!Number.isFinite(basis[index])) {
      return null;
    }

    return Math.abs(close - basis[index]);
  });

  return candles.map((candle, index) => {
    const meanAbsoluteError = sma(absoluteErrors, index, maeLength);

    if (!Number.isFinite(basis[index]) || !Number.isFinite(meanAbsoluteError)) {
      return {
        time: candle.time,
        basis: null,
        upper: null,
        lower: null,
      };
    }

    const envelope = meanAbsoluteError * multiplier;

    return {
      time: candle.time,
      basis: round(basis[index]),
      upper: round(basis[index] + envelope),
      lower: round(basis[index] - envelope),
    };
  });
}

export function toLineData(envelope, key) {
  return envelope
    .filter((point) => Number.isFinite(point[key]))
    .map((point) => ({
      time: point.time,
      value: point[key],
    }));
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function maxDrawdown(equityCurve) {
  let peak = equityCurve[0]?.equity ?? 0;
  let maxDd = 0;

  equityCurve.forEach((point) => {
    peak = Math.max(peak, point.equity);
    if (peak > 0) {
      maxDd = Math.max(maxDd, ((peak - point.equity) / peak) * 100);
    }
  });

  return maxDd;
}

function consecutive(trades, isWin) {
  let current = 0;
  let best = 0;

  trades.forEach((trade) => {
    if (isWin(trade)) {
      current += 1;
      best = Math.max(best, current);
    } else {
      current = 0;
    }
  });

  return best;
}

function simpleSharpe(trades) {
  if (trades.length < 2) {
    return 0;
  }

  const returns = trades.map((trade) => trade.returnPercent);
  const average = sum(returns) / returns.length;
  const variance =
    sum(returns.map((value) => (value - average) ** 2)) / (returns.length - 1);
  const deviation = Math.sqrt(variance);

  return deviation === 0 ? 0 : average / deviation;
}

export function calculateBacktestMetrics({ trades, equityCurve, startingBalance }) {
  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl < 0);
  const grossProfit = sum(wins.map((trade) => trade.netPnl));
  const grossLoss = Math.abs(sum(losses.map((trade) => trade.netPnl)));
  const netProfit = sum(trades.map((trade) => trade.netPnl));
  const totalTrades = trades.length;

  return {
    averageLoss: losses.length ? sum(losses.map((trade) => trade.netPnl)) / losses.length : 0,
    averageTrade: totalTrades ? netProfit / totalTrades : 0,
    averageWin: wins.length ? grossProfit / wins.length : 0,
    consecutiveLosses: consecutive(trades, (trade) => trade.netPnl < 0),
    consecutiveWins: consecutive(trades, (trade) => trade.netPnl > 0),
    endingBalance: startingBalance + netProfit,
    expectancy: totalTrades ? netProfit / totalTrades : 0,
    grossLoss,
    grossProfit,
    largestLoss: losses.length ? Math.min(...losses.map((trade) => trade.netPnl)) : 0,
    largestWin: wins.length ? Math.max(...wins.map((trade) => trade.netPnl)) : 0,
    longTrades: trades.filter((trade) => trade.direction === "LONG").length,
    maxDrawdown: maxDrawdown(equityCurve),
    netProfit,
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? Infinity : 0) : grossProfit / grossLoss,
    sharpeLike: simpleSharpe(trades),
    shortTrades: trades.filter((trade) => trade.direction === "SHORT").length,
    totalTrades,
    winRate: totalTrades ? (wins.length / totalTrades) * 100 : 0,
  };
}

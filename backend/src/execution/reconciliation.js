export function normalizeList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.positions)) return value.positions;
  if (Array.isArray(value?.orders)) return value.orders;
  if (Array.isArray(value?.balances)) return value.balances;
  if (Array.isArray(value?.data)) return value.data;
  return value ? [value] : [];
}

function compactSymbol(symbol) {
  return String(symbol ?? "").replace("-", "").toUpperCase();
}

function positionAmount(position) {
  return Number(position.positionAmt ?? position.positionAmount ?? position.quantity ?? position.availableAmt ?? 0);
}

function positionSide(position) {
  const side = String(position.positionSide ?? position.side ?? "").toUpperCase();

  if (side.includes("LONG")) return "LONG";
  if (side.includes("SHORT")) return "SHORT";

  return positionAmount(position) >= 0 ? "LONG" : "SHORT";
}

function matchingPositions(positions, symbol) {
  return positions.filter(
    (position) => compactSymbol(position.symbol) === compactSymbol(symbol) && Math.abs(positionAmount(position)) > 0,
  );
}

function stopOrdersForSymbol(orders, symbol) {
  return orders.filter((order) => {
    const orderSymbol = compactSymbol(order.symbol);
    const type = String(order.type ?? order.orderType ?? "").toUpperCase();
    const status = String(order.status ?? order.orderStatus ?? "").toUpperCase();
    return orderSymbol === compactSymbol(symbol) && type.includes("STOP") && !["FILLED", "CANCELED", "CANCELLED"].includes(status);
  });
}

export async function reconcileBingxState({ client, logger, profiles, repairMissingStops = false }) {
  if (!client.auth.configured) {
    return {
      balance: null,
      lastSyncAt: new Date().toISOString(),
      openOrders: [],
      openPositions: [],
      reconciliationStatus: "NO_API_KEYS",
      warning: "",
    };
  }

  const balance = await client.getPerpetualFuturesBalance();
  const openPositions = normalizeList(await client.getOpenPositions());
  const openOrders = normalizeList(await client.getOpenOrders());
  const warnings = [];
  const actions = [];

  for (const profile of profiles.filter((item) => item.executionMode === "live")) {
    const localPosition = profile.live?.openPosition;
    const exchangePositions = matchingPositions(openPositions, profile.symbol);
    const exchangeHasPosition = exchangePositions.length > 0;
    const stopOrders = stopOrdersForSymbol(openOrders, profile.symbol);
    const exchangeHasStop = stopOrders.length > 0;

    if (localPosition && !exchangeHasPosition) {
      warnings.push(`${profile.id}: local position exists but exchange position is missing`);
    }

    if (!localPosition && exchangeHasPosition) {
      warnings.push(`${profile.id}: exchange position exists but local position is missing`);
    }

    if (exchangePositions.length > 1) {
      warnings.push(`${profile.id}: duplicate exchange positions detected`);
    }

    if (stopOrders.length > 1) {
      warnings.push(`${profile.id}: duplicate stop orders detected`);
    }

    if (localPosition && exchangeHasPosition) {
      const exchangePosition = exchangePositions[0];
      const localSide = localPosition.direction;
      const localQuantity = Number(localPosition.quantity ?? 0);
      const exchangeQuantity = Math.abs(positionAmount(exchangePosition));

      if (positionSide(exchangePosition) !== localSide) {
        warnings.push(`${profile.id}: exchange side mismatch`);
      }

      if (localQuantity > 0 && exchangeQuantity > 0 && Math.abs(localQuantity - exchangeQuantity) > Math.max(0.001, localQuantity * 0.02)) {
        warnings.push(`${profile.id}: exchange quantity mismatch`);
      }
    }

    if (localPosition && !exchangeHasStop) {
      if (repairMissingStops && Number.isFinite(localPosition.stopLoss) && Number(localPosition.quantity) > 0) {
        try {
          const side = localPosition.direction === "LONG" ? "BUY" : "SELL";
          const stopOrder = await client.placeStopLoss(
            profile.symbol,
            side,
            localPosition.stopLoss,
            localPosition.quantity,
          );
          actions.push(`${profile.id}: missing stop loss repaired`);
          await logger("safety action", { action: "missing stop loss repaired", profileId: profile.id, stopOrder });
        } catch (error) {
          warnings.push(`${profile.id}: stop loss missing and repair failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        warnings.push(`${profile.id}: stop loss order is missing`);
      }
    }
  }

  if (warnings.length > 0) {
    await logger("reconciliation warning", { warnings });
  }

  return {
    actions,
    balance,
    lastSyncAt: new Date().toISOString(),
    openOrders,
    openPositions,
    activeSlOrders: openOrders.filter((order) => String(order.type ?? order.orderType ?? "").toUpperCase().includes("STOP")),
    reconciliationStatus: warnings.length > 0 ? "WARNING" : "OK",
    warning: warnings.join(" | "),
  };
}

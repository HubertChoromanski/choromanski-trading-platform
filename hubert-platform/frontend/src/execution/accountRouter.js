export const ACCOUNT_TYPES = {
  MAIN: "main",
  SUBACCOUNT: "subaccount",
};

export function createAccountRoute({
  accountLabel = "Main Account",
  accountType = ACCOUNT_TYPES.MAIN,
  apiProfile = "paper-main",
  exchange = "BingX",
} = {}) {
  return {
    accountLabel,
    accountType,
    apiProfile,
    exchange,
  };
}

export function testConnection(route) {
  return {
    ok: false,
    message: `${route.exchange} live connection is not enabled yet.`,
  };
}

// a stellar.expert link for an address or a transaction, on the wallet's network.
//
// the explorer names mainnet "public"; every other id is a test network to it.
// history had its own private copy of this; it now lives here so the receipt and
// the history detail cannot disagree on where "view on chain" goes.
export function explorerUrl(
  network: string | undefined,
  kind: "account" | "tx",
  id: string,
): string {
  const net = network === "public" || network === "mainnet" ? "public" : "testnet";
  return `https://stellar.expert/explorer/${net}/${kind}/${id}`;
}

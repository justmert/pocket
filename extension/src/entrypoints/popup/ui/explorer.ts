// a stellar.expert link for an address or a transaction, on the wallet's network.
//
// the explorer names mainnet "public"; every other id is a test network to it.
// history had its own private copy of this; it now lives here so the receipt and
// the history detail cannot disagree on where "view on chain" goes.
export function explorerUrl(
  network: string | undefined,
  kind: "account" | "contract" | "tx",
  id: string,
): string {
  const net = network === "public" || network === "mainnet" ? "public" : "testnet";
  return `https://stellar.expert/explorer/${net}/${kind}/${id}`;
}

/**
 * The link for a COUNTERPARTY, whatever kind of address it turns out to be.
 *
 * A counterparty is not always an account. Every `invoke_host_function` entry
 * names a contract: the Aquarius router on a swap, the CCTP token messenger on
 * a bridge, the DeFindex vault on a yield move. Those were all handed to the
 * account route, and stellar.expert has a separate one for contracts.
 *
 * Measured against its API on 2026-08-09:
 *   /explorer/testnet/account/CDNG7HXA...  -> 400 "Invalid account public key"
 *   /explorer/testnet/contract/CDNG7HXA... -> the contract, with its balances
 *   /explorer/testnet/account/M...         -> the same 400
 *
 * So: G goes to the account route, C to the contract route, and anything else
 * gets NO link. That last case covers a muxed M-address and a bridge's 0x
 * recipient on another chain, neither of which stellar.expert can resolve. The
 * rule is the one the CCTP row already states: no link is better than one that
 * denies the address.
 */
export function addressUrl(network: string | undefined, id: string | undefined): string | undefined {
  if (!id) return undefined;
  if (/^G[A-Z2-7]{55}$/.test(id)) return explorerUrl(network, "account", id);
  if (/^C[A-Z2-7]{55}$/.test(id)) return explorerUrl(network, "contract", id);
  return undefined;
}

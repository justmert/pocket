// stellar.expert has two address routes, and the wallet used one of them.
//
// Every `invoke_host_function` entry's counterparty is a contract: the Aquarius
// router on a swap, the CCTP token messenger on a bridge, the DeFindex vault on
// a yield move. All of them were handed to /explorer/<net>/account/<id>.
//
// Measured against api.stellar.expert on 2026-08-09:
//   /explorer/testnet/account/CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP
//     -> {"error":"Bad request. Invalid parameter: \"account\". Invalid account
//        public key.","status":400}
//   /explorer/testnet/contract/CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP
//     -> the contract, with its creator, wasm hash and balances
//   /explorer/testnet/account/MBB2...  -> the same 400
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { addressUrl, explorerUrl } from "./explorer";

const HISTORY = readFileSync(
  fileURLToPath(new URL("./screens/History.tsx", import.meta.url)),
  "utf8",
);

const G = "GDYXWRHXUTWKXQZ33IKCZLKKDTGNKERWXFRVM5Z7H7TFYZJBHMC7UAIK";
const C = "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP";
const M = "MBB2FJQ35YIW4WCRCFAJML5TIBBGEZLHOB5C7U4TMTHRRDNJWNYNZAAAAAAAAAAAAAAAB";

describe("where an address on a receipt links to", () => {
  it("sends an account to the account route", () => {
    expect(addressUrl("testnet", G)).toBe(`https://stellar.expert/explorer/testnet/account/${G}`);
  });

  it("sends a contract to the CONTRACT route, which is the one that resolves it", () => {
    expect(
      addressUrl("testnet", C),
      "a swap router, a bridge messenger and a yield vault are all C-addresses",
    ).toBe(`https://stellar.expert/explorer/testnet/contract/${C}`);
  });

  it("gives a muxed address no link, because neither route accepts it", () => {
    expect(addressUrl("testnet", M)).toBeUndefined();
  });

  it("gives a bridge recipient on another chain no link", () => {
    expect(addressUrl("testnet", "0x5f2b7077a7e5b4fdd97cbb56d9ad02a4f0c8e1a9")).toBeUndefined();
  });

  it("gives nothing at all no link, rather than a link to nothing", () => {
    expect(addressUrl("testnet", undefined)).toBeUndefined();
    expect(addressUrl("testnet", "")).toBeUndefined();
  });

  it("keeps mainnet on the explorer's own name for it", () => {
    expect(addressUrl("mainnet", C)).toBe(`https://stellar.expert/explorer/public/contract/${C}`);
    expect(addressUrl("public", G)).toBe(`https://stellar.expert/explorer/public/account/${G}`);
    expect(explorerUrl("mainnet", "tx", "a".repeat(64))).toContain("/explorer/public/tx/");
  });

  it("is what the receipt actually calls: no address goes to the account route by hand", () => {
    // The defect was one call site passing every counterparty, contract or not,
    // straight to the account route. A unit test of `addressUrl` alone would
    // stay green while that line was still there.
    expect(
      HISTORY.match(/explorerUrl\([^)]*"account"/g),
      "an address on the history screen is being routed without addressUrl",
    ).toBeNull();
  });
});

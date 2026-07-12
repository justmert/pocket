import { describe, it, expect } from "vitest";
import { AquariusClient } from "./aquarius";
import { NETWORKS } from "../config";

// Hits live testnet Aquarius. Not mocked: the point is that a route with real
// liquidity actually exists, which is why Aquarius was chosen over the
// mainnet-only aggregators.
const XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

describe("live testnet Aquarius routing", () => {
  const apiUrl = NETWORKS.testnet.aquarius?.apiUrl;
  const client = new AquariusClient({ apiUrl: apiUrl ?? "" });

  it("finds a strict-send route for XLM -> USDC with real liquidity", async () => {
    const p = await client.findPath(XLM, USDC, 10_000000n);
    expect(p.amount).toBeGreaterThan(0n);
    expect(p.swapChainXdr.length).toBeGreaterThan(0);
    expect(p.pools.length).toBeGreaterThan(0);
  });

  it("finds a strict-receive route for USDC -> XLM", async () => {
    const p = await client.findPathStrictReceive(USDC, XLM, 1_000000n);
    expect(p.amount).toBeGreaterThan(0n);
  });
});

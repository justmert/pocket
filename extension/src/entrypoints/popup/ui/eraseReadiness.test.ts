// The last sentence before the one irreversible act has to be true.
//
// `privateLossAfterErase` promised, unconditionally when an archive URL is
// configured, that the keys could be rebuilt afterwards.
//
// The branch read `Boolean(NETWORKS[network].archiveUrl)` and nothing else. Not
// whether the archive answers, not whether it is current, not whether it holds
// this contract at all. Measured 2026-08-08 against the archive this checkout
// configures: ingested_through 4033277 while soroban-testnet reported sequence
// 4035534, about three hours behind. A user erasing then, having read that
// sentence, meets RecoveryMismatchError for any private movement in the window
// and gets nothing back, with the keys already destroyed.
import { describe, it, expect } from "vitest";
import { archiveReadiness, privateLossAfterErase } from "./copy";

describe("the erase sheet's promise", () => {
  it("no longer guarantees a rebuild it cannot check", async () => {
    const { NETWORKS } = await import("../../../core/config");
    // Only meaningful on a network that HAS an archive configured; the other
    // branch already said the truth.
    if (!NETWORKS.testnet.archiveUrl) return;
    const said = privateLossAfterErase("testnet");
    expect(said, "still promising a rebuild from a build-time flag").not.toMatch(
      /can be rebuilt afterwards/,
    );
    // the dependency, not a guarantee: `archiveReadiness` below is drawn beside
    // this line and is the only thing that can answer whether it would work.
    expect(said).toBe("Private balances come back only from the archive.");
  });

  it("still says plainly that a build with no archive cannot rebuild at all", async () => {
    const { NETWORKS } = await import("../../../core/config");
    if (NETWORKS.mainnet.archiveUrl) return;
    expect(privateLossAfterErase("mainnet")).toBe("Private balances cannot be recovered.");
  });
});

describe("what the archive actually reports", () => {
  it("refuses to reassure when the archive did not answer", () => {
    const r = archiveReadiness(null, 4_035_534);
    expect(r.ok).toBe(false);
    expect(r.sentence).toBe("Archive unreachable: private balances could not be rebuilt.");
  });

  it("refuses to reassure when the archive is behind", () => {
    // The measured case. Seconds is what the archive believes about the clock;
    // ledgers is what the replay actually needs, so the comparison stays in
    // ledgers even though the raw sequence number is no longer quoted at
    // someone about to erase their wallet.
    const r = archiveReadiness({ ingestedThrough: 4_033_277 }, 4_035_534);
    expect(r.ok).toBe(false);
    expect(r.sentence).toBe("Archive is behind: recent private activity could not be rebuilt.");
  });

  it("says so when the archive holds nothing for this deployment", () => {
    const r = archiveReadiness({ ingestedThrough: null }, 4_035_534);
    expect(r.ok).toBe(false);
    expect(r.sentence).toBe("Nothing recorded yet: private balances could not be rebuilt.");
  });

  it("does not claim current when the chain's own position is unknown", () => {
    // Two unknowns are not a yes. Without the chain there is nothing to compare
    // the archive against, and the sentence has to say that rather than round
    // it up.
    const r = archiveReadiness({ ingestedThrough: 4_033_277 }, null);
    expect(r.ok).toBe(false);
    expect(r.sentence).toBe("Cannot confirm your private balances could be rebuilt.");
  });

  it("reassures only when the archive has actually caught up", () => {
    // The control. A readiness check that never says yes is a check nobody can
    // act on, and the user would erase anyway with the warning ignored.
    const r = archiveReadiness({ ingestedThrough: 4_035_534 }, 4_035_534);
    expect(r.ok).toBe(true);
    expect(r.sentence).toBe("Archive up to date");
  });

  it("treats an archive AHEAD of our read of the chain as caught up", () => {
    // The two reads are not simultaneous, so the archive can legitimately be a
    // ledger or two in front. Calling that "behind by -2" would be nonsense on
    // screen.
    const r = archiveReadiness({ ingestedThrough: 4_035_536 }, 4_035_534);
    expect(r.ok).toBe(true);
  });
});

// What a non-ready private pocket offers to do about itself.
//
// Two screens offer this and they disagreed. The private asset sheet mapped
// each state to its own action and to NO button for `unavailable` and
// `unfunded`; the Shield/Unshield screen showed one unbranched "Open the
// private pocket" for all six. Two of those six have no action at all, so the
// button was a door back to the same wall.
//
// A rebuild is also only a real offer where there is an archive to replay from,
// which the sheet checked and the other screen did not.
import { describe, it, expect, vi } from "vitest";

vi.mock("../../../core/config", async (orig) => {
  const real = (await orig()) as { NETWORKS: Record<string, Record<string, unknown>> };
  return {
    ...real,
    NETWORKS: {
      ...real.NETWORKS,
      testnet: { ...real.NETWORKS.testnet, archiveUrl: "https://archive.invalid" },
      mainnet: { ...real.NETWORKS.mainnet, archiveUrl: undefined },
    },
  };
});

const { privateStateAction } = await import("./copy");

describe("the action a private pocket state offers", () => {
  it("offers nothing where nothing can be done here", () => {
    // An account that is not on the network yet needs funding, not a private
    // pocket; a network with no deployment has nothing to open.
    expect(privateStateAction("unfunded", "testnet")).toBeNull();
    expect(privateStateAction("unavailable", "testnet")).toBeNull();
    expect(privateStateAction("ready", "testnet")).toBeNull();
  });

  it("names the action for the states that have one", () => {
    expect(privateStateAction("unregistered", "testnet")).toBe("Set up");
    expect(privateStateAction("archived", "testnet")).toBe("Reactivate");
    expect(privateStateAction("needsRecovery", "testnet")).toBe("Rebuild");
    expect(privateStateAction("diverged", "testnet")).toBe("Rebuild");
  });

  it("does not offer a rebuild where there is no archive to replay from", () => {
    // The sheet checked this and the move screen did not, which is how one
    // screen offered a button the other knew was impossible.
    expect(privateStateAction("needsRecovery", "mainnet")).toBeNull();
    expect(privateStateAction("diverged", "mainnet")).toBeNull();
  });

  it("still offers set-up and reactivation without an archive", () => {
    // Neither replays history, so neither depends on one.
    expect(privateStateAction("unregistered", "mainnet")).toBe("Set up");
    expect(privateStateAction("archived", "mainnet")).toBe("Reactivate");
  });
});

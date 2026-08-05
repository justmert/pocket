// The wallet cannot be pointed at mainnet, and the guard is a test.
//
// This build is testnet-only. `config.ts` nonetheless declares a mainnet entry,
// so the string `mainnet.sorobanrpc.com` is in the shipped bytes — which is fine
// only while something guarantees it is unreachable. The coverage matrix found
// that nothing did: `setNetwork` appears in the tree twice, once in a list of
// message names and once in a fixture that passes "testnet", and no test
// anywhere asserts what happens when someone asks for mainnet.
//
// That is the gap this file closes. A wallet that could be switched to mainnet
// would be a wallet moving real money under testnet-grade assurance, and the
// only thing standing between those two states is six lines in the controller.
//
// Three independent layers are asserted, because one guard is not a guard:
//   1. the controller refuses the switch outright
//   2. the manifest grants no host permission for it, so the call could not be
//      made even if the refusal were removed
//   3. no test fixture or harness in this repository points anywhere but testnet
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { NETWORKS } from "../../src/core/config";

const ROOT = process.cwd();
const OUT = join(ROOT, ".output", "chrome-mv3");

describe("the mainnet guard", () => {
  it("declares mainnet without granting it a host permission", () => {
    // Layer 2. If the controller's refusal were deleted tomorrow, this is what
    // would still stop a request reaching a mainnet node: chrome will not let
    // the extension talk to a host it never asked for.
    if (!existsSync(join(OUT, "manifest.json"))) {
      expect.unreachable("no build to check — run `npm run build` before this tier");
    }
    const m = JSON.parse(readFileSync(join(OUT, "manifest.json"), "utf8"));
    const hosts: string[] = m.host_permissions ?? [];
    const mainnetHost = new URL(NETWORKS.mainnet.rpcUrl).hostname;

    expect(
      hosts.some((h) => h.includes(mainnetHost)),
      `the manifest grants a host permission for ${mainnetHost}. that removes the second of the two things keeping this build off mainnet`,
    ).toBe(false);

    // A mainnet host is permitted ONLY when it is narrowed to a path that cannot
    // move money. The value chart reads prices from mainnet Horizon, because
    // testnet has no market to read; what it must never gain is the ability to
    // submit, and Horizon accepts `POST /transactions`. A match pattern includes
    // its path, so the grant is `/trade_aggregations*` and nothing else on that
    // host is reachable.
    //
    // The rule this encodes: a mainnet grant must be read-only BY CONSTRUCTION,
    // not by the good behaviour of the code that uses it. `https://host/*` would
    // fail here, which is the point.
    const READ_ONLY_MAINNET = ["https://horizon.stellar.org/trade_aggregations*"];
    for (const h of hosts) {
      if (h.includes("testnet")) continue;
      expect(
        READ_ONLY_MAINNET.includes(h),
        `host permission "${h}" reaches mainnet without being narrowed to a read-only path. ` +
          `Horizon accepts POST /transactions, so an unscoped grant here is a route to submitting real money`,
      ).toBe(true);
    }
  });

  it("keeps the two networks' passphrases distinct, so an envelope cannot be valid on both", () => {
    // The replay case. A transaction signed with the wrong network passphrase is
    // valid somewhere the user did not choose; identical passphrases would make
    // every testnet signature a mainnet signature.
    expect(NETWORKS.testnet.passphrase).not.toBe(NETWORKS.mainnet.passphrase);
    expect(NETWORKS.testnet.passphrase).toContain("Test SDF Network");
    expect(NETWORKS.testnet.rpcUrl).toContain("testnet");
  });

  it("has no confidential deployment configured on mainnet", () => {
    // Belt and braces: even reaching mainnet, there is nothing there to spend
    // into. An entry appearing here would mean someone deployed contracts for a
    // network this build refuses to talk to, which is worth a conversation.
    expect(NETWORKS.mainnet.confidential ?? []).toEqual([]);
  });

  it("points no test fixture or harness at anything but testnet", () => {
    // Layer 3, and the one the brief cares about most: the suite itself must be
    // structurally incapable of touching mainnet. A fixture that names a mainnet
    // host is a test that could spend real money.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const e of entries) {
        if (e === "node_modules" || e === ".output") continue;
        const p = join(dir, e);
        if (statSync(p).isDirectory()) {
          walk(p);
          continue;
        }
        if (!/\.(ts|tsx|mjs|json)$/.test(e)) continue;
        // the two files that exist to FORBID mainnet necessarily name it. any
        // other file naming it is the finding, which is why this is an exact
        // path list and not a pattern.
        if (/tests\/qa\/(network-guard|supply-chain)\.test\.ts$/.test(p)) continue;
        // hostile-rpc holds the mainnet passphrase as DATA TO BE REJECTED: it
        // decodes a signed envelope as if it were mainnet to prove it is not
        // valid there, and it stubs an rpc that lies about which network it is.
        // neither is a destination — no request in that file can leave for
        // mainnet, because every one of them is answered by the stub. checked
        // by reading both call sites rather than by trusting the filename.
        if (/tests\/qa\/hostile-rpc\.spec\.ts$/.test(p)) continue;
        const text = readFileSync(p, "utf8");
        // The public mainnet passphrase and the mainnet rpc host. Either one in
        // a test means that test could reach the real network.
        if (
          text.includes("Public Global Stellar Network") ||
          text.includes("mainnet.sorobanrpc.com")
        ) {
          offenders.push(p.replace(ROOT, ""));
        }
      }
    };
    walk(join(ROOT, "tests"));
    walk(join(ROOT, "e2e"));

    expect(
      offenders,
      "a test fixture names a mainnet identity. the live tier must be structurally incapable of reaching mainnet, and a string is how that stops being true",
    ).toEqual([]);
  });

  it("refuses a mainnet switch in the controller's own source", () => {
    // Layer 1, asserted against the source rather than by booting a worker,
    // because this file is the cheap tier. The behavioural half — asking a real
    // running worker to switch and watching it refuse — is
    // tests/qa/network-guard.spec.ts.
    const controller = readFileSync(join(ROOT, "src/core/controller.ts"), "utf8");
    const setNetwork = controller.slice(controller.indexOf("async setNetwork"));
    const body = setNetwork.slice(0, setNetwork.indexOf("\n  }"));
    expect(
      body,
      "setNetwork no longer refuses mainnet. that is the first of the two things keeping this build off the real network",
    ).toMatch(/network === "mainnet"[\s\S]*throw/);
  });
});

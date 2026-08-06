// Soroban RPC: the simulated reads. The private pocket's whole view of itself
// comes through `simulateTransaction`, and each of these decides a sentence the
// user is asked to act on.
//
// The three states this must keep apart, because their instructions are
// opposite and one of them is irreversible:
//
//   registered      show the balance
//   archived        "dormant, reactivate it"       (a small fee, recoverable)
//   unregistered    "set one up"                   (PERMANENT, binds an auditor)
//
// A degraded RPC collapsing any of these into another is the same defect as a
// fabricated balance: the user acts on a claim about the ledger that was never
// read from the ledger.
import { describe, it, expect, afterEach } from "vitest";
import { rpc } from "@stellar/stellar-sdk";
import { Account, SorobanDataBuilder, xdr } from "@stellar/stellar-sdk/base";
import "../../src/lib/polyfill";
import {
  readConfidentialAccount,
  readAuditorKey,
  ConfidentialReadError,
} from "../../src/core/chain/confidential";
import {
  assertVerificationKey,
  assertVerifierBinding,
  readBoundVerifier,
  readVerificationKey,
  VerificationKeyMismatchError,
} from "../../src/core/chain/verification-key";
import { withRequestDeadline } from "../../src/core/chain/http";
import { describeError } from "../../src/core/dispatch";
import { G, H, IDENTITY, encodePoint, equals } from "../../src/core/crypto/grumpkin";
import { FaultServer, DEAD_ORIGIN, rpcOk, rpcError, type Fault } from "./_harness/faults";

const ACCOUNT = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
const TOKEN = "CDMXZEFOM5DN2GSHQKNOOW242RJZGCEM5LOOAPGRQE35GGHB7ALDK2Y6";
const VERIFIER = "CBERRYPR34G2MB3EOUNO3JGWOAWFVBUPINJ42JP7XVVB3AHKIPVPPWYH";
const REGISTRY = "CDE5JETGXV7TOUUDQPUTGLJB6TCUUIIWJJTLWFX4RNH36XABKCEPNTEV";
const PASSPHRASE = "Test SDF Network ; September 2015";
const GENERIC = "Something went wrong. Try again.";

const SOROBAN_DATA = new SorobanDataBuilder().build().toXDR("base64");
const source = () => new Account(ACCOUNT, "100");

const open: FaultServer[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

async function serving(fault: Fault): Promise<rpc.Server> {
  const server = await FaultServer.start({ fallback: fault });
  open.push(server);
  return withRequestDeadline(new rpc.Server(server.url), 4_000);
}

/** A healthy simulation carrying a return value. */
const simOk = (retval: xdr.ScVal): Fault =>
  rpcOk({
    latestLedger: 1_000,
    minResourceFee: "100",
    transactionData: SOROBAN_DATA,
    events: [],
    results: [{ xdr: retval.toXDR("base64"), auth: [] }],
  });

/** A contract panic, as the RPC reports it. `message` is the RPC's own words. */
const simError = (message: string): Fault =>
  rpcOk({ latestLedger: 1_000, error: message, events: [] });

/** An archived persistent entry: no value, a restore preamble instead. */
const simArchived = (): Fault =>
  rpcOk({
    latestLedger: 1_000,
    minResourceFee: "100",
    transactionData: SOROBAN_DATA,
    events: [],
    results: [],
    restorePreamble: { minResourceFee: "5000", transactionData: SOROBAN_DATA },
  });

/** The ConfidentialAccount struct, as the host renders a #[contracttype]. */
function confidentialAccountScVal(auditorId = 7): xdr.ScVal {
  const bytes = (p: { x: bigint; y: bigint }) => xdr.ScVal.scvBytes(Buffer.from(encodePoint(p)));
  const entry = (name: string, val: xdr.ScVal) =>
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(name), val });
  return xdr.ScVal.scvMap([
    entry("auditor_id", xdr.ScVal.scvU32(auditorId)),
    entry("receiving_commitment", bytes(IDENTITY)),
    entry("receiving_commitment_placeholder", xdr.ScVal.scvVoid()),
    entry("spendable_commitment", bytes(H)),
    entry("spending_public_key", bytes(G)),
    entry("viewing_public_key", bytes(H)),
  ]);
}

const GARBAGE: [string, Fault][] = [
  ["a 429 with retry-after", { kind: "rateLimited", retryAfter: "30" }],
  ["a 500", { kind: "text", status: 500, body: "upstream failure" }],
  [
    "HTML on a 200",
    {
      kind: "text",
      status: 200,
      contentType: "text/html",
      body: "<html>SECRET-RPC-STRING</html>",
    },
  ],
  ["an empty 200 body", { kind: "text", status: 200, contentType: "application/json", body: "" }],
  ["a JSON-RPC error object", rpcError("SECRET-RPC-STRING")],
  ["result: null", rpcOk(null)],
  ["a simulation with no results and no error", rpcOk({ latestLedger: 9 })],
  ["a simulation whose results list is empty", rpcOk({ latestLedger: 9, results: [] })],
  // `parseRawSimulation` only treats `error` as an error when it is a STRING.
  // Anything else falls through to the success branch, so a structured error
  // arrives as a simulation that succeeded and returned nothing.
  [
    "an error reported as an object rather than a string",
    rpcOk({ latestLedger: 9, error: { code: -32000, message: "SECRET-RPC-STRING" } }),
  ],
  ["an error reported as a number", rpcOk({ latestLedger: 9, error: 500 })],
  ["a truncated body", { kind: "truncated", body: '{"jsonrpc":"2.0","id":1,"resu' }],
  ["a socket closed mid-body", { kind: "closeMidBody", body: '{"jsonrpc":"2.0","id":1,' }],
  ["a connection reset", { kind: "reset" }],
];

describe("readConfidentialAccount: unregistered is a conclusion, not a default", () => {
  it("reports an archived entry as archived rather than as a failure", async () => {
    // Calibration case 4. A dormant pocket surfaced as an error sent the user
    // looking for a problem instead of pressing reactivate. `null` here is the
    // shared "no live entry" answer the caller then classifies by TTL.
    const server = await serving(simArchived());
    await expect(
      readConfidentialAccount(server, TOKEN, ACCOUNT, source(), PASSPHRASE),
    ).resolves.toBeNull();
  });

  it("reports contract error 3501 as unregistered, which is a normal state", async () => {
    const server = await serving(simError("HostError: Error(Contract, #3501)"));
    await expect(
      readConfidentialAccount(server, TOKEN, ACCOUNT, source(), PASSPHRASE),
    ).resolves.toBeNull();
  });

  for (const [name, fault] of GARBAGE) {
    it(`does not conclude "no private pocket" from ${name}`, async () => {
      const server = await serving(fault);
      const said = await readConfidentialAccount(server, TOKEN, ACCOUNT, source(), PASSPHRASE).then(
        (v) => (v === null ? "null, which reads as unregistered" : "a value"),
        () => "raised",
      );
      expect(said).toBe("raised");
    });
  }

  it("does not conclude anything from a dead port", async () => {
    const server = withRequestDeadline(new rpc.Server(DEAD_ORIGIN), 4_000);
    await expect(
      readConfidentialAccount(server, TOKEN, ACCOUNT, source(), PASSPHRASE),
    ).rejects.toThrow();
  });

  it("does not hang on a server that accepts and never answers", async () => {
    const server = await serving({ kind: "stall" });
    await expect(
      readConfidentialAccount(server, TOKEN, ACCOUNT, source(), PASSPHRASE),
    ).rejects.toThrow();
  });

  it("never puts the RPC's own words on screen", async () => {
    const server = await serving(simError("SECRET-RPC-STRING at 127.0.0.1"));
    const said = await readConfidentialAccount(server, TOKEN, ACCOUNT, source(), PASSPHRASE).then(
      () => "resolved",
      (e) => describeError(e),
    );
    expect(said).not.toContain("SECRET-RPC-STRING");
    expect(said).not.toContain("127.0.0.1");
    expect(said).toBe("Pocket could not read the private pocket from this deployment.");
  });

  it("reads the account once the RPC recovers", async () => {
    const server = await FaultServer.start({
      script: [{ kind: "rateLimited" }, { kind: "reset" }],
      fallback: simOk(confidentialAccountScVal(7)),
    });
    open.push(server);
    const client = withRequestDeadline(new rpc.Server(server.url), 4_000);
    await expect(
      readConfidentialAccount(client, TOKEN, ACCOUNT, source(), PASSPHRASE),
    ).rejects.toThrow();
    await expect(
      readConfidentialAccount(client, TOKEN, ACCOUNT, source(), PASSPHRASE),
    ).rejects.toThrow();
    const account = await readConfidentialAccount(client, TOKEN, ACCOUNT, source(), PASSPHRASE);
    expect(account?.auditorId).toBe(7);
    expect(equals(account!.spendingPublicKey, G)).toBe(true);
  });
});

describe("readAuditorKey: null means the registry said unregistered, nothing else", () => {
  it("reports registry error 3301 as no such auditor", async () => {
    const server = await serving(simError("HostError: Error(Contract, #3301)"));
    await expect(readAuditorKey(server, 4, REGISTRY, source(), PASSPHRASE)).resolves.toBeNull();
  });

  for (const [name, fault] of GARBAGE) {
    it(`does not conclude "no registered key" from ${name}`, async () => {
      const server = await serving(fault);
      const said = await readAuditorKey(server, 4, REGISTRY, source(), PASSPHRASE).then(
        (v) => (v === null ? "null, which reads as unregistered" : "a value"),
        () => "raised",
      );
      expect(said).toBe("raised");
    });
  }

  it("refuses a dormant registry with an instruction, not a shrug", async () => {
    const server = await serving(simArchived());
    await expect(readAuditorKey(server, 4, REGISTRY, source(), PASSPHRASE)).rejects.toBeInstanceOf(
      ConfidentialReadError,
    );
    const said = await readAuditorKey(server, 4, REGISTRY, source(), PASSPHRASE).then(
      () => "resolved",
      (e) => describeError(e),
    );
    expect(said).toMatch(/dormant/i);
    expect(said).not.toBe(GENERIC);
  });

  it("refuses a value that is not bytes", async () => {
    const server = await serving(simOk(xdr.ScVal.scvU32(1)));
    await expect(readAuditorKey(server, 4, REGISTRY, source(), PASSPHRASE)).rejects.toThrow(
      /unexpected value/i,
    );
  });

  it("refuses bytes that are not a curve point", async () => {
    const server = await serving(simOk(xdr.ScVal.scvBytes(Buffer.alloc(64, 0xff))));
    await expect(readAuditorKey(server, 4, REGISTRY, source(), PASSPHRASE)).rejects.toThrow();
  });

  it("reads the key once the registry answers", async () => {
    const server = await FaultServer.start({
      script: [{ kind: "stall" }],
      fallback: simOk(xdr.ScVal.scvBytes(Buffer.from(encodePoint(G)))),
    });
    open.push(server);
    const client = withRequestDeadline(new rpc.Server(server.url), 700);
    await expect(readAuditorKey(client, 4, REGISTRY, source(), PASSPHRASE)).rejects.toThrow();
    expect(equals((await readAuditorKey(client, 4, REGISTRY, source(), PASSPHRASE))!, G)).toBe(
      true,
    );
  });
});

describe("trap 14 fails closed when the RPC is degraded", () => {
  // A proof built against the wrong verification key is rejected on chain after
  // the user has waited through proving and signed. A degraded RPC must make
  // this refuse, never wave a proof through.
  for (const [name, fault] of GARBAGE) {
    it(`refuses to build a proof after ${name}`, async () => {
      // Fails CLOSED is the property, not the class of the refusal. A transport
      // error escaping unnamed still stops the proof, and the user is told the
      // generic connection message, which is true. What must never happen is a
      // resolve: that would mean the key was accepted without being read.
      const server = await serving(fault);
      const outcome = await assertVerificationKey(
        server,
        VERIFIER,
        "transfer",
        source(),
        PASSPHRASE,
      ).then(
        () => "accepted the key without reading it",
        () => "refused",
      );
      expect(outcome).toBe("refused");
    });

    it(`says something honest to the user after ${name}`, async () => {
      const server = await serving(fault);
      const said = await assertVerificationKey(
        server,
        VERIFIER,
        "transfer",
        source(),
        PASSPHRASE,
      ).then(
        () => "resolved",
        (e) => describeError(e),
      );
      expect(said).not.toContain("SECRET-RPC-STRING");
      expect(said).not.toContain("127.0.0.1");
      expect(said).not.toContain("AxiosError");
      // Either the generic connection message or the authored refusal. Both are
      // ours; neither invents a verdict about the deployment's key.
      const authored =
        said === GENERIC ||
        said === "Something went wrong." ||
        /will not build a proof/i.test(said);
      expect(authored, `unexpected user-facing text: ${said}`).toBe(true);
    });
  }

  it("names the mismatch when the deployment answers with the wrong key", async () => {
    // The one case where the refusal must be specific: the RPC worked, the key
    // came back, and it is not the key this build proves against. Telling the
    // user to check their connection here would be wrong advice.
    const server = await serving(simOk(xdr.ScVal.scvBytes(Buffer.alloc(1760, 0x11))));
    const said = await readVerificationKey(server, VERIFIER, "transfer", source(), PASSPHRASE).then(
      async (key) => {
        expect(key).not.toBeNull();
        return assertVerificationKey(server, VERIFIER, "transfer", source(), PASSPHRASE).then(
          () => "resolved",
          (e) => describeError(e),
        );
      },
      (e) => describeError(e),
    );
    expect(said).toMatch(/out of date for this network/i);
    expect(said).not.toBe(GENERIC);
  });

  for (const [name, fault] of GARBAGE) {
    it(`refuses the token's verifier binding after ${name}`, async () => {
      // This one DOES name itself, because readBoundVerifier swallows the
      // transport error and returns null, which the assert turns into an
      // authored refusal.
      const server = await serving(fault);
      await expect(assertVerifierBinding(server, TOKEN, VERIFIER)).rejects.toBeInstanceOf(
        VerificationKeyMismatchError,
      );
    });
  }

  it("reports a dormant verifier as dormant, with its own instruction", async () => {
    const server = await serving(simArchived());
    const said = await readVerificationKey(server, VERIFIER, "transfer", source(), PASSPHRASE).then(
      () => "resolved",
      (e) => describeError(e),
    );
    expect(said).toMatch(/dormant/i);
    expect(said).not.toBe(GENERIC);
  });

  it("never surfaces the RPC's own words when the key cannot be read", async () => {
    const server = await serving(simError("SECRET-RPC-STRING"));
    const said = await assertVerificationKey(
      server,
      VERIFIER,
      "transfer",
      source(),
      PASSPHRASE,
    ).then(
      () => "resolved",
      (e) => describeError(e),
    );
    expect(said).not.toContain("SECRET-RPC-STRING");
    expect(said).toMatch(/will not build a proof/i);
  });

  it("returns null rather than a verifier address it could not decode", async () => {
    const server = await serving(rpcOk({ latestLedger: 9, entries: [] }));
    await expect(readBoundVerifier(server, TOKEN)).resolves.toBeNull();
  });
});

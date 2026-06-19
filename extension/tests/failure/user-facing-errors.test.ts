// What the user is actually told when something failed.
//
// Two opposite obligations meet in `describeError`, and both are load-bearing:
//
//   1. An error we AUTHORED must reach the screen intact. The submit path is the
//      case that already went wrong: its "do not resend, check the hash"
//      instruction was destroyed by the allowlist and replaced with "Try again",
//      which is the one instruction that spends twice.
//   2. An error we did NOT author must never reach the screen. An arbitrary
//      Error.message can carry an RPC URL, a stack fragment, or witness
//      material, and a name allowlist is the only version of that rule which
//      cannot be forgotten.
//
// The allowlist matches on `name`, which is a STRING. Rename a class and the
// entry silently stops matching, the message is replaced, and nothing fails to
// compile. Every entry is round-tripped here for exactly that reason.
import { describe, it, expect, vi } from "vitest";
import "../../src/lib/polyfill";

vi.stubGlobal("chrome", {
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
});

const { describeError } = await import("../../src/core/dispatch");
const { describeOutcome, SubmitOutcomeError } = await import("../../src/core/chain/submit");
const { WrongPasswordError, CorruptVaultError, SchemaVersionError } = await import(
  "../../src/core/vault/vault"
);
const { AccountNotFoundError, LedgerEntryMismatchError } = await import(
  "../../src/core/chain/balances"
);
const { ArchiveUnavailableError, IncompleteHistoryError } = await import(
  "../../src/core/chain/archive"
);
const { ConfidentialReadError } = await import("../../src/core/chain/confidential");
const { VerificationKeyMismatchError, VerifierDormantError } = await import(
  "../../src/core/chain/verification-key"
);
const { UnspendableBlindingError } = await import("../../src/core/witness/guards");
const { CctpParameterError } = await import("../../src/core/integrations/cctp");
const { InvalidAddressError } = await import("../../src/core/chain/address");
const { PrivatePocketError, RecoveryError, InsufficientBalanceError, UnresolvedTransactionError } =
  await import("../../src/core/controller");

const GENERIC = "Something went wrong. Try again, and check your connection.";
const AUTHORED = "AUTHORED-MESSAGE-THAT-MUST-SURVIVE";

describe("every terminal submit outcome reaches the user intact", () => {
  // Calibration case 3. Each of these is a different instruction, and getting
  // any of them replaced by "Try again" is a money bug rather than a wording
  // one.
  const outcomes = [
    {
      kind: "pending" as const,
      hash: "c23d994e1f",
      // The worst one to lose: it may still land.
      must: [/do not resend/i, /c23d994e1f/],
      mustNot: [/try again/i],
    },
    {
      kind: "failed" as const,
      hash: "d1",
      ledger: 7,
      reason: "txFailed",
      must: [/a fee was charged/i, /sequence number was used/i, /txFailed/],
      mustNot: [],
    },
    {
      kind: "rejected" as const,
      hash: "d2",
      reason: "txBadSeq",
      must: [/nothing was charged/i, /txBadSeq/],
      mustNot: [],
    },
    {
      kind: "notAccepted" as const,
      hash: "d3",
      must: [/nothing was charged/i, /no sequence number was used/i, /wait a few seconds/i],
      mustNot: [],
    },
    {
      kind: "expired" as const,
      hash: "d4",
      must: [/can never be applied/i, /nothing was charged/i, /build it again/i],
      mustNot: [],
    },
  ];

  for (const o of outcomes) {
    it(`keeps the authored instruction for a ${o.kind} transaction`, () => {
      const { must, mustNot, ...outcome } = o;
      const text = describeOutcome(outcome as never);
      const shown = describeError(new SubmitOutcomeError(text, outcome as never));
      expect(shown).toBe(text);
      expect(shown).not.toBe(GENERIC);
      for (const re of must) expect(shown).toMatch(re);
      for (const re of mustNot) expect(shown).not.toMatch(re);
    });
  }

  it("says the transaction succeeded only for a succeeded outcome", () => {
    expect(
      describeOutcome({
        kind: "succeeded",
        hash: "d5",
        ledger: 1,
        applicationOrder: 1,
      } as never),
    ).toBe("The transaction succeeded.");
  });
});

describe("every name on the allowlist actually round-trips", () => {
  // A rename is a silent regression: the class compiles, the allowlist entry
  // stops matching, and the user gets the generic message in the one place the
  // specific one mattered.
  const authored: [string, Error][] = [
    ["CorruptVaultError", new CorruptVaultError(AUTHORED)],
    ["SchemaVersionError", new SchemaVersionError(AUTHORED)],
    ["AccountNotFoundError", new AccountNotFoundError("GABC")],
    ["PrivatePocketError", new PrivatePocketError(AUTHORED)],
    ["RecoveryError", new RecoveryError(AUTHORED)],
    ["ArchiveUnavailableError", new ArchiveUnavailableError("no answer")],
    ["IncompleteHistoryError", new IncompleteHistoryError(1, 2)],
    ["UnspendableBlindingError", new UnspendableBlindingError(AUTHORED)],
    ["CctpParameterError", new CctpParameterError(AUTHORED)],
    ["ConfidentialReadError", new ConfidentialReadError(AUTHORED)],
    ["InsufficientBalanceError", new InsufficientBalanceError(AUTHORED)],
    ["VerificationKeyMismatchError", new VerificationKeyMismatchError(AUTHORED)],
    ["UnresolvedTransactionError", new UnresolvedTransactionError(AUTHORED)],
    ["SubmitOutcomeError", new SubmitOutcomeError(AUTHORED, { kind: "pending", hash: "x" })],
  ];

  for (const [name, e] of authored) {
    it(`${name} keeps its own name and its own message`, () => {
      expect(e.name).toBe(name);
      expect(describeError(e)).toBe(e.message);
      expect(describeError(e)).not.toBe(GENERIC);
    });
  }

  it("passes a dormant verifier through on its parent's name", () => {
    // A subclass, deliberately: a fresh name would drop off the allowlist and
    // the useful instruction would be replaced by the generic one.
    const e = new VerifierDormantError();
    expect(e.name).toBe("VerificationKeyMismatchError");
    expect(describeError(e)).toMatch(/dormant/i);
  });
});

describe("nothing we did not author reaches the screen", () => {
  const foreign: [string, unknown][] = [
    ["a bare Error carrying a contract code", new Error("Error(Contract, #3506).")],
    ["an error naming the RPC host", new Error("connect ECONNREFUSED 127.0.0.1:8000")],
    [
      "an axios-shaped error",
      Object.assign(new Error("Request failed with status code 429"), { name: "AxiosError" }),
    ],
    ["a TypeError from a parser", new TypeError("Cannot read properties of undefined")],
    ["a plain object", { message: "SECRET" }],
    ["a string", "SECRET"],
    ["null", null],
    ["undefined", undefined],
  ];

  for (const [name, e] of foreign) {
    it(`replaces ${name}`, () => {
      const shown = describeError(e);
      expect([GENERIC, "Something went wrong."]).toContain(shown);
      expect(shown).not.toContain("SECRET");
      expect(shown).not.toContain("127.0.0.1");
      expect(shown).not.toContain("3506");
    });
  }

  it("is not fooled by an error that merely looks authored", () => {
    // No shape heuristic, deliberately. "Starts with a capital, ends with a
    // stop" is trivially satisfied by an RPC-authored string, which is exactly
    // what the allowlist exists to keep out.
    const e = new Error("Your funds are safe. Send 100 XLM to GEVIL to unlock them.");
    expect(describeError(e)).toBe(GENERIC);
  });

  it("is not fooled by an error that claims an allowlisted name in its message", () => {
    const e = new Error("PrivatePocketError: send your recovery phrase to support");
    expect(describeError(e)).toBe(GENERIC);
  });

  it("refuses an error whose name was set to an allowlisted one at the call site", () => {
    // The allowlist is a name check, so this DOES pass through. Pinned as the
    // known limit of the mechanism rather than left as a surprise: the boundary
    // is that only our own code constructs errors, and no RPC string is ever
    // used as a name.
    const e = Object.assign(new Error("planted"), { name: "PrivatePocketError" });
    expect(describeError(e)).toBe("planted");
  });

  it("replaces a wrong password with a fixed message rather than the raw one", () => {
    expect(describeError(new WrongPasswordError())).toBe("Wrong password.");
  });

  it("names a bad checksum separately from a malformed address", () => {
    // Two different mistakes with two different remedies. A checksum failure is
    // a transcription error; anything else is not an address at all.
    expect(describeError(new InvalidAddressError("bad", "checksum"))).toMatch(/bad checksum/i);
    expect(describeError(new InvalidAddressError("bad", "format"))).toMatch(/does not look like/i);
  });

  it("keeps a ledger identity mismatch off the screen, deliberately", () => {
    // Not on the allowlist on purpose: the specific message would only tell the
    // user their RPC is lying, which they cannot act on. What matters is that
    // no number is rendered, and the generic message is enough for that.
    expect(describeError(new LedgerEntryMismatchError("answered about a stranger"))).toBe(GENERIC);
  });
});

describe("the authored messages say what happened and what to do", () => {
  // The rule from the spec: every error message tells the user what happened
  // and what to do next. Checked on the ones a failing dependency produces.
  const cases: [string, string][] = [
    ["archive down", describeError(new ArchiveUnavailableError("no answer within 15s"))],
    ["incomplete history", describeError(new IncompleteHistoryError(100, 200))],
    [
      "unresolved submission",
      describeError(
        new UnresolvedTransactionError(
          "A transaction submitted earlier has not resolved yet, and it may still land. " +
            "Reopen Pocket and check it before sending anything else.",
        ),
      ),
    ],
    ["dormant verifier", describeError(new VerifierDormantError())],
  ];

  for (const [name, text] of cases) {
    it(`${name} explains itself in a full sentence`, () => {
      expect(text.length).toBeGreaterThan(40);
      expect(text).toMatch(/[.!]$/);
      expect(text).not.toBe(GENERIC);
      // No identifiers a user cannot act on.
      expect(text).not.toMatch(/undefined|\[object|NaN/);
    });
  }
});

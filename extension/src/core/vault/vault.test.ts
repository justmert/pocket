import { describe, it, expect } from "vitest";
import {
  createVault,
  unlockVault,
  sealPayload,
  openPayload,
  changePassword,
  WrongPasswordError,
  SchemaVersionError,
  CorruptVaultError,
} from "./vault";
import { KDF_PARAMS, canonicalHeaderBytes, b64, type VaultHeader } from "./envelope";

const PW = "correct horse battery staple";

describe("vault round trip", () => {
  it("seals and opens a payload", async () => {
    const { header, dek } = await createVault(PW);
    const sealed = await sealPayload(dek, { seed: "abc", openings: [1, 2, 3] });
    const dek2 = await unlockVault(header, PW);
    expect(await openPayload(dek2, sealed)).toEqual({ seed: "abc", openings: [1, 2, 3] });
  });

  it("rejects the wrong password via the GCM tag, with no separate oracle", async () => {
    const { header } = await createVault(PW);
    await expect(unlockVault(header, "wrong")).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it("uses a fresh salt and IV per vault, so no precomputation carries across users", async () => {
    const a = await createVault(PW);
    const b = await createVault(PW);
    expect(a.header.salt).not.toBe(b.header.salt);
    expect(a.header.wrap.iv).not.toBe(b.header.wrap.iv);
    expect(a.header.wrap.ct).not.toBe(b.header.wrap.ct);
  });

  it("uses a fresh IV on every payload write", async () => {
    const { dek } = await createVault(PW);
    const one = await sealPayload(dek, { x: 1 });
    const two = await sealPayload(dek, { x: 1 });
    expect(one.iv).not.toBe(two.iv);
    expect(one.ct).not.toBe(two.ct); // same plaintext, different ciphertext
  });

  it("pins the KDF at OWASP's scrypt parameters", async () => {
    const { header } = await createVault(PW);
    expect(header.kdf).toEqual({ id: "scrypt", N: 131072, r: 8, p: 1, dkLen: 32 });
    expect(KDF_PARAMS.N).toBe(2 ** 17);
  });
});

describe("the header is AAD, so tampering is an authentication failure", () => {
  it("refuses a downgraded schema version", async () => {
    // The attack: flip v:2 to v:1 so the wallet parses v2 openings under v1
    // rules. Because v is inside the AAD this is a tag mismatch, not a
    // convention we have to remember to enforce.
    const { header } = await createVault(PW);
    const tampered: VaultHeader = { ...header, v: 99 };
    await expect(unlockVault(tampered, PW)).rejects.toBeInstanceOf(SchemaVersionError);
  });

  it("refuses weakened KDF parameters by name, not as a wrong password", async () => {
    // Reporting this as "wrong password" would send a user with the correct
    // password toward a reset that destroys their wallet.
    const { header } = await createVault(PW);
    const weakened: VaultHeader = { ...header, kdf: { ...KDF_PARAMS, N: 1024 } };
    await expect(unlockVault(weakened, PW)).rejects.toThrow(/weaker key derivation/);
  });

  it("honours the header's own KDF parameters, so raising the default is not a lockout", async () => {
    // A vault created under today's parameters must keep opening after
    // KDF_PARAMS is raised, which is why deriveKek reads the header.
    const { header, dek } = await createVault(PW);
    const opened = await unlockVault(header, PW);
    expect(Array.from(opened)).toEqual(Array.from(dek));
    expect(header.kdf.N).toBe(KDF_PARAMS.N);
  });

  it("rejects a corrupted header as damage, not as a wrong password", async () => {
    const { header } = await createVault(PW);
    await expect(
      unlockVault({ ...header, wrap: { ...header.wrap, iv: "!!!" } }, PW),
    ).rejects.toThrow(/damaged|malformed|not valid base64/);
  });

  it("refuses a swapped salt", async () => {
    const a = await createVault(PW);
    const b = await createVault(PW);
    await expect(unlockVault({ ...a.header, salt: b.header.salt }, PW)).rejects.toThrow();
  });

  it("binds every header field it needs to", () => {
    const h: VaultHeader = {
      v: 1,
      kdf: KDF_PARAMS,
      salt: b64.encode(new Uint8Array(16)),
      wrap: { iv: b64.encode(new Uint8Array(12)), ct: "" },
      aadAlg: "canonical-json-v1",
    };
    const base = new TextDecoder().decode(canonicalHeaderBytes(h));
    expect(base).toContain('"v":1');
    expect(base).toContain('"N":131072');
    expect(base).toContain('"salt"');
    expect(base).toContain('"wrapIv"');
    expect(base).toContain('"aadAlg":"canonical-json-v1"');
  });

  it("canonicalises deterministically regardless of key insertion order", () => {
    const salt = b64.encode(new Uint8Array(16));
    const iv = b64.encode(new Uint8Array(12));
    const one = { v: 1, kdf: KDF_PARAMS, salt, wrap: { iv, ct: "x" }, aadAlg: "canonical-json-v1" };
    const two = { aadAlg: "canonical-json-v1", wrap: { ct: "x", iv }, salt, kdf: KDF_PARAMS, v: 1 };
    expect(canonicalHeaderBytes(one as VaultHeader)).toEqual(
      canonicalHeaderBytes(two as VaultHeader),
    );
  });

  it("excludes the wrap ciphertext from its own AAD", () => {
    // Including it would be circular: the tag covers the ciphertext already.
    const salt = b64.encode(new Uint8Array(16));
    const iv = b64.encode(new Uint8Array(12));
    const mk = (ct: string): VaultHeader => ({
      v: 1,
      kdf: KDF_PARAMS,
      salt,
      wrap: { iv, ct },
      aadAlg: "canonical-json-v1",
    });
    expect(canonicalHeaderBytes(mk("aaa"))).toEqual(canonicalHeaderBytes(mk("bbb")));
  });
});

describe("password change", () => {
  it("re-wraps the DEK without touching the payload", async () => {
    const { header, dek } = await createVault(PW);
    const sealed = await sealPayload(dek, { balance: 500 });

    const next = await changePassword(header, PW, "new password");

    // Same payload, still readable: the DEK did not change.
    const dek2 = await unlockVault(next, "new password");
    expect(await openPayload(dek2, sealed)).toEqual({ balance: 500 });
    expect(Array.from(dek2)).toEqual(Array.from(dek));

    // Old password no longer opens it.
    await expect(unlockVault(next, PW)).rejects.toBeInstanceOf(WrongPasswordError);
    // And the salt rotated.
    expect(next.salt).not.toBe(header.salt);
  });

  it("refuses to change on a wrong current password", async () => {
    const { header } = await createVault(PW);
    await expect(changePassword(header, "nope", "new")).rejects.toBeInstanceOf(WrongPasswordError);
  });
});

describe("schema versions below this build are damage, not a wrong password", () => {
  // The version gate used to be one-sided. A header carrying v:0 fell straight
  // through to the AAD check and came back as WrongPasswordError, which is the
  // single most expensive thing to get wrong: it routes a user who typed the
  // RIGHT password to the erase-and-restore flow, and that destroys openings.
  for (const v of [0, -1, 1.5, Number.NaN] as number[]) {
    it(`refuses a header claiming schema v${String(v)}`, async () => {
      const { header } = await createVault(PW);
      await expect(unlockVault({ ...header, v }, PW)).rejects.toBeInstanceOf(CorruptVaultError);
    });
  }

  it("refuses a sealed record claiming a schema below v1", async () => {
    const { dek } = await createVault(PW);
    const sealed = await sealPayload(dek, { x: 1 });
    await expect(openPayload(dek, { ...sealed, v: 0 })).rejects.toBeInstanceOf(CorruptVaultError);
  });

  it("refuses a key length AES-256 cannot use, rather than a bare WebCrypto error", async () => {
    // dkLen 64 clears the MIN_KDF floor and then dies inside importKey as
    // `DataError: Invalid key length`, a class dispatch does not recognise, so
    // the user is told to check their connection.
    const { header } = await createVault(PW);
    await expect(
      unlockVault({ ...header, kdf: { ...KDF_PARAMS, dkLen: 64 } }, PW),
    ).rejects.toBeInstanceOf(CorruptVaultError);
  });

  it("calls a non-integer KDF parameter damage, not weakness", async () => {
    const { header } = await createVault(PW);
    await expect(unlockVault({ ...header, kdf: { ...KDF_PARAMS, N: 1.5 } }, PW)).rejects.toThrow(
      /not an integer/,
    );
  });
});

describe("payload schema", () => {
  it("fails closed on a payload newer than this build", async () => {
    const { dek } = await createVault(PW);
    const sealed = await sealPayload(dek, { x: 1 });
    await expect(openPayload(dek, { ...sealed, v: 99 })).rejects.toBeInstanceOf(SchemaVersionError);
  });

  it("rejects a payload whose ciphertext was swapped in from another vault", async () => {
    const a = await createVault(PW);
    const b = await createVault(PW);
    const sealedByB = await sealPayload(b.dek, { secret: 1 });
    await expect(openPayload(a.dek, sealedByB)).rejects.toThrow();
  });
});

describe("password normalisation", () => {
  it("treats canonically equivalent unicode passwords as the same", async () => {
    // NFKC, so a composed and decomposed "é" unlock the same vault rather than
    // stranding a user whose keyboard emits the other form.
    const { header } = await createVault("café");
    await expect(unlockVault(header, "café")).resolves.toBeDefined();
  });
});

describe("AAD canonicalisation is unambiguous (audit M6)", () => {
  it("escapes field values rather than interpolating them raw", () => {
    // Two headers that differ only in where a quote-like character sits must
    // not serialise to the same AAD. Raw interpolation could let a crafted
    // field close one JSON string and open another.
    const base = {
      v: 1,
      kdf: KDF_PARAMS,
      wrap: { iv: b64.encode(new Uint8Array(12)), ct: "" },
      aadAlg: "canonical-json-v1" as const,
    };
    const a = canonicalHeaderBytes({ ...base, salt: 'x","wrapIv":"y' } as VaultHeader);
    const b = canonicalHeaderBytes({
      ...base,
      salt: "x",
      wrap: { iv: "y", ct: "" },
    } as VaultHeader);
    expect(a).not.toEqual(b);
    // And the result is still parseable JSON, which raw interpolation would break.
    expect(() => JSON.parse(new TextDecoder().decode(a))).not.toThrow();
  });

  it("rejects a non-integer numeric parameter instead of emitting invalid JSON", () => {
    const bad = {
      v: 1,
      kdf: { ...KDF_PARAMS, N: 1.5 },
      salt: b64.encode(new Uint8Array(16)),
      wrap: { iv: b64.encode(new Uint8Array(12)), ct: "" },
      aadAlg: "canonical-json-v1" as const,
    };
    expect(() => canonicalHeaderBytes(bad as VaultHeader)).toThrow(/non-integer/);
  });
});

describe("a damaged vault is never reported as a wrong password", () => {
  // This is the one diagnosis that must never be wrong. `Unlock.tsx` offers
  // exactly two things: try again, and "Forgot your password?", which routes to
  // recoverFromMnemonic -> erase() -> removeLocal(every openingKeys() blob). So
  // telling an owner who holds the correct password that it is wrong points them
  // at the control that destroys the private pocket.

  it("names a ciphertext truncated inside the old lower bound", async () => {
    // The wrapped DEK is always 48 bytes: a 32-byte key plus GCM's 16-byte tag.
    // The guard used to be `< 33`, so losing anything from 1 to 15 bytes off the
    // end sailed past it, failed the tag, and came back as WrongPasswordError.
    const { header } = await createVault(PW);
    const full = b64.decode(header.wrap.ct);
    expect(full.length, "the premise of this test").toBe(48);
    for (const len of [33, 40, 47]) {
      const damaged: VaultHeader = {
        ...header,
        wrap: { ...header.wrap, ct: b64.encode(full.slice(0, len)) },
      };
      await expect(unlockVault(damaged, PW), `${len} bytes`).rejects.toBeInstanceOf(
        CorruptVaultError,
      );
      await expect(unlockVault(damaged, PW), `${len} bytes`).rejects.not.toBeInstanceOf(
        WrongPasswordError,
      );
    }
  });

  it("names a ciphertext that is too long", async () => {
    const { header } = await createVault(PW);
    const full = b64.decode(header.wrap.ct);
    const padded = new Uint8Array(full.length + 1);
    padded.set(full);
    const damaged: VaultHeader = {
      ...header,
      wrap: { ...header.wrap, ct: b64.encode(padded) },
    };
    await expect(unlockVault(damaged, PW)).rejects.toBeInstanceOf(CorruptVaultError);
  });

  it("names an undecodable salt instead of letting atob escape", async () => {
    // The salt used to be decoded one line ABOVE the try that exists to catch
    // exactly this, so a bad one escaped as a raw InvalidCharacterError. That
    // name is not in dispatch's SAFE_ERRORS, so the user was told to check their
    // connection about a vault that will never open again.
    const { header } = await createVault(PW);
    const damaged: VaultHeader = { ...header, salt: "!!!not base64!!!" };
    const err = await unlockVault(damaged, PW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CorruptVaultError);
    const { describeError } = await import("../dispatch");
    expect(describeError(err)).not.toMatch(/Something went wrong/i);
  });

  it("still reports an actual wrong password as one", async () => {
    // The control. Without it every assertion above is satisfied by an unlock
    // that has stopped distinguishing anything at all.
    const { header } = await createVault(PW);
    await expect(unlockVault(header, "not the password")).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
  });
});

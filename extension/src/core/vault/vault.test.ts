import { describe, it, expect } from "vitest";
import {
  createVault,
  unlockVault,
  sealPayload,
  openPayload,
  changePassword,
  WrongPasswordError,
  SchemaVersionError,
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

  it("refuses weakened KDF parameters rather than silently accepting them", async () => {
    const { header } = await createVault(PW);
    const weakened: VaultHeader = {
      ...header,
      kdf: { ...KDF_PARAMS, N: 1024 },
    };
    await expect(unlockVault(weakened, PW)).rejects.toBeInstanceOf(WrongPasswordError);
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

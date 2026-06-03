import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk/base";
import { buildRootMessage, sep53Digest, signerRoot, verifyRoot, SEP53_PREFIX } from "./root";
import { deriveSk, SK_LABEL } from "./sk";
import { addressToField } from "../crypto/address";
import { R } from "../crypto/field";

const ZERO_G = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const ZERO_C = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("SEP-0053 construction", () => {
  it("uses a 24-byte prefix ending in a real LF", () => {
    const p = new TextEncoder().encode(SEP53_PREFIX);
    expect(p.length).toBe(24);
    expect(p[23]).toBe(0x0a);
    // A language that does not interpret \n gives a 25-byte prefix and every
    // derived key changes.
    expect(hex(p)).toBe("5374656c6c6172205369676e6564204d6573736167653a0a");
  });

  it("builds a 151-byte message", () => {
    const m = buildRootMessage(ZERO_C, ZERO_G);
    expect(m.length).toBe(151);
    expect(new TextEncoder().encode(SK_LABEL).length).toBe(37);
  });

  it("hashes prefix||msg before signing, not the raw bytes", () => {
    const m = buildRootMessage(ZERO_C, ZERO_G);
    expect(hex(sep53Digest(m))).toBe(
      "9cd9d169d15ffbf1f36d1f2d7ce48a65aa8b0569d431204b9aaa01c8c6986ce0",
    );
  });

  it("rejects a wrong-length strkey rather than producing a short message", () => {
    expect(() => buildRootMessage("CABC", ZERO_G)).toThrow();
  });
});

describe("SEP-0053's own published test vectors", () => {
  // Authoritative: straight from ecosystem/sep-0053.md, so they pin the
  // construction independently of any downstream document. One seed, covering
  // ASCII, multi-byte UTF-8 and raw binary.
  const SEED = "SAKICEVQLYWGSOJS4WW7HZJWAHZVEEBS527LHK5V4MLJALYKICQCJXMW";
  const ADDRESS = "GBXFXNDLV4LSWA4VB7YIL5GBD7BVNR22SGBTDKMO2SBZZHDXSKZYCP7L";
  const kp = Keypair.fromSecret(SEED);

  const vectors: Array<[string, Uint8Array, string]> = [
    [
      "ASCII",
      new TextEncoder().encode("Hello, World!"),
      "7cee5d6d885752104c85eea421dfdcb95abf01f1271d11c4bec3fcbd7874dccd" +
        "6e2e98b97b8eb23b643cac4073bb77de5d07b0710139180ae9f3cbba78f2ba04",
    ],
    [
      "Japanese UTF-8",
      new TextEncoder().encode("こんにちは、世界！"),
      "083536eb95ecf32dce59b07fe7a1fd8cf814b2ce46f40d2a16e4ea1f6cecd980" +
        "e04e6fbef9d21f98011c785a81edb85f3776a6e7d942b435eb0adc07da4d4604",
    ],
    [
      "binary",
      new Uint8Array(Buffer.from("2zZDP1sa1BVBfLP7TeeMk3sUbaxAkUhBhDiNdrksaFo=", "base64")),
      "540d7eee179f370bf634a49c1fa9fe4a58e3d7990b0207be336c04edfcc539ff" +
        "8bd0c31bb2c0359b07c9651cb2ae104e4504657b5d17d43c69c7e50e23811b0d",
    ],
  ];

  it("derives the published address from the published seed", () => {
    expect(kp.publicKey()).toBe(ADDRESS);
  });

  for (const [name, message, expected] of vectors) {
    it(`reproduces the ${name} vector`, () => {
      const sig = new Uint8Array(kp.sign(Buffer.from(sep53Digest(message))));
      expect(hex(sig)).toBe(expected);
    });
  }

  it("does NOT reproduce them when signing raw bytes instead of the digest", () => {
    // The counter-experiment. Were SEP-0053 signing the raw payload these would
    // match. They do not, which is what pins the SHA-256 step.
    const raw = new Uint8Array(
      kp.sign(
        Buffer.concat([Buffer.from(SEP53_PREFIX, "utf8"), Buffer.from("Hello, World!", "utf8")]),
      ),
    );
    expect(hex(raw)).not.toBe(vectors[0]![2]);
  });

  it("signs deterministically, per RFC 8032", () => {
    const once = hex(new Uint8Array(kp.sign(Buffer.from(sep53Digest(vectors[0]![1])))));
    const twice = hex(new Uint8Array(kp.sign(Buffer.from(sep53Digest(vectors[0]![1])))));
    expect(once).toBe(twice);
  });
});

describe("root verification, the wrong-signer trap", () => {
  // SDK.md 5.2 MUST: verify the returned signature against the public key we
  // expect, and abort on mismatch. A wallet with a different account selected
  // returns a well-formed signature over the same message, yielding a wrong but
  // entirely usable sk. Registration then succeeds and the account is
  // unreproducible from the key the user believes controls it. Nothing
  // downstream detects this, so the check has to happen here.
  const mine = Keypair.random();
  const theirs = Keypair.random();

  it("accepts a root signed by the expected key", () => {
    const root = signerRoot(mine, ZERO_C, ZERO_G);
    expect(verifyRoot(root, mine.publicKey(), ZERO_C, ZERO_G)).toBe(true);
  });

  it("rejects a well-formed root signed by a different key", () => {
    const root = signerRoot(theirs, ZERO_C, ZERO_G);
    expect(root.length).toBe(64); // well-formed, and still wrong
    expect(verifyRoot(root, mine.publicKey(), ZERO_C, ZERO_G)).toBe(false);
  });

  it("rejects a root bound to a different deployment", () => {
    const other = "CBF64DEOVQAXJFBSNGFEUT2AH4H7K5JBY3ZYJ5GVEINMNSDISWRG5N3F";
    const root = signerRoot(mine, other, ZERO_G);
    expect(verifyRoot(root, mine.publicKey(), ZERO_C, ZERO_G)).toBe(false);
  });

  it("rejects a root bound to a different account", () => {
    const otherAccount = Keypair.random().publicKey();
    const root = signerRoot(mine, ZERO_C, otherAccount);
    expect(verifyRoot(root, mine.publicKey(), ZERO_C, ZERO_G)).toBe(false);
  });
});

describe("the sk rejection loop", () => {
  const kp = Keypair.fromSecret("SAKICEVQLYWGSOJS4WW7HZJWAHZVEEBS527LHK5V4MLJALYKICQCJXMW");

  it("chains off the pinned address_to_field outputs", async () => {
    const addrF = addressToField(ZERO_C);
    const acctF = addressToField(ZERO_G);
    expect("0x" + addrF.toString(16)).toBe(
      "0x1997b0390a25f684e91575771f4c3ca72ac8f20f45a462838ea918bbe8c4e19c",
    );
    expect("0x" + acctF.toString(16)).toBe(
      "0x1d3b0901201ea22ad61ed4600b49dee57bb73369bf07bdeab17cbf0e54debd4f",
    );

    const { sk, vk } = await deriveSk(signerRoot(kp, ZERO_C, ZERO_G), addrF, acctF);
    expect(sk > 0n && sk < R).toBe(true);
    expect(vk > 0n && vk < R).toBe(true);
  });

  it("actually rejects when a draw lands at or above r", async () => {
    // A j=0-only test cannot catch a big-endian counter, because le4(0) is
    // symmetric. Search for a root whose first draw is rejected so the loop and
    // its little-endian counter are genuinely exercised.
    const addrF = addressToField(ZERO_C);
    let found = 0;
    for (let i = 1; i < 60 && found === 0; i++) {
      const k = Keypair.fromRawEd25519Seed(Buffer.from(i.toString(16).padStart(64, "0"), "hex"));
      const acct = k.publicKey();
      const r = await deriveSk(signerRoot(k, ZERO_C, acct), addrF, addressToField(acct));
      if (r.rejections > 0) found = r.rejections;
    }
    expect(found).toBeGreaterThan(0);
  });
});

describe("sk binding", () => {
  const kp = Keypair.random();

  it("yields a different sk per account, so two addresses are not linkable", async () => {
    const a = Keypair.random().publicKey();
    const b = Keypair.random().publicKey();
    const addrF = addressToField(ZERO_C);
    const root = signerRoot(kp, ZERO_C, a);
    const one = await deriveSk(root, addrF, addressToField(a));
    const two = await deriveSk(root, addrF, addressToField(b));
    expect(one.sk).not.toBe(two.sk);
  });

  it("yields a different sk per deployment", async () => {
    const acct = kp.publicKey();
    const root = signerRoot(kp, ZERO_C, acct);
    const one = await deriveSk(root, addressToField(ZERO_C), addressToField(acct));
    const two = await deriveSk(root, 0x1234n, addressToField(acct));
    expect(one.sk).not.toBe(two.sk);
  });

  it("is deterministic", async () => {
    const acct = kp.publicKey();
    const root = signerRoot(kp, ZERO_C, acct);
    const a = await deriveSk(root, addressToField(ZERO_C), addressToField(acct));
    const b = await deriveSk(root, addressToField(ZERO_C), addressToField(acct));
    expect(a.sk).toBe(b.sk);
  });
});

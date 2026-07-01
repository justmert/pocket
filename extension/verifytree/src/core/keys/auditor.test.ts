import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk/base";
import {
  AUDITOR_LABEL,
  AUDITOR_DERIVATION_VERSION,
  buildAuditorRootMessage,
  auditorSignerRoot,
  verifyAuditorRoot,
  deriveAuditorKey,
} from "./auditor";
import { signerRoot, buildRootMessage } from "./root";
import { deriveSk, SK_LABEL } from "./sk";
import { addressToField } from "../crypto/address";
import { R, Q, R_LT_Q } from "../crypto/field";
import { DOMAIN } from "../crypto/domain";
import { spongeSqueeze2 } from "../crypto/poseidon";
import {
  auditorPublicKey,
  publicViewingKey,
  spendingPublicKey,
  sharedScalar,
  ephemeralScalar,
} from "../crypto/derive";
import { H, scalarMul, isOnCurve, equals, decodePoint, encodePoint } from "../crypto/grumpkin";

const ZERO_G = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const ZERO_C = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

const kp = Keypair.fromSecret("SAKICEVQLYWGSOJS4WW7HZJWAHZVEEBS527LHK5V4MLJALYKICQCJXMW");
const addrF = addressToField(ZERO_C);
const acctF = addressToField(ZERO_G);
const auditorRoot = () => auditorSignerRoot(kp, ZERO_C, ZERO_G);
const spendRoot = () => signerRoot(kp, ZERO_C, ZERO_G);

describe("the modulus the auditor scalar is drawn from", () => {
  // DESIGN.md 2.2 "Scalar sampling": Grumpkin scalars live in F_q, but every
  // secret scalar in the design is drawn from F_r by rejection sampling. What
  // makes that sound is r < q, so an F_r draw is always already a valid scalar
  // and no two draws collide onto one. R_LT_Q exists to name that; asserting it
  // is what turns it from a comment into an invariant.
  it("rests on r < q, so no F_r draw is ever reduced", () => {
    expect(R_LT_Q).toBe(true);
    expect(R).toBeLessThan(Q);
  });

  it("gives up only about one part in 2^127 of the scalar space", () => {
    // The cost of the narrower range, stated as a number rather than asserted
    // to be small. q - r is ~2^127 against a field of ~2^254.
    const forgone = Q - R;
    expect(forgone).toBeLessThan(1n << 128n);
    expect(forgone).toBeGreaterThan(1n << 126n);
  });

  it("draws a canonical F_r element in [1, r)", async () => {
    const { audSk } = await deriveAuditorKey(auditorRoot(), addrF, acctF);
    expect(audSk).toBeGreaterThan(0n);
    expect(audSk).toBeLessThan(R);
  });
});

describe("the auditor public key", () => {
  it("is aud_sk*H, which is what makes ECDH close", async () => {
    const { audSk, publicKey } = await deriveAuditorKey(auditorRoot(), addrF, acctF);
    expect(publicKey).toEqual(scalarMul(audSk, H));
    expect(isOnCurve(publicKey)).toBe(true);
  });

  it("is never the identity, which the registry refuses", async () => {
    const { publicKey } = await deriveAuditorKey(auditorRoot(), addrF, acctF);
    expect(publicKey.x === 0n && publicKey.y === 0n).toBe(false);
  });

  it("round-trips through the registry's 64-byte encoding", async () => {
    // The registry stores BytesN<64> = be(x) || be(y) and validates canonical,
    // on-curve and non-identity on write. If our key cannot survive that
    // encoding it cannot be registered at all.
    const { publicKey } = await deriveAuditorKey(auditorRoot(), addrF, acctF);
    const bytes = encodePoint(publicKey);
    expect(bytes.length).toBe(64);
    expect(decodePoint(bytes)).toEqual(publicKey);
  });
});

describe("the auditor channel actually decrypts", () => {
  // The end-to-end proof that the key is right. If K_aud were on G instead of
  // H, or the scalar were reduced by the wrong modulus, every assertion below
  // still type-checks and the amounts come back as garbage.
  it("recovers the sender-channel amount and balance from aud_sk alone", async () => {
    const { audSk, publicKey: kAud } = await deriveAuditorKey(auditorRoot(), addrF, acctF);
    const { sk, vk } = await deriveSk(spendRoot(), addrF, acctF);
    const sigma = 0x2a2a2a2an;
    const amount = 1234500000n;
    const balanceAfter = 9876500000n;

    // Sender side, exactly as buildTransferWitness does it.
    const rE = ephemeralScalar(vk, sigma);
    const RE = scalarMul(rE, H);
    const sAs = sharedScalar(rE, kAud);
    const [maskAmount, maskBalance] = spongeSqueeze2(DOMAIN.AUDITOR_SENDER, sAs, sigma);
    const vTilde = (amount + maskAmount) % R;
    const bTilde = (balanceAfter + maskBalance) % R;

    // Auditor side: DESIGN_cont.md 8.1, S = k*R_e from the published R_e and
    // sigma. The auditor holds aud_sk and nothing else.
    const sAudit = sharedScalar(audSk, RE);
    expect(sAudit).toBe(sAs);

    const [mv, mb] = spongeSqueeze2(DOMAIN.AUDITOR_SENDER, sAudit, sigma);
    expect((vTilde - mv + R) % R).toBe(amount);
    expect((bTilde - mb + R) % R).toBe(balanceAfter);

    // Unused here, but it is the sender's key and must not be confused with the
    // auditor's anywhere in the flow.
    expect(spendingPublicKey(sk)).not.toEqual(kAud);
  });

  it("recovers the recipient-channel amount and transfer blinding", async () => {
    const { audSk, publicKey: kAud } = await deriveAuditorKey(auditorRoot(), addrF, acctF);
    const sigma = 0x99n;
    const amount = 777n;
    const rTransfer = 0x5150n;

    const rE = 0x1234567n;
    const RE = scalarMul(rE, H);
    const sAr = sharedScalar(rE, kAud);
    const [mv, mr] = spongeSqueeze2(DOMAIN.AUDITOR_RECIPIENT, sAr, sigma);
    const vTilde = (amount + mv) % R;
    const rTilde = (rTransfer + mr) % R;

    const [mv2, mr2] = spongeSqueeze2(DOMAIN.AUDITOR_RECIPIENT, sharedScalar(audSk, RE), sigma);
    expect((vTilde - mv2 + R) % R).toBe(amount);
    expect((rTilde - mr2 + R) % R).toBe(rTransfer);
  });

  it("decrypts nothing if the key is put on G instead of H", async () => {
    // The failure this design note guards against, made concrete. A G-based key
    // is on-curve, non-identity and registrable, and simply does not work.
    const { audSk } = await deriveAuditorKey(auditorRoot(), addrF, acctF);
    const { G } = await import("../crypto/grumpkin");
    const wrongKey = scalarMul(audSk, G);
    expect(isOnCurve(wrongKey)).toBe(true); // registrable
    const rE = 0xabcdefn;
    const RE = scalarMul(rE, H);
    expect(sharedScalar(rE, wrongKey)).not.toBe(sharedScalar(audSk, RE));
  });
});

describe("separation from the spending key (SDK.md 11)", () => {
  it("signs a different message, so neither root yields the other", () => {
    const a = buildAuditorRootMessage(ZERO_C, ZERO_G);
    const b = buildRootMessage(ZERO_C, ZERO_G);
    expect(a.length).toBe(151);
    expect(b.length).toBe(151); // same length, different bytes
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(Buffer.from(auditorRoot()).equals(Buffer.from(spendRoot()))).toBe(false);
  });

  it("uses a label in our own namespace that cannot collide with upstream's", () => {
    expect(AUDITOR_LABEL).toBe("pocket/confidential-auditor/v1/aud_sk");
    expect(AUDITOR_LABEL.startsWith("pocket/")).toBe(true);
    expect(SK_LABEL.startsWith("openzeppelin/")).toBe(true);
    expect(AUDITOR_LABEL).not.toBe(SK_LABEL);
  });

  it("rejects an auditor root signed by a different key", () => {
    const theirs = Keypair.random();
    const root = auditorSignerRoot(theirs, ZERO_C, ZERO_G);
    expect(root.length).toBe(64); // well-formed, and still wrong
    expect(verifyAuditorRoot(root, kp.publicKey(), ZERO_C, ZERO_G)).toBe(false);
    expect(verifyAuditorRoot(root, theirs.publicKey(), ZERO_C, ZERO_G)).toBe(true);
  });

  it("will not accept the spending root as an auditor root", () => {
    // The two roots are signatures over different messages, so presenting one
    // where the other belongs fails verification rather than deriving a
    // plausible wrong key.
    expect(verifyAuditorRoot(spendRoot(), kp.publicKey(), ZERO_C, ZERO_G)).toBe(false);
  });

  it("yields a scalar that is neither sk nor vk", async () => {
    const { audSk } = await deriveAuditorKey(auditorRoot(), addrF, acctF);
    const { sk, vk } = await deriveSk(spendRoot(), addrF, acctF);
    expect(audSk).not.toBe(sk);
    expect(audSk).not.toBe(vk);
  });

  it("yields a point that cannot be mistaken for Y or PVK", async () => {
    const { publicKey: kAud } = await deriveAuditorKey(auditorRoot(), addrF, acctF);
    const { sk, vk } = await deriveSk(spendRoot(), addrF, acctF);
    // All three are scalar*H, so only the scalars distinguish them. A wallet
    // that swapped two of them would publish a well-formed, useless key.
    expect(equals(kAud, spendingPublicKey(sk))).toBe(false);
    expect(equals(kAud, publicViewingKey(vk))).toBe(false);
    expect(equals(publicViewingKey(vk), auditorPublicKey(vk))).toBe(true); // same formula
  });

  it("is not derivable from vk", async () => {
    // vk is what a viewing-side facade would hold. Nothing about it reaches the
    // auditor scalar: the auditor scalar hangs off a signature vk never sees.
    const { vk } = await deriveSk(spendRoot(), addrF, acctF);
    const { audSk } = await deriveAuditorKey(auditorRoot(), addrF, acctF);
    expect(audSk).not.toBe(vk);
    expect(auditorPublicKey(vk)).not.toEqual(auditorPublicKey(audSk));
  });

  it("does not let the auditor scalar open a post-merge spendable balance", async () => {
    // DESIGN_cont.md 9: "r_s depends on vk_A and is not derivable from any
    // auditor key". The spendable blinding is Poseidon2(SPEND_RANDOMNESS, vk,
    // sigma); feeding the auditor scalar where vk belongs gives a different
    // blinding, which is the point.
    const { spendRandomness } = await import("../crypto/derive");
    const { vk } = await deriveSk(spendRoot(), addrF, acctF);
    const { audSk } = await deriveAuditorKey(auditorRoot(), addrF, acctF);
    const sigma = 0x31337n;
    expect(spendRandomness(audSk, sigma)).not.toBe(spendRandomness(vk, sigma));
  });
});

describe("binding and determinism", () => {
  it("is deterministic", async () => {
    const a = await deriveAuditorKey(auditorRoot(), addrF, acctF);
    const b = await deriveAuditorKey(auditorRoot(), addrF, acctF);
    expect(a.audSk).toBe(b.audSk);
    expect(a.publicKey).toEqual(b.publicKey);
  });

  it("regenerates from the seed with no on-chain lookup", async () => {
    // The reason auditor_id is NOT in the info. A user restoring from their
    // phrase can rebuild the auditor key knowing only the deployment and the
    // account, and then find their id on chain, rather than needing the id
    // before they can rebuild the key.
    const restored = Keypair.fromSecret(kp.secret());
    const { audSk } = await deriveAuditorKey(
      auditorSignerRoot(restored, ZERO_C, ZERO_G),
      addrF,
      acctF,
    );
    const { audSk: original } = await deriveAuditorKey(auditorRoot(), addrF, acctF);
    expect(audSk).toBe(original);
  });

  it("yields a different key per deployment", async () => {
    const one = await deriveAuditorKey(auditorRoot(), addrF, acctF);
    const two = await deriveAuditorKey(auditorRoot(), 0x1234n, acctF);
    expect(one.audSk).not.toBe(two.audSk);
  });

  it("yields a different key per account, so two of a user's accounts do not link", async () => {
    const other = Keypair.random().publicKey();
    const one = await deriveAuditorKey(auditorRoot(), addrF, acctF);
    const two = await deriveAuditorKey(auditorRoot(), addrF, addressToField(other));
    expect(one.audSk).not.toBe(two.audSk);
    expect(equals(one.publicKey, two.publicKey)).toBe(false);
  });

  it("stamps the construction version", async () => {
    const { version } = await deriveAuditorKey(auditorRoot(), addrF, acctF);
    expect(version).toBe(AUDITOR_DERIVATION_VERSION);
    expect(AUDITOR_DERIVATION_VERSION).toBe(1);
  });
});

describe("the rejection loop", () => {
  it("actually rejects when a draw lands at or above r", async () => {
    // le4(0) is byte-symmetric, so a j=0-only test cannot catch a big-endian
    // counter. Search for a root whose first draw is rejected, exactly as the
    // sk test does, so the little-endian counter is genuinely exercised.
    let found = 0;
    for (let i = 1; i < 60 && found === 0; i++) {
      const k = Keypair.fromRawEd25519Seed(Buffer.from(i.toString(16).padStart(64, "0"), "hex"));
      const acct = k.publicKey();
      const r = await deriveAuditorKey(
        auditorSignerRoot(k, ZERO_C, acct),
        addrF,
        addressToField(acct),
      );
      if (r.rejections > 0) found = r.rejections;
    }
    expect(found).toBeGreaterThan(0);
  });

  it("refuses a root that is neither 64 nor 32 bytes", async () => {
    await expect(deriveAuditorKey(new Uint8Array(63), addrF, acctF)).rejects.toThrow(
      /64-byte SEP-0053 signature or a 32-byte raw root/,
    );
    await expect(deriveAuditorKey(new Uint8Array(0), addrF, acctF)).rejects.toThrow();
  });

  it("accepts the 32-byte raw-root form", async () => {
    const { audSk } = await deriveAuditorKey(new Uint8Array(32).fill(7), addrF, acctF);
    expect(audSk).toBeGreaterThan(0n);
    expect(audSk).toBeLessThan(R);
  });
});

describe("the auditor root message", () => {
  it("rejects a wrong-length strkey rather than producing a short message", () => {
    expect(() => buildAuditorRootMessage("C123", ZERO_G)).toThrow(/56-character strkey/);
    expect(() => buildAuditorRootMessage(ZERO_C, "G123")).toThrow(/56-character strkey/);
  });

  it("puts the label first, then contract, then operator, LF-separated", () => {
    const msg = new TextDecoder().decode(buildAuditorRootMessage(ZERO_C, ZERO_G));
    expect(msg).toBe(`${AUDITOR_LABEL}\n${ZERO_C}\n${ZERO_G}`);
    expect(msg.split("\n")).toHaveLength(3);
  });

  it("binds the operator, so a root for one operator does not verify for another", () => {
    const other = Keypair.random().publicKey();
    const root = auditorSignerRoot(kp, ZERO_C, other);
    expect(verifyAuditorRoot(root, kp.publicKey(), ZERO_C, ZERO_G)).toBe(false);
    expect(verifyAuditorRoot(root, kp.publicKey(), ZERO_C, other)).toBe(true);
  });
});

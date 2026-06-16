// The self-auditor key, against the real registry on live testnet.
//
// The unit tests prove the maths closes. This proves the two things only the
// chain can answer: that the derived point survives the registry's own
// validation (canonical, on-curve, non-identity, enforced on every write), and
// that `get_key` hands back exactly the bytes we registered, so a wallet
// restoring from the seed alone will find its own key where it left it.
//
// This WRITES: it allocates one fresh auditor id per run. That is deliberate
// and matches e2e.live.test.ts, which moves real XLM. Registration is
// self-serve and allocating, so a new id collides with nothing and binds no
// account: an auditor id only matters once an account names it at registration.
import { describe, it, expect } from "vitest";
import { rpc } from "@stellar/stellar-sdk";
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk/base";
import "../../lib/polyfill";
import { NETWORKS } from "../config";
import { submitAndConfirm } from "../chain/submit";
import { readAuditorKey } from "../chain/confidential";
import { addressToField } from "../crypto/address";
import { encodePoint, equals, isOnCurve } from "../crypto/grumpkin";
import { auditorSignerRoot, deriveAuditorKey, verifyAuditorRoot } from "./auditor";

const net = NETWORKS.testnet;
const server = new rpc.Server(net.rpcUrl);
const SECRET = process.env.POCKET_TESTNET_SECRET;
const OPERATOR = SECRET ? Keypair.fromSecret(SECRET) : null;

function deployment() {
  const c = net.confidential[0];
  if (!c) throw new Error("no confidential deployment configured for testnet");
  return c;
}

/**
 * The next id `register` will hand out. Also the count registered so far.
 *
 * Read before and after so the id our registration got is established by a
 * counter that moved by exactly one, rather than assumed. `submitAndConfirm`
 * does not surface a return value, and guessing an id would silently read
 * somebody else's key if another registration landed in between.
 *
 * Fetches its OWN Account rather than borrowing the caller's. `build()` calls
 * `incrementSequenceNumber()` on whatever it is handed, so a shared object
 * comes back one ahead and the next real transaction submits at a sequence the
 * network has not reached. That surfaces as a bare `rejected`, several steps
 * from the cause.
 */
async function nextId(account: string) {
  const tx = new TransactionBuilder(await server.getAccount(account), {
    fee: BASE_FEE,
    networkPassphrase: net.passphrase,
  })
    .addOperation(new Contract(deployment().auditor).call("next_id"))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if ("error" in sim) throw new Error(`next_id simulation failed: ${sim.error}`);
  const raw = (sim as { result?: { retval: xdr.ScVal } }).result?.retval;
  if (!raw) throw new Error("next_id returned nothing");
  return Number(raw.u32());
}

describe.skipIf(!OPERATOR)("the self-auditor key against the live registry", () => {
  const dep = deployment();

  it("derives a key the registry will accept", async () => {
    const account = OPERATOR!.publicKey();
    const root = auditorSignerRoot(OPERATOR!, dep.token, account);
    expect(verifyAuditorRoot(root, account, dep.token, account)).toBe(true);

    const { publicKey } = await deriveAuditorKey(
      root,
      addressToField(dep.token),
      addressToField(account),
    );
    // The three conditions the registry enforces on write.
    expect(isOnCurve(publicKey)).toBe(true);
    expect(publicKey.x === 0n && publicKey.y === 0n).toBe(false);
    expect(encodePoint(publicKey).length).toBe(64);
  });

  it("registers and reads back byte-for-byte", async () => {
    const account = OPERATOR!.publicKey();
    const root = auditorSignerRoot(OPERATOR!, dep.token, account);
    const { publicKey } = await deriveAuditorKey(
      root,
      addressToField(dep.token),
      addressToField(account),
    );

    const expectedId = await nextId(account);
    const source = await server.getAccount(account);

    const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: net.passphrase })
      .addOperation(
        new Contract(dep.auditor).call(
          "register",
          nativeToScVal(Address.fromString(account)),
          xdr.ScVal.scvBytes(Buffer.from(encodePoint(publicKey))),
        ),
      )
      .setTimeout(60)
      .build();

    // Simulated for its footprint and auth entries before signing, exactly as
    // every other invocation is. Signing first produces an envelope the network
    // rejects outright.
    const prepared = await server.prepareTransaction(tx);
    prepared.sign(OPERATOR!);
    const outcome = await submitAndConfirm(server, prepared);
    expect(outcome.kind).toBe("succeeded");
    if (outcome.kind !== "succeeded") throw new Error(outcome.kind);

    // The counter must have moved by exactly one for `expectedId` to be ours.
    // If anyone else registered in between, fail here rather than go on to read
    // a key that is not the one we just wrote.
    const after = await nextId(account);
    expect(after, "another registration raced this one").toBe(expectedId + 1);

    const fresh = await server.getAccount(account);
    const onChain = await readAuditorKey(server, expectedId, dep.auditor, fresh, net.passphrase);
    expect(onChain).not.toBeNull();
    expect(equals(onChain!, publicKey)).toBe(true);
  }, 120_000);
});

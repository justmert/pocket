# Pocket

A self-custody Stellar wallet with two pockets. One public, one private.

**Confidential, not anonymous.** Pocket hides *amounts*. It does not hide who you
pay. Sender and recipient addresses stay on the public ledger, permanently, on
every transfer. If you need to hide who you transact with, Pocket is the wrong
tool and we would rather say so than let you find out later.

## The two pockets

| | Public | Private |
|---|---|---|
| Holds | ordinary XLM and USDC | the same assets inside a confidential wrapper |
| Who sees amounts | everyone | you, your bound auditor, and anyone you disclose to |
| Who sees addresses | everyone | **everyone, unchanged** |
| Earns yield | yes, reported (DeFindex) | no, and this is structural |
| Bridges | yes (Circle CCTP) | no, unshield first |
| Connects to dApps | yes (SEP-43) | no, sessions are public-pocket only |

**What "connects to dApps" means here, precisely.** A site can discover the
wallet, ask the network, and ask for the address. A connection is granted per
ORIGIN by the user, expires in 24 hours, is dropped when the wallet locks or is
erased, and is refused if the wallet on the device changed since the grant.
Signing is never covered by a connection: every signature is approved
individually on a screen that lists what the transaction does, and a
transaction Pocket cannot decode is refused rather than shown as a hash to
trust. `signAuthEntry` and `signMessage` are still refused outright, because
there is no screen that can show a user what those commit them to.

The split itself is not a product preference. Confidential balances are Pedersen
commitments, which are additively homomorphic and nothing more. You can add and
subtract committed values without decrypting them, but you cannot multiply,
discover a price, or hold the state a lending pool needs. Yield, bridging and
dApp interaction belong in the public pocket because they cannot live anywhere
else.

## What leaks, stated plainly

Hidden: confidential balances, and confidential transfer amounts.

Public, permanently:

- sender and recipient addresses on every confidential transfer
- deposit amounts at the shield boundary
- withdrawal amounts at the unshield boundary
- transaction timing, and the fee-paying account
- the fact that an address has a confidential account at all

The UI surfaces all of these rather than hiding them.

## Status

Working on **testnet**, end to end, with real proofs. See
`resources/testnet-evidence.md` for transaction hashes.

Proven on chain: auditor key registration, confidential account registration
with a real UltraHonk proof the on-chain verifier accepted, deposit, merge, and
a confidential transfer.

**Not on mainnet, deliberately.** Two things gate it and neither is ours:

1. **The proofs are not zero-knowledge.** The on-chain verifier implements only
   the non-ZK `ultra_flavor`. Soundness holds, so nobody can mint or overspend.
   Amount confidentiality rests on Pedersen hiding and Poseidon encryption, both
   formally hiding, but the proof layer contributes no zero-knowledge property,
   so leakage cannot be *ruled out*. There is no public timeline for a
   ZK-flavour Soroban verifier.
2. **The UltraHonk verifier backend is unaudited.** Its own README says so. The
   confidential token contracts and circuits were audited by OpenZeppelin
   Security with remediation complete as of 27 July 2026, but that report is not
   yet published.

## Repository

```
extension/    the wallet (Chrome MV3, WXT + React + TypeScript)
contracts/    three Rust Soroban contracts, ours to write and maintain
indexer/      the durable event archive, conforming to INDEXER.md C1-C4
scripts/      release gates
resources/    internal working files, not part of the distribution
```

### Why we write contracts at all

OpenZeppelin's library ships no constructor for the confidential token: the four
setters are free functions and the deployer chooses the policy. So we write
three thin contracts and they are inside our audit scope and our liability:

- **the token wrapper**, which binds one asset permanently and has no admin
- **the verifier**, which installs six verification keys at construction and
  implements no path that can ever change them
- **the auditor registry**, self-serve, with ids allocated by a counter rather
  than chosen by the caller

We deployed our own rather than using the upstream demo's testnet instance,
because that one holds **pre-audit** verification keys: building against it
would mean implementing five known audit findings, including a register replay.

## Development

```
cd extension && npm install
npm run check          # types, lint, tests
npm run build          # vendors bb.js + SRS + circuits, then builds
npm run test:e2e       # loads the real extension into real Chrome

cd contracts && stellar contract build     # target: wasm32v1-none
node deploy.mjs                            # writes resources/deployment-<net>.json

cd indexer && npm test
CONTRACT_ID=C... node --experimental-strip-types src/backfill.ts

DB_PATH=archive.db CONTRACT_ID=C... node --experimental-strip-types indexer/src/backfill.ts
DB_PATH=archive.db PORT=8787 node --experimental-strip-types indexer/src/server.ts

./scripts/release-gate.sh                  # the six gates
```

The proving toolchain is pinned to **nargo 1.0.0-beta.11 + bb 0.87.0**. That is
not a preference: the Soroban verifier hardcodes bb 0.87's proof layout, and bb
5.x cannot even read beta.11's ACIR. Upgrading is a protocol migration that
requires the on-chain verifier to be replaced first.

## Recovery

Your seed recovers your **keys**. It does not recover your **money**.

The chain stores commitments, not the openings that make them spendable. Only
your wallet knows those, and it reconstructs them by replaying events. Stellar
RPC retains events for 120,960 ledgers, about seven days. Past that, without a
durable archive, a user who loses local state can see their funds on chain and
**cannot spend them, ever**.

That is why `indexer/` exists, and it is wired: the private pocket shows a
**Rebuild from history** button that replays your events from the archive and
refuses the result unless it reproduces the commitments the contract holds. So a
broken or hostile archive cannot hand you a wrong balance; it can only fail to
help. Recent transfers, inside the RPC window, are credited without any archive
at all.

**What rebuilding cannot do, and it is a real limit.** An account that has ever
RECEIVED a confidential transfer cannot be rebuilt from history. Opening an
inbound transfer needs the commitment `C_transfer`, and the contract passes it in
the invocation payload without publishing it in the event, so the event stream
carries nothing that can confirm a decrypted amount is the one committed. Pocket
refuses rather than credit an amount it cannot verify, and says so. Deposits,
merges, withdrawals and transfers you SENT replay normally. Closing this needs
the commitment in the event, which is a contract change upstream, not ours.

The wallet refuses to sync when an archive it was told about is unavailable.
Falling back to recent-history-only would move the sync cursor past the gap and
make those openings unrecoverable.

## Licence

Apache-2.0. Third-party notices in `THIRD_PARTY_NOTICES.md`.

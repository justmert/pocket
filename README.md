# Pocket

A self-custody Stellar wallet with two pockets, one public and one private.
Chrome extension, Manifest V3.

**Confidential, not anonymous.** Pocket hides *amounts*. It does not hide who you
pay: sender and recipient addresses stay on the public ledger, permanently, on
every transfer. If you need your counterparty hidden, Pocket is the wrong tool.

Full documentation: [docs.pocket-wallet.app](https://docs.pocket-wallet.app).

## Install

Pocket is not on the Chrome Web Store yet, so it installs as an unpacked
extension. About a minute, in Chrome or any Chromium browser (Brave, Edge, Arc):

1. Download the latest build from
   **[the releases page](https://github.com/justmert/pocket/releases/latest)**
   (the `pocket-v*-chrome.zip` asset) and unzip it.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**, top-right.
4. Click **Load unpacked** and pick the unzipped `chrome-mv3` folder.

Keep the folder: deleting it removes the extension. To update, download the
newest release and click the reload icon on the extension's card. Pocket runs on
Stellar **testnet**, so do not use mainnet funds.

Prefer to build it yourself? `git clone`, then `npm run dev` (see Development
below) hot-loads it into a browser.

## The two pockets

| | Public | Private |
|---|---|---|
| Holds | ordinary XLM and USDC | the same assets inside a confidential wrapper |
| Who sees amounts | everyone | you and the auditor key you bound |
| Who sees addresses | everyone | **everyone, unchanged** |
| Yield, swap, bridge | yes | no, unshield first |
| dApp sessions | public pocket only | never |

Yield, swapping and bridging cannot move to the private pocket. A Pedersen
commitment is additively homomorphic and nothing more: you can add and subtract
committed values without decrypting them, but you cannot multiply, compare, or
discover a price. Those features need the number.

## What leaks

Hidden: confidential balances, and confidential transfer amounts.

Public, permanently:

- sender and recipient addresses on every confidential transfer
- deposit amounts at the shield boundary
- withdrawal amounts at the unshield boundary
- transaction timing, and the fee-paying account
- the fact that an address has a confidential account at all

The interface states all of these rather than hiding them.

## Status

Working on **testnet**, end to end, with real proofs. Look any of these up at
`https://stellar.expert/explorer/testnet/tx/<hash>`:

| What happened | Transaction | Fee |
|---|---|---|
| Auditor key registered, id allocated by the registry | `7465cc8836381d3304b7ebae1461305615e3f878ef1c9e52850244f01a5899b9` | 0.0051934 XLM |
| Confidential account registered, proof accepted on chain | `60dff27fbc25f9012b8c5b52a5072a4126b30875d65bb7241b95ac73e176cfdb` | 0.0312027 XLM |
| Received balance merged into spendable | `792caf072fa887956673ff795f1c233f920a9a084ee639b9a51c693ec6c929b0` | 0.0009266 XLM |
| Confidential transfer, amount hidden | `391b5767abb00a117b8f15a5639c1268776bdc60b6498181440630b26a2fa1bc` | 0.0397523 XLM |

The register transaction proves the whole pipeline with no mocks in it: a
spending key derived from a SEP-0053 signer root, a witness built here, the real
Noir circuit solving it, a 14,592-byte UltraHonk proof, and the on-chain
verifier accepting it.

**Not on mainnet, deliberately.** Two things gate it and neither is ours:

1. **The proofs are not zero-knowledge.** The Soroban verifier implements only
   the non-ZK `ultra_flavor`. Soundness holds, so nobody can mint or overspend.
   Amount confidentiality rests on Pedersen hiding and Poseidon encryption, both
   formally hiding, but the proof layer adds no zero-knowledge property, so
   leakage cannot be ruled out. No public timeline for a ZK-flavour verifier.
2. **The UltraHonk verifier backend is unaudited.** Its own README says so. The
   confidential token contracts and circuits were audited by OpenZeppelin
   Security with remediation complete 27 July 2026; that report is not yet
   published.

## Repository

```
extension/    the wallet (WXT + React + TypeScript, Chrome MV3)
contracts/    three Rust Soroban contracts, ours to write and maintain
indexer/      the durable event archive, conforming to INDEXER.md C1-C4
scripts/      release gates and the scheduled infrastructure check
docs/         the documentation site (Fumadocs)
resources/    internal working files, gitignored, not distributed
```

OpenZeppelin's confidential token library ships no constructor: the four setters
are free functions and the deployer picks the policy. Those choices are
permanent, so we make them explicitly, in three contracts that are inside our
audit scope and our liability:

- **the token wrapper**, which binds one asset permanently and has no admin
- **the verifier**, which installs six verification keys at construction and
  implements no path that can ever change them
- **the auditor registry**, self-serve, with ids allocated by a counter rather
  than chosen by the caller

We deployed our own rather than using the upstream demo's testnet instance,
because that one holds **pre-audit** verification keys.

## Development

```sh
cd extension
npm install
npm run check      # tsc (src) + tsc (tests) + eslint + both vitest configs
npm run build      # vendors bb.js + SRS + circuits, then builds the extension
npm run test:pass  # builds, then Playwright against the real extension

cd contracts
stellar contract build          # wasm32v1-none
node deploy.mjs                 # writes resources/deployment-<network>.json

cd indexer
npm test
CONTRACT_ID=C... npm run backfill
PORT=8787 npm start

./scripts/release-gate.sh       # the seven gates, all must pass before a release
```

`.githooks/pre-commit` runs the extension's `check`, the indexer's types and
tests, and `cargo fmt --check`.

`HORIZON_URL` matters on the indexer. The backfill reads transfer payloads from
Horizon, and without them received payments cannot be rebuilt.

### The toolchain pin is a protocol constraint

**nargo 1.0.0-beta.11 + bb 0.87.0.** The Soroban verifier hardcodes bb 0.87's
proof layout, and bb 5.x cannot read beta.11's ACIR. Upgrading means replacing
the on-chain verifier first, which means every user re-registers. It is a
migration, not a dependency bump.

## Recovery

Your seed recovers your **keys**. It does not recover your **money**.

The chain stores commitments, not the openings that make them spendable. Only
your own device holds those, and it rebuilds them by replaying events. Soroban
RPC retains events for 120,960 ledgers, about seven days. Past that, without a
durable archive, someone who loses local state can see their funds on chain and
never spend them. That is why `indexer/` exists.

The archive is outside the trust boundary. **Rebuild from history** replays your
events and refuses the result unless it reproduces the commitments the contract
holds, so a broken or hostile archive can fail to help and cannot hand you a
wrong balance. Recent transfers, inside the RPC window, need no archive at all.

## Licence

Apache-2.0. Third-party notices in `THIRD_PARTY_NOTICES.md`.

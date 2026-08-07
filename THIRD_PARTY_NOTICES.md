# Third-party notices

Pocket is Apache-2.0. This file records the third-party material it includes or
depends on, and what each requires.

## Vendored into the extension package

### @aztec/bb.js 0.87.0

Barretenberg's browser build is copied verbatim into `extension/public/vendor/bb/`
by `extension/scripts/vendor-bb.mjs` and loaded as native ESM at runtime. It is
not bundled: the 0.87.0 build declares a top-level `__webpack_exports__` and
spawns its worker from a `webpackIgnore`-marked `import.meta.url`, so a bundled
copy resolves the worker to a chunk that does not exist and hangs silently.

Licence: Apache-2.0 (see `extension/public/vendor/bb/index.js.LICENSE.txt`,
`main.worker.js.LICENSE.txt` and `thread.worker.js.LICENSE.txt`, all shipped
alongside the code).

### Aztec Ignition structured reference string

`extension/public/vendor/srs/` holds a prefix of the Aztec Ignition powers-of-tau
string, fetched at build time from `crs.aztec.network` and verified against the
G2 point the on-chain verifier compiles in.

The ceremony ran 25 October 2019 to 2 January 2020 with 176 participants. It is
closed: there is no mechanism to contribute today, and Pocket's soundness rests
permanently on the assumption that at least one of those 176 destroyed their
contribution.

### OpenZeppelin confidential-token circuits and verification keys

`extension/public/vendor/circuits/` holds the compiled Noir circuits and their
verification keys, built from `OpenZeppelin/stellar-contracts` at rev
`219c560f7f5a44195457943d79485cc6a527dfca`.

Licence: Apache-2.0 (see `resources/upstream/stellar-contracts/LICENSE`).

## Rust dependencies

The contracts in `contracts/` consume `stellar-tokens`, `stellar-access`,
`stellar-macros` and `stellar-contract-utils` from OpenZeppelin as git
dependencies pinned by revision, because they are not published to crates.io.
Apache-2.0.

Through them, proof verification runs `brozorec/rs-soroban-ultrahonk` branch
`v27`, a fork of `NethermindEth/rs-soroban-ultrahonk` that exists solely to bump
soroban-sdk 26 to 27. Release gate 4 asserts that fork contains no Rust changes.

Nethermind's own README states: **"This project has not been audited."**

## npm dependencies

Standard transitive licences, all permissive. The direct set is small and
deliberately so: `@stellar/stellar-sdk`, `@noble/curves`, `@noble/hashes`,
`@scure/bip39`, `@zkpassport/poseidon2`, `buffer`, `react`, `react-dom`.

`@noble/hashes` is used for scrypt specifically, and that choice is deliberate:
its `argon2` is explicitly **outside** the scope of the only independent audit
the library has had (Cure53, 2022), while `scrypt` is inside it.

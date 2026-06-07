//! Pocket's confidential token wrapper.
//!
//! This contract IS the private pocket for one asset. It holds real SEP-41
//! tokens and tracks who owns what as Pedersen commitments, so the amounts are
//! hidden while the addresses stay public. Confidential, not anonymous.
//!
//! Almost all behaviour comes from OpenZeppelin's `ConfidentialToken` trait.
//! What we supply is the constructor, because the library deliberately does not
//! ship one: the four setters are free functions and the deployer chooses the
//! policy around them.
//!
//! # One wrapper, one asset, forever
//!
//! `set_underlying_asset` is one-shot. Wrapping a second asset means deploying
//! this contract again with a different `token`. Because `addr_f` (this
//! contract's own address, compressed to a field element) is baked into every
//! viewing key, each deployment is also a separate confidential identity: users
//! register once per wrapper.
//!
//! # Not production ready
//!
//! The UltraHonk verifier backend is unaudited. The confidential token contracts
//! and circuits were audited by OpenZeppelin Security with remediation complete
//! as of 2026-07-27, but that report is not yet published, and the proofs are
//! not zero-knowledge (the on-chain verifier implements only `ultra_flavor`).
//! Testnet only.
#![no_std]

// The trait's generated impl references these in its signatures, so they must
// be in scope even though this file names none of them directly.
use soroban_sdk::{contract, contractimpl, Address, Bytes, Env};
use stellar_tokens::confidential::{
    storage as token_storage, ConfidentialAccount, ConfidentialToken, NoHooks, SpenderDelegation,
};

#[contract]
pub struct PocketConfidentialToken;

#[contractimpl]
impl PocketConfidentialToken {
    /// Bind this wrapper to its asset, verifier and auditor registry.
    ///
    /// `token` is the SEP-41 / SAC contract holding the real asset. `verifier`
    /// holds one verification key per circuit type and is shared across
    /// wrappers. `auditor` is the Grumpkin key registry, also shared.
    ///
    /// No `admin` argument. The library's design docs describe one, but it was
    /// never implemented, and we do not want one: an admin able to swap the
    /// verifier could point this wrapper at a contract that accepts forged
    /// proofs. Everything here is set once, at construction, and cannot be
    /// changed afterwards because this contract exposes no setter.
    pub fn __constructor(e: &Env, token: Address, verifier: Address, auditor: Address) {
        token_storage::set_underlying_asset(e, &token);
        token_storage::set_verifier(e, &verifier);
        token_storage::set_auditor(e, &auditor);
        // Computes and stores addr_f. One-shot, and every viewing key derived
        // for this deployment depends on it.
        token_storage::set_address_as_field_element(e);
    }
}

#[contractimpl(contracttrait)]
impl ConfidentialToken for PocketConfidentialToken {
    // No hooks. A vanilla deployment pays zero overhead for the compliance
    // extension points, and adding one later means a new deployment, which
    // means every user re-registers. Deliberate.
    type Hooks = NoHooks;
}

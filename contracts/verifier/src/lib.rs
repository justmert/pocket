//! Pocket's UltraHonk verifier registry.
//!
//! Stores one verification key per circuit type and verifies proofs on behalf
//! of the token contract, which calls it cross-contract on every state-changing
//! confidential operation.
//!
//! # Verification keys are IMMUTABLE here
//!
//! OpenZeppelin's example gates `update_verification_key` behind a `manager`
//! role "purely for illustration", and its own documentation says a real
//! deployment should ship keys immutably where possible. We do.
//!
//! The reason is blunt: a verification key that does not correspond to the
//! audited circuit will happily verify FORGED proofs, including proofs that mint
//! tokens or drain accounts. The on-chain bytes are opaque and nothing in the
//! contract can detect a wrong replacement. So this contract implements neither
//! `register_verification_key` nor `update_verification_key` as callable
//! operations after construction: the keys go in once, in the constructor, and
//! there is no code path that can change them.
//!
//! Changing a circuit therefore means deploying a new verifier and a new token
//! wrapper, which means every user re-registers. That is the correct cost.
#![no_std]

use soroban_sdk::{contract, contractimpl, Bytes, Env, Vec};
use stellar_tokens::confidential::verifier::{
    storage as verifier, CircuitType, ConfidentialVerifier,
};

#[contract]
pub struct PocketConfidentialVerifier;

#[contractimpl]
impl PocketConfidentialVerifier {
    /// Install all six verification keys, once.
    ///
    /// Order matches `CircuitType`: Register, Withdraw, Transfer,
    /// SpenderTransfer, SetSpender, RevokeSpender. Every key must be supplied;
    /// a deployment missing one would fail opaquely at first use of that
    /// operation rather than at construction.
    pub fn __constructor(e: &Env, keys: Vec<Bytes>) {
        let circuits = [
            CircuitType::Register,
            CircuitType::Withdraw,
            CircuitType::Transfer,
            CircuitType::SpenderTransfer,
            CircuitType::SetSpender,
            CircuitType::RevokeSpender,
        ];
        if keys.len() != circuits.len() as u32 {
            panic!("expected exactly six verification keys");
        }
        for (i, circuit) in circuits.into_iter().enumerate() {
            verifier::register_verification_key(e, circuit, &keys.get_unchecked(i as u32));
        }
    }
}

// `verify_proof` and `get_verification_key` come from the trait's default
// implementations, which run the UltraHonk backend. We override nothing: the
// registration methods are deliberately absent, so the trait's defaults are the
// entire surface.
#[contractimpl(contracttrait)]
impl ConfidentialVerifier for PocketConfidentialVerifier {}

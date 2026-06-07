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

use soroban_sdk::{contract, contracterror, contractimpl, panic_with_error, Address, Bytes, Env, Vec};
use stellar_tokens::confidential::verifier::{
    storage as verifier, CircuitType, ConfidentialVerifier,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum PocketVerifierError {
    /// Verification keys are set once at construction and can never change.
    KeysAreImmutable = 1,
}

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
// implementations, which run the UltraHonk backend.
//
// The two mutation methods have no default, so the trait forces us to write
// them. Both refuse unconditionally. That is the point: a verification key not
// corresponding to the audited circuit verifies FORGED proofs, and nothing in
// the contract can detect a wrong replacement, so there is no caller and no
// role that should be able to reach these.
#[contractimpl(contracttrait)]
impl ConfidentialVerifier for PocketConfidentialVerifier {
    fn register_verification_key(e: &Env, _c: CircuitType, _k: Bytes, _op: Address) {
        panic_with_error!(e, PocketVerifierError::KeysAreImmutable)
    }

    fn update_verification_key(e: &Env, _c: CircuitType, _k: Bytes, _op: Address) {
        panic_with_error!(e, PocketVerifierError::KeysAreImmutable)
    }
}

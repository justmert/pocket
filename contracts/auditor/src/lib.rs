//! Pocket's auditor key registry, with SELF-SERVE registration.
//!
//! Every confidential account binds an `auditor_id` at registration, the field
//! is immutable for the life of the account, and every transfer emits auditor
//! ciphertexts the circuit enforces. There is no opt-out. So somebody's key is
//! bound to every account, permanently, at first use.
//!
//! Pocket's answer (decision D8) is that the user is their own auditor: the
//! wallet derives a second Grumpkin key from the same seed and registers it
//! here. Nobody else can decrypt anything, the compliance channel is real and
//! populated rather than architecturally absent, and the key recovers from the
//! same seed with nothing extra to back up.
//!
//! # Why this contract exists at all
//!
//! OpenZeppelin's example gates `register_key` behind a `manager` role, which
//! is that deployment's choice and not a library constraint: the trait methods
//! have no default implementation and the module documentation says access
//! control is "expected to be gated by the implementor's access-control
//! scheme". The underlying storage helper is callable from any policy we write.
//!
//! A manager-gated registry would make Pocket the gatekeeper of every user's
//! auditor key, which is the surveillance posture D8 exists to avoid. So
//! registration here is open, and ids are allocated by a monotonic counter
//! rather than chosen by the caller, because a caller-chosen `u32` collides
//! with `AuditorAlreadyRegistered` and there is no way to recover a taken id.
//!
//! Rotation is likewise self-serve, but only by the account that registered the
//! id: an id nobody owns cannot be rotated, and one you own cannot be rotated
//! by anyone else. Visibility is forward-only, so a rotated-in key sees nothing
//! that happened before it.
#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, BytesN, Env};
use stellar_tokens::confidential::auditor::{storage as auditor, ConfidentialAuditor};

#[contracttype]
#[derive(Clone)]
enum DataKey {
    /// Monotonic id allocator. Never reused, so a rotation cannot resurrect an
    /// old binding.
    NextId,
    /// auditor_id -> the address permitted to rotate it.
    Owner(u32),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum RegistryError {
    /// The caller does not own this auditor_id.
    NotKeyOwner = 1,
    /// No such auditor_id has been registered.
    UnknownAuditorId = 2,
}

#[contract]
pub struct PocketAuditorRegistry;

#[contractimpl]
impl PocketAuditorRegistry {
    /// Register a Grumpkin public key and receive a fresh `auditor_id`.
    ///
    /// Open to anyone: the caller registers a key for themselves. The id is
    /// allocated, not chosen, so two users cannot collide. `owner` authorises,
    /// so an id is always tied to an address that can later rotate it.
    ///
    /// Point validation is inherited from the library, which rejects the
    /// identity, non-canonical encodings and off-curve points on every write.
    pub fn register(e: &Env, owner: Address, point: BytesN<64>) -> u32 {
        owner.require_auth();

        let id: u32 = e.storage().instance().get(&DataKey::NextId).unwrap_or(0);
        auditor::register_key(e, id, &point);

        e.storage().persistent().set(&DataKey::Owner(id), &owner);
        e.storage().instance().set(&DataKey::NextId, &(id + 1));
        id
    }

    /// Replace the key behind an id you own.
    ///
    /// Visibility is forward-only: the new key sees nothing that happened under
    /// the old one. Note that a rotation between proof construction and
    /// submission invalidates the in-flight proof, because the contract reads
    /// the auditor key at verification time.
    pub fn rotate(e: &Env, owner: Address, auditor_id: u32, new_point: BytesN<64>) {
        owner.require_auth();

        let registered: Address = e
            .storage()
            .persistent()
            .get(&DataKey::Owner(auditor_id))
            .unwrap_or_else(|| panic_with(e, RegistryError::UnknownAuditorId));
        if registered != owner {
            panic_with(e, RegistryError::NotKeyOwner);
        }
        auditor::rotate_key(e, auditor_id, &new_point);
    }

    /// The address permitted to rotate an id, if it is registered.
    pub fn owner_of(e: &Env, auditor_id: u32) -> Option<Address> {
        e.storage().persistent().get(&DataKey::Owner(auditor_id))
    }

    /// The next id `register` will hand out. Also the count registered so far.
    pub fn next_id(e: &Env) -> u32 {
        e.storage().instance().get(&DataKey::NextId).unwrap_or(0)
    }
}

fn panic_with(e: &Env, err: RegistryError) -> ! {
    soroban_sdk::panic_with_error!(e, err)
}

// `get_key` comes from the trait's default implementation. The token contract
// calls it during verification and reverts if the id does not resolve to a
// valid, canonical, on-curve, non-identity point.
#[contractimpl(contracttrait)]
impl ConfidentialAuditor for PocketAuditorRegistry {}

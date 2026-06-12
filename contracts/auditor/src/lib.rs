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

mod test;

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
    /// The trait's caller-chosen-id form is closed. Use `register` or `rotate`.
    UseAllocatingRegister = 3,
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
        extend_owner_ttl(e, id);
        e.storage().instance().set(&DataKey::NextId, &(id + 1));
        bump_instance(e);
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
        extend_owner_ttl(e, auditor_id);
        bump_instance(e);
    }

    /// The address permitted to rotate an id, if it is registered.
    pub fn owner_of(e: &Env, auditor_id: u32) -> Option<Address> {
        e.storage()
            .persistent()
            .get(&DataKey::Owner(auditor_id))
            .inspect(|_| extend_owner_ttl(e, auditor_id))
    }

    /// The next id `register` will hand out. Also the count registered so far.
    pub fn next_id(e: &Env) -> u32 {
        e.storage().instance().get(&DataKey::NextId).unwrap_or(0)
    }
}

/// The library's own schedule, restated because its constants are private.
///
/// Values read from stellar-contracts@219c560,
/// packages/tokens/src/confidential/auditor/mod.rs:159-161. Matching them
/// deliberately: the ownership record and the key it governs should decay
/// together rather than one silently outliving the other. A test pins these
/// against the library's behaviour so a divergence upstream is caught here.
const DAY_IN_LEDGERS: u32 = 17_280;
const OWNER_EXTEND_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const OWNER_TTL_THRESHOLD: u32 = OWNER_EXTEND_AMOUNT - DAY_IN_LEDGERS;

/// Keep an ownership record alive for as long as the key it governs.
///
/// Soroban does NOT auto-extend on read. Without this the record archives after
/// min_persistent_ttl (about 7 days on testnet, 120 on mainnet) while the
/// auditor key itself stays alive, because the library extends that one on
/// every read. Rotation is the only remedy for a compromised auditor key, so
/// letting the record that authorises it decay silently removes the single
/// recovery lever the design offers.
///
/// Same constants as the library uses for the key, so the two decay together
/// rather than one outliving the other.
fn extend_owner_ttl(e: &Env, auditor_id: u32) {
    e.storage().persistent().extend_ttl(
        &DataKey::Owner(auditor_id),
        OWNER_TTL_THRESHOLD,
        OWNER_EXTEND_AMOUNT,
    );
}

/// NextId lives in instance storage, so it shares the contract's own TTL.
/// An archived instance would lose the counter and start reissuing ids that
/// are already taken.
fn bump_instance(e: &Env) {
    e.storage()
        .instance()
        .extend_ttl(OWNER_TTL_THRESHOLD, OWNER_EXTEND_AMOUNT);
}

fn panic_with(e: &Env, err: RegistryError) -> ! {
    soroban_sdk::panic_with_error!(e, err)
}

// `get_key` comes from the trait's default implementation. The token contract
// calls it during verification and reverts if the id does not resolve to a
// valid, canonical, on-curve, non-identity point.
//
// The trait's two mutation methods take a caller-CHOSEN auditor_id, which
// collides with AuditorAlreadyRegistered and leaves the loser of a race with no
// way to recover the id. Ours allocate instead, so the trait forms are closed
// off and callers are pointed at `register` / `rotate` above.
#[contractimpl(contracttrait)]
impl ConfidentialAuditor for PocketAuditorRegistry {
    fn register_key(e: &Env, _id: u32, _point: BytesN<64>, _op: Address) {
        panic_with(e, RegistryError::UseAllocatingRegister)
    }

    fn rotate_key(e: &Env, _id: u32, _point: BytesN<64>, _op: Address) {
        panic_with(e, RegistryError::UseAllocatingRegister)
    }
}

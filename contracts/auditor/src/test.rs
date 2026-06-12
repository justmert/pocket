#![cfg(test)]
//! The registry's two guarantees: ids are allocated, never chosen, and an
//! ownership record does not decay out from under the rotation it authorises.

use soroban_sdk::{
    testutils::{storage::Persistent as _, Address as _, Ledger as _},
    Address, BytesN, Env,
};

use crate::{DataKey, PocketAuditorRegistry, PocketAuditorRegistryClient};

/// Barretenberg's Pedersen generator G, which is a valid Grumpkin point.
///
/// The library validates every write (identity, non-canonical encodings and
/// off-curve points are all rejected), so an arbitrary 64 bytes would be
/// refused before any of this is exercised. Taken from the same source the
/// extension uses, circuits/lib/src/lib.nr, and independently confirmed to
/// satisfy y^2 = x^3 - 17 over the BN254 scalar field.
fn generator(e: &Env) -> BytesN<64> {
    let mut b = [0u8; 64];
    let x: [u8; 32] = [
        0x08, 0x3e, 0x79, 0x11, 0xd8, 0x35, 0x09, 0x76, 0x29, 0xf0, 0x06, 0x75, 0x31, 0xfc, 0x15,
        0xca, 0xfd, 0x79, 0xa8, 0x9b, 0xee, 0xcb, 0x39, 0x90, 0x3f, 0x69, 0x57, 0x2c, 0x63, 0x6f,
        0x4a, 0x5a,
    ];
    let y: [u8; 32] = [
        0x1a, 0x7f, 0x5e, 0xfa, 0xad, 0x7f, 0x31, 0x5c, 0x25, 0xa9, 0x18, 0xf3, 0x0c, 0xc8, 0xd7,
        0x33, 0x3f, 0xcc, 0xab, 0x7a, 0xd7, 0xc9, 0x0f, 0x14, 0xde, 0x81, 0xbc, 0xc5, 0x28, 0xf9,
        0x93, 0x5d,
    ];
    b[..32].copy_from_slice(&x);
    b[32..].copy_from_slice(&y);
    BytesN::from_array(e, &b)
}

fn setup() -> (Env, PocketAuditorRegistryClient<'static>) {
    let e = Env::default();
    e.mock_all_auths();
    let id = e.register(PocketAuditorRegistry, ());
    let client = PocketAuditorRegistryClient::new(&e, &id);
    (e, client)
}

#[test]
fn ids_are_allocated_by_a_counter_never_chosen() {
    let (e, c) = setup();
    let a = Address::generate(&e);
    let b = Address::generate(&e);

    assert_eq!(c.register(&a, &generator(&e)), 0);
    assert_eq!(c.register(&b, &generator(&e)), 1);
    assert_eq!(c.next_id(), 2);
}

#[test]
fn owner_of_reports_the_registrant() {
    let (e, c) = setup();
    let a = Address::generate(&e);
    let id = c.register(&a, &generator(&e));
    assert_eq!(c.owner_of(&id), Some(a));
    assert_eq!(c.owner_of(&99), None);
}

#[test]
#[should_panic]
fn rotation_by_a_non_owner_is_refused() {
    let (e, c) = setup();
    let owner = Address::generate(&e);
    let stranger = Address::generate(&e);
    let id = c.register(&owner, &generator(&e));
    c.rotate(&stranger, &id, &generator(&e));
}

/// M4. Soroban does NOT auto-extend on read, so without an explicit bump the
/// ownership record archives after min_persistent_ttl while the auditor key it
/// governs stays alive. Rotation is the only remedy for a compromised key, so
/// a silently expiring record removes the single recovery lever the design has.
#[test]
fn reading_the_owner_extends_its_ttl() {
    let (e, c) = setup();
    let owner = Address::generate(&e);
    let id = c.register(&owner, &generator(&e));

    let key = DataKey::Owner(id);
    let after_register = e.as_contract(&c.address, || e.storage().persistent().get_ttl(&key));

    // Let most of the window elapse, then read.
    e.ledger().with_mut(|l| l.sequence_number += 400_000);
    let before_read = e.as_contract(&c.address, || e.storage().persistent().get_ttl(&key));
    assert!(
        before_read < after_register,
        "TTL should decay as ledgers pass"
    );

    c.owner_of(&id);

    let after_read = e.as_contract(&c.address, || e.storage().persistent().get_ttl(&key));
    assert!(
        after_read > before_read,
        "reading the owner must extend its TTL: {after_read} should exceed {before_read}"
    );
}

#[test]
fn rotating_extends_the_record_it_checked() {
    let (e, c) = setup();
    let owner = Address::generate(&e);
    let id = c.register(&owner, &generator(&e));
    let key = DataKey::Owner(id);

    e.ledger().with_mut(|l| l.sequence_number += 400_000);
    let before = e.as_contract(&c.address, || e.storage().persistent().get_ttl(&key));

    c.rotate(&owner, &id, &generator(&e));

    let after = e.as_contract(&c.address, || e.storage().persistent().get_ttl(&key));
    assert!(after > before, "rotate must leave the record alive");
}

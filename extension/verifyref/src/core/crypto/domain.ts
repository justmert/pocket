// Domain separation tags. The integer IS the wire contract: it is the first
// element absorbed by every Poseidon2 call, so a wrong value produces a
// well-formed ciphertext that decrypts to nothing.
//
// DESIGN_cont.md 13 assigns all sixteen and is their only source. Tags 1-13 are
// part of the on-chain wire contract; 14-16 are not absorbed on-chain but ARE
// part of the cross-client contract, because two wallets serving one account
// must agree on them.
//
// Do NOT migrate these from the reference demo. Its table is both shifted and
// permuted relative to normative: it puts DISCLOSURE at 13, where normative has
// ECDH_SHARED_SECRET, so a naive "+1" fix maps DISCLOSURE onto EPHEMERAL_KEY.
export const DOMAIN = {
  /** address_to_field(a) = Poseidon2(ADDRESS, lo, hi). Absorbed on-chain by the contract. */
  ADDRESS: 1n,
  /** vk = Poseidon2(VIEWING_KEY, sk, addr_f). */
  VIEWING_KEY: 2n,
  /** dvk_i = Poseidon2(DELEGATION_VIEWING_KEY, vk, op_i). */
  DELEGATION_VIEWING_KEY: 3n,
  /** r' = Poseidon2(SPEND_RANDOMNESS, vk, sigma). */
  SPEND_RANDOMNESS: 4n,
  /** r_transfer = Poseidon2(TRANSFER_BLINDING, s, sigma). */
  TRANSFER_BLINDING: 5n,
  /** v_tilde = v_transfer + Poseidon2(TRANSFER_AMOUNT, s, sigma). */
  TRANSFER_AMOUNT: 6n,
  /** b_tilde = v_new + Poseidon2(ENCRYPTED_BALANCE, vk, sigma). */
  ENCRYPTED_BALANCE: 7n,
  /** a_tilde = v_a + Poseidon2(ENCRYPTED_ALLOWANCE, dvk, sigma_a). */
  ENCRYPTED_ALLOWANCE: 8n,
  /** r_a = Poseidon2(ALLOWANCE_RANDOMNESS, dvk, sigma_a). */
  ALLOWANCE_RANDOMNESS: 9n,
  /** Delegation-key escrow mask. */
  ESCROWED_DELEGATION_VIEWING_KEY: 10n,
  /** Sender / owner-auditor channel. A two-mask tag: lane 0 amount, lane 1 balance. */
  AUDITOR_SENDER: 11n,
  /** Recipient-auditor channel. A two-mask tag: lane 0 amount, lane 1 r_transfer. */
  AUDITOR_RECIPIENT: 12n,
  /** s = Poseidon2(ECDH_SHARED_SECRET, S.x, S.y). BOTH coordinates, never x-only. */
  ECDH_SHARED_SECRET: 13n,
  /** r_e = Poseidon2(EPHEMERAL_KEY, vk, sigma_E). Derived off-circuit. */
  EPHEMERAL_KEY: 14n,
  /** Off-chain disclosure nonce binding. */
  DISCLOSURE_BIND: 15n,
  /** Off-chain disclosure ciphertext. */
  DISCLOSURE: 16n,
} as const;

/** The two tags that drive a two-lane sponge squeeze; all others yield one output. */
export const TWO_MASK_TAGS: readonly bigint[] = [DOMAIN.AUDITOR_SENDER, DOMAIN.AUDITOR_RECIPIENT];

/** Verifier circuit-type discriminants. Part of the on-chain interface; MUST NOT change. */
export const CIRCUIT_TYPE = {
  Register: 0,
  Withdraw: 1,
  Transfer: 2,
  SpenderTransfer: 3,
  SetSpender: 4,
  RevokeSpender: 5,
} as const;

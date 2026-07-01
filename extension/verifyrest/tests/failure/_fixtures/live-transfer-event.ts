// A REAL transfer event body, captured off the deployed contract.
//
// Frozen here rather than hand-rolled, and that distinction is the whole point.
// The `bigint` decode bug was found by printing a live event and noticing the
// fields were BytesN rather than bigints. Every test that exercised that path
// built its fixtures with the same encoder the fix expects, so they agreed with
// the fix by construction instead of pinning it against the contract.
//
// This one cannot drift from the contract, because it came from the contract.
//
//   contract  CDMXZEFOM5DN2GSHQKNOOW242RJZGCEM5LOOAPGRQE35GGHB7ALDK2Y6 (testnet)
//   ledger    3900337
//   event id  0016751819858399232-0000000000
//   captured  2026-08-01, within the RPC's retention window at the time
//
// It is the `value` of a `transfer` event, base64 XDR, exactly as
// `getEvents` returns it on the raw endpoint.
export const LIVE_TRANSFER_VALUE_B64 =
  "AAAAEQAAAAEAAAAIAAAADwAAAAdiX3RpbGRlAAAAAA0AAAAgHy83heE30Bb9tjhXAcrXYiAmB7D/" +
  "nQhkJTjFZu+kWPQAAAAPAAAADWJfdGlsZGVfYXVkX3MAAAAAAAANAAAAIBWOtL818xVEnjGae+vB" +
  "2XH7P/M6MTV+fvvur7/zQBakAAAADwAAAAlyX2VfcG9pbnQAAAAAAAANAAAAQC6pW9wnEEfWleY/" +
  "BtHrE0FZFEA4pCWev0qQlS5QcoRPBr/nUCaM5bZrNBw9rBNRUq8MffBu615lpyDAzAsHuC8AAAAP" +
  "AAAADXJfdGlsZGVfYXVkX3IAAAAAAAANAAAAICLi7nwUcPnGZ5qZU7yn0sHuhjjELDB8mvqyNHi/" +
  "XEgmAAAADwAAAAVzaWdtYQAAAAAAAA0AAAAgGack5OSy0FBYZSVTLiA6CnlAmuA1xVIrmC620OHC" +
  "m7IAAAAPAAAAB3ZfdGlsZGUAAAAADQAAACANHXE0IqpB+eVfiafE+nWcu/IOU8nhHzxEyE2s00WS" +
  "CAAAAA8AAAANdl90aWxkZV9hdWRfcgAAAAAAAA0AAAAgJGTjqLzpCF2SB73xNgBqlw24xBrSKt7/" +
  "AP3qzIu4FdAAAAAPAAAADXZfdGlsZGVfYXVkX3MAAAAAAAANAAAAIBptr+CKbJQuFAxNjEFvsaZW" +
  "6DluPXarXyNmkrzLvv0q";

/** The eight fields the contract publishes, and the width of each. */
export const LIVE_TRANSFER_FIELDS: Record<string, number> = {
  b_tilde: 32,
  b_tilde_aud_s: 32,
  r_e_point: 64,
  r_tilde_aud_r: 32,
  sigma: 32,
  v_tilde: 32,
  v_tilde_aud_r: 32,
  v_tilde_aud_s: 32,
};

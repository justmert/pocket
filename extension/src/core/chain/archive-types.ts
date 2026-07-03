/** One archived event. Mirrors INDEXER.md 3.1's required record. */
export interface StoredEvent {
  id: string;
  contract_id: string;
  ledger_seq: number;
  close_time: number;
  tx_hash: string;
  tx_application_order: number;
  event_index: number;
  event_type: string;
  /** Verbatim XDR, base64. Survives binding renames with no migration. */
  topics_xdr: string;
  data_xdr: string;
  /**
   * Base64 XDR of the invocation payload, set only for transfer events.
   *
   * The event body of a transfer carries no `c_transfer`, and `c_transfer` is
   * the only thing that proves a decrypted amount is the one that was actually
   * committed. It travels in the invocation instead, so an archive that stores
   * only events cannot serve a recipient their own history. Optional because an
   * older archive will not have it, and absent it the wallet refuses that event
   * exactly as it did before.
   */
  payload_xdr?: string | null;
}

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
}

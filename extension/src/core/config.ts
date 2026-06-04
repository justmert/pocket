// Network configuration. Contract addresses are config, never hardcoded
// constants: testnet is wiped on resets, and confidential identities are
// per-deployment, so a redeployment means every user re-registers.
export type NetworkId = "testnet" | "mainnet";

export interface ConfidentialDeployment {
  /** The wrapper contract. Its address is baked into every key we derive. */
  token: string;
  /** UltraHonk verifier, one VK per circuit type. Shared across wrappers. */
  verifier: string;
  /** Auditor key registry. Also shared. */
  auditor: string;
  /** The SEP-41 / SAC asset this wrapper holds. */
  underlying: string;
  /** Display symbol for the underlying. */
  symbol: string;
}

export interface NetworkConfig {
  id: NetworkId;
  passphrase: string;
  rpcUrl: string;
  horizonUrl: string;
  friendbotUrl?: string;
  /** Native XLM's Stellar Asset Contract. */
  nativeSac: string;
  /**
   * One entry per private asset. A wrapper binds exactly one underlying at
   * construction (set_underlying_asset is one-shot), so private XLM and private
   * USDC are two deployments, each with its own confidential identity.
   */
  confidential: ConfidentialDeployment[];
}

export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  testnet: {
    id: "testnet",
    passphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    friendbotUrl: "https://friendbot.stellar.org",
    nativeSac: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    // Populated when we deploy our own wrappers in phase 5. The upstream demo's
    // testnet deployment is deliberately not listed: it holds pre-audit
    // verification keys, so building against it would mean implementing five
    // known audit findings.
    confidential: [],
  },
  mainnet: {
    id: "mainnet",
    passphrase: "Public Global Stellar Network ; September 2015",
    rpcUrl: "https://mainnet.sorobanrpc.com",
    horizonUrl: "https://horizon.stellar.org",
    nativeSac: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
    confidential: [],
  },
};

export const DEFAULT_NETWORK: NetworkId = "testnet";

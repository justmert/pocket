// Network configuration. Contract addresses are config, never hardcoded
// constants: testnet is wiped on resets, and confidential identities are
// per-deployment, so a redeployment means every user re-registers.
//
// Every endpoint and passphrase below was checked against the live network on
// 2026-07-31 rather than recalled:
//   - testnet passphrase and friendbotUrl returned verbatim by getNetwork
//   - both passphrases, both Horizon hosts and both RPC hosts answered
//   - all three testnet contracts and both native SACs resolve on chain
// Re-run scripts/check-infrastructure.sh to re-establish this; do not trust the
// comment on its own once it is more than a release old.
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
  /**
   * The durable event archive, and it is not optional for the private pocket.
   *
   * Soroban RPC retains events for 120,960 ledgers, about seven days. Past
   * that a wallet that lost its local state can see its confidential balances
   * on chain and cannot spend them, because only the openings make a
   * commitment spendable and only a replay of the event history rebuilds them.
   * That is the whole reason `indexer/` exists.
   *
   * Absent here, recovery beyond the RPC window is impossible and the wallet
   * says so rather than guessing.
   */
  archiveUrl?: string;
  /**
   * Yield, which lives in the PUBLIC pocket only.
   *
   * Absent means the wallet says so plainly rather than showing an empty
   * position, because "no vault configured" and "you have nothing deposited"
   * are different facts and only one of them is about the user.
   */
  defindex?: { baseUrl: string; vault?: string; apiKey?: string };
}

export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  testnet: {
    id: "testnet",
    passphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    friendbotUrl: "https://friendbot.stellar.org",
    nativeSac: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    // Our own deployment. The upstream demo's testnet instance is deliberately
    // not used: it holds PRE-AUDIT verification keys, so building against it
    // would mean implementing five known audit findings including a register
    // replay. Ours carry the VKs from OpenZeppelin's post-audit branch, whose
    // hashes are recorded in resources/deployment-testnet.json.
    // Local by default. A hosted archive replaces this; the wallet refuses to
    // sync rather than falling back when it cannot reach one, because falling
    // back moves the cursor past a gap and loses openings permanently.
    archiveUrl: "http://127.0.0.1:8787",
    // The API key is supplied at build time, never committed. Without it the
    // wallet reports yield as unconfigured instead of failing at a fetch.
    defindex: {
      baseUrl: "https://api.defindex.io",
      apiKey: import.meta.env.VITE_DEFINDEX_API_KEY,
      vault: import.meta.env.VITE_DEFINDEX_VAULT,
    },
    confidential: [
      {
        token: "CDMXZEFOM5DN2GSHQKNOOW242RJZGCEM5LOOAPGRQE35GGHB7ALDK2Y6",
        verifier: "CBERRYPR34G2MB3EOUNO3JGWOAWFVBUPINJ42JP7XVVB3AHKIPVPPWYH",
        auditor: "CDE5JETGXV7TOUUDQPUTGLJB6TCUUIIWJJTLWFX4RNH36XABKCEPNTEV",
        underlying: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        symbol: "XLM",
      },
    ],
  },
  mainnet: {
    id: "mainnet",
    passphrase: "Public Global Stellar Network ; September 2015",
    // NOT an SDF endpoint. SDF publishes no public mainnet RPC at all: it runs
    // one for testnet and futurenet only, and directs production traffic to
    // commercial providers. sorobanrpc.com is one such third party, so on the
    // day this network is enabled it sees every address the wallet queries and
    // can lie about any read it answers. Shipping mainnet on a public endpoint
    // is a trust decision that must be made deliberately, not inherited from
    // this line. Verified against developers.stellar.org/docs/data/apis/rpc/providers
    // on 2026-07-31.
    rpcUrl: "https://mainnet.sorobanrpc.com",
    horizonUrl: "https://horizon.stellar.org",
    nativeSac: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
    // No friendbot on mainnet, by design: the field is optional so that the
    // absence is a type-level fact rather than a URL that would fail at runtime.
    //
    // Empty until a mainnet deployment exists. Every consumer guards on this
    // being empty and reports the private pocket unavailable rather than
    // reading confidential[0] off the end, so enabling mainnet cannot silently
    // point the private pocket at a testnet contract.
    confidential: [],
  },
};

export const DEFAULT_NETWORK: NetworkId = "testnet";

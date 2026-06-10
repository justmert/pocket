// Circle CCTP for Stellar.
//
// ⚠️ SAFETY CRITICAL. On a burn destined for Stellar, BOTH `mintRecipient` AND
// `destinationCaller` must be the CctpForwarder contract address, as raw 32
// bytes. The real recipient goes in hook data.
//
// Circle's own words: "If destinationCaller is wrong, the forwarder cannot
// complete the transfer. If mintRecipient is set to a user account or muxed
// address, USDC is not sent to the forwarder. In either case funds become
// permanently stuck and cannot be recovered."
//
// The forwarder exists because CCTP messages carry a raw 32-byte address with
// no strkey type marker, so the protocol cannot tell a G account from a C
// contract and assumes mintRecipient is always a contract.
//
// This module therefore refuses to build a burn whose parameters deviate. That
// check is the whole point of the module: a caller cannot opt out of it.
export const CCTP = {
  mainnet: {
    forwarder: "CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T",
    tokenMessengerMinter: "CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL",
    messageTransmitter: "CACMENFFJPJMSDAJQLX4R7K3SFZIW2LJSE3R2UMLGSWHFHS353FVXAZV",
    usdc: "USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  },
  testnet: {
    forwarder: "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ",
    tokenMessengerMinter: "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP",
    messageTransmitter: "CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY",
    usdc: "USDC-GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  },
} as const;

/** Stellar's CCTP domain. The protocol supports it; Circle's Bridge Kit SDK does not. */
export const STELLAR_DOMAIN = 27;

/** 1000 = fast, 2000 = standard. */
export const FINALITY = { fast: 1000, standard: 2000 } as const;

export class CctpParameterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CctpParameterError";
  }
}

/**
 * Hook data layout, byte for byte:
 *
 *   0-23    bytes24  magic, Circle-reserved, all zero
 *   24-27   uint32   version, 0
 *   28-31   uint32   L, the length of the recipient strkey
 *   32..    bytes    recipient strkey, UTF-8
 *   32+L..  bytes    optional integrator payload
 *
 * The magic bytes are NOT validated on chain despite the doc comment naming
 * them, so writing them correctly is our discipline rather than an enforced
 * invariant.
 */
export function buildForwarderHookData(recipient: string, payload?: Uint8Array): Uint8Array {
  const strkey = new TextEncoder().encode(recipient);
  const out = new Uint8Array(32 + strkey.length + (payload?.length ?? 0));
  const view = new DataView(out.buffer);
  // 0-23 magic stays zero. 24-27 version 0.
  view.setUint32(24, 0, false);
  view.setUint32(28, strkey.length, false);
  out.set(strkey, 32);
  if (payload) out.set(payload, 32 + strkey.length);
  return out;
}

export function parseForwarderHookData(data: Uint8Array): {
  version: number;
  recipient: string;
  payload: Uint8Array;
} {
  if (data.length < 32) throw new CctpParameterError("hook data is shorter than its header");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = view.getUint32(24, false);
  const len = view.getUint32(28, false);
  if (32 + len > data.length) throw new CctpParameterError("hook data recipient length overruns");
  return {
    version,
    recipient: new TextDecoder().decode(data.subarray(32, 32 + len)),
    payload: data.subarray(32 + len),
  };
}

export interface BurnParams {
  /** MUST be the forwarder. */
  mintRecipient: string;
  /** MUST be the forwarder. */
  destinationCaller: string;
  destinationDomain: number;
  /** The real recipient, carried in hook data. */
  recipient: string;
  amount: bigint;
  network: keyof typeof CCTP;
}

/**
 * Refuse to build a burn whose parameters would strand the funds.
 *
 * This is a pre-flight gate, not advice. It runs before anything is signed,
 * and there is no flag to bypass it.
 */
export function assertBurnParameters(p: BurnParams): void {
  const forwarder = CCTP[p.network].forwarder;

  if (p.mintRecipient !== forwarder) {
    throw new CctpParameterError(
      `mintRecipient must be the CctpForwarder (${forwarder}), got ${p.mintRecipient}. ` +
        `Any other value sends the USDC somewhere it cannot be recovered from.`,
    );
  }
  if (p.destinationCaller !== forwarder) {
    throw new CctpParameterError(
      `destinationCaller must be the CctpForwarder (${forwarder}), got ${p.destinationCaller}. ` +
        `A zero value would let a third party relay the message and strand the USDC in the ` +
        `forwarder; any other value stops it completing at all.`,
    );
  }
  if (p.destinationDomain !== STELLAR_DOMAIN) {
    throw new CctpParameterError(
      `destinationDomain must be ${STELLAR_DOMAIN} for Stellar, got ${p.destinationDomain}.`,
    );
  }
  // The forwarder parses the hook-data recipient as a MuxedAddress, so M...
  // works there. As mintRecipient it would destroy the funds. Two opposite
  // behaviours for the same address type in one flow, so check the shape.
  if (!/^[GCM][A-Z2-7]{55,68}$/.test(p.recipient)) {
    throw new CctpParameterError(`recipient is not a valid Stellar address: ${p.recipient}`);
  }
  if (p.amount <= 0n) throw new CctpParameterError("amount must be positive");
}

/**
 * Stellar USDC has SEVEN decimals; CCTP's amount field has SIX.
 *
 * Bridging from Stellar therefore debits only through the sixth decimal, and
 * the seventh is left behind as dust. Users report this as a bug unless it is
 * stated, so the caller gets both numbers back and must show the residual.
 */
export function toCctpAmount(stellarStroops: bigint): { cctpAmount: bigint; dust: bigint } {
  const cctpAmount = stellarStroops / 10n;
  return { cctpAmount, dust: stellarStroops - cctpAmount * 10n };
}

/** The reverse: a 6-decimal CCTP amount scaled to Stellar's 7. */
export function fromCctpAmount(cctpAmount: bigint): bigint {
  return cctpAmount * 10n;
}

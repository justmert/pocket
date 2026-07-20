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
// `assertBurnParameters` below refuses a burn whose parameters deviate, and a
// caller cannot opt out of it. Read what it actually governs before relying on
// it: it requires `destinationDomain === STELLAR_DOMAIN`, so it describes an
// INBOUND leg composed on another chain. Pocket's own outbound burn goes the
// other way and has no production caller of this gate at all; see the note at
// `toCctpFee` further down, which says the same thing 200 lines later.
//
// What keeps the outbound path safe is different and worth stating here rather
// than leaving implied: every parameter it sends is a hardcoded constant from
// the table below, a value fixed by the wallet, or a user-typed recipient that
// is displayed in full and checksum-verified by `evmAddressToBytes32`.
import { keccak_256 } from "@noble/hashes/sha3.js";

export const CCTP = {
  mainnet: {
    forwarder: "CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T",
    tokenMessengerMinter: "CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL",
    messageTransmitter: "CACMENFFJPJMSDAJQLX4R7K3SFZIW2LJSE3R2UMLGSWHFHS353FVXAZV",
    usdc: "USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    iris: "https://iris-api.circle.com",
  },
  testnet: {
    forwarder: "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ",
    tokenMessengerMinter: "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP",
    messageTransmitter: "CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY",
    usdc: "USDC-GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    iris: "https://iris-api-sandbox.circle.com",
  },
} as const;

/**
 * An EVM recipient address (20 bytes) as CCTP's 32-byte `mint_recipient`.
 *
 * CCTP addresses are a raw 32-byte field with no chain-specific encoding, and an
 * EVM address is right-aligned in it (12 zero bytes, then the 20 address bytes).
 * Getting this wrong sends the mint to the wrong address on the far side, so the
 * input is validated as a 20-byte hex string first.
 */
export function evmAddressToBytes32(address: string): Uint8Array {
  const hex = address.startsWith("0x") ? address.slice(2) : address;
  if (!/^[0-9a-fA-F]{40}$/.test(hex)) {
    throw new CctpParameterError(`not a 20-byte EVM address: ${address}`);
  }
  assertEip55(hex, address);
  const out = new Uint8Array(32);
  for (let i = 0; i < 20; i++) out[12 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * The EIP-55 capitalisation checksum, where the address carries one.
 *
 * A mistyped recipient here is not recoverable: the USDC burns on Stellar and
 * mints to whatever address the message names on the far chain. Misdelivery
 * rather than destruction, but equally final for the user, and nothing else in
 * the flow can catch it. The address is typed by hand and shown back verbatim,
 * so a transposed pair of characters looks exactly like a correct one.
 *
 * The check only works on a MIXED-CASE address, because that is where EIP-55
 * puts the checksum. An all-lowercase or all-uppercase address carries none and
 * is accepted unchanged: refusing it would reject a legitimate form that every
 * EVM tool emits. So this catches the common case (a wallet-copied checksummed
 * address that was then corrupted) and cannot catch a lowercase typo, which is
 * worth stating rather than implying it is a complete guard.
 */
function assertEip55(hex: string, original: string): void {
  const lower = hex.toLowerCase();
  const upper = hex.toUpperCase();
  // No checksum to verify: the address is in a case-insensitive form.
  if (hex === lower || hex === upper) return;

  if (eip55(lower) !== hex) {
    throw new CctpParameterError(
      `That EVM address fails its own checksum, so it has been mistyped or altered: ${original}. ` +
        `USDC bridged to a wrong address cannot be recovered.`,
    );
  }
}

/** The EIP-55 capitalisation of a lowercase 40-character hex address. */
function eip55(lower: string): string {
  const digest = keccak_256(new TextEncoder().encode(lower));
  let out = "";
  for (let i = 0; i < 40; i++) {
    const c = lower[i]!;
    if (c >= "0" && c <= "9") {
      out += c;
      continue;
    }
    // The nibble governing character i is the high or low half of byte i/2.
    const byte = digest[i >> 1]!;
    const nibble = i % 2 === 0 ? byte >> 4 : byte & 0x0f;
    out += nibble >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

/**
 * Read a mint recipient back OUT of the 32 bytes that will be signed.
 *
 * The inverse of `evmAddressToBytes32`, and it exists for the approval screen
 * rather than for the protocol. The bridge sheet was showing an amount and a
 * chain and no destination at all, so the one field that decides where the money
 * lands was visible only in the form the user had already left. Echoing the
 * typed string back would prove nothing; this decodes the value the worker
 * actually recorded and will actually burn to.
 *
 * Returned in EIP-55 capitalisation, computed here rather than carried through,
 * so the case a user compares against the far chain's explorer is derived from
 * these bytes and not from what they typed.
 *
 * Refuses anything whose top 12 bytes are not zero. CCTP left-pads a 20-byte
 * address into 32; a value with something up there is not an EVM address, and
 * rendering its bottom 20 bytes as one would be a confident lie about a
 * destination.
 */
export function bytes32ToEvmAddress(bytes: Uint8Array): string {
  if (bytes.length !== 32) {
    throw new CctpParameterError(`a mint recipient is 32 bytes, not ${bytes.length}`);
  }
  for (let i = 0; i < 12; i++) {
    if (bytes[i] !== 0) {
      throw new CctpParameterError(
        "that mint recipient is not a left-padded EVM address, so Pocket cannot say where it " +
          "would land",
      );
    }
  }
  let lower = "";
  for (let i = 12; i < 32; i++) lower += bytes[i]!.toString(16).padStart(2, "0");
  return `0x${eip55(lower)}`;
}

/** The all-zero 32-byte value, used for a permissionless destination_caller. */
export function zeroBytes32(): Uint8Array {
  return new Uint8Array(32);
}

/** Stellar's CCTP domain. The protocol supports it; Circle's Bridge Kit SDK does not. */
export const STELLAR_DOMAIN = 27;

/**
 * CCTP V2 domain ids to display names, for the approval screen. Only the common
 * destinations; an unlisted domain is shown by number rather than guessed at.
 */
export const CCTP_DOMAIN_NAMES: Record<number, string> = {
  0: "Ethereum",
  1: "Avalanche",
  2: "OP Mainnet",
  3: "Arbitrum",
  5: "Solana",
  6: "Base",
  7: "Polygon",
  10: "Unichain",
  11: "Linea",
  16: "Sei",
  17: "BNB Smart Chain",
  27: "Stellar",
};

export function cctpDomainName(domain: number): string {
  return CCTP_DOMAIN_NAMES[domain] ?? `domain ${domain}`;
}

/**
 * Domains a burn from Stellar can actually reach, read off the deployed
 * contract rather than off the name table.
 *
 * Being NAMED is not being reachable. BNB Smart Chain (17) sits in
 * `CCTP_DOMAIN_NAMES` and the picker offered it, and the route does not exist:
 * the user picked it, paid for the approve, and the burn then trapped at
 * `Error(Contract, #7106)`, deterministically, every time.
 *
 * Three live oracles agreed, 2026-08-08:
 *
 *   1. The deployed TokenMessengerMinter,
 *      CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP:
 *      `get_remote_token_messenger(17)` returns None, while 0, 1, 2, 3, 5, 6,
 *      7, 10, 11 and 16 all return a value.
 *   2. Circle's Iris: GET /v2/burn/USDC/fees/27/17 answers
 *      {"error":"Invalid source/destination domain id"} on sandbox AND on
 *      mainnet, and mainnet answers the same for 0 -> 17.
 *   3. A real `deposit_for_burn` to 17, composed exactly as `confirmCctpSend`
 *      composes it, simulated to Error(Contract, #7106).
 *
 * Kept here beside the names so the picker and the worker read one list. They
 * read two, and that is how a chain nobody can bridge to came to be offered by
 * name on the screen that charges for trying.
 */
export const CCTP_BURN_REACHABLE = new Set([0, 1, 2, 3, 5, 6, 7, 10, 11, 16]);

/** Can a burn from Stellar be delivered to this domain at all? */
export function cctpCanBurnTo(domain: number): boolean {
  return CCTP_BURN_REACHABLE.has(domain);
}

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
  /** Stellar USDC subunits, SEVEN decimals. Not the same scale as maxFee. */
  amount: bigint;
  /** Canonical CCTP units, SIX decimals. Not the same scale as amount. */
  maxFee: bigint;
  network: keyof typeof CCTP;
}

/**
 * Refuse to build a burn whose parameters would strand the funds.
 *
 * This is a pre-flight gate, not advice. It runs before anything is signed,
 * and there is no flag to bypass it.
 */
export function assertBurnParameters(p: BurnParams): void {
  const chain = CCTP[p.network];
  // An unknown network must fail like every other branch here, with a typed
  // error a caller can catch. Dereferencing undefined fails closed but throws
  // a TypeError, which every `catch (e instanceof CctpParameterError)` misses.
  if (!chain) {
    throw new CctpParameterError(
      `unknown network "${String(p.network)}": CCTP addresses are only known for mainnet and testnet.`,
    );
  }
  const forwarder = chain.forwarder;

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

  // THE decimal trap. `amount` is 7dp and `max_fee` is 6dp in the SAME call,
  // which is Circle's own documented shape and the easiest expensive mistake
  // in this flow. A caller who reaches for toCctpAmount to fill `amount`
  // under-sends tenfold; a caller who passes a 7dp fee overpays tenfold.
  //
  // The gate: a fee at the wrong scale is essentially always larger than the
  // amount it is a fee on, once both are expressed in the same units.
  if (p.maxFee < 0n) throw new CctpParameterError("maxFee must not be negative");
  const amountIn6dp = p.amount / 10n;
  if (p.maxFee > amountIn6dp) {
    throw new CctpParameterError(
      `maxFee (${p.maxFee}) exceeds the amount being bridged (${amountIn6dp} in CCTP units). ` +
        `amount is in Stellar subunits (7 decimals) and max_fee is in canonical CCTP units ` +
        `(6 decimals); passing a 7-decimal fee here overpays by 10x.`,
    );
  }
}

/**
 * Scale a fee to the SIX decimals a canonical CCTP `max_fee` takes.
 *
 * CORRECTION (verified D10 against circlefin/stellar-cctp
 * token-messenger-minter-v2/src/deposit.rs): the STELLAR `deposit_for_burn`
 * takes BOTH `amount` and `max_fee` in LOCAL decimals (Stellar's 7), and the
 * contract converts them to canonical internally and removes dust itself. So do
 * NOT apply this to the Stellar `max_fee`: pass the 7-decimal value straight
 * through (Pocket's outbound uses max_fee = 0, so it is moot on the live path).
 * This helper, `assertBurnParameters`, and the hook-data builders describe the
 * canonical/other-chain side and are NOT used by Pocket's Stellar-only flow.
 *
 * Named apart from toCctpAmount on purpose. Both divide by ten, and having one
 * function for both would let the two scales be confused silently, which is
 * exactly the failure this module exists to prevent.
 */
export function toCctpFee(canonicalStroops: bigint): bigint {
  return canonicalStroops / 10n;
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

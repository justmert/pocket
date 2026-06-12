// Circuit artifact loading.
//
// The compiled circuits ship inside the extension package, vendored at build
// time from the pinned upstream revision. The ACIR arrives base64-gzipped
// inside the Noir artifact, so it is decompressed before the prover sees it:
// bb.js's own acirToUint8Array does base64-decode then decompress, and the
// low-level API expects the result.
import type { CircuitSource } from "./confidential-ops";

const BASE = "/vendor/circuits/target";

async function gunzip(b: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Loads circuits from the extension package. Never from the network: MV3 bans
 * remotely hosted code, and a circuit is code.
 */
export class BundledCircuits implements CircuitSource {
  private cache = new Map<string, Uint8Array>();

  async acir(name: string): Promise<Uint8Array> {
    const hit = this.cache.get(name);
    if (hit) return hit;

    const res = await fetch(`${BASE}/circuit_${name}.json`);
    if (!res.ok) throw new Error(`circuit ${name} is missing from the extension package`);
    const artifact = (await res.json()) as { bytecode: string };
    const raw = Uint8Array.from(atob(artifact.bytecode), (c) => c.charCodeAt(0));
    const acir = await gunzip(raw);
    this.cache.set(name, acir);
    return acir;
  }

  /**
   * Solve a witness.
   *
   * Solving is what turns named inputs into the ordered witness the prover
   * consumes, and it is also a free correctness check: the circuit refuses an
   * assignment that does not satisfy its constraints, so a bad witness fails
   * here rather than producing a proof that fails on chain.
   */
  async solve(name: string, inputs: Record<string, bigint>): Promise<Uint8Array> {
    const { Noir } = await import("@noir-lang/noir_js");
    const res = await fetch(`${BASE}/circuit_${name}.json`);
    if (!res.ok) throw new Error(`circuit ${name} is missing from the extension package`);
    const artifact = await res.json();

    const noir = new Noir(artifact);
    const hex: Record<string, string> = {};
    for (const [k, v] of Object.entries(inputs)) {
      hex[k] = "0x" + v.toString(16).padStart(64, "0");
    }
    const { witness } = await noir.execute(hex);
    return witness;
  }
}

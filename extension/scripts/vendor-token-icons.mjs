// Token logos, resolved from curated SEP-42 Stellar Asset Lists and VENDORED
// into the package. Same stance as vendor-bb / vendor-srs / vendor-circuits:
// pull an upstream artifact once, ship it locally, fetch nothing at runtime.
//
// Why not fetch icons at runtime, the way Freighter does from a live asset list:
// an <img> pulled per held asset from an issuer-controlled host is a per-holding
// tracking pixel. It would also falsify two claims the wallet makes in its own
// copy, "one network host" and "nothing is loaded from the internet at runtime",
// and force img-src wider than 'self'. So we take Freighter's SOURCE, the
// curated and anti-spoof SEP-42 lists, and none of its runtime cost.
//
// Identity is the ISSUER, never the code. The generated map is keyed on the
// canonical asset id ("native" | "CODE:ISSUER") exactly as chain/balances.ts
// mints it, so a "USDC" from any issuer but the verified one misses the map and
// falls back to the monogram rather than wearing Circle's logo. Icons and
// symbols are trivially spoofable; the issuer is the only real identity, which
// is the whole reason SEP-42 lists exist.
//
// UNLIKE bb/srs/circuits this is NOT run on every build and its output IS
// committed. A token logo is a trust signal and a swapped one is a phishing aid,
// so it is reviewed in the diff rather than re-fetched silently, and the build
// stays offline. Run on demand:  npm run vendor:icons
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const tokensDir = join(here, "../public/tokens");
const genFile = join(here, "../src/entrypoints/popup/ui/tokenIcons.generated.ts");

// Curated SEP-42 lists. Read for issuer->icon bindings only; the anti-spoof
// curation is theirs, the vendoring is ours. Ordered by preference: the first
// list that carries an icon for a code+issuer wins.
const LISTS = [
  "https://api.stellar.expert/explorer/public/asset-list/top50",
  "https://raw.githubusercontent.com/soroswap/token-list/main/tokenList.json",
];

// We ship every asset the curated lists carry an icon for, not a re-curated
// subset: the SEP-42 list IS the vetted allowlist, so trimming it down would
// only insert an arbitrary judgment and leave real holdings on the monogram. The
// only bound is MAX_ICON_BYTES below, so one rogue image cannot bloat the
// package. Everything still keyed on its exact issuer, so the anti-spoof rule is
// untouched.

// Native XLM is not a trustline asset, so no SEP-42 list carries it. Pinned to a
// stable first-party logo and keyed on the canonical id "native".
const NATIVE = {
  id: "native",
  icon: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/stellar/info/logo.png",
};

// Testnet SEP-42 lists. Their entries carry verified testnet ISSUERS but no icon
// (testnet assets do not ship logos), so each is matched by CODE to the mainnet
// brand icon already vendored above. Still gated by the curated list: an
// unlisted testnet issuer gets the monogram, so the strict-issuer rule holds on
// testnet too, and a matched issuer is one StellarExpert vets as that brand.
const TESTNET_LISTS = ["https://api.stellar.expert/explorer/testnet/asset-list/top50"];

// A single rogue IPFS image must not bloat the package. Anything larger falls
// back to the monogram with a warning rather than shipping.
const MAX_ICON_BYTES = 100 * 1024;

const EXT_BY_TYPE = {
  "image/png": "png",
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
  "image/gif": "gif",
};

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "user-agent": "pocket-vendor" } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function fetchIcon(url) {
  const res = await fetch(url, { headers: { "user-agent": "pocket-vendor" } });
  if (!res.ok) throw new Error(`icon ${url} -> ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const type = (res.headers.get("content-type") || "").split(";")[0].trim();
  const ext = EXT_BY_TYPE[type] || "png";
  return { buf, ext };
}

async function main() {
  // Read every mainnet list, keep the FIRST icon seen for each canonical id, and
  // index by code so a testnet issuer can resolve its brand's icon.
  const byId = new Map(); // "CODE:ISSUER" -> { code, issuer, icon }
  const byCode = new Map(); // "CODE" -> first entry seen with an icon
  for (const listUrl of LISTS) {
    let list;
    try {
      list = await fetchJson(listUrl);
    } catch (e) {
      console.warn(`skipping list ${listUrl}: ${e.message}`);
      continue;
    }
    const assets = list.assets || list.tokens || [];
    for (const a of assets) {
      if (!a.code || !a.issuer || !a.icon) continue;
      const id = `${a.code}:${a.issuer}`;
      if (!byId.has(id)) byId.set(id, { code: a.code, issuer: a.issuer, icon: a.icon });
      if (!byCode.has(a.code)) byCode.set(a.code, byId.get(id));
    }
  }

  // The set of (id, iconUrl) to actually vendor: native, then every vetted
  // mainnet entry that carries an icon, then testnet issuers matched by code.
  const targets = [{ id: NATIVE.id, icon: NATIVE.icon }];
  for (const [id, entry] of byId) {
    targets.push({ id, icon: entry.icon });
  }

  // Testnet: the list vouches for the issuer, the mainnet brand supplies the
  // icon. A testnet code with no mainnet icon (an obscure test token) is left on
  // the monogram rather than given a stranger's logo.
  let testnetMatched = 0;
  for (const listUrl of TESTNET_LISTS) {
    let list;
    try {
      list = await fetchJson(listUrl);
    } catch (e) {
      console.warn(`skipping testnet list ${listUrl}: ${e.message}`);
      continue;
    }
    for (const a of list.assets || list.tokens || []) {
      if (!a.code || !a.issuer) continue;
      const brand = byCode.get(a.code);
      if (!brand) continue;
      targets.push({ id: `${a.code}:${a.issuer}`, icon: brand.icon });
      testnetMatched++;
    }
  }

  // Rewrite from scratch so a removed asset does not leave an orphan file.
  rmSync(tokensDir, { recursive: true, force: true });
  mkdirSync(tokensDir, { recursive: true });

  const map = {}; // canonical id -> filename under public/tokens
  const fileByUrl = new Map(); // icon URL -> filename, so one image is fetched
  // and stored once even when many ids share it (every testnet USDC issuer
  // points at the one mainnet USDC logo).
  for (const { id, icon } of targets) {
    if (map[id]) continue;
    let name = fileByUrl.get(icon);
    if (!name) {
      let got;
      try {
        got = await fetchIcon(icon);
      } catch (e) {
        console.warn(`no icon for ${id}: ${e.message}`);
        continue;
      }
      if (got.buf.length > MAX_ICON_BYTES) {
        console.warn(`icon for ${id} is ${(got.buf.length / 1024) | 0}KB > cap; monogram it is`);
        continue;
      }
      // Filename is a hash of the icon SOURCE, so the same image lands in one
      // file, no issuer address ever appears in a path, and a swapped icon at
      // the same URL shows as a changed BYTE rather than a changed name.
      name = `${createHash("sha256").update(icon).digest("hex").slice(0, 16)}.${got.ext}`;
      writeFileSync(join(tokensDir, name), got.buf);
      fileByUrl.set(icon, name);
    }
    map[id] = name;
  }

  // Match prettier's quoteProps:"as-needed": a valid identifier ("native") is
  // emitted unquoted, a "CODE:ISSUER" key (the colon) stays quoted, so a
  // regenerated file needs no prettier pass to stay clean.
  const key = (id) => (/^[A-Za-z_$][\w$]*$/.test(id) ? id : JSON.stringify(id));
  const entries = Object.keys(map)
    .sort()
    .map((id) => `  ${key(id)}: ${JSON.stringify(map[id])},`)
    .join("\n");
  const banner =
    "// GENERATED by scripts/vendor-token-icons.mjs. Do not edit by hand.\n" +
    "//\n" +
    "// Canonical asset id (\"native\" | \"CODE:ISSUER\") -> filename under\n" +
    "// public/tokens, served from the extension origin via chrome.runtime.getURL.\n" +
    "// Only verified issuers from curated SEP-42 lists appear here, so a lookup\n" +
    "// miss is the correct, safe outcome for a spoofed or unknown asset.\n";
  writeFileSync(genFile, `${banner}export const TOKEN_ICONS: Record<string, string> = {\n${entries}\n};\n`);

  const files = new Set(Object.values(map)).size;
  console.log(
    `vendored ${Object.keys(map).length} id mappings (${testnetMatched} testnet) ` +
      `as ${files} unique files -> public/tokens`,
  );
  for (const id of Object.keys(map).sort()) console.log(`  ${id} -> ${map[id]}`);
}

if (!existsSync(dirname(genFile))) {
  throw new Error(`ui dir missing: ${dirname(genFile)}`);
}
await main();

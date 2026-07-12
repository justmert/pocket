#!/usr/bin/env bash
# The five release gates. Every one must pass before a release, and all five
# must be re-verified for EVERY release, not just the first.
#
# Each exists because getting it wrong produces a failure that looks like a
# protocol bug rather than a build mistake.
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0
note() { printf '\n=== %s ===\n' "$1"; }
ok()   { printf '  PASS  %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; fail=1; }

NARGO=${NARGO:-/tmp/nargo-beta11}
BB=${BB:-/tmp/bb-0.87.0}
UPSTREAM=resources/upstream/stellar-contracts
PINNED_VKS=extension/src/core/vk-hashes.json
CIRCUITS=$UPSTREAM/packages/tokens/src/confidential/circuits

note "Gate 1: toolchain pin"
# bb determines the proof and VK byte layout the on-chain verifier hardcodes.
# It is the binding constraint, not nargo.
if [ -x "$NARGO" ] && "$NARGO" --version 2>/dev/null | grep -q '1\.0\.0-beta\.11'; then
  ok "nargo 1.0.0-beta.11"
else
  bad "nargo is not 1.0.0-beta.11 (set NARGO=/path)"
fi
if [ -x "$BB" ] && "$BB" --version 2>/dev/null | grep -q '^v\?0\.87\.0$'; then
  ok "bb 0.87.0"
else
  bad "bb is not 0.87.0 (set BB=/path)"
fi

note "Gate 2: verification keys reproduce from circuit source"
# A VK not corresponding to the audited circuit verifies FORGED proofs, and
# nothing on chain can detect it. Reproducing them ourselves is the only way to
# know a deployment's keys are the audited ones.
#
# Reproduce, then hash. A size check is not enough: a VK from a different
# revision of the same circuit is the same 1760 bytes and would pass one. The
# measured sizes are keccak 1760 and poseidon2 1764, so size catches a wrong
# transcript only by accident, and the hash is what actually pins it.
VENDOR=extension/public/vendor/circuits
if [ -x "$BB" ] && [ -d "$VENDOR/target" ] && [ -f "$PINNED_VKS" ]; then
  bad_vk=0
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  for c in register withdraw transfer spender_transfer set_spender revoke_spender; do
    acir="$VENDOR/target/circuit_$c.json"
    [ -f "$acir" ] || { bad "$c: compiled circuit missing"; bad_vk=1; continue; }
    if ! "$BB" write_vk -b "$acir" -o "$tmp" --scheme ultra_honk --oracle_hash keccak \
         >/dev/null 2>&1; then
      bad "$c: bb write_vk failed"; bad_vk=1; continue
    fi
    got=$(shasum -a 256 "$tmp/vk" | cut -d' ' -f1)
    want=$(grep "\"$c\"" "$PINNED_VKS" | sed 's/.*: *"//; s/".*//')
    [ -n "$want" ] || { bad "$c: no pinned hash recorded"; bad_vk=1; continue; }
    if [ "$got" != "$want" ]; then
      bad "$c: VK hash $got does not match the pinned $want"; bad_vk=1; continue
    fi
    size=$(wc -c < "$tmp/vk" | tr -d ' ')
    [ "$size" = "1760" ] || { bad "$c: VK is $size bytes, expected 1760"; bad_vk=1; }
    # A vendored VK that disagrees with the reproduced one ships a key the
    # extension would check against and the chain would not.
    if [ -f "$VENDOR/vks/$c.vk.bin" ]; then
      have=$(shasum -a 256 "$VENDOR/vks/$c.vk.bin" | cut -d' ' -f1)
      [ "$have" = "$got" ] || { bad "$c: vendored VK differs from the reproduced one"; bad_vk=1; }
    fi
  done
  [ "$bad_vk" = "0" ] && ok "six VKs reproduced from circuit source and hash-matched"

  # An accidental --zk changes the proof length the on-chain verifier hardcodes.
  # Measured: 14592 without, 16224 with. The VK hash cannot catch this, and the
  # proof size cannot catch a wrong transcript, so both assertions are needed.
  if [ -f "$VENDOR/target/w_register.gz" ]; then
    if "$BB" prove -b "$VENDOR/target/circuit_register.json" -w "$VENDOR/target/w_register.gz" \
       -o "$tmp" --scheme ultra_honk --oracle_hash keccak >/dev/null 2>&1; then
      psize=$(wc -c < "$tmp/proof" | tr -d ' ')
      [ "$psize" = "14592" ] && ok "proof is 14592 bytes, the layout the verifier hardcodes" \
        || bad "proof is $psize bytes, expected 14592 (an accidental --zk gives 16224)"
    else
      bad "bb prove failed on register"
    fi
  else
    bad "register witness missing; run npm run vendor in extension/"
  fi
else
  [ -x "$BB" ] || bad "bb not found (set BB=/path); cannot reproduce verification keys"
  [ -d "$VENDOR/target" ] || bad "compiled circuits not vendored; run npm run vendor in extension/"
  [ -f "$PINNED_VKS" ] || bad "pinned VK hashes not found at $PINNED_VKS"
fi

note "Gate 3: deployment addresses resolve on chain"
# Testnet is wiped on resets, and confidential identities are per-deployment, so
# a stale address means every user silently re-registers.
for net in testnet; do
  f="resources/deployment-$net.json"
  if [ -f "$f" ]; then
    # EVERY id the record declares. This was `for key in token verifier auditor`
    # against a hardcoded count of three, so a wrapper added to
    # `confidentialAssets` was neither resolved nor counted, and the gate said
    # "all three contracts resolve" about a deployment that had four.
    ids=$(./scripts/deployment-ids.sh "$f")
    want=$(printf '%s\n' "$ids" | wc -l | tr -d ' ')
    live=0
    while read -r key id; do
      [ -n "$key" ] || continue
      if stellar contract info interface --id "$id" --network "$net" >/dev/null 2>&1; then
        live=$((live+1))
      else
        bad "$net $key ($id) does not resolve"
      fi
    done <<< "$ids"
    [ "$live" = "$want" ] && ok "$net: all $want contracts resolve"
  else
    printf '  SKIP  no %s deployment recorded\n' "$net"
  fi
done

note "Gate 4: the pinned verifier fork contains no Rust changes"
# The fork exists only to bump soroban-sdk 26 -> 27. Any .rs change would mean
# we are running verifier logic that upstream has not reviewed.
UP=resources/upstream/nethermind-rs-soroban-ultrahonk
FORK=resources/upstream/brozorec-rs-soroban-ultrahonk
if [ -d "$UP/.git" ] && [ -d "$FORK/.git" ]; then
  git -C "$FORK" remote add _upstream ../nethermind-rs-soroban-ultrahonk 2>/dev/null || true
  git -C "$FORK" fetch -q _upstream 2>/dev/null || true
  changed=$(git -C "$FORK" diff --name-only _upstream/main HEAD 2>/dev/null | grep -c '\.rs$' || true)
  if [ "${changed:-0}" = "0" ]; then
    ok "fork diff touches no .rs files"
  else
    bad "fork diff contains $changed .rs changes: review before shipping"
  fi
else
  printf '  SKIP  verifier repos not cloned\n'
fi

note "Gate 5: public-input slot counts match the circuit sources"
# DESIGN.md is authoritative for MEMBERSHIP; the circuit signature for the SLOT
# COUNT. This gate checks COUNTS, which is what it can check from a signature.
#
# Counting is not ordering, and the sharper risk is ordering: a permutation of
# two same-typed inputs is a well-formed vector that verifies a DIFFERENT
# statement. Nothing here catches that. What does is witness/parity.test.ts,
# which hands our built witnesses to the real circuits and rejects every
# permuted variant, so the gate is named for what it actually asserts.
if [ -d "$CIRCUITS" ]; then
  expected="register:6 withdraw:15 transfer:24 spender_transfer:24 set_spender:24 revoke_spender:19"
  bad_pi=0
  for pair in $expected; do
    c=${pair%%:*}; want=${pair##*:}
    got=$(sed -n '/^fn main(/,/^) {/p' "$CIRCUITS/$c/src/main.nr" | grep -c ': pub Field' || true)
    [ "$got" = "$want" ] || { bad "$c has $got public inputs, expected $want"; bad_pi=1; }
  done
  [ "$bad_pi" = "0" ] && ok "all six circuits match their recorded slot counts"
else
  bad "circuits not found"
fi

note "Gate 6: the shipping package is the one we think we are shipping"
# Gates 1 to 5 all inspect SOURCES. Nothing here looked at the .zip a user
# actually installs, which is where a stale version, a leaked source map or a
# dev endpoint would be. Build it and read it.
OUT=extension/.output/chrome-mv3
if (cd extension && npm run --silent build >/tmp/pocket-build.log 2>&1); then
  ok "extension builds"
else
  bad "extension build failed; see /tmp/pocket-build.log"
fi

if [ -f "$OUT/manifest.json" ]; then
  bad_pkg=0
  pkg_v=$(python3 -c "import json;print(json.load(open('extension/package.json'))['version'])")
  man_v=$(python3 -c "import json;print(json.load(open('$OUT/manifest.json'))['version'])")
  [ "$pkg_v" = "$man_v" ] || { bad "package.json is $pkg_v but the built manifest says $man_v"; bad_pkg=1; }

  # Chrome's rules, not ours: one to four dot-separated integers, each 0-65535,
  # no leading zeros, not all zero.
  # https://developer.chrome.com/docs/extensions/reference/manifest/version
  if ! python3 - "$man_v" <<'PY'
import re, sys
v = sys.argv[1]
parts = v.split(".")
ok = 1 <= len(parts) <= 4 and all(
    re.fullmatch(r"0|[1-9][0-9]*", p) and int(p) <= 65535 for p in parts
) and any(int(p) for p in parts)
sys.exit(0 if ok else 1)
PY
  then
    bad "version '$man_v' is not a version Chrome will accept"; bad_pkg=1
  fi

  # An upload whose version did not increase is not an update: Chrome only
  # replaces an installed extension when the published version string is NEWER.
  # A fix that never reaches an existing install is the worst kind of release,
  # because the release looks successful.
  last=$(git tag --list 'v*' --sort=-v:refname | head -1)
  if [ -n "$last" ]; then
    if python3 - "$man_v" "${last#v}" <<'PY'
import sys
key = lambda v: tuple(int(x) for x in v.split("."))
sys.exit(0 if key(sys.argv[1]) > key(sys.argv[2]) else 1)
PY
    then
      ok "version $man_v is newer than the last released $last"
    else
      bad "version $man_v is not newer than the last released $last: existing installs would not update"
      bad_pkg=1
    fi
  else
    printf '  SKIP  no v* tag yet, so there is no previous release to outrank\n'
  fi

  # A source map ships the unminified sources, every comment in them, and the
  # original file layout. Nothing in a wallet's bundle should be reconstructible
  # that cheaply, and it is a one-line build-config regression away.
  maps=$(find "$OUT" -name '*.map' | wc -l | tr -d ' ')
  # grep exits 1 on no match, which is the PASSING case here, so it must not
  # take the whole script down under `set -e`.
  refs=$({ grep -rIl 'sourceMappingURL' "$OUT" 2>/dev/null || true; } | wc -l | tr -d ' ')
  [ "$maps" = "0" ] && [ "$refs" = "0" ] || {
    bad "the package carries $maps source maps and $refs sourceMappingURL references"; bad_pkg=1; }

  # A dev endpoint that survives into a release points a wallet at a host the
  # manifest never declared, so it fails opaquely rather than loudly.
  if grep -rIl 'localhost\|127\.0\.0\.1\|0\.0\.0\.0' "$OUT" >/dev/null 2>&1; then
    bad "the package references a loopback address"; bad_pkg=1
  fi
  # An ENDPOINT, not any occurrence of the scheme. Three things legitimately
  # contain "http://" and none of them is ever fetched: XML/schema namespace
  # URIs, which are identifiers; and the content script's `http://*/*` match
  # pattern, which is a permission the dApp provider needs in order to be
  # injected into ordinary pages at all. Requiring a host character after the
  # slashes is what separates a real endpoint from those.
  if grep -rIoh 'http://[a-zA-Z0-9._-]\+' "$OUT" 2>/dev/null \
     | grep -v 'w3\.org\|json-schema\.org' | grep -q .; then
    bad "the package contains a plaintext http:// endpoint"; bad_pkg=1
  fi

  # MV3 bans remotely hosted code, and this build vendors bb.js, the SRS and the
  # circuits precisely so it can obey that. 'unsafe-eval' would undo it;
  # 'wasm-unsafe-eval' is the narrow exception the prover needs.
  csp=$(python3 -c "
import json
m = json.load(open('$OUT/manifest.json'))
print(m.get('content_security_policy', {}).get('extension_pages', ''))")
  [ -n "$csp" ] || { bad "the manifest declares no extension_pages CSP"; bad_pkg=1; }
  case "$csp" in
    *"'unsafe-eval'"*) bad "the CSP allows unsafe-eval"; bad_pkg=1 ;;
  esac
  case "$csp" in
    *http*) bad "the CSP names a remote origin: $csp"; bad_pkg=1 ;;
  esac

  # An extension with no icons cannot be submitted, and the icons key is
  # auto-discovered from public/icon/<size>.png rather than written by hand, so
  # a rename or a missing file breaks it silently at build time.
  icons=$(python3 -c "
import json
m = json.load(open('$OUT/manifest.json'))
for size, path in sorted(m.get('icons', {}).items(), key=lambda kv: int(kv[0])):
    print(f'{size} {path}')")
  if [ -z "$icons" ]; then
    bad "the manifest declares no icons; the Web Store will not accept it"; bad_pkg=1
  else
    # A here-string, not a pipe: `bad` has to run in THIS shell or it sets
    # `fail` in a subshell that exits a moment later, and the gate prints a
    # failure and then reports success.
    while read -r _size path; do
      [ -f "$OUT/$path" ] \
        || { bad "manifest icon $path is not in the package"; bad_pkg=1; }
    done <<< "$icons"
    for want in 16 48 128; do
      cut -d' ' -f1 <<< "$icons" | grep -qx "$want" \
        || { bad "no ${want}px icon; Chrome uses that size for the toolbar, management page and store"; bad_pkg=1; }
    done
  fi

  # A host permission nobody calls is a permission prompt paid for nothing, and
  # a reviewer reads it as a capability the wallet has.
  for host in $(python3 -c "
import json,urllib.parse
m=json.load(open('$OUT/manifest.json'))
for h in m.get('host_permissions',[]): print(urllib.parse.urlparse(h).netloc)
"); do
    grep -rIq "$host" "$OUT"/*.js "$OUT"/chunks/*.js 2>/dev/null \
      || { bad "host permission $host is declared but never used by the shipped code"; bad_pkg=1; }
  done

  # Confidential openings are stored under a key containing the TOKEN CONTRACT
  # ADDRESS. If the build points at a different deployment than the one gate 3
  # just resolved, every existing user's openings are silently orphaned, which
  # loses them their private balance permanently.
  #
  # EVERY id the record declares, which is the whole point given what the
  # paragraph above says it protects. Hardcoded to the three top-level fields,
  # this gate would have passed a bundle built against a stale USDC wrapper while
  # claiming it had checked "deployment ids", and the orphaned openings it exists
  # to prevent are per-token.
  if [ -f resources/deployment-testnet.json ]; then
    pkg_ids=$(./scripts/deployment-ids.sh resources/deployment-testnet.json)
    while read -r key id; do
      [ -n "$key" ] || continue
      grep -q "$id" "$OUT/background.js" \
        || { bad "$key $id is the recorded deployment but is not in the built bundle"; bad_pkg=1; }
    done <<< "$pkg_ids"
  fi

  [ "$bad_pkg" = "0" ] \
    && ok "version, source maps, endpoints, CSP, icons, permissions and deployment ids"
else
  bad "no built package to inspect at $OUT"
fi

note "Build and test"
# Failures print. A gate that says only "FAIL" is a gate people learn to skip.
#
# `npm run check` is tsc + eslint + vitest behind one exit code, and that exit
# code cannot tell a real pass from a run that quietly disabled part of itself.
# Run the three separately so the test step can be INSPECTED rather than
# trusted.
(cd extension && npx tsc --noEmit >/tmp/pocket-tsc.log 2>&1) && ok "extension: types" \
  || { bad "extension types"; sed -n '1,25p' /tmp/pocket-tsc.log | sed 's/^/        /'; }
# The tests tree is a separate project and was never typechecked by anything.
# It held 36 errors, including two error classes constructed with arguments they
# do not take, in a file whose whole job is asserting what those classes say.
(cd extension && npx tsc --noEmit -p tsconfig.tests.json >/tmp/pocket-tsc-tests.log 2>&1) \
  && ok "extension: types (tests)" \
  || { bad "extension test types"; sed -n '1,25p' /tmp/pocket-tsc-tests.log | sed 's/^/        /'; }
(cd extension && npx eslint src >/tmp/pocket-lint.log 2>&1) && ok "extension: lint" \
  || { bad "extension lint"; sed -n '1,25p' /tmp/pocket-lint.log | sed 's/^/        /'; }

VITEST_JSON=/tmp/pocket-vitest.json
rm -f "$VITEST_JSON"
# vitest prints the run first and the failures last, so the excerpt has to come
# off the TAIL. Printing the head shows forty green ticks and hides the reason.
(cd extension && npx vitest run --reporter=default --reporter=json --outputFile="$VITEST_JSON" \
   >/tmp/pocket-vitest.log 2>&1) && ok "extension: tests" \
  || { bad "extension tests"; { sed -n '/Failed Tests/,$p' /tmp/pocket-vitest.log | head -40 \
       || tail -40 /tmp/pocket-vitest.log; } | sed 's/^/        /'; }

# The suites under `tests/`, which `vitest.config.ts` does not include.
#
# They were run once each by the agent that wrote them and by nothing since. A
# commit that broke 88 of them passed a pre-commit run reporting 597 green,
# because the 88 were in a directory no configured run looked at. A test nobody
# runs is a file.
(cd extension && npx vitest run --config vitest.suites.config.ts \
   >/tmp/pocket-suites.log 2>&1) && ok "extension: tests (auth, failure, edge)" \
  || { bad "extension suite tests"; { sed -n '/Failed Tests/,$p' /tmp/pocket-suites.log | head -40 \
       || tail -40 /tmp/pocket-suites.log; } | sed 's/^/        /'; }

# A SKIPPED test is not a passing test, and vitest exits 0 with any number of
# them. Measured on a clean checkout: `vitest run src/core/witness/parity.test.ts`
# reports "24 skipped" and exits 0, because parity gates on a nargo binary in
# /tmp and on circuit sources under resources/, which is gitignored in its
# entirety and therefore cannot exist in a fresh clone. Six more in
# prover/protocol.test.ts go the same way.
#
# That is not an ordinary skipped test. Gate 5 above checks public-input
# COUNTS and says in its own comment that ORDERING is caught "not here" but by
# parity.test.ts, and a permutation of two same-typed inputs is a well-formed
# vector that proves a DIFFERENT statement. So on a machine without the
# toolchain the gate asserts a property that nothing checked, and says PASS.
if [ -f "$VITEST_JSON" ]; then
  skipped=$(python3 - "$VITEST_JSON" <<'PY' || true
import collections, json, sys
by = collections.Counter()
for r in json.load(open(sys.argv[1]))["testResults"]:
    for a in r["assertionResults"]:
        if a["status"] in ("pending", "skipped", "todo"):
            by[r["name"].split("/extension/")[-1]] += 1
for f, n in sorted(by.items()):
    print(f"{n} {f}")
PY
)
  if [ -n "$skipped" ]; then
    bad "tests disabled themselves; a skip is not a pass"
    printf '%s\n' "$skipped" | while read -r n f; do
      printf '        %s skipped in %s\n' "$n" "$f"
    done
    [ -x "$NARGO" ] || printf '        cause: no nargo at %s\n' "$NARGO"
    [ -d "$CIRCUITS" ] || printf '        cause: no circuit sources at %s\n' "$CIRCUITS"
  else
    ok "no test disabled itself"
  fi
else
  bad "vitest produced no machine-readable report, so skips cannot be ruled out"
fi
(cd indexer && npx tsc --noEmit >/tmp/pocket-indexer.log 2>&1 && npx vitest run --silent >>/tmp/pocket-indexer.log 2>&1) \
  && ok "indexer: types, tests" \
  || { bad "indexer checks"; sed -n '1,25p' /tmp/pocket-indexer.log | sed 's/^/        /'; }
(cd contracts && cargo fmt --check >/tmp/pocket-fmt.log 2>&1) && ok "contracts: formatting" \
  || { bad "contracts formatting"; sed -n '1,25p' /tmp/pocket-fmt.log | sed 's/^/        /'; }

note "Gate 7: the browser suite runs against the package that was just built"
# NO BROWSER TEST RAN ON ANY GATE. `npm run check`, and therefore the pre-commit
# hook, is tsc + tsc(tests) + eslint + two vitest configs; Playwright appears in
# neither. So every screen assertion in `tests/` had never blocked a commit or a
# release, and four shared locators had gone stale against a rebuilt UI without
# anything going red: each one timed out after 30 to 60 seconds and took every
# spec that called it, which was more than thirty of them.
#
# Here rather than in `npm run check`, because the expensive part is the build
# and Gate 6 has already done it. `POCKET_EXT_PATH` points the suite at that
# exact package instead of building a second one, which is also the stronger
# check: the browser tests then run against the artifact the other gates
# inspected, not against a fresh build that might differ.
if [ -f "$OUT/manifest.json" ]; then
  if (cd extension && POCKET_EXT_PATH="$(cd "$(dirname "$0")/.." && pwd)/$OUT" \
        npx playwright test -c playwright.tests.config.ts --reporter=line \
        >/tmp/pocket-playwright.log 2>&1); then
    ok "browser suite passes against the shipping package"
  else
    bad "browser suite failed against the shipping package"
    tail -n 30 /tmp/pocket-playwright.log | sed 's/^/        /'
  fi
else
  bad "no built package to run the browser suite against"
fi

printf '\n'
if [ "$fail" = "0" ]; then
  printf 'All release gates passed.\n'
else
  printf 'RELEASE BLOCKED: one or more gates failed.\n'
  exit 1
fi

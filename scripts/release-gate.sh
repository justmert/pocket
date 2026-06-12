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
    live=0
    for key in token verifier auditor; do
      id=$(python3 -c "import json,sys; print(json.load(open('$f'))['$key'])")
      if stellar contract info interface --id "$id" --network "$net" >/dev/null 2>&1; then
        live=$((live+1))
      else
        bad "$net $key ($id) does not resolve"
      fi
    done
    [ "$live" = "3" ] && ok "$net: all three contracts resolve"
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

note "Build and test"
(cd extension && npm run --silent check >/dev/null 2>&1) && ok "extension: types, lint, tests" || bad "extension checks"
(cd indexer && npx tsc --noEmit >/dev/null 2>&1 && npx vitest run --silent >/dev/null 2>&1) && ok "indexer: types, tests" || bad "indexer checks"
(cd contracts && cargo fmt --check >/dev/null 2>&1) && ok "contracts: formatting" || bad "contracts formatting"

printf '\n'
if [ "$fail" = "0" ]; then
  printf 'All release gates passed.\n'
else
  printf 'RELEASE BLOCKED: one or more gates failed.\n'
  exit 1
fi

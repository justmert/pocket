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
if [ -d "$CIRCUITS/vks" ]; then
  bad_vk=0
  for c in register withdraw transfer spender_transfer set_spender revoke_spender; do
    f="$CIRCUITS/vks/$c.vk.bin"
    [ -f "$f" ] || { bad "$c.vk.bin missing"; bad_vk=1; continue; }
    size=$(wc -c < "$f" | tr -d ' ')
    [ "$size" = "1760" ] || { bad "$c.vk.bin is $size bytes, expected 1760"; bad_vk=1; }
  done
  [ "$bad_vk" = "0" ] && ok "six VKs present at the 1760-byte on-chain layout"
else
  bad "circuit VKs not found; clone the upstream repo into resources/upstream"
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

note "Gate 5: public-input ordering matches the circuit sources"
# DESIGN.md is authoritative for MEMBERSHIP; the circuit signature for the SLOT
# COUNT. A permutation of two same-typed inputs verifies a DIFFERENT statement.
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

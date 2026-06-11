#!/usr/bin/env bash
# Infrastructure health. Run on a schedule.
#
# The verifier holds every verification key in INSTANCE storage and the library
# never extends it. If that entry archives, EVERY confidential operation on
# EVERY token pointing at it fails. It is a single point of failure for the
# whole deployment and it is ours because we deployed it.
#
# Testnet caps a fresh instance at min_persistent_ttl = 120,960 ledgers, about
# SEVEN DAYS. Our own deployment sat at exactly that until this script's check
# caught it. Mainnet's floor is 2,073,600 ledgers, about 120 days, so never
# calibrate this on testnet.
set -euo pipefail
cd "$(dirname "$0")/.."

NETWORK=${NETWORK:-testnet}
SOURCE=${SOURCE:-pocket-deploy}
EXTEND=${EXTEND:-500000}
WARN_DAYS=${WARN_DAYS:-30}
DEPLOYMENT="resources/deployment-$NETWORK.json"

[ -f "$DEPLOYMENT" ] || { echo "no deployment recorded for $NETWORK"; exit 1; }

latest=$(curl -s -X POST "$(python3 - <<PY
import json
print({"testnet":"https://soroban-testnet.stellar.org","mainnet":"https://mainnet.sorobanrpc.com"}["$NETWORK"])
PY
)" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['sequence'])")

# ~5s ledgers on both networks; close enough for a threshold check.
per_day=17280
fail=0

for key in token verifier auditor; do
  id=$(python3 -c "import json;print(json.load(open('$DEPLOYMENT'))['$key'])")
  ttl=$(stellar contract extend --id "$id" --source "$SOURCE" --network "$NETWORK" \
          --ledgers-to-extend 0 --durability persistent 2>&1 \
          | grep -oE '[0-9]+' | tail -1 || true)
  if [ -z "$ttl" ]; then
    echo "  UNKNOWN  $key ($id): could not read TTL"
    fail=1
    continue
  fi
  days=$(( (ttl - latest) / per_day ))
  if [ "$days" -lt "$WARN_DAYS" ]; then
    echo "  LOW      $key: $days days remaining, extending"
    stellar contract extend --id "$id" --source "$SOURCE" --network "$NETWORK" \
      --ledgers-to-extend "$EXTEND" --durability persistent >/dev/null 2>&1 \
      && echo "  EXTENDED $key" || { echo "  FAILED   $key extension"; fail=1; }
  else
    echo "  OK       $key: $days days remaining"
  fi
done

exit $fail

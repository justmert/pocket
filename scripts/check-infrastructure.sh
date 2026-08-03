#!/usr/bin/env bash
# Infrastructure health. Run on a schedule.
#
# The verifier holds every verification key in INSTANCE storage and the library
# never extends it, so nothing keeps that entry alive except this script.
#
# It used to say "if that entry archives, EVERY confidential operation on EVERY
# token pointing at it fails", and on protocol 27 that is no longer true:
# soroban-rpc auto-restores an archived persistent entry into the readWrite
# footprint rather than failing the transaction. Measured on this deployment,
# restoring an archived instance costs minResourceFee 606,654 stroops against
# 14,363 for a live one. So the real consequence is a 40x fee on the first
# operation after archival, paid by whichever user happens to be next, not a
# dead deployment. Still worth preventing, and worth stating correctly: a claim
# that overstates the stakes is one nobody can calibrate against.
#
# NOTHING SCHEDULES THIS. There is no CI workflow and no cron entry in the
# repo; it is run by hand. To schedule it, and the point of the file is that
# somebody should:
#
#   crontab -e
#   0 9 * * * cd /path/to/pocket && ./scripts/check-infrastructure.sh >> /tmp/pocket-infra.log 2>&1
#
# It needs the `pocket-deploy` key configured in the stellar CLI, so it runs
# where that key is, which is why it is not a CI job.
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

# EVERY id the record declares, not the three it happens to name at top level.
#
# This read used to be `for key in token verifier auditor`, which is the record's
# three top-level fields. When a second wrapper was deployed on 2026-08-07 it was
# added to `confidentialAssets` and this loop never saw it, so the entry that
# keeps private USDC spendable went unwatched: measured at 6.83 days remaining
# while the three ids this loop did watch sat at 22.09. The whole point of a
# scheduled check is that nobody is looking, so a check that silently covers a
# subset is worse than none.
#
# A here-string rather than a pipe, for the reason release-gate.sh records at its
# own icon loop: `fail` has to be set in THIS shell, and a `while` on the right of
# a pipe runs in a subshell that exits a moment later, so the script would print a
# failure and then exit 0.
IDS=$(./scripts/deployment-ids.sh "$DEPLOYMENT")
while read -r key id; do
  [ -n "$key" ] || continue
  # STDOUT only, and the whole line has to be one integer.
  #
  # This used to take the last integer out of stdout AND stderr combined, which
  # is a parse of whatever the CLI last happened to print: a warning carrying a
  # number, a retry count, an error mentioning a ledger, any of them would be
  # read as the TTL and compared against the threshold. The failure is silent
  # and it is in the direction of saying everything is fine.
  #
  # Diagnostics still reach the operator; they simply do not reach the parse.
  raw=$(stellar contract extend --id "$id" --source "$SOURCE" --network "$NETWORK" \
          --ledgers-to-extend 0 --durability persistent 2>/tmp/pocket-ttl-err || true)
  ttl=$(printf '%s\n' "$raw" | tr -d '[:space:]')
  if ! printf '%s' "$ttl" | grep -qE '^[0-9]+$'; then
    echo "  UNKNOWN  $key ($id): could not read TTL"
    sed 's/^/           /' /tmp/pocket-ttl-err 2>/dev/null | head -3
    fail=1
    continue
  fi
  # A TTL behind the chain's own head is an ARCHIVED entry, not a low one, and
  # the arithmetic below would report it as a large negative number of days.
  if [ "$ttl" -le "$latest" ]; then
    echo "  ARCHIVED $key ($id): liveUntil $ttl is behind ledger $latest, restoring"
    stellar contract restore --id "$id" --source "$SOURCE" --network "$NETWORK" \
      --durability persistent >/dev/null 2>&1 \
      && echo "  RESTORED $key" || { echo "  FAILED   $key restore"; fail=1; }
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
done <<< "$IDS"

exit $fail

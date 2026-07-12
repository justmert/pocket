#!/usr/bin/env bash
# Every contract id a deployment record declares, as "label id" lines.
#
# This exists because three separate loops asked the same question and all three
# answered it with a hardcoded `for key in token verifier auditor`, which reads
# the record's three TOP-LEVEL fields and nothing else. On 2026-08-07 the record
# gained a `confidentialAssets` array carrying a second wrapper (USDC), and none
# of the three noticed:
#
#   check-infrastructure.sh  never checked the new wrapper's TTL, so the entry
#                            that keeps private USDC spendable was unmonitored
#                            while it sat at 6.8 days against the 22 the three
#                            watched ids had.
#   release-gate.sh gate 3   never checked the new wrapper resolves on chain.
#   release-gate.sh gate 6   never checked the new wrapper's id is in the built
#                            bundle, though its own comment states the cost:
#                            "every existing user's openings are silently
#                            orphaned, which loses them their private balance
#                            permanently".
#
# So the set is DERIVED from the record rather than restated next to it. A
# wrapper added to `confidentialAssets` is covered by all three the day it lands,
# which is the property the hardcoded list could not have.
#
# Ids are deduplicated, because the verifier and the auditor are shared across
# wrappers and extending one entry three times is three times the fee for one
# effect. The first label wins, so a shared contract reads as "verifier" rather
# than "verifier-XLM".
set -euo pipefail

[ $# -eq 1 ] || { echo "usage: deployment-ids.sh <deployment.json>" >&2; exit 2; }

python3 - "$1" <<'PY'
import json, sys

with open(sys.argv[1]) as fh:
    record = json.load(fh)

# id -> label, insertion-ordered, so the top-level names take precedence over the
# per-asset ones for the contracts that appear in both.
seen: dict[str, str] = {}

for key in ("token", "verifier", "auditor"):
    if record.get(key):
        seen.setdefault(record[key], key)

for asset in record.get("confidentialAssets", []):
    symbol = asset.get("symbol") or "?"
    for key in ("token", "verifier", "auditor"):
        if asset.get(key):
            seen.setdefault(asset[key], f"{key}-{symbol}")

if not seen:
    sys.exit("deployment record declares no contract ids")

for contract_id, label in seen.items():
    print(label, contract_id)
PY

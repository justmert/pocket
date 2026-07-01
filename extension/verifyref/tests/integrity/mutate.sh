#!/usr/bin/env bash
# Build a deliberately broken wallet, WITHOUT touching the shared source tree.
#
# Rule 2 of the pass: every test must be shown failing before it passes. Nine
# other agents build from `extension/src` at the same moment, so the mutation
# goes into a copy named by POCKET_T10_SRC and the broken build lands in
# `.output-t10-mut`, which nothing else reads. There is no restore step, which
# is the point: nothing was broken to begin with.
#
#   ./tests/integrity/mutate.sh 'core/controller.ts' 'FROM' 'TO'
#
# Run from extension/. The substitution is verified to have APPLIED, before and
# after: a mutation that silently matches nothing produces a green run that
# looks like proof and is not, and one of these did exactly that on its first
# attempt.
set -euo pipefail

FILE="${1:?usage: mutate.sh <path under src> <from> <to>}"
FROM="${2:?}"
TO="${3:?}"
SRC="src-t10-mut"

rm -rf "$SRC"
cp -R src "$SRC"

python3 - "$SRC/$FILE" "$FROM" "$TO" <<'PY'
import sys, pathlib
path, old, new = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
s = path.read_text()
n = s.count(old)
if n == 0:
    sys.exit(f"MUTATION DID NOT APPLY: no match in {path}")
out = s.replace(old, new)
# Not "no occurrences remain": a mutation that INSERTS a line next to the one
# it matched legitimately keeps the original text. What must be true is that
# the file changed and the replacement is in it.
if out == s or new not in out:
    sys.exit(f"MUTATION ONLY PARTIALLY APPLIED in {path}")
path.write_text(out)
print(f"mutated {path}: {n} occurrence(s)")
PY

POCKET_T10_SRC="$SRC" POCKET_T10_OUT=.output-t10-mut npx wxt build --config wxt.t10.config.ts >/dev/null
rm -rf "$SRC"
echo "built -> .output-t10-mut/chrome-mv3"

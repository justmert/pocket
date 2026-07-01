#!/usr/bin/env bash
# Build a PREVIOUS commit's extension, without touching the shared source tree.
#
# The migration specs need an install made by an older version of this wallet,
# and the only honest way to get one is to run that version. `git archive` a
# commit's `extension/src` into a scratch directory, point wxt at it with
# POCKET_T10_SRC, and send the output somewhere nothing else reads. src/ is
# never modified, so nine other agents building from this checkout at the same
# time see nothing.
#
#   ./tests/integrity/build-old.sh 7076c5a .output-t10-old
#
# Run from extension/.
set -euo pipefail

COMMIT="${1:?usage: build-old.sh <commit> <outdir>}"
OUT="${2:?usage: build-old.sh <commit> <outdir>}"
SRC="src-t10-old-${COMMIT}"

rm -rf "$SRC"
mkdir -p "$SRC"
(cd .. && git archive "$COMMIT" -- extension/src) | tar -x --strip-components=2 -C "$SRC"

POCKET_T10_SRC="$SRC" POCKET_T10_OUT="$OUT" npx wxt build --config wxt.t10.config.ts

rm -rf "$SRC"
echo "built $COMMIT -> $OUT/chrome-mv3"

#!/bin/bash
# Pocket dev: server + wallet window. Leave this window open; closing it stops both.
#
# Two things here are not optional and both cost hours to find:
#
#  1. The browser is Chrome for Testing, not Chrome. Real Chrome 150 accepts
#     --load-extension, starts, and loads nothing at all.
#  2. The popup is opened through the debugging protocol, not as a startup URL.
#     popup.html is not in web_accessible_resources (only injected.js is, on
#     purpose), and Chromium blocks direct navigation to it: "This page has been
#     blocked by Chromium". Loaded fine, just unreachable that way.
set -e
cd "$(dirname "$0")"
EXT="$PWD/.output/chrome-mv3-dev"
APP="/Users/mert/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app"
PORT=9333

pkill -f "pocket-cft-profile" 2>/dev/null || true

npm run dev &
DEV=$!
trap 'kill $DEV 2>/dev/null; pkill -f pocket-cft-profile 2>/dev/null' EXIT

echo "waiting for the first build..."
until [ -f "$EXT/manifest.json" ] && curl -s -o /dev/null --max-time 1 http://localhost:3000; do sleep 1; done
sleep 2

open -na "$APP" --args --user-data-dir=/tmp/pocket-cft-profile \
  --load-extension="$EXT" --disable-extensions-except="$EXT" \
  --no-first-run --no-default-browser-check \
  --remote-debugging-port=$PORT --new-window "about:blank"

until curl -s "http://localhost:$PORT/json/version" >/dev/null 2>&1; do sleep 1; done
sleep 2
ID=$(curl -s "http://localhost:$PORT/json" | python3 -c "
import sys,json,re
known={'nkeimhogjdpnpccoofpliimaahmaaome','admccjkmockfdflocgggjfgdacdodkdf','mhjfbmdgcfjbbpaeojofohoefgiehjai'}
for t in json.load(sys.stdin):
    m=re.match(r'chrome-extension://([a-p]{32})/', t.get('url',''))
    if m and m.group(1) not in known: print(m.group(1)); break")

if [ -z "$ID" ]; then echo "the extension did not load"; wait $DEV; fi
echo "wallet: $ID"
curl -s -X PUT "http://localhost:$PORT/json/new?chrome-extension://$ID/popup.html" >/dev/null
echo "open. save a file and it reloads."
wait $DEV

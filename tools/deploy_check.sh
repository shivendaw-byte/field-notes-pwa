#!/usr/bin/env bash
# Usage: tools/deploy_check.sh 9.4   -> waits until both production sites serve that version.
want="$1"
sites="https://field-notes-two-blond.vercel.app https://field-notes-pwa-gules.vercel.app"
ver() { curl -s "$1/app.js?cb=$RANDOM$RANDOM" | grep -o 'APP_VERSION = "[0-9.]*"' | grep -o '[0-9.]*'; }
for i in $(seq 1 45); do
  ok=1
  for u in $sites; do [ "$(ver $u)" = "$want" ] && [ "$(ver $u)" = "$want" ] || ok=0; done
  [ $ok = 1 ] && break
  sleep 4
done
ok=1
for u in $sites; do
  v=$(ver $u); [ "$v" = "$want" ] || ok=0
  echo "$u app=$v sw=$(curl -s "$u/sw.js?cb=$RANDOM" | grep -o "field-notes-v[0-9]*" | head -1) page=$(curl -s -o /dev/null -w '%{http_code}' "$u/") tests=$(curl -s -o /dev/null -w '%{http_code}' "$u/tests/tests.js")"
done
[ $ok = 1 ] && echo "DEPLOY_OK $want" || echo "DEPLOY_NOT_CONFIRMED $want"

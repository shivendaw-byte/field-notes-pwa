#!/usr/bin/env bash
# Usage: tools/deploy_check.sh 9.4   -> waits until both production sites serve that version.
want="$1"; ok=0
for i in $(seq 1 40); do
  ok=1
  for u in https://field-notes-two-blond.vercel.app https://field-notes-pwa-gules.vercel.app; do
    v=$(curl -s "$u/app.js?cb=$RANDOM" | grep -o 'APP_VERSION = "[0-9.]*"' | grep -o '[0-9.]*')
    [ "$v" = "$want" ] || ok=0
  done
  [ $ok = 1 ] && break
  sleep 4
done
for u in https://field-notes-two-blond.vercel.app https://field-notes-pwa-gules.vercel.app; do
  echo "$u app=$(curl -s "$u/app.js?cb=$RANDOM" | grep -o 'APP_VERSION = "[0-9.]*"') sw=$(curl -s "$u/sw.js?cb=$RANDOM" | grep -o "field-notes-v[0-9]*" | head -1) tests=$(curl -s -o /dev/null -w '%{http_code}' "$u/tests/run.html") page=$(curl -s -o /dev/null -w '%{http_code}' "$u/")"
done
[ $ok = 1 ] && echo "DEPLOY_OK $want" || echo "DEPLOY_NOT_CONFIRMED $want"

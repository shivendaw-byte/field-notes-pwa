#!/usr/bin/env bash
# Real round trip against the live sync endpoint (and so against real Upstash).
# Usage: tools/sync_smoke.sh https://your-site.vercel.app
# Writes one throwaway record under a random id, reads it back, checks that a
# stale write is refused, then deletes it. Sends no contact data.
site="${1:?usage: sync_smoke.sh https://site}"
id=$(python -c "import uuid; print(uuid.uuid4())")
say() { printf '%-34s %s\n' "$1" "$2"; }
code=$(curl -s -o /tmp/fn_s.json -w '%{http_code}' "$site/api/sync?id=$id")
if [ "$code" = "501" ]; then echo "NOT CONFIGURED: $site has no Upstash store. $(cat /tmp/fn_s.json)"; exit 2; fi
say "read before write (want 404)" "$code"
w1=$(curl -s -X PUT "$site/api/sync" -H 'Content-Type: application/json' -d "{\"id\":\"$id\",\"blob\":\"smoke-test-1\",\"baseRev\":0}")
say "first write (want rev 1)" "$w1"
say "read back (want smoke-test-1)" "$(curl -s "$site/api/sync?id=$id")"
say "stale write (want 409)" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$site/api/sync" -H 'Content-Type: application/json' -d "{\"id\":\"$id\",\"blob\":\"stale\",\"baseRev\":0}")"
say "second write (want rev 2)" "$(curl -s -X PUT "$site/api/sync" -H 'Content-Type: application/json' -d "{\"id\":\"$id\",\"blob\":\"smoke-test-2\",\"baseRev\":1}")"
say "delete (want ok)" "$(curl -s -X DELETE "$site/api/sync?id=$id")"
say "read after delete (want 404)" "$(curl -s -o /dev/null -w '%{http_code}' "$site/api/sync?id=$id")"

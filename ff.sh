#!/usr/bin/env bash
# ff.sh <action> [json-params]  — send a command to the bridge, print the result.
#   bash ff.sh ping
#   bash ff.sh navigate '{"url":"https://example.com"}'
#   bash ff.sh screenshot
#   bash ff.sh read_page
BRIDGE="${BRIDGE:-http://localhost:8765}"
action="$1"
params="${2:-{}}"

resp=$(curl -s "$BRIDGE/command" -H 'content-type: application/json' \
  -d "{\"action\":\"$action\",\"params\":$params}")
id=$(printf '%s' "$resp" | perl -ne 'print $1 if /"id"\s*:\s*(\d+)/')
if [ -z "$id" ]; then echo "ERROR: bridge did not accept command: $resp"; exit 1; fi

# Poll for the result (up to ~75s — first page loads on a fat profile are slow).
for i in $(seq 1 375); do
  r=$(curl -s "$BRIDGE/result/$id")
  case "$r" in
    *'"done":true'*) printf '%s\n' "$r"; exit 0;;
  esac
  perl -e 'select(undef,undef,undef,0.2)'
done
echo "TIMEOUT waiting for result (id=$id)"
exit 1

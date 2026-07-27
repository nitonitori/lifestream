#!/usr/bin/env bash
# Minimal fake `claude`: reads stdin lines and appends each as a user record
# to <home>/projects/<proj>/<session-id>.jsonl. Used by integration tests to
# verify the tmux send-keys -> transcript loop without a real claude.
home=""; proj=""; id=""
while [ $# -gt 0 ]; do
  case "$1" in
    --home) home="$2"; shift 2;;
    --proj) proj="$2"; shift 2;;
    --session-id) id="$2"; shift 2;;
    *) shift;;
  esac
done
mkdir -p "$home/projects/$proj"
f="$home/projects/$proj/$id.jsonl"
while IFS= read -r line; do
  enc=$(printf '%s' "$line" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
  printf '{"type":"user","uuid":"%s","message":{"role":"user","content":%s}}\n' "$RANDOM$RANDOM" "$enc" >> "$f"
done

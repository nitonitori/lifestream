#!/usr/bin/env bash
# Minimal fake `claude -p --output-format json` for the messenger agent.
# Echoes the prompt back inside a result envelope after a delay, so tests can
# assert the IM ack is sent while the agent turn is still running.
text=""
while [ $# -gt 0 ]; do
  case "$1" in
    -p) text="$2"; shift 2;;
    *) shift;;
  esac
done
sleep "${FAKE_CLAUDE_DELAY:-0.4}"
python3 -c 'import json,sys; print(json.dumps([{"type":"result","result":"echo:"+sys.argv[1]}]))' "$text"

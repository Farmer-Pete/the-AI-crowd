#!/bin/sh
# Forwards one Claude Code hook event (JSON on stdin) to The AI Crowd on this machine.
# It never blocks Claude and never fails: if the dashboard isn't running, curl gives up quietly.
# The cmux ids let the dashboard jump straight to this session's pane.
curl --silent --max-time 2 --request POST \
  --header 'content-type: application/json' \
  --header "x-cmux-surface: ${CMUX_SURFACE_ID:-}" \
  --header "x-cmux-workspace: ${CMUX_WORKSPACE_ID:-}" \
  --data-binary @- \
  "http://127.0.0.1:${AI_CROWD_PORT:-4747}/api/hook" >/dev/null 2>&1
exit 0

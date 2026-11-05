#!/usr/bin/env bash
# Stand-in for the claude CLI (VARIUS_CLAUDE_BIN). FAKE_CLAUDE picks the
# behavior; each mode reproduces a failure the runner has to survive.
RESULT='{"type":"result","result":"hi","session_id":"s1","total_cost_usd":0.01,"duration_ms":5,"num_turns":1}'
echo '{"type":"system","subtype":"init"}'
case "${FAKE_CLAUDE:-ok}" in
  ok) echo "$RESULT" ;;
  # The real CLI (or a tool subprocess holding stdout) can outlive a finished
  # run by an hour: result first, then keep the pipe open with an orphan.
  orphan) sleep 30 & echo $! > "$FAKE_PIDFILE"; echo "$RESULT"; sleep 30 ;;
  hang) sleep 30 ;;
  error) echo '{"type":"result","result":"boom","session_id":"s1","total_cost_usd":0,"duration_ms":1,"num_turns":1,"is_error":true}' ;;
  split) printf '%s' "${RESULT:0:40}"; sleep 0.3; printf '%s\n' "${RESULT:40}" ;;
  nonl) printf '%s' "$RESULT" ;;
  noresult) echo 'auth failed' >&2; exit 3 ;;
esac

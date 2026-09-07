#!/usr/bin/env bash
# Restart the bridge when its Socket Mode connection zombifies — the client
# logs "pong wasn't received" every ~13s forever without reconnecting, so the
# unit stays green while every Slack message is silently eaten. Runs as root
# from fleet-watchdog.timer every 5 minutes.
set -euo pipefail

UNIT=fleet-bridge
THRESHOLD=4          # pong warnings inside the window before we act
WINDOW="5 min ago"

# Scope the log search to the *current* invocation so warnings from a process
# we already restarted can't trigger a second, pointless restart.
inv=$(systemctl show -p InvocationID --value "$UNIT")

count=0
if [[ -n "$inv" ]]; then
  count=$(journalctl "_SYSTEMD_INVOCATION_ID=$inv" --since "$WINDOW" -q --no-pager 2>/dev/null |
    grep -c "pong wasn't received" || true)
fi

if ! systemctl is-active --quiet "$UNIT"; then
  reason="unit inactive"
elif (( count >= THRESHOLD )); then
  reason="$count pong timeouts in 5m"
else
  exit 0
fi

echo "watchdog: restarting $UNIT ($reason)"
systemctl restart "$UNIT"

# One-liner to #ops; detail stays in journalctl (architecture.md §9).
source /srv/fleet/.env 2>/dev/null || true
if [[ -n "${SLACK_BOT_TOKEN:-}" && -n "${OPS_CHANNEL:-}" ]]; then
  curl -sS -m 10 -X POST https://slack.com/api/chat.postMessage \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
    -H "Content-type: application/json" \
    -d "{\"channel\":\"$OPS_CHANNEL\",\"text\":\":rotating_light: watchdog restarted \`$UNIT\` ($reason) — detail in \`journalctl -u $UNIT\`\"}" \
    >/dev/null || true
fi

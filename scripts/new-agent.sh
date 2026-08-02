#!/usr/bin/env bash
# Scaffold a new agent folder from the committed example.
set -euo pipefail

id="${1:?usage: new-agent.sh <id>   (lowercase, hyphens, no underscores)}"
[[ "$id" =~ ^[a-z][a-z0-9-]*$ ]] || { echo "id must be lowercase-hyphen: $id" >&2; exit 1; }

root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/agents/_examples/news"
dest="$root/agents/$id"
[[ -e "$dest" ]] && { echo "agents/$id already exists" >&2; exit 1; }

cp -R "$src" "$dest"
# Stamp the id; name/channel/model/tools must be edited by hand.
tmp="$(mktemp)"
sed "s/\"id\": \"news\"/\"id\": \"$id\"/" "$dest/agent.json" >"$tmp" && mv "$tmp" "$dest/agent.json"

cat <<EOF
Scaffolded agents/$id. Now:
  1. Edit agents/$id/agent.json — name, channel ID (create #ag-$id, invite the bot), model, allowedTools, schedule
  2. Rewrite agents/$id/CLAUDE.md for its role
  3. If scheduled: edit prompts/daily.md, then run scripts/sync-units.sh on the VPS
Convention: folder = id = #ag-$id = fleet-agent@$id (architecture.md §5).
EOF

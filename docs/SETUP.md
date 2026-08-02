# SETUP.md

Manual, once-per-box steps (architecture.md §12). Everything else is in the
repo.

## 1. VPS

- [ ] Provision the box; create a non-root `fleet` user (never run as root)
- [ ] SSH key auth only, password auth off, UFW default-deny inbound
      (Socket Mode needs no open ports)
- [ ] Install Node 20 and `jq`
- [ ] `npm install -g @anthropic-ai/claude-code`
- [ ] Clone this repo to `/srv/fleet`, `npm install`

## 2. Claude auth

- [ ] As `fleet`, run `claude setup-token` interactively → token into `.env`
- [ ] `cp .env.example .env && chmod 600 .env` (owned by `fleet`)
- [ ] Verify: `claude -p "say hi"` returns as `fleet`  ← slice 1 done
- [ ] Note the installed version and re-check flag casing against
      `claude --help` (`--allowedTools`, `--resume`, `--output-format`)

## 3. Slack app

- [ ] Create the app; enable **Socket Mode**
- [ ] App-level token (`xapp-`) with scope `connections:write` → `.env`
- [ ] Bot token (`xoxb-`) → `.env`; bot scopes: `chat:write`,
      `channels:history`, `groups:history`, `app_mentions:read`
- [ ] Event subscriptions: `message.channels` **and** `message.groups`
      (private channels are invisible without the second)
- [ ] Create `#ag-<id>` channels plus `#ag-ops`; invite the bot to each;
      put the ops channel ID in `.env` as `OPS_CHANNEL`

## 4. systemd

- [ ] `sudo cp deploy/fleet-bridge.service deploy/fleet-agent@.service deploy/fleet-agent@.timer /etc/systemd/system/`
- [ ] `scripts/sync-units.sh` — generates per-agent timer drop-ins from
      manifests and enables the timers
- [ ] `sudo systemctl enable --now fleet-bridge` (slice 5; skip until then)

## 5. Coding agent (slice 6)

- [ ] `gh auth login` as `fleet`
- [ ] Repo checkout under `agents/projx/repo/` (gitignored)

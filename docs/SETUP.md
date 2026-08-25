# SETUP.md

Manual, once-per-box steps (architecture.md §12). Everything else is in the
repo. Executed 2026-08-25 on the real box; ordering notes below are from that
run.

The box: netcup VPS 500 G12 (2 vCPU / 4 GB / 128 GB NVMe, US-East), Ubuntu
24.04 LTS minimal. netcup's installer only offers European timezones — fix
the timezone *first*, before anything else: systemd `OnCalendar` uses system
time, so a Berlin clock fires the 07:00 digest at 01:00 local.

## 1. VPS

- [x] Provision the box; `fleet` user with sudo (never run as root)
- [x] `timedatectl set-timezone America/New_York` — FIRST (see above)
- [x] `apt update && apt upgrade -y && apt install -y ufw git jq tmux`
- [x] SSH keys before hardening, in this order: `ssh-copy-id` to the box,
      verify a fresh key login works, only then set
      `PasswordAuthentication no` + `PermitRootLogin no` and restart ssh.
      Locking yourself out means netcup's VNC console. Rotate the emailed
      root password (`chpasswd`) — it only matters via VNC now
- [x] UFW: default-deny inbound, allow OpenSSH only
      (Socket Mode needs no open ports)
- [x] 2G swapfile + fstab entry — insurance against OOM during agent builds
- [x] Node 20 **system-wide** via nodesource (`/usr/bin/node`). No nvm: it
      lives in shell init, which systemd services never source
- [x] As `fleet`: `npm config set prefix ~/.npm-global`, PATH export in
      `.bashrc`, then `npm install -g @anthropic-ai/claude-code`
- [x] `sudo ln -sf ~fleet/.npm-global/bin/claude /usr/local/bin/claude` —
      systemd's default PATH won't find the npm prefix; without this the
      timer units die with `claude: command not found`

## 2. Claude auth

- [x] As `fleet`, run `claude setup-token` → prints a URL (headless);
      complete it in the laptop browser, paste the code back
- [x] Token into `/srv/fleet/.env` as `CLAUDE_CODE_OAUTH_TOKEN`
      (chmod 600, owned by `fleet`) — systemd reads it via `EnvironmentFile=`
- [x] Verify: `claude -p "say hi"` returns as `fleet`  ← slice 1 done
- [x] Note the installed version and re-check flag casing against
      `claude --help` (`--allowedTools`, `--resume`, `--output-format`)

## 3. Deploy the code

The repo is private and the box has no GitHub credential until slice 6, so
the box can't clone. Push to it instead:

- [x] `git init -b main /srv/fleet` +
      `git -C /srv/fleet config receive.denyCurrentBranch updateInstead`
- [x] Laptop: `git remote add vps fleet@<ip>:/srv/fleet` — from then on
      **`git push vps main` is a deploy** (the working tree updates on push)
- [x] `npm ci` in `/srv/fleet`
- [x] Copy the gitignored pieces by hand: Slack lines appended to `.env`,
      and the `agents/*` folders (tar over ssh; the minimal image has no
      rsync). Skip `threads.json` — session ids don't transfer across boxes

## 4. Slack app

- [x] Create the app from `deploy/slack-manifest.yaml`; enable **Socket Mode**
- [x] App-level token (`xapp-`) with scope `connections:write` → `.env`
- [x] Bot token (`xoxb-`) → `.env`; bot scopes: `chat:write`,
      `channels:history`, `groups:history`, `app_mentions:read`
- [x] Event subscriptions: `message.channels` **and** `message.groups`
      (private channels are invisible without the second)
- [x] Create `#<id>` channels plus `#ops`; invite the bot to each;
      put the ops channel ID in `.env` as `OPS_CHANNEL`

## 5. systemd

- [x] `sudo cp deploy/fleet-bridge.service deploy/fleet-agent@.service deploy/fleet-agent@.timer /etc/systemd/system/`
- [x] `scripts/sync-units.sh` — generates per-agent timer drop-ins from
      manifests and enables the timers
- [x] Fire the service once by hand — `sudo systemctl start
      fleet-agent@news.service` — to validate the *systemd* environment
      today instead of debugging a silent failure at 07:00
- [x] `sudo systemctl enable --now fleet-bridge` — after this, never run
      `npm run bridge` on a laptop too: two bridges answer every message

## 6. Coding agent (slice 6)

- [x] Install `gh` (official apt repo; not in the minimal image), then
      `gh auth login --web` as `fleet` + `gh auth setup-git`
- [x] Linear/Notion MCP OAuth as `fleet`: the callback server listens on
      the *box*, so tunnel it —
      `ssh -t -L 3118:localhost:3118 fleet@<ip> 'cd /srv/fleet/agents/projx && claude'`
      then `/mcp` → authenticate. Retry with the port claude prints if it
      differs
- [x] Repo checkouts under `agents/projx/repos/<name>/` (gitignored),
      cloned on demand via the account-wide `gh` auth

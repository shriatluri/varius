# varius

**Your agents, your context, 24/7.**

A personal fleet of Claude Code agents on a single VPS. Each agent is a folder
with its own instructions, tools, and Slack channel. Scheduled agents push
digests while you sleep; interactive agents answer when you message their
channel.

## The problem

Chat assistants forget everything between sessions, only run while you're at
the keyboard, and cram every job into one context. varius gives each job its
own agent with durable, scoped context — running around the clock on a box you
own. No platform, no database, no dashboard: a few hundred lines of TypeScript
and systemd.

## How it works

```
Slack message ──▶ ┌────────┐
 (Socket Mode)    │ runner │ ──▶ claude -p ──▶ posts to Slack
systemd timer ──▶ └────────┘     (cwd = agent folder)
```

- **An agent is a folder, not code.** Adding one never means touching `src/`.
- **One runner, two triggers.** Timers post fresh top-level digests; Slack
  replies resume their thread's session (`threads.json` maps
  `thread_ts → session_id`).
- **Memory is deliberate.** Agents write durable notes (`NOTES.md`,
  `PROGRESS.md`) at full fidelity before finishing — transcripts are never
  summarized.
- **Context is a budget.** Tools and MCP servers are allowlisted per agent in
  its manifest.

## Anatomy of an agent

```
agents/news/
├── agent.json     # channel, model, allowedTools, maxTurns, schedule
├── CLAUDE.md      # persona and standing rules
├── prompts/       # scheduled prompt(s)
├── .mcp.json      # MCP servers scoped to this agent (optional)
└── NOTES.md       # durable knowledge (optional)
```

See `agents/_examples/news/` for a complete reference agent.

## Run it locally

```bash
git clone https://github.com/shriatluri/varius.git && cd varius
npm install
cp .env.example .env        # Slack bot + app tokens, Claude OAuth token
scripts/new-agent.sh mybot  # scaffold; then set its Slack channel ID in agent.json
npm run post -- mybot "hello"   # bot posts to the channel
npm run agent -- mybot          # run the scheduled prompt once
npm run bridge                  # answer Slack messages in-thread
```

Slack app setup (Socket Mode, scopes, channels) is in `docs/SETUP.md` §3 —
`deploy/slack-manifest.yaml` creates the app in one paste.

## Run it 24/7

On a VPS, follow `docs/SETUP.md`: create a `fleet` user, authenticate with
`claude setup-token`, install the systemd units, then:

```bash
scripts/sync-units.sh                      # timer drop-ins from agent manifests
sudo systemctl enable --now fleet-bridge   # interactive agents
```

Each agent fires on its manifest's `onCalendar`; every run appends to
`runs.jsonl` (`scripts/rollup.sh` for a weekly cost summary). Failures post a
one-liner to the agent's channel and `#ag-ops`.

## Docs

- [`architecture.md`](architecture.md) — design, invariants, context strategy
- [`docs/SETUP.md`](docs/SETUP.md) — once-per-box setup checklist

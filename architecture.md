# architecture.md

Root architecture reference for this repo. Read this before changing anything.

---

## 1. What this is

A personal fleet of Claude Code agents on a single VPS. Each agent is a folder
with its own instructions, MCP servers, and Slack channel. Some run on a
schedule and push digests; some answer when you message their channel.

Single operator. Single box. No multi-tenancy.

---

## 2. Invariants

These are the load-bearing decisions. Changing one is a design discussion, not
a refactor.

1. **An agent is a folder, not code.** Adding an agent means creating a
   directory with a manifest. It never means editing `src/`. If a feature
   requires special-casing an agent by name in the runtime, the design is wrong
   — push it into the manifest instead.
2. **One runner, two triggers.** Scheduled runs and Slack replies execute
   through the same code path. The wake-up and the session strategy differ
   (fresh vs. resumed — see §6); everything else is shared.
3. **Sessions are disposable. Notes are deliberate.** Continuity inside a
   thread comes from `--resume` via the thread map (§6). Durable knowledge is
   written explicitly
   while the agent still has full fidelity — never reconstructed later by
   summarizing a transcript. See §7.
4. **The channel is the conversation.** One Slack channel maps to exactly one
   agent.
5. **Context window is a budget.** Tools *and* MCP servers are allowlisted per
   agent. An agent that doesn't need Notion doesn't load Notion.
6. **No database until something forces one.** Flat files until concurrency or
   query complexity actually breaks them. See §8.

---

## 3. Architecture

```
                    ┌────────────────────────┐
  Slack message ───▶│                        │
  (Socket Mode)     │        runner          │──▶ claude -p  ──▶ Slack
                    │  resolve → spawn →     │    (cwd = agent dir)
  systemd timer ───▶│  parse → post → log    │
                    └───────────┬────────────┘
                                │
                          runs.jsonl
```

**Inbound flow**
1. Bolt receives a message event over Socket Mode.
2. Resolve `channel_id → agent` from the in-memory registry. Unknown channel →
   ignore silently.
3. Load `agent.json`, take a `flock` on the agent directory.
4. Look up `thread_ts` in the agent's `threads.json`. Hit → spawn
   `claude -p --resume <session_id>`; miss (new thread, or a stored id that no
   longer resolves) → fresh session, then record the returned `session_id`
   under that `thread_ts`. `cwd` = the agent folder either way.
5. Parse JSON result, post as a **threaded reply**, append a run record.

**Scheduled flow**
Same path, three differences: the prompt is read from the agent's `prompts/`
file, the result is posted as a **new top-level message**, and the session is
**always fresh** — never resumed. Durable knowledge crosses scheduled runs via
`NOTES.md` (§7), not via an ever-growing session.

---

## 4. Layout

```
/srv/fleet/
├── architecture.md         ← this file
├── CLAUDE.md               ← two-liner pointing here; operational gotchas
├── .env                    ← secrets, chmod 600, never committed
├── runs.jsonl              ← append-only run log, gitignored
├── src/
│   ├── runner.ts           spawn + parse + post + log
│   ├── bridge.ts           Slack Socket Mode listener
│   ├── slack.ts            chat.postMessage wrapper
│   ├── registry.ts         scan agents/, validate manifests, hold in memory
│   ├── cli.ts              npm run post / npm run agent entrypoints
│   └── types.ts            AgentManifest, RunRecord
├── deploy/
│   ├── fleet-bridge.service
│   ├── fleet-agent@.service    templated, takes agent id
│   └── fleet-agent@.timer      OnCalendar comes from per-instance drop-ins
├── agents/                 ← gitignored except _examples/
│   ├── _examples/          committed reference agents
│   ├── news/
│   ├── research/
│   ├── tutor/
│   └── projx/
├── docs/
│   └── SETUP.md            manual once-per-box steps (§12)
└── scripts/
    ├── new-agent.sh        scaffold a folder from _examples
    ├── sync-units.sh       generate per-agent timer drop-ins from manifests
    └── rollup.sh           weekly cost/run summary from runs.jsonl
```

Note there is no `store.ts`. That's deliberate — see §8.

### Gitignore rules that matter

```gitignore
agents/*
!agents/_examples/
!agents/_examples/**
runs.jsonl
.env
*/repo/          # coding-agent checkouts — nested git, keep out
```

Anyone cloning gets working code plus example agents, and none of your
prompts, books, channel IDs, or repos.

---

## 5. The agent folder contract

Every agent folder MUST have `agent.json` and `CLAUDE.md`. Everything else is
optional.

```
agents/news/
├── agent.json          manifest — machine config
├── CLAUDE.md           persona and standing instructions — model config
├── .mcp.json           MCP servers scoped to this agent (optional)
├── prompts/
│   └── daily.md        the scheduled prompt (required if scheduled)
├── threads.json        thread_ts → session_id map, runner-owned (§8)
└── NOTES.md            durable knowledge, if this agent needs any (§7)
```

### `agent.json`

```jsonc
{
  "id": "news",
  "name": "News Desk",
  "channel": "C09XXXXXXXX",     // Slack channel ID, not #name
  "model": "sonnet",            // sonnet | haiku | opus
  "interactive": true,          // does it respond to Slack messages?
  "allowedTools": ["Read", "Write", "WebSearch", "WebFetch"],
  "maxTurns": 30,
  "timeoutSec": 900,
  "schedule": {
    "prompt": "prompts/daily.md",
    "onCalendar": "*-*-* 07:00:00"   // systemd OnCalendar syntax
  }
}
```

Omit `schedule` for a purely reactive agent. Set `interactive: false` for a
purely scheduled one.

### `CLAUDE.md`

Role, output format, tone, standing rules, and the note-writing instruction if
the agent has one. This is the part you'll iterate on most. Claude Code picks
it up automatically from `cwd`. Keep machine config out of it — that belongs in
`agent.json`.

### `.mcp.json` — scope it

MCP servers load their tool definitions into the context window at session
start, before any work happens. The Notion server alone is roughly twenty
tools. Two servers on every run is a real chunk of window spent on capability
that may go unused.

Give each agent only the servers it needs. The coding agent gets Notion and
Linear; the news agent gets none. This is the single highest-leverage lever on
context efficiency in this project — larger than anything the notes strategy
buys.

Scoping `.mcp.json` controls what *loads*; it does not grant *permission*. MCP
tools must also appear in `allowedTools`, either by full name
(`mcp__linear__save_issue`) or as `mcp__linear` to allow a whole server. In
`-p` mode there is no one to click "allow": anything not allowlisted is
silently denied, and the model tends to work around the denial rather than
error. Vet a new agent by reading the turns of its first real run, not just
its final output.

### Naming convention

Folder name = `id` = Slack channel `#ag-<id>` = systemd unit
`fleet-agent@<id>`. Lowercase, hyphens, no underscores. Keep these in lockstep;
the tooling assumes it.

---

## 6. Stack

| Concern | Choice | Rationale |
|---|---|---|
| Runtime | Node 20 + TypeScript | Node is already present for Claude Code |
| Slack | `@slack/bolt`, **Socket Mode** | No inbound ports, no public URL on the VPS |
| Agent execution | `claude -p` subprocess | Not the SDK — we want CLAUDE.md, skills, and MCP discovery, which the CLI does for free |
| Auth | `claude setup-token` (OAuth) | Runs against the Max subscription |
| Scheduling | systemd timers | Real logs via `journalctl`; cron fails silently |
| Supervision | systemd unit, `Restart=always` | Bridge stays up across reboots |
| Run log | append-only JSONL | One `jq` away from any report we'd want |
| Concurrency | `flock` on the agent directory | Two triggers can't run one agent at once |
| Secrets | `.env` + `EnvironmentFile=` | chmod 600, owned by `fleet` |

**No** database, no Docker, no queue broker, no web UI, no orchestrator. One
box, systemd, a few hundred lines.

### Invocation shape

```bash
flock -w "$LOCK_WAIT" "$AGENT_DIR/.lock" claude -p "$PROMPT" \
  --output-format json \
  --model "$MODEL" \
  --allowedTools $ALLOWED \
  --max-turns "$MAX_TURNS" \
  --resume "$SESSION_ID"     # interactive runs resuming a thread only
```

`--output-format json` returns an object containing `result`, `session_id`,
`total_cost_usd`, `duration_ms`, and `num_turns`. Parse it once and you have
both the reply and the run record.

### Session strategy — the one place the two triggers differ

`--continue` (most-recent-session-in-cwd) is **not used at all**: with a timer
and a Slack thread sharing one cwd, "most recent" is whichever ran last, and
the two conversations interleave — the digest hijacks your thread, your next
reply continues the digest.

- **Scheduled** → fresh session every run, no resume flag. A digest that
  resumed itself would grow without bound for an agent whose yesterday is
  explicitly not context.
- **Interactive** → `--resume <session_id>`, looked up from the agent's
  `threads.json` by `thread_ts`. New thread, or a stored id that no longer
  resolves → run fresh and record the returned `session_id`. This also gives
  independent concurrent threads per channel for free.

### Per-agent schedules

A template unit is one file, but `OnCalendar` varies per agent.
`sync-units.sh` reads each manifest and writes a drop-in —
`/etc/systemd/system/fleet-agent@<id>.timer.d/schedule.conf` — then runs
`daemon-reload`. The manifest stays the single source of truth; never edit a
drop-in by hand.

> Flag names drift between versions and `claude --help` does not list every
> flag. Verify against the installed version before scripting; check
> `--allowedTools` vs `--allowed-tools` casing on your build. (Verified on
> 2.1.197: `--resume`, `--allowedTools`, `--output-format json` all present.)
> Reference: https://code.claude.com/docs/en/cli-reference

---

## 7. Context strategy

The goal is enough context to be useful, not enough to be expensive. Two rules.

**Don't summarize transcripts.** A compressed conversation is still a record of
*what was discussed*. What a future session needs is *what is true now*. Those
are different artifacts and the first converts badly into the second.
Threshold-triggered summarization also compounds: you end up summarizing
summaries, each pass shedding specifics and keeping generalities, until the
file reads plausible and says nothing.

**Write at full fidelity, not in hindsight.** Where an agent needs durable
knowledge, its `CLAUDE.md` ends with an explicit write step — append to
`NOTES.md` before finishing. Extraction happens while the agent still has the
detail, so sessions can be thrown away freely.

Claude Code already auto-compacts within a long session, so in-session length
is largely handled. The gap this addresses is *cross-session* knowledge.

### What each agent actually needs

| Agent | Persistent context | Why |
|---|---|---|
| **projx** (coding) | Thin. Notion + Linear MCP cover docs and tickets; the repo and git history cover the rest. Optionally a short decisions log for *why* — especially rejected approaches, which nothing else records. | The code is the context |
| **tutor** | A structured progress file, overwritten in place: chapter, what landed, what didn't, what to revisit. Never grows. | Memory *is* the product here |
| **news** | None. Optionally a rolling 20-line "recently covered" list that trims itself. | Yesterday's news is not context |
| **research** | None initially. Revisit if it starts repeating itself. | |

### When to revisit

When a `NOTES.md` becomes annoying to read, prune it by hand. At four agents
and one operator, five minutes a week of manual pruning beats debugging a
summarizer — and it teaches you which notes you actually reference. Automate
only once you know that.

---

## 8. Persistence

Deliberately minimal.

**Thread map** — `threads.json` per agent:
`{ "<thread_ts>": "<session_id>" }`. Read before an interactive run, written
after; runner-owned and covered by the same `flock` as everything else in the
folder. Scheduled runs never touch it. Prune stale threads whenever you prune
`NOTES.md`.

**Run log** — one JSON object appended to `runs.jsonl` per invocation:

```json
{"ts":"2026-08-02T07:00:04Z","agent":"news","trigger":"schedule","status":"ok","cost_usd":0.0412,"turns":6,"ms":38210}
```

Weekly rollup:

```bash
jq -s 'group_by(.agent)|map({agent:.[0].agent,runs:length,cost:(map(.cost_usd)|add)})' runs.jsonl
```

**Channel → agent map** — built by scanning `agents/*/agent.json` at bridge
startup, held in memory, reloaded on SIGHUP. Not persisted.

**Concurrency** — `flock` per agent directory. Interactive runs wait for the
lock; scheduled runs use a bounded wait (`flock -w 300`) so a timer stuck
behind a long thread logs a skip and exits instead of hanging the unit — the
next fire retries.

### When a database becomes justified

Only one of these, and none apply yet:

- The thread map outgrowing a read-all/write-all flat file — thousands of
  live threads on one agent. Prune stale entries first; at one operator this
  doesn't happen.
- Run history large enough that `jq` over the file is slow. That is years away
  at this volume.

Migrating JSONL into SQLite later is a twenty-line script. Building the schema
now costs a dependency and a module for benefits we can't yet name.

---

## 9. Conventions

- **Errors go to Slack, not just logs.** A failed run posts a short message to
  its own channel plus `#ag-ops`. Silent failure is the main way a fleet like
  this rots.
- **Threaded replies for inbound, top-level for scheduled.** Keeps digests
  scannable.
- **Never post raw stderr to Slack.** One-line summary in-channel, full detail
  in `journalctl`.
- **Slack has a 3000-char block limit.** Chunking lives in `slack.ts` from
  day one — digests hit the limit in week one, not eventually.
- **Ignore bot messages** (`subtype: bot_message`, or matching own bot ID) or
  you will build an infinite loop on day one.
- **Commits:** `feat(runner):`, `fix(bridge):`, `chore(deploy):`. Agent folder
  changes aren't commits — they're gitignored.

---

## 10. Security

This box holds a GitHub credential and a Claude OAuth token. Treat it like it.

- Runs as a non-root `fleet` user. Never root.
- **No `--dangerously-skip-permissions`.** Ever. Not "temporarily."
- `allowedTools` is per-agent and minimal:
  - news / research / tutor → `Read`, `Write`, `WebSearch`, `WebFetch`
  - coding agent → adds `Edit`, `Bash`, scoped via permission syntax, and only
    inside its own `repo/`
- `Bash(*)` does not mean what it looks like — read the permissions syntax in
  the settings reference before writing an allowlist.
- SSH key auth only, password auth off, UFW default-deny inbound. Socket Mode
  means nothing needs to be open.
- `.env` is chmod 600. Rotate the Slack and OAuth tokens if the box is ever
  shared or snapshotted.

---

## 11. Budget

Claude Max ($100 tier). Scheduled runs share the same rolling usage window as
your own interactive Claude Code work — an over-eager fleet will crowd out your
real sessions.

- Digest agents run overnight, off your working hours.
- Default to `sonnet` or `haiku` for scheduled agents. `opus` only for the
  coding agent, and only on demand.
- `maxTurns` set on every agent. No exceptions.
- Scope `.mcp.json` per agent (§5). Unused tool definitions are pure overhead.

`total_cost_usd` in the run log is a **notional API-equivalent figure**, not a
bill — on a subscription there's no invoice to reconcile it against. Treat it
as a relative signal for which agent is heaviest, not an accounting number.
The real constraint is usage-window contention with your own sessions.

> Subscription-backed automation terms have changed before. If they change
> again, the fallback is an API key on Claude Platform — swap the env var, no
> code change. Keep that seam clean.

---

## 12. Not in this repo

Documented here, done by hand once. Setup steps live in `docs/SETUP.md`.

1. VPS provisioned, `fleet` user created, Node 20 + `@anthropic-ai/claude-code`
   installed.
2. `claude setup-token` run interactively as `fleet` → token into `.env`.
3. Slack app created: Socket Mode on, `app_token` (`xapp-`, scope
   `connections:write`) + `bot_token` (`xoxb-`), bot scopes `chat:write`,
   `channels:history`, `groups:history`, `app_mentions:read`; event
   subscriptions `message.channels` **and** `message.groups` — private
   channels are invisible without the second.
4. Channels created and the bot invited to each.
5. `gh auth login` for the coding agent.

---

## 13. Build order

Six vertical slices. Each one visibly works on its own. One in progress at a
time.

| # | Outcome | Done when |
|---|---|---|
| 1 | VPS runs an authenticated Claude Code as a service user | `claude -p "say hi"` returns as `fleet` |
| 2 | Slack bot can post to a channel from the VPS | `npm run post -- news "hello"` appears in `#ag-news` |
| 3 | Runner executes any agent folder | `npm run agent -- news` runs and posts output |
| 4 | Scheduled agents fire unattended | Digest lands in `#ag-news` at 07:00 two days running, laptop closed |
| 5 | Replying in a channel talks to that agent | Follow-up in `#ag-research` gets a context-aware answer |
| 6 | Coding agent opens a PR from Slack | Message in `#ag-projx` produces a branch and PR |

Plus a standing **Ops** issue that never closes: log rotation, failure alerts,
weekly cost rollup, notes pruning.

Ship 1–4 before touching 5. They deliver the agents you'll actually use daily.
Let them run for a week before adding the inbound bridge — you may find you
only ever needed the push direction.

---

## 14. Non-goals

Say no to these:

- A web dashboard. `journalctl` and Slack are the UI.
- A database, until §8 says otherwise.
- Automatic context consolidation. Manual pruning until we know what we read.
- Agents talking to each other. They're independent by design.
- Docker/Kubernetes. One VPS, systemd.
- tmux session management. Nothing needs a live TTY.
- Multi-user or team support. If that's ever the need, use Claude Tag instead
  of rebuilding it.
- A plugin system. The agent folder contract *is* the extension point.
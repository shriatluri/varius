# CLAUDE.md

Read `architecture.md` before changing anything — it is the root reference for
this repo. An agent is a folder, not code; if a change special-cases an agent
by name in `src/`, the design is wrong.

## Operational gotchas

- `flock(1)` is Linux-only. The runner skips locking on macOS — fine for local
  dev, but concurrency guarantees only hold on the VPS.
- `claude` CLI flags drift between versions. Verified on 2.1.197: `--resume`,
  `--allowedTools`, `--output-format json`. Re-check after CLI updates.
- Never `--continue`. Scheduled runs are always fresh; interactive runs resume
  via `threads.json` (`thread_ts → session_id`). See architecture.md §6.
- MCP tools must appear in `allowedTools` (`mcp__<server>` or full names) —
  in `-p` mode unlisted tools are silently denied, not errored.
- Never post raw stderr to Slack. One-line summary in-channel, detail in
  `journalctl`.
- Permission rules: `Write(path)` rules are accepted but never consulted —
  `Edit(path)` governs all file-editing tools. Compound Bash commands are
  checked per segment.
- The CLI blocks `cd X && git …` (hook-safety guard) even when both segments
  are allowlisted. Agents must use `git -C <dir>` instead.

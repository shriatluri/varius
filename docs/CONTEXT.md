# CONTEXT.md

The context layer: retrieval over the fleet's durable markdown, in place of
reading whole notes files or grepping them. Design rationale and the
invariants it touches are in `architecture.md` §7.

---

## What an agent sees

An agent with a `context` block in its manifest gets four MCP tools:

| tool | what it does |
|---|---|
| `context_search(query, scopes?, budget?)` | hybrid search; returns whole sections with provenance, trimmed to a token budget |
| `context_get(id \| path)` | the full section behind a hit, or every section of a file |
| `context_recent(scopes?, limit?)` | most recently updated sections — "what happened lately" |
| `context_write(text, scope?, tags?)` | append a durable note at full fidelity |

A hit looks like this, and the header is the point — an agent can cite where
a claim came from and how stale it is:

```
[#42] agents/guru/PROGRESS.md § Progress › Chapter 4 — consensus · 3d ago

## Chapter 4 — consensus
Landed Raft leader election. Operator still shaky on log compaction; revisit.
```

## Scopes

A scope is one of:

- `self` — the running agent's own folder
- `<agent-id>` — another agent's folder
- `shared/<topic>` — `context/shared/<topic>.md`, a hand-prunable file

Declared in `agent.json`:

```jsonc
{
  "context": {
    "read":  ["self", "guru", "shared/decisions"],
    "write": ["self", "shared/decisions"],
    "budget": { "tokens": 2000 }
  }
}
```

**Overlap is read-only.** `write` accepts only `self` and `shared/*` — an
agent can read another agent's notes but can never edit them, so one agent's
bad run cannot corrupt another's memory. Shared files are append-only and
plain markdown; pruning stays a five-minute manual job (architecture.md §7).

No `context` block → no server, no tools, no behaviour change. The runner
also appends `mcp__varius-context` to the agent's `allowedTools`; without it
the tools would be silently denied in `-p` mode (CLAUDE.md).

Indexed sources: every `.md` under an agent folder except `CLAUDE.md` and
`prompts/` (persona and inputs, not knowledge), plus `context/shared/*.md`.

## Retrieval

- **Chunk = heading section**, so a hit arrives with its title and reads on
  its own. Sections over ~700 tokens split at paragraph boundaries.
- **BM25 (SQLite FTS5)** for the terms actually typed — names, ids, errors.
- **Embeddings** for the ones meant — "the auth thing" → "rejected session
  cookies because…".
- **Reciprocal Rank Fusion** over the two rankings, then a **token budget**,
  not a result count: retrieval that cannot blow the context window.

With no embedding provider configured the layer runs lexical-only — degraded
recall, everything else identical.

## Embeddings

```bash
# .env — pick one, or neither
OPENAI_API_KEY=sk-…          # text-embedding-3-small (default)
VOYAGE_API_KEY=pa-…          # voyage-3.5-lite
VARIUS_EMBED_PROVIDER=       # openai | voyage | none (default: whichever key is set)
VARIUS_EMBED_MODEL=          # override the model
```

Only *changed* chunks are embedded, so steady-state cost is a handful of
chunks per run; a full rebuild of a fleet-sized corpus is cents.

## Index

`context/index.db` (SQLite, gitignored) is **derived state** — delete it and
`npm run context -- reindex` rebuilds it from the markdown. Markdown stays
the source of truth; nothing is summarized or rewritten.

The runner reindexes an agent's readable scopes before each run and its
writable scopes after, inside the existing per-agent `flock`. Indexing
failures are logged and never fail a run.

```bash
npm run context -- reindex [--force]                 # all agents + shared
npm run context -- search "log compaction" --agent guru
npm run context -- stats                             # chunks/embeddings per scope
scripts/reindex.sh                                   # same as reindex, for cron/systemd
```

## Writing notes

`context_write` appends a timestamped, attributed section:

```
## 2026-09-12 21:40Z · guru — #consensus

Operator asked for log compaction again; still unclear.
```

It never rewrites and never summarizes a transcript — an agent's `CLAUDE.md`
should tell it to write *what is true now*, while it still has the detail
(architecture.md §7).

## Gotchas

- Hand-edits to a shared file are picked up on the next run of an agent that
  reads it (or an explicit `reindex`), not instantly.
- `better-sqlite3` is a native module: it rebuilds on `npm install` and is
  pinned to the Node 20 line the box runs.
- An agent that reads another agent's scope inherits its staleness. Prune
  shared files when you prune `NOTES.md`.

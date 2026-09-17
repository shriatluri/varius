export type Model = 'sonnet' | 'haiku' | 'opus';
export type Trigger = 'schedule' | 'slack';

export interface AgentSchedule {
  /** Path to the scheduled prompt, relative to the agent dir (e.g. "prompts/daily.md"). */
  prompt: string;
  /** systemd OnCalendar syntax — materialized into a timer drop-in by scripts/sync-units.sh. */
  onCalendar: string;
}

/**
 * Opt-in access to the context layer (docs/CONTEXT.md). Read scopes may name
 * other agents — overlap is read-only by construction; an agent writes into
 * its own folder or a shared file, never into another agent's notes.
 */
export interface AgentContext {
  /** "self" | "<agent-id>" | "shared/<topic>" */
  read: string[];
  /** Where context_write appends; omit for a read-only consumer. */
  write?: string[];
  /** Retrieval is trimmed to a token budget, not a result count. */
  budget?: { tokens: number };
}

export interface AgentManifest {
  id: string;
  name: string;
  /** Slack channel ID (C…), not #name. One channel = one agent. */
  channel: string;
  model: Model;
  /** Does it respond to Slack messages? */
  interactive: boolean;
  /** Includes MCP entries (mcp__<server> or full tool names) — unlisted tools are silently denied in -p mode. */
  allowedTools: string[];
  maxTurns: number;
  timeoutSec: number;
  /** Attach Merge/Deny buttons when a reply contains a GitHub PR URL (coding agents). */
  prReview?: boolean;
  context?: AgentContext;
  schedule?: AgentSchedule;
}

export interface Agent {
  manifest: AgentManifest;
  /** Absolute path to the agent folder; becomes cwd for claude -p. */
  dir: string;
}

/** Shape of `claude -p --output-format json` stdout. */
export interface ClaudeResult {
  result: string;
  session_id: string;
  total_cost_usd: number;
  duration_ms: number;
  num_turns: number;
  is_error?: boolean;
}

/** One line of runs.jsonl. */
export interface RunRecord {
  ts: string;
  agent: string;
  trigger: Trigger;
  status: 'ok' | 'error' | 'skipped';
  cost_usd?: number;
  turns?: number;
  ms?: number;
  error?: string;
}

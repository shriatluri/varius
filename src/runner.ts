import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { postPrReview, postText } from './slack';
import { Agent, ClaudeResult, RunRecord, Trigger } from './types';

const RUNS_LOG = path.resolve(__dirname, '..', 'runs.jsonl');

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

// Fallback spend ceiling when a manifest omits maxBudgetUsd. The CLI has no
// turn cap (2.1.197), so without this a run is bounded only by timeoutSec.
const DEFAULT_BUDGET_USD = 1.5;

// Scheduled runs give up on the lock and let the next timer fire retry;
// interactive runs wait out a long-running turn.
const LOCK_WAIT_SCHEDULE_SEC = 300;
const LOCK_WAIT_SLACK_SEC = 3600;

export interface RunOptions {
  trigger: Trigger;
  prompt: string;
  /** Interactive only — keys the agent's threads.json. */
  threadTs?: string;
}

function threadsPath(agent: Agent): string {
  return path.join(agent.dir, 'threads.json');
}

function readThreads(agent: Agent): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(threadsPath(agent), 'utf8'));
  } catch {
    return {};
  }
}

function writeThread(agent: Agent, threadTs: string, sessionId: string): void {
  const threads = readThreads(agent);
  threads[threadTs] = sessionId;
  fs.writeFileSync(threadsPath(agent), JSON.stringify(threads, null, 2) + '\n');
}

// Relative path-scoped rules anchor to the session's *current* cwd, and a
// persisted `cd` (allowed by e.g. `Bash(cd *)`) silently re-anchors them —
// after `cd repos/website`, `Edit(repos/**)` means `repos/website/repos/**`
// and every edit is denied. Pin file rules to the agent dir at spawn time
// (`//` is the absolute-path rule syntax); manifests stay portable across
// boxes. Bash/MCP rules aren't paths and pass through untouched.
const FILE_RULE = /^(Read|Edit|Write|Glob|Grep)\((?![/~])([^)]+)\)$/;
function absolutizeRules(agent: Agent, rules: string[]): string[] {
  return rules.map((rule) => {
    const match = rule.match(FILE_RULE);
    return match ? `${match[1]}(/${path.resolve(agent.dir, match[2])})` : rule;
  });
}

function claudeArgs(agent: Agent, prompt: string, resumeSessionId?: string): string[] {
  const m = agent.manifest;
  const args = [
    '-p', prompt,
    // stream-json (not json): `json` block-buffers one blob flushed only at
    // process exit — and heavy runs don't exit for ~70 min after finishing the
    // work, so we'd never see the result in time. stream-json emits NDJSON
    // events as they happen; we resolve on the `result` line and kill the rest.
    '--output-format', 'stream-json',
    '--verbose', // required by the CLI for stream-json under --print
    '--model', m.model,
    // `--max-turns` does NOT exist in CLI 2.1.197 — it was silently ignored,
    // leaving runs uncapped (a media run hit 54 turns / 95 min). `--max-budget-usd`
    // is the real ceiling and only works with --print (which we use).
    '--max-budget-usd', String(m.maxBudgetUsd ?? DEFAULT_BUDGET_USD),
  ];
  if (m.allowedTools.length > 0) args.push('--allowedTools', ...absolutizeRules(agent, m.allowedTools));

  // Scope MCP per agent (§5). Without --strict-mcp-config, `claude -p` inherits
  // the operator's global MCP servers (Slack, Notion, …) — a context-budget leak
  // and a correctness hazard: an agent that sees slack_send_message tries to post
  // itself instead of returning its result. Load only the agent's own .mcp.json,
  // or nothing if it has none.
  const mcpConfig = path.join(agent.dir, '.mcp.json');
  if (fs.existsSync(mcpConfig)) args.push('--mcp-config', mcpConfig);
  args.push('--strict-mcp-config');

  if (resumeSessionId) args.push('--resume', resumeSessionId);
  return args;
}

/** flock is Linux-only; local macOS dev runs unlocked. */
function withLock(agent: Agent, trigger: Trigger, args: string[]): { cmd: string; args: string[] } {
  if (process.platform !== 'linux') return { cmd: 'claude', args };
  const wait = trigger === 'schedule' ? LOCK_WAIT_SCHEDULE_SEC : LOCK_WAIT_SLACK_SEC;
  return {
    cmd: 'flock',
    args: ['-w', String(wait), path.join(agent.dir, '.lock'), 'claude', ...args],
  };
}

function invoke(agent: Agent, trigger: Trigger, prompt: string, resumeSessionId?: string): Promise<ClaudeResult> {
  const { cmd, args } = withLock(agent, trigger, claudeArgs(agent, prompt, resumeSessionId));
  return new Promise<ClaudeResult>((resolve, reject) => {
    // `detached` puts the child in its own process group so a timeout can kill
    // the *whole tree* (claude + flock + any curl/tool subprocess). execFile's
    // built-in timeout only signals the direct child: claude ignores SIGTERM,
    // and even under SIGKILL an orphaned grandchild keeps the stdout pipe open,
    // so the parent hung ~70 min past a finished run. `stdin: 'ignore'` gives
    // claude an immediate EOF so nothing blocks waiting on stdin.
    const child = spawn(cmd, args, {
      cwd: agent.dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const killTree = (signal: NodeJS.Signals) => {
      // Negative pid targets the whole process group (requires `detached`).
      try { if (child.pid) process.kill(-child.pid, signal); }
      catch { child.kill(signal); }
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree('SIGKILL'); // reap claude + any tool subprocess, settled or not
      fn();
    };
    const succeed = (p: ClaudeResult) => finish(() =>
      p.is_error ? reject(new Error(`claude reported error: ${p.result?.slice(0, 200)}`)) : resolve(p));
    const fail = (msg: string) => finish(() => reject(new Error(msg)));

    const timer = setTimeout(() => fail(`timed out after ${agent.manifest.timeoutSec}s`), agent.manifest.timeoutSec * 1000);

    // stream-json emits one JSON event per line. The terminal `{"type":"result"}`
    // line carries the same payload the old `json` format returned (result text,
    // session_id, total_cost_usd, num_turns, is_error). Resolve the instant it
    // arrives — then killTree() reaps the process even if it won't exit on its own.
    const scanLines = () => {
      let nl: number;
      while ((nl = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, nl).trim();
        stdout = stdout.slice(nl + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line);
          if (evt?.type === 'result') return succeed(evt as ClaudeResult);
        } catch { /* partial or non-JSON verbose line — skip */ }
      }
    };

    child.stdout.on('data', (d) => {
      if (settled) return;
      stdout += d;
      if (stdout.length > MAX_OUTPUT_BYTES) return fail('output exceeded buffer limit');
      scanLines();
    });
    child.stderr.on('data', (d) => { if (stderr.length < 8192) stderr += d; });

    child.on('error', (err) => fail(err.message));
    // No result line by the time stdout closes = genuine failure (crash, auth,
    // bad flag). scanLines once more in case the last line lacked a trailing \n.
    child.on('close', (code) => {
      if (settled) return;
      if (stdout.trim()) stdout += '\n';
      scanLines();
      if (!settled) fail(`claude exited ${code} with no result event: ${(stderr || stdout).slice(0, 200)}`);
    });
  });
}

function appendRun(record: RunRecord): void {
  fs.appendFileSync(RUNS_LOG, JSON.stringify(record) + '\n');
}

async function reportFailure(agent: Agent, trigger: Trigger, err: unknown): Promise<void> {
  // Full detail to stderr for journalctl; one line to Slack, never raw stderr.
  console.error(`run failed: agent=${agent.manifest.id} trigger=${trigger}`, err);
  const line = `:warning: \`${agent.manifest.id}\` ${trigger} run failed — see \`journalctl -u fleet-agent@${agent.manifest.id}\``;
  try {
    await postText(agent.manifest.channel, line);
    if (process.env.OPS_CHANNEL) await postText(process.env.OPS_CHANNEL, line);
  } catch (slackErr) {
    console.error('also failed to report to Slack:', slackErr);
  }
}

/**
 * The one code path for both triggers (architecture.md §3).
 * Session strategy (§6): scheduled → always fresh, but its post's ts is mapped
 * in threads.json; interactive → --resume via threads.json, falling back to a
 * fresh session if the stored id is stale.
 */
export async function runAgent(agent: Agent, opts: RunOptions): Promise<void> {
  const started = Date.now();
  const { trigger, prompt, threadTs } = opts;

  let resumeSessionId: string | undefined;
  if (trigger === 'slack' && threadTs) resumeSessionId = readThreads(agent)[threadTs];

  try {
    let result: ClaudeResult;
    try {
      result = await invoke(agent, trigger, prompt, resumeSessionId);
    } catch (err) {
      if (!resumeSessionId) throw err;
      // Stale session id (pruned, rotated, or from a dead install) — run fresh.
      console.error(`resume ${resumeSessionId} failed for ${agent.manifest.id}; retrying fresh`, err);
      resumeSessionId = undefined;
      result = await invoke(agent, trigger, prompt);
    }

    if (trigger === 'slack' && threadTs) writeThread(agent, threadTs, result.session_id);

    // A scheduled agent may decline to post by ending its reply with a line
    // that is exactly `SKIP` — e.g. a retrying timer whose data source hasn't
    // updated yet. Matched on the final line (models reliably *end* with the
    // sentinel but can't be trusted to say nothing else); agent personas must
    // never use the word in a real post. Interactive runs always post: a
    // person asked, silence reads as breakage.
    const skipped = trigger === 'schedule' && /(^|\n)\s*[`*_~]*SKIP[`*_~]*\s*$/.test(result.result.trim());

    if (!skipped) {
      // Threaded replies for inbound, top-level for scheduled (§9).
      const postedTs = await postText(agent.manifest.channel, result.result, trigger === 'slack' ? threadTs : undefined);

      // A reply under a scheduled post opens a thread keyed by that post's ts.
      // Map it to the session that wrote the post, so "log this" resumes with
      // the digest in context instead of starting blind (§6). The scheduled
      // run itself stays fresh; only the thread hanging off it resumes.
      if (trigger === 'schedule') for (const ts of postedTs) writeThread(agent, ts, result.session_id);

      // Coding agents (manifest opt-in): a reply containing a PR link gets
      // Merge/Deny buttons. Clicks land in bridge.ts — merging stays human.
      if (agent.manifest.prReview) {
        const prUrl = result.result.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/)?.[0];
        if (prUrl) await postPrReview(agent.manifest.channel, prUrl, trigger === 'slack' ? threadTs : undefined);
      }
    }

    appendRun({
      ts: new Date(started).toISOString(),
      agent: agent.manifest.id,
      trigger,
      status: skipped ? 'skipped' : 'ok',
      cost_usd: result.total_cost_usd,
      turns: result.num_turns,
      ms: Date.now() - started,
    });
  } catch (err) {
    appendRun({
      ts: new Date(started).toISOString(),
      agent: agent.manifest.id,
      trigger,
      status: 'error',
      ms: Date.now() - started,
      error: err instanceof Error ? err.message.slice(0, 300) : String(err),
    });
    await reportFailure(agent, trigger, err);
    throw err;
  }
}

/** Read the scheduled prompt for an agent (schedule.prompt, relative to the agent dir). */
export function scheduledPrompt(agent: Agent): string {
  const schedule = agent.manifest.schedule;
  if (!schedule) throw new Error(`${agent.manifest.id} has no schedule`);
  return fs.readFileSync(path.join(agent.dir, schedule.prompt), 'utf8');
}

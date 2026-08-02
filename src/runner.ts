import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { postText } from './slack';
import { Agent, ClaudeResult, RunRecord, Trigger } from './types';

const execFileP = promisify(execFile);

const RUNS_LOG = path.resolve(__dirname, '..', 'runs.jsonl');

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

function claudeArgs(agent: Agent, prompt: string, resumeSessionId?: string): string[] {
  const m = agent.manifest;
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--model', m.model,
    '--max-turns', String(m.maxTurns),
  ];
  if (m.allowedTools.length > 0) args.push('--allowedTools', ...m.allowedTools);
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

async function invoke(agent: Agent, trigger: Trigger, prompt: string, resumeSessionId?: string): Promise<ClaudeResult> {
  const { cmd, args } = withLock(agent, trigger, claudeArgs(agent, prompt, resumeSessionId));
  const { stdout } = await execFileP(cmd, args, {
    cwd: agent.dir,
    timeout: agent.manifest.timeoutSec * 1000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const parsed: ClaudeResult = JSON.parse(stdout);
  if (parsed.is_error) throw new Error(`claude reported error: ${parsed.result?.slice(0, 200)}`);
  return parsed;
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
 * Session strategy (§6): scheduled → always fresh; interactive → --resume via
 * threads.json, falling back to a fresh session if the stored id is stale.
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

    // Threaded replies for inbound, top-level for scheduled (§9).
    await postText(agent.manifest.channel, result.result, trigger === 'slack' ? threadTs : undefined);

    appendRun({
      ts: new Date(started).toISOString(),
      agent: agent.manifest.id,
      trigger,
      status: 'ok',
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

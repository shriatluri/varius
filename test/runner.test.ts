import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Agent, AgentManifest } from '../src/types';

// Must be set before runner.ts loads: it reads the binary at import time.
process.env.VARIUS_CLAUDE_BIN = path.join(__dirname, 'fake-claude.sh');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { claudeArgs, invoke, isSkip } = require('../src/runner') as typeof import('../src/runner');

function makeAgent(overrides: Partial<AgentManifest> = {}): Agent {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varius-agent-'));
  const manifest: AgentManifest = {
    id: 'demo', name: 'Demo', channel: 'C123', model: 'sonnet', interactive: true,
    allowedTools: [], maxTurns: 10, timeoutSec: 10, ...overrides,
  };
  return { manifest, dir };
}

const flagValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

test('claudeArgs: always stream-json + verbose + strict MCP', () => {
  const args = claudeArgs(makeAgent(), 'hello');
  assert.equal(flagValue(args, '-p'), 'hello');
  assert.equal(flagValue(args, '--output-format'), 'stream-json');
  assert.ok(args.includes('--verbose'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(!args.includes('--mcp-config'), 'no .mcp.json, no --mcp-config');
});

test('claudeArgs: never emits flags the design forbids', () => {
  const args = claudeArgs(makeAgent({ allowedTools: ['Read'] }), 'x', 'sess-1');
  for (const banned of ['--continue', '--max-turns', '--dangerously-skip-permissions']) {
    assert.ok(!args.includes(banned), `${banned} must never be passed`);
  }
});

test('claudeArgs: budget defaults to 1.5, manifest overrides', () => {
  assert.equal(flagValue(claudeArgs(makeAgent(), 'x'), '--max-budget-usd'), '1.5');
  assert.equal(flagValue(claudeArgs(makeAgent({ maxBudgetUsd: 0.25 }), 'x'), '--max-budget-usd'), '0.25');
});

test('claudeArgs: relative file rules pin to the agent dir, others pass through', () => {
  const agent = makeAgent({ allowedTools: ['Edit(repos/**)', 'Read', 'Bash(git *)', 'Read(~/x)', 'mcp__notion'] });
  const args = claudeArgs(agent, 'x');
  const tools = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--strict-mcp-config'));
  assert.deepEqual(tools, [`Edit(/${path.resolve(agent.dir, 'repos/**')})`, 'Read', 'Bash(git *)', 'Read(~/x)', 'mcp__notion']);
  assert.ok(tools[0].startsWith('Edit(//'), '`//` is the absolute-path rule syntax');
});

test('claudeArgs: scoped .mcp.json and --resume when given', () => {
  const agent = makeAgent();
  fs.writeFileSync(path.join(agent.dir, '.mcp.json'), '{}');
  const args = claudeArgs(agent, 'x', 'sess-9');
  assert.equal(flagValue(args, '--mcp-config'), path.join(agent.dir, '.mcp.json'));
  assert.equal(flagValue(args, '--resume'), 'sess-9');
  assert.ok(!claudeArgs(agent, 'x').includes('--resume'));
});

test('isSkip: final-line sentinel only', () => {
  for (const yes of ['SKIP', 'nothing new today\nSKIP', '**SKIP**', '`SKIP`\n']) assert.ok(isSkip(yes), yes);
  for (const no of ['', 'SKIPPED', 'SKIP the first one\nhere is the digest', 'skip']) assert.ok(!isSkip(no), no);
});

// invoke() against the fake CLI. Linux wraps the binary in flock, which is
// fine; on macOS the fake runs directly.
async function run(mode: string, overrides: Partial<AgentManifest> = {}) {
  process.env.FAKE_CLAUDE = mode;
  return invoke(makeAgent(overrides), 'schedule', 'p');
}

test('invoke: resolves on the result event', async () => {
  const r = await run('ok');
  assert.equal(r.result, 'hi');
  assert.equal(r.session_id, 's1');
});

test('invoke: resolves fast and kills the process group when the CLI lingers', async () => {
  const pidfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'varius-pid-')), 'pid');
  process.env.FAKE_PIDFILE = pidfile;
  const t0 = Date.now();
  await run('orphan');
  assert.ok(Date.now() - t0 < 5000, 'must not wait for the lingering process');
  const pid = Number(fs.readFileSync(pidfile, 'utf8'));
  let alive = true;
  for (let i = 0; i < 20 && alive; i++) {
    try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 50)); }
    catch { alive = false; }
  }
  assert.ok(!alive, `orphan ${pid} survived the group kill`);
});

test('invoke: times out a run that never produces a result', async () => {
  await assert.rejects(run('hang', { timeoutSec: 1 }), /timed out after 1s/);
});

test('invoke: is_error result rejects', async () => {
  await assert.rejects(run('error'), /claude reported error: boom/);
});

test('invoke: result line split across chunks still parses', async () => {
  assert.equal((await run('split')).result, 'hi');
});

test('invoke: result line without trailing newline parses at close', async () => {
  assert.equal((await run('nonl')).result, 'hi');
});

test('invoke: exit with no result event rejects with stderr summary', async () => {
  await assert.rejects(run('noresult'), /exited 3 with no result event: auth failed/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { lintManifest } from '../src/lint';
import type { AgentManifest } from '../src/types';

function lint(allowedTools: string[], mcpServers?: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varius-lint-'));
  if (mcpServers) {
    const servers = Object.fromEntries(mcpServers.map((s) => [s, { type: 'http', url: 'https://example.com' }]));
    fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
  }
  const m: AgentManifest = {
    id: 'x', name: 'x', channel: 'C1', model: 'sonnet', interactive: true,
    allowedTools, maxTurns: 1, timeoutSec: 1,
  };
  return lintManifest(m, dir).map((f) => `${f.level}:${f.message.split(':')[0]}`);
}

test('lint: a scoped, helper-based grant is clean', () => {
  assert.deepEqual(lint(['Read(notes/**)', 'Edit(notes/**)', 'Write', 'Bash(./plaid.sh *)', 'Bash(jq *)', 'mcp__notion'], ['notion']), []);
});

test('lint: interpreter, network and shell grants are errors', () => {
  for (const t of ['Bash', 'Bash(*)', 'Bash(curl *)', 'Bash(python3 -c *)', 'Bash(node *)', 'Bash(sh -c *)']) {
    assert.ok(lint([t]).includes(`error:${t}`), t);
  }
  assert.deepEqual(lint(['Bash(./curl-wrapper.sh *)', 'Bash(jq *)', 'Bash(date *)']), []);
});

test('lint: git * and cd * warn', () => {
  assert.deepEqual(lint(['Bash(git *)', 'Bash(cd *)']), ['warn:Bash(git *)', 'warn:Bash(cd *)']);
  assert.deepEqual(lint(['Bash(git status)', 'Bash(gh pr *)']), []);
});

test('lint: Write(path) without Edit(path) is an error', () => {
  assert.deepEqual(lint(['Write(notes/**)']), ['error:Write(notes/**)']);
  assert.deepEqual(lint(['Write(notes/**)', 'Edit(notes/**)']), []);
});

test('lint: bare Write without Edit warns', () => {
  assert.deepEqual(lint(['Write']), ['warn:bare Write without Edit']);
});

test('lint: unscoped Read plus an outbound tool warns', () => {
  assert.deepEqual(lint(['Read', 'Edit', 'WebFetch']), ['warn:unscoped Read + an outbound tool']);
  assert.deepEqual(lint(['Read', 'Edit', 'WebSearch']), []);
});

test('lint: MCP server loaded but not granted is an error', () => {
  assert.deepEqual(lint(['Read'], ['notion', 'linear']), [
    'error:.mcp.json loads "notion" but no mcp__notion grant',
    'error:.mcp.json loads "linear" but no mcp__linear grant',
  ]);
  assert.deepEqual(lint(['mcp__notion__search', 'mcp__linear'], ['notion', 'linear']), []);
});

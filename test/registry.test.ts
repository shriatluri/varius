import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Registry, validate } from '../src/registry';
import type { AgentManifest } from '../src/types';

const base = (id: string): AgentManifest => ({
  id, name: id, channel: 'C0001', model: 'sonnet', interactive: true,
  allowedTools: ['Read'], maxTurns: 10, timeoutSec: 60,
});

function agentDir(root: string, folder: string, manifest: object, files: Record<string, string> = { 'CLAUDE.md': '# x' }) {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(manifest));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

test('validate: one rule per case', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varius-reg-'));
  const cases: [string, Partial<AgentManifest> & Record<string, unknown>, RegExp | null][] = [
    ['ok', {}, null],
    ['wrong-id', { id: 'other' }, /!= folder name/],
    ['Bad_Id', { id: 'Bad_Id' }, /lowercase-hyphen/],
    ['chan', { channel: '#news' }, /Slack channel ID/],
    ['model', { model: 'gpt' as never }, /bad model/],
    ['tools', { allowedTools: 'Read' as never }, /must be an array/],
    ['budget', { maxBudgetUsd: 0 }, /maxBudgetUsd must be > 0/],
    ['timeout', { timeoutSec: 0 }, /timeoutSec required/],
    ['sched', { schedule: { prompt: 'prompts/missing.md', onCalendar: 'daily' } }, /not found/],
  ];
  for (const [folder, patch, expected] of cases) {
    const m = { ...base(folder), ...patch } as AgentManifest;
    const dir = agentDir(root, folder, m);
    const problem = validate(m, dir);
    if (expected) assert.match(problem ?? '', expected, folder);
    else assert.equal(problem, null, folder);
  }
  const noClaude = agentDir(root, 'bare', base('bare'), {});
  assert.match(validate(base('bare'), noClaude) ?? '', /CLAUDE.md missing/);
});

test('Registry: loads valid agents, skips invalid, _examples and junk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varius-reg-'));
  agentDir(root, 'news', { ...base('news'), channel: 'C0NEWS' });
  agentDir(root, 'broken', { ...base('broken'), model: 'gpt' });
  agentDir(root, '_examples', base('_examples'));
  fs.mkdirSync(path.join(root, 'notes-only'));
  fs.mkdirSync(path.join(root, 'garbled'));
  fs.writeFileSync(path.join(root, 'garbled', 'agent.json'), '{not json');

  const reg = new Registry(root);
  assert.deepEqual(reg.all().map((a) => a.manifest.id), ['news']);
  assert.equal(reg.byChannel('C0NEWS')?.manifest.id, 'news');
  assert.equal(reg.byId('broken'), undefined);
});

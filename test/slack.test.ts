import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk, toSlackMrkdwn } from '../src/slack';
import cases from './cases/mrkdwn-cases.json';

for (const c of cases) {
  test(`toSlackMrkdwn: ${c.name}`, () => assert.equal(toSlackMrkdwn(c.in), c.out));
}

test('chunk: short text is one chunk', () => {
  assert.deepEqual(chunk('hello'), ['hello']);
});

test('chunk: splits on line boundaries under the 3000-char block limit', () => {
  const text = Array.from({ length: 200 }, (_, i) => `line ${i} `.padEnd(40, 'x')).join('\n');
  const parts = chunk(text);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 2900);
  assert.equal(parts.join('\n'), text, 'no content lost or reordered');
});

test('chunk: hard-splits a single overlong line', () => {
  const parts = chunk('y'.repeat(7000));
  assert.deepEqual(parts.map((p) => p.length), [2900, 2900, 1200]);
});

/**
 * `context_write` appends; it never rewrites. Durable knowledge is written at
 * full fidelity while the agent still has the detail (architecture.md §7), and
 * a human can still read and prune the file by hand afterwards.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Scope, writeTarget } from './scopes';

export interface WriteResult {
  file: string;
  heading: string;
}

export function appendNote(scope: Scope, text: string, author: string, tags: string[] = []): WriteResult {
  const file = writeTarget(scope);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + 'Z';
  const suffix = tags.length > 0 ? ` — ${tags.map((t) => `#${t}`).join(' ')}` : '';
  const heading = `${stamp} · ${author}${suffix}`;
  const body = `## ${heading}\n\n${text.trim()}\n`;

  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8');
    fs.appendFileSync(file, `${existing.endsWith('\n') ? '' : '\n'}\n${body}`);
  } else {
    fs.writeFileSync(file, `# ${scope.name}\n\n${body}`);
  }
  return { file, heading };
}

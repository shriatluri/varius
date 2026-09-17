/**
 * Scopes are the unit of access in the context layer: an agent declares which
 * ones it may read and which one it writes, in its own manifest. Nothing here
 * knows an agent by name — `self` resolves against whoever is running.
 *
 *   self             the running agent's own folder
 *   <agent-id>       another agent's folder (read-only in practice: an agent
 *                    can only declare its own folder or a shared file as write)
 *   shared/<topic>   context/shared/<topic>.md, a hand-prunable append-only file
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const CONTEXT_DIR = path.join(REPO_ROOT, 'context');
export const SHARED_DIR = path.join(CONTEXT_DIR, 'shared');
export const DB_PATH = path.join(CONTEXT_DIR, 'index.db');

export const SCOPE_RE = /^(self|shared\/[a-z][a-z0-9-]*|[a-z][a-z0-9-]*)$/;

/** Persona and prompt files are inputs to a run, not knowledge to retrieve. */
const SKIP_FILES = new Set(['CLAUDE.md']);
const SKIP_DIRS = new Set(['prompts', 'node_modules', 'repos', 'repo']);

export interface Scope {
  /** Canonical name — "self" is already resolved to the agent id. */
  name: string;
  kind: 'agent' | 'shared';
  /** Directory walked for sources (agent scopes). */
  dir?: string;
  /** Single file (shared scopes). */
  file?: string;
}

export function resolveScope(ref: string, agentId?: string): Scope {
  if (!SCOPE_RE.test(ref)) throw new Error(`bad scope "${ref}"`);
  if (ref === 'self') {
    if (!agentId) throw new Error('scope "self" needs an agent id');
    return { name: agentId, kind: 'agent', dir: path.join(REPO_ROOT, 'agents', agentId) };
  }
  if (ref.startsWith('shared/')) {
    return { name: ref, kind: 'shared', file: path.join(SHARED_DIR, `${ref.slice('shared/'.length)}.md`) };
  }
  return { name: ref, kind: 'agent', dir: path.join(REPO_ROOT, 'agents', ref) };
}

export function resolveScopes(refs: string[], agentId?: string): Scope[] {
  const seen = new Map<string, Scope>();
  for (const ref of refs) {
    const scope = resolveScope(ref, agentId);
    seen.set(scope.name, scope);
  }
  return [...seen.values()];
}

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.md') && !SKIP_FILES.has(entry.name)) {
      out.push(full);
    }
  }
}

/** Absolute paths of every markdown source a scope contributes. */
export function scopeSources(scope: Scope): string[] {
  if (scope.kind === 'shared') return scope.file && fs.existsSync(scope.file) ? [scope.file] : [];
  const out: string[] = [];
  if (scope.dir) walk(scope.dir, out);
  return out.sort();
}

/** Repo-relative, for display and for stable ids across boxes. */
export function relPath(absolute: string): string {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
}

/** Where `context_write` appends for a given scope. */
export function writeTarget(scope: Scope): string {
  if (scope.kind === 'shared') return scope.file!;
  return path.join(scope.dir!, 'NOTES.md');
}

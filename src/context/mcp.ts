/**
 * Wiring between an agent folder and the context layer.
 *
 * Everything the server needs comes from the manifest, so `src/` never learns
 * an agent's name (architecture.md §2.1): no `context` block → nothing here
 * runs and the agent behaves exactly as it did before.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent } from '../types';
import { loadEmbedder } from './embed';
import { reindex } from './indexer';
import { Scope, REPO_ROOT, resolveScopes } from './scopes';
import { openDb } from './store';

export const CONTEXT_SERVER_NAME = 'varius-context';
const DEFAULT_BUDGET_TOKENS = 2000;

const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const SERVER_ENTRY = path.join(REPO_ROOT, 'src', 'context', 'server.ts');

interface McpConfig {
  mcpServers: Record<string, unknown>;
}

export interface ContextSpawn {
  /** Merged MCP config to hand to `claude --mcp-config`. */
  configPath: string;
  /** Tool rules the agent needs for the context server to be callable at all. */
  allowRules: string[];
  cleanup(): void;
}

function readOwnConfig(agent: Agent): McpConfig {
  const file = path.join(agent.dir, '.mcp.json');
  if (!fs.existsSync(file)) return { mcpServers: {} };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<McpConfig>;
  return { mcpServers: parsed.mcpServers ?? {} };
}

/**
 * Merge the agent's own `.mcp.json` with the context server into one config
 * file. A temp file rather than an inline JSON argument: `--mcp-config`
 * accepts a path on every CLI version we've verified (CLAUDE.md — flags
 * drift), and the agent folder stays untouched.
 */
export function prepareContext(agent: Agent): ContextSpawn | null {
  const context = agent.manifest.context;
  if (!context) return null;

  const config = readOwnConfig(agent);
  config.mcpServers[CONTEXT_SERVER_NAME] = {
    command: TSX,
    args: [
      SERVER_ENTRY,
      '--agent', agent.manifest.id,
      '--read', context.read.join(','),
      '--write', (context.write ?? []).join(','),
      '--budget', String(context.budget?.tokens ?? DEFAULT_BUDGET_TOKENS),
    ],
  };

  const configPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), `varius-${agent.manifest.id}-`)),
    'mcp.json',
  );
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  return {
    configPath,
    // Unlisted MCP tools are silently denied in -p mode (CLAUDE.md), which
    // would leave the agent quietly blind to its own context.
    allowRules: [`mcp__${CONTEXT_SERVER_NAME}`],
    cleanup: () => fs.rmSync(path.dirname(configPath), { recursive: true, force: true }),
  };
}

export function contextScopes(agent: Agent): { read: Scope[]; write: Scope[] } {
  const context = agent.manifest.context;
  if (!context) return { read: [], write: [] };
  return {
    read: resolveScopes(context.read, agent.manifest.id),
    write: resolveScopes(context.write ?? [], agent.manifest.id),
  };
}

/**
 * Freshness pass around a run. Best-effort by construction: an index problem
 * degrades retrieval, it never fails a run.
 */
export async function refreshContext(agent: Agent, scopes: Scope[]): Promise<void> {
  if (scopes.length === 0) return;
  try {
    const db = openDb();
    try {
      await reindex(db, scopes, { embedder: loadEmbedder() });
    } finally {
      db.close();
    }
  } catch (err) {
    console.error(`context: reindex failed for ${agent.manifest.id}:`, err);
  }
}

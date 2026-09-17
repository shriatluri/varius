#!/usr/bin/env node
/**
 * The context layer as an MCP server, one process per run, spawned by
 * `claude -p` from the agent's merged MCP config.
 *
 * Access is entirely argv-driven — the scopes come from the agent's manifest
 * via the runner, so no agent is known by name here (architecture.md §2.1).
 *
 *   context-server --agent <id> --read self,shared/infra --write self --budget 2000
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadEmbedder } from './embed';
import { reindex } from './indexer';
import { Scope, resolveScopes } from './scopes';
import { fileChunks, formatHits, getChunk, recent, search } from './search';
import { openDb } from './store';
import { appendNote } from './write';

interface Args {
  agent: string;
  read: string[];
  write: string[];
  budget: number;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument "${argv[i]}"`);
    flags.set(argv[i].slice(2), argv[i + 1] ?? '');
  }
  const list = (key: string): string[] => (flags.get(key) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const agent = flags.get('agent');
  if (!agent) throw new Error('--agent is required');
  return { agent, read: list('read'), write: list('write'), budget: Number(flags.get('budget') ?? 2000) };
}

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] };
}

function pick(scopes: Scope[], requested: string[] | undefined, agent: string): Scope[] {
  if (!requested || requested.length === 0) return scopes;
  const allowed = new Map(scopes.map((s) => [s.name, s]));
  // "self" is the caller's own folder; anything not granted is simply not
  // visible rather than an error the model will try to route around.
  return resolveScopes(requested, agent).filter((s) => allowed.has(s.name));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const readScopes = resolveScopes(args.read, args.agent);
  const writeScopes = resolveScopes(args.write, args.agent);
  const embedder = loadEmbedder();
  const db = openDb();

  const server = new McpServer({ name: 'varius-context', version: '0.1.0' });

  server.registerTool(
    'context_search',
    {
      description:
        'Search durable fleet context (notes, journals, decisions, shared files) by meaning and by exact term. ' +
        'Prefer this over reading whole notes files or grepping. Returns whole sections with provenance ' +
        `[#id path § heading · age], trimmed to a token budget. Readable scopes: ${args.read.join(', ') || '(none)'}.`,
      inputSchema: {
        query: z.string().describe('What you want to know, in natural language.'),
        scopes: z.array(z.string()).optional().describe('Subset of readable scopes; omit to search all of them.'),
        budget: z.number().int().positive().optional().describe(`Token budget for results (default ${args.budget}).`),
      },
    },
    async ({ query, scopes, budget }) => {
      const hits = await search(db, {
        query,
        scopes: pick(readScopes, scopes, args.agent),
        tokenBudget: budget ?? args.budget,
        embedder,
      });
      return text(formatHits(hits));
    },
  );

  server.registerTool(
    'context_get',
    {
      description:
        'Fetch full context behind a search hit: a section by its [#id], or every section of a file by its path.',
      inputSchema: {
        id: z.number().int().optional().describe('Section id from a search result.'),
        path: z.string().optional().describe('Repo-relative path, e.g. agents/guru/NOTES.md.'),
      },
    },
    async ({ id, path: filePath }) => {
      const allowed = new Set(readScopes.map((s) => s.name));
      if (id !== undefined) {
        const hit = getChunk(db, id);
        if (!hit || !allowed.has(hit.scope)) return text(`No readable section #${id}.`);
        return text(formatHits([hit]));
      }
      if (filePath) {
        const hits = fileChunks(db, filePath).filter((h) => allowed.has(h.scope));
        return text(hits.length > 0 ? formatHits(hits) : `No readable context at ${filePath}.`);
      }
      return text('Pass either id or path.');
    },
  );

  server.registerTool(
    'context_recent',
    {
      description: 'Most recently updated context sections — what happened lately, without a query.',
      inputSchema: {
        scopes: z.array(z.string()).optional().describe('Subset of readable scopes.'),
        limit: z.number().int().positive().max(20).optional(),
      },
    },
    async ({ scopes, limit }) => text(formatHits(recent(db, pick(readScopes, scopes, args.agent), limit ?? 5))),
  );

  if (writeScopes.length > 0) {
    server.registerTool(
      'context_write',
      {
        description:
          'Append a durable note, at full fidelity, while you still have the detail. Never a summary of the ' +
          `conversation — write what is true now. Writable scopes: ${args.write.join(', ')}.`,
        inputSchema: {
          text: z.string().describe('The note, in markdown.'),
          scope: z.string().optional().describe(`Writable scope (default ${args.write[0]}).`),
          tags: z.array(z.string()).optional(),
        },
      },
      async ({ text: note, scope, tags }) => {
        const target = scope
          ? writeScopes.find((s) => s.name === resolveScopes([scope], args.agent)[0].name)
          : writeScopes[0];
        if (!target) return text(`Scope "${scope}" is not writable by this agent.`);
        const { file, heading } = appendNote(target, note, args.agent, tags);
        await reindex(db, [target], { embedder });
        return text(`Wrote to ${file} under "${heading}".`);
      },
    );
  }

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error('context server failed:', err);
  process.exit(1);
});

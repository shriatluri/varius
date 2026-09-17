/**
 * Operator entrypoints for the context layer.
 *
 *   npm run context -- reindex [--force]        index every agent + shared scope
 *   npm run context -- search "<query>" [--agent <id>] [--budget 2000]
 *   npm run context -- stats
 */
import * as fs from 'node:fs';
import { loadRegistry } from '../registry';
import { loadEmbedder } from './embed';
import { reindex } from './indexer';
import { SHARED_DIR, Scope, resolveScope, resolveScopes } from './scopes';
import { formatHits, search } from './search';
import { openDb } from './store';

function usage(): never {
  console.error('usage: context reindex [--force]');
  console.error('       context search "<query>" [--agent <id>] [--budget <tokens>]');
  console.error('       context stats');
  process.exit(2);
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Everything indexable: every registered agent plus every shared file. */
function allScopes(): Scope[] {
  const agents = loadRegistry().all().map((a) => resolveScope(a.manifest.id));
  const shared = fs.existsSync(SHARED_DIR)
    ? fs
        .readdirSync(SHARED_DIR)
        .filter((f) => f.endsWith('.md'))
        .map((f) => resolveScope(`shared/${f.replace(/\.md$/, '')}`))
    : [];
  return [...agents, ...shared];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const db = openDb();

  switch (cmd) {
    case 'reindex': {
      const stats = await reindex(db, allScopes(), { force: argv.includes('--force'), embedder: loadEmbedder() });
      console.error(
        `indexed ${stats.chunks} chunk(s) from ${stats.filesChanged}/${stats.filesSeen} file(s) ` +
          `across ${stats.scopes} scope(s); removed ${stats.filesRemoved}; ` +
          `embeddings: ${stats.embedModel ?? 'off (lexical only)'}`,
      );
      break;
    }
    case 'search': {
      const query = argv[1];
      if (!query || query.startsWith('--')) usage();
      const agentId = flag(argv, 'agent');
      const agent = agentId ? loadRegistry().byId(agentId) : undefined;
      if (agentId && !agent) {
        console.error(`unknown agent "${agentId}"`);
        process.exit(1);
      }
      const scopes = agent?.manifest.context
        ? resolveScopes(agent.manifest.context.read, agent.manifest.id)
        : allScopes();
      const hits = await search(db, {
        query,
        scopes,
        tokenBudget: Number(flag(argv, 'budget') ?? agent?.manifest.context?.budget?.tokens ?? 2000),
        embedder: loadEmbedder(),
      });
      console.log(formatHits(hits));
      break;
    }
    case 'stats': {
      const rows = db
        .prepare<[], { scope: string; chunks: number; embedded: number }>(
          'select scope, count(*) as chunks, sum(embedding is not null) as embedded from chunks group by scope order by scope',
        )
        .all();
      if (rows.length === 0) console.error('index is empty — run: npm run context -- reindex');
      for (const row of rows) console.log(`${row.scope}\t${row.chunks} chunks\t${row.embedded} embedded`);
      break;
    }
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

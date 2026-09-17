/**
 * Hybrid retrieval: BM25 for the terms the operator actually typed, vectors
 * for the ones they meant, fused with Reciprocal Rank Fusion.
 *
 * Results are trimmed to a **token budget**, not to a result count — the
 * point of this layer is retrieval that cannot blow the context window
 * (architecture.md §2.5). `k` results of unknown size can.
 */
import { Embedder } from './embed';
import { Scope } from './scopes';
import { Db, cosine, unpackEmbedding } from './store';

const CANDIDATES = 40;
const RRF_K = 60;

export interface Hit {
  id: number;
  scope: string;
  path: string;
  heading: string;
  text: string;
  tokens: number;
  mtime_ms: number;
  score: number;
}

/** FTS5 treats punctuation as syntax; quote every term and OR them. */
function ftsQuery(query: string): string | null {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((t) => t.length > 1)
    .map((t) => `"${t.replace(/"/g, '')}"`);
  return terms.length > 0 ? terms.join(' OR ') : null;
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ');
}

function lexical(db: Db, query: string, scopeNames: string[]): Hit[] {
  const match = ftsQuery(query);
  if (!match || scopeNames.length === 0) return [];
  return db
    .prepare<unknown[], Hit>(
      `select c.id, c.scope, c.path, c.heading, c.text, c.tokens, c.mtime_ms,
              -bm25(chunks_fts, 1.0, 2.0) as score
         from chunks_fts f
         join chunks c on c.id = f.rowid
        where chunks_fts match ? and c.scope in (${placeholders(scopeNames.length)})
        order by bm25(chunks_fts, 1.0, 2.0)
        limit ${CANDIDATES}`,
    )
    .all(match, ...scopeNames);
}

async function semantic(db: Db, query: string, scopeNames: string[], embedder: Embedder): Promise<Hit[]> {
  const rows = db
    .prepare<unknown[], { id: number; embedding: Buffer }>(
      `select id, embedding from chunks
        where embedding is not null and scope in (${placeholders(scopeNames.length)})`,
    )
    .all(...scopeNames);
  if (rows.length === 0) return [];

  const [queryVector] = await embedder.embed([query]);
  const probe = new Float32Array(queryVector);
  const scored = rows
    .map((row) => ({ id: row.id, score: cosine(probe, unpackEmbedding(row.embedding)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATES);

  const byId = new Map(scored.map((s) => [s.id, s.score]));
  const hydrated = db
    .prepare<unknown[], Hit>(
      `select id, scope, path, heading, text, tokens, mtime_ms, 0 as score
         from chunks where id in (${placeholders(scored.length)})`,
    )
    .all(...scored.map((s) => s.id));
  return hydrated
    .map((hit) => ({ ...hit, score: byId.get(hit.id) ?? 0 }))
    .sort((a, b) => b.score - a.score);
}

function fuse(rankings: Hit[][]): Hit[] {
  const scores = new Map<number, number>();
  const hits = new Map<number, Hit>();
  for (const ranking of rankings) {
    ranking.forEach((hit, rank) => {
      scores.set(hit.id, (scores.get(hit.id) ?? 0) + 1 / (RRF_K + rank + 1));
      hits.set(hit.id, hit);
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ ...hits.get(id)!, score }));
}

export interface SearchOptions {
  query: string;
  scopes: Scope[];
  tokenBudget: number;
  embedder?: Embedder | null;
}

export async function search(db: Db, opts: SearchOptions): Promise<Hit[]> {
  const scopeNames = opts.scopes.map((s) => s.name);
  const rankings: Hit[][] = [lexical(db, opts.query, scopeNames)];

  if (opts.embedder) {
    try {
      rankings.push(await semantic(db, opts.query, scopeNames, opts.embedder));
    } catch (err) {
      // A provider hiccup degrades recall; it must not fail the search.
      console.error('context: semantic search failed, lexical only:', err);
    }
  }

  const fused = fuse(rankings);
  const kept: Hit[] = [];
  let spent = 0;
  for (const hit of fused) {
    if (spent + hit.tokens > opts.tokenBudget) {
      if (kept.length === 0) kept.push(hit); // never return nothing for one oversized section
      continue;
    }
    kept.push(hit);
    spent += hit.tokens;
  }
  return kept;
}

export function recent(db: Db, scopes: Scope[], limit: number): Hit[] {
  const names = scopes.map((s) => s.name);
  if (names.length === 0) return [];
  return db
    .prepare<unknown[], Hit>(
      `select id, scope, path, heading, text, tokens, mtime_ms, 0 as score
         from chunks where scope in (${placeholders(names.length)})
        order by mtime_ms desc, id desc limit ?`,
    )
    .all(...names, limit);
}

export function getChunk(db: Db, id: number): Hit | undefined {
  return db
    .prepare<[number], Hit>(
      'select id, scope, path, heading, text, tokens, mtime_ms, 0 as score from chunks where id = ?',
    )
    .get(id);
}

export function fileChunks(db: Db, path: string): Hit[] {
  return db
    .prepare<[string], Hit>(
      'select id, scope, path, heading, text, tokens, mtime_ms, 0 as score from chunks where path = ? order by ord',
    )
    .all(path);
}

function ago(mtimeMs: number): string {
  const days = Math.floor((Date.now() - mtimeMs) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(mtimeMs).toISOString().slice(0, 10);
}

/**
 * Every hit carries where it came from and how old it is, so an agent can say
 * "per your guru notes from Tuesday" instead of asserting something the
 * operator cannot trace.
 */
export function formatHits(hits: Hit[]): string {
  if (hits.length === 0) return 'No matching context.';
  return hits
    .map((hit) => {
      const where = hit.heading ? `${hit.path} § ${hit.heading}` : hit.path;
      return `[#${hit.id}] ${where} · ${ago(hit.mtime_ms)}\n\n${hit.text}`;
    })
    .join('\n\n---\n\n');
}

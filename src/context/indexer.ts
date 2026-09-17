/**
 * Incremental reindex: hash a source, skip it if unchanged, otherwise replace
 * its chunks wholesale. One edited NOTES.md costs milliseconds plus (if a
 * provider is configured) one embeddings call for the chunks that changed.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { chunkMarkdown } from './chunk';
import { Embedder, loadEmbedder } from './embed';
import { Scope, relPath, scopeSources } from './scopes';
import { Db, packEmbedding } from './store';

export interface IndexStats {
  scopes: number;
  filesSeen: number;
  filesChanged: number;
  filesRemoved: number;
  chunks: number;
  embedded: number;
  embedModel: string | null;
}

function sha1(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

interface PendingChunk {
  scope: string;
  path: string;
  heading: string;
  ord: number;
  text: string;
  tokens: number;
  mtime_ms: number;
}

/** Text handed to the embedder: the heading trail earns its keep as context. */
function embedText(chunk: PendingChunk): string {
  return chunk.heading ? `${chunk.path} › ${chunk.heading}\n\n${chunk.text}` : `${chunk.path}\n\n${chunk.text}`;
}

export async function reindex(
  db: Db,
  scopes: Scope[],
  opts: { force?: boolean; embedder?: Embedder | null } = {},
): Promise<IndexStats> {
  const embedder = opts.embedder === undefined ? loadEmbedder() : opts.embedder;
  const stats: IndexStats = {
    scopes: scopes.length,
    filesSeen: 0,
    filesChanged: 0,
    filesRemoved: 0,
    chunks: 0,
    embedded: 0,
    embedModel: embedder?.model ?? null,
  };

  const selectFile = db.prepare<[string], { hash: string }>('select hash from files where path = ?');
  const upsertFile = db.prepare(
    'insert into files(path, scope, mtime_ms, hash) values (?, ?, ?, ?) ' +
      'on conflict(path) do update set scope=excluded.scope, mtime_ms=excluded.mtime_ms, hash=excluded.hash',
  );
  const deleteChunks = db.prepare('delete from chunks where path = ?');
  const deleteFile = db.prepare('delete from files where path = ?');
  const insertChunk = db.prepare(
    'insert into chunks(scope, path, heading, ord, text, tokens, mtime_ms, embedding, embed_model) ' +
      'values (@scope, @path, @heading, @ord, @text, @tokens, @mtime_ms, @embedding, @embed_model)',
  );

  const pending: PendingChunk[] = [];

  for (const scope of scopes) {
    const sources = scopeSources(scope);
    const live = new Set<string>();

    for (const absolute of sources) {
      const rel = relPath(absolute);
      live.add(rel);
      stats.filesSeen++;
      const raw = fs.readFileSync(absolute, 'utf8');
      const hash = sha1(raw);
      if (!opts.force && selectFile.get(rel)?.hash === hash) continue;

      stats.filesChanged++;
      const mtime = Math.round(fs.statSync(absolute).mtimeMs);
      deleteChunks.run(rel);
      upsertFile.run(rel, scope.name, mtime, hash);
      for (const chunk of chunkMarkdown(raw)) {
        pending.push({ scope: scope.name, path: rel, mtime_ms: mtime, ...chunk });
      }
    }

    // Sources deleted since the last pass leave the index stale otherwise.
    const known = db
      .prepare<[string], { path: string }>('select path from files where scope = ?')
      .all(scope.name);
    for (const { path: rel } of known) {
      if (live.has(rel)) continue;
      deleteChunks.run(rel);
      deleteFile.run(rel);
      stats.filesRemoved++;
    }
  }

  let vectors: (number[] | null)[] = pending.map(() => null);
  if (embedder && pending.length > 0) {
    try {
      vectors = await embedder.embed(pending.map(embedText));
      stats.embedded = pending.length;
    } catch (err) {
      // Lexical-only is a degraded index, not a broken one — a provider
      // outage must never block a run or leave the index half-written.
      console.error('context: embedding failed, indexing lexically only:', err);
      vectors = pending.map(() => null);
      stats.embedModel = null;
    }
  }

  db.transaction(() => {
    pending.forEach((chunk, i) => {
      const vector = vectors[i];
      insertChunk.run({
        ...chunk,
        embedding: vector ? packEmbedding(vector) : null,
        embed_model: vector ? embedder!.model : null,
      });
    });
  })();
  stats.chunks = pending.length;

  return stats;
}

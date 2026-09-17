/**
 * SQLite index over the fleet's markdown.
 *
 * Derived state only: `context/index.db` can be deleted at any time and
 * rebuilt from the files. The markdown stays the source of truth
 * (architecture.md §7) — nothing here rewrites or summarizes it.
 */
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DB_PATH } from './scopes';

export type Db = Database.Database;

export interface ChunkRow {
  id: number;
  scope: string;
  path: string;
  heading: string;
  ord: number;
  text: string;
  tokens: number;
  mtime_ms: number;
  embedding: Buffer | null;
  embed_model: string | null;
}

const SCHEMA = `
create table if not exists files (
  path      text primary key,
  scope     text not null,
  mtime_ms  integer not null,
  hash      text not null
);
create table if not exists chunks (
  id          integer primary key,
  scope       text not null,
  path        text not null,
  heading     text not null,
  ord         integer not null,
  text        text not null,
  tokens      integer not null,
  mtime_ms    integer not null,
  embedding   blob,
  embed_model text
);
create index if not exists chunks_by_path  on chunks(path);
create index if not exists chunks_by_scope on chunks(scope, mtime_ms desc);
create virtual table if not exists chunks_fts using fts5(
  text, heading, content='chunks', content_rowid='id', tokenize='porter unicode61'
);
create trigger if not exists chunks_ai after insert on chunks begin
  insert into chunks_fts(rowid, text, heading) values (new.id, new.text, new.heading);
end;
create trigger if not exists chunks_ad after delete on chunks begin
  insert into chunks_fts(chunks_fts, rowid, text, heading) values ('delete', old.id, old.text, old.heading);
end;
`;

export function openDb(file = DB_PATH): Db {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  // A run's own MCP server and the runner's freshness pass can both be writing.
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

export function packEmbedding(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

export function unpackEmbedding(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

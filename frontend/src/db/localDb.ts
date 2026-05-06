/**
 * Local Database — singleton PGlite wrapper
 *
 * All WASM execution happens in pglite.worker.ts off the main thread.
 * This module exposes:
 *   - getLocalDb()   — Drizzle client backed by PGliteWorker (lazy init)
 *   - getWorker()    — raw PGliteWorker for parameterised SQL not covered by Drizzle
 *   - initLocalDb()  — explicit bootstrap (called once in main.ts)
 *
 * Schema is applied via DDL on first boot; subsequent loads skip
 * existing tables/indexes due to IF NOT EXISTS guards.
 */
import { PGliteWorker } from '@electric-sql/pglite/worker'
import { drizzle } from 'drizzle-orm/pglite'
import * as schema from './localSchema'

type LocalDrizzle = ReturnType<typeof drizzle<typeof schema>>

// ---------------------------------------------------------------------------
// Singletons
// ---------------------------------------------------------------------------

let _worker: PGliteWorker | null = null
let _db: LocalDrizzle | null = null
let _initPromise: Promise<void> | null = null

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Returns the Drizzle client. Waits for init if not yet complete. */
export async function getLocalDb(): Promise<LocalDrizzle> {
  await initLocalDb()
  return _db!
}

/** Returns raw PGliteWorker for complex SQL (RRF, tsvector, vector queries). */
export async function getWorker(): Promise<PGliteWorker> {
  await initLocalDb()
  return _worker!
}

/** Idempotent bootstrap — safe to call multiple times. */
export async function initLocalDb(): Promise<void> {
  if (_db) return
  if (_initPromise) return _initPromise

  _initPromise = (async () => {
    _worker = new PGliteWorker(
      new Worker(new URL('../workers/pglite.worker.ts', import.meta.url), { type: 'module' }),
    )

    await _worker.waitReady

    // drizzle-orm/pglite accepts PGliteWorker as a drop-in for PGlite.
    // The worker wrapper type does not line up with drizzle's overloads cleanly.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _db = drizzle(_worker as any, { schema })

    await applySchema(_worker)
  })()

  return _initPromise
}

// ---------------------------------------------------------------------------
// DDL — applied once on startup
// ---------------------------------------------------------------------------

async function applySchema(pg: PGliteWorker): Promise<void> {
  // pgvector extension (loaded in the worker, but the SQL command is idempotent)
  await pg.exec(`CREATE EXTENSION IF NOT EXISTS vector;`)

  await pg.exec(`
    CREATE TABLE IF NOT EXISTS local_posts (
      id                       TEXT        PRIMARY KEY,
      content                  TEXT        NOT NULL,
      created_at               TIMESTAMPTZ,
      is_public                BOOLEAN     NOT NULL DEFAULT TRUE,
      author_id                INTEGER,
      author_name              TEXT        NOT NULL,
      author_web_id            TEXT        NOT NULL,
      author_provider_endpoint TEXT        NOT NULL DEFAULT '',
      author_avatar            TEXT,
      source                   TEXT        NOT NULL,
      at_uri                   TEXT,
      object_uri               TEXT,
      synced_at                TIMESTAMPTZ DEFAULT now(),
      embedding                vector(384),
      content_tsv              tsvector
    );

    ALTER TABLE local_posts ADD COLUMN IF NOT EXISTS object_uri TEXT;
    ALTER TABLE local_posts ADD COLUMN IF NOT EXISTS author_avatar TEXT;

    CREATE TABLE IF NOT EXISTS sync_state (
      entity         TEXT        PRIMARY KEY,
      last_synced_at TIMESTAMPTZ,
      cursor         TEXT
    );

    CREATE TABLE IF NOT EXISTS pending_writes (
      id           TEXT        PRIMARY KEY,
      entity       TEXT        NOT NULL,
      method       TEXT        NOT NULL,
      path         TEXT        NOT NULL,
      payload      TEXT        NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT now(),
      attempted_at TIMESTAMPTZ,
      fail_count   INTEGER     NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS local_follows (
      object_uri  TEXT        PRIMARY KEY,
      followed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS local_bookmarks (
      post_id       TEXT        PRIMARY KEY,
      bookmarked_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)

  // HNSW index for approximate nearest-neighbour vector search (cosine)
  await pg.exec(`
    CREATE INDEX IF NOT EXISTS local_posts_embedding_hnsw
      ON local_posts USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64);
  `)

  // GIN index for full-text search
  await pg.exec(`
    CREATE INDEX IF NOT EXISTS local_posts_tsv_gin
      ON local_posts USING gin (content_tsv);
  `)

  // Keep timeline reads and cursor-style scans fast as local cache grows.
  await pg.exec(`
    CREATE INDEX IF NOT EXISTS local_posts_created_at_idx
      ON local_posts (created_at DESC);
  `)

  // Speeds up background embedding selection/count of rows still missing vectors.
  await pg.exec(`
    CREATE INDEX IF NOT EXISTS local_posts_embedding_pending_idx
      ON local_posts (id)
      WHERE embedding IS NULL;
  `)

  // Preserves FIFO replay order for offline mutations and avoids full scans.
  await pg.exec(`
    CREATE INDEX IF NOT EXISTS pending_writes_created_at_idx
      ON pending_writes (created_at ASC);
  `)
}

/**
 * Wipe all user-data rows from the local PGlite database.
 *
 * Used for private logout: a subsequent user on the same device cannot read
 * another account's cached posts, follows, or pending writes.
 *
 * The schema (table definitions, indexes) is preserved; only rows are removed.
 * On next login, syncStore.syncFeed() will re-populate from the pod.
 */
export async function clearLocalData(): Promise<void> {
  const pg = await getWorker()
  await pg.exec(`
    TRUNCATE
      local_posts,
      sync_state,
      pending_writes,
      local_follows,
      local_bookmarks
    RESTART IDENTITY CASCADE;
  `)
}

/**
 * Full device reset: drop the entire IndexedDB database.
 *
 * Used for device-reset logout mode (device handoff, security incident).
 * The PGlite worker process is terminated; the DB is recreated on next boot.
 */
export async function clearAllAppStorage(): Promise<void> {
  // Terminate the worker so PGlite releases its IndexedDB lock.
  if (_worker) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (_worker as any).close?.()
    } catch {
      // Ignore close failures and continue best-effort cleanup.
    }
    _worker = null
    _db = null
    _initPromise = null
  }

  if (typeof indexedDB === 'undefined') {
    return
  }

  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('paper-atproto-db')
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    req.onblocked = () => {
      // Another tab still has the DB open; resolve and allow eventual cleanup.
      resolve()
    }
  })
}

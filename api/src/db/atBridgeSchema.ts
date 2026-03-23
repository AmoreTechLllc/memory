/**
 * AT Protocol Bridge — Database Schema
 *
 * Extends the memory app's existing schema with tables that store
 * federated AT Protocol content received via the Phase 5.5 ingress pipeline.
 *
 * Design principles:
 *   - AT content is stored separately from ActivityPods content to preserve
 *     provenance and allow independent lifecycle management.
 *   - The atPosts table mirrors the structure of the existing posts table
 *     so the frontend can render both sources uniformly.
 *   - The atIdentities table caches DID → handle mappings for display.
 *   - All AT-sourced content is marked with its source DID and rkey for
 *     deduplication and AT URI reconstruction.
 *
 * Security notes:
 *   - Content is stored as received; sanitisation happens at render time.
 *   - The sourceUrl field is validated before storage.
 *   - No user credentials are stored in this schema.
 */

import { text, serial, pgTable as table, timestamp, boolean, integer, varchar, jsonb, pgView } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './schema'

// ---------------------------------------------------------------------------
// AT Identities (DID → handle cache)
// ---------------------------------------------------------------------------

/**
 * Caches resolved AT Protocol identities for display in the UI.
 * Updated whenever an #identity event is processed by the verifier.
 */
export const atIdentities = table('at_identities', {
  id: serial().primaryKey(),

  /** ATProto DID (e.g. did:plc:abc123). */
  did: varchar('did', { length: 2048 }).notNull().unique(),

  /** Current handle (e.g. alice.bsky.social). May be null if unresolved. */
  handle: varchar('handle', { length: 512 }),

  /** Full DID document as JSON. */
  didDocument: jsonb('did_document'),

  /** Whether this identity is currently active. */
  isActive: boolean('is_active').notNull().default(true),

  /** ISO-8601 timestamp of last successful resolution. */
  resolvedAt: timestamp('resolved_at', { withTimezone: true }).defaultNow(),

  /** ISO-8601 timestamp of last update from the ingress pipeline. */
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),

  /**
   * Optional link to a local memory user.
   * Set when a local user has linked their AT identity.
   */
  localUserId: integer('local_user_id').references(() => users.id),
})

// ---------------------------------------------------------------------------
// AT Posts (federated content from the AT firehose)
// ---------------------------------------------------------------------------

/**
 * Stores AT Protocol posts received via the Phase 5.5 ingress pipeline.
 * These are posts from external ATProto users that are relevant to local users
 * (e.g. followed accounts, mentioned users).
 */
export const atPosts = table('at_posts', {
  id: serial().primaryKey(),

  /** ATProto DID of the author. */
  authorDid: varchar('author_did', { length: 2048 }).notNull(),

  /** ATProto record key (rkey) for deduplication. */
  rkey: varchar('rkey', { length: 512 }).notNull(),

  /** Full AT URI (at://did:plc:xxx/app.bsky.feed.post/rkey). */
  atUri: varchar('at_uri', { length: 3072 }).notNull().unique(),

  /** Content-addressed CID of the record. */
  cid: varchar('cid', { length: 512 }),

  /** Post text content. */
  content: text('content').notNull(),

  /** Whether this post is publicly visible. */
  isPublic: boolean('is_public').notNull().default(true),

  /** Facets (mentions, links, tags) as JSON. */
  facets: jsonb('facets'),

  /** Embed data (images, external links, quotes) as JSON. */
  embeds: jsonb('embeds'),

  /** AT URI of the parent post if this is a reply. */
  replyParentUri: varchar('reply_parent_uri', { length: 3072 }),

  /** AT URI of the root post in the reply thread. */
  replyRootUri: varchar('reply_root_uri', { length: 3072 }),

  /** ISO-8601 timestamp from the ATProto record. */
  createdAt: timestamp('created_at', { withTimezone: true }),

  /** ISO-8601 timestamp of local ingestion. */
  ingestedAt: timestamp('ingested_at', { withTimezone: true }).defaultNow(),

  /** Upstream firehose source (e.g. wss://relay.bsky.network). */
  sourceRelay: varchar('source_relay', { length: 512 }),

  /** ATProto firehose sequence number for ordering and deduplication. */
  firehoseSeq: integer('firehose_seq'),
})

// ---------------------------------------------------------------------------
// AT Firehose Cursor State (for UI observability)
// ---------------------------------------------------------------------------

/**
 * Exposes the current firehose cursor state for each source relay.
 * Used by the admin UI to monitor ingestion health.
 */
export const atFirehoseCursors = table('at_firehose_cursors', {
  id: serial().primaryKey(),

  /** Source relay identifier (e.g. wss://relay.bsky.network). */
  sourceId: varchar('source_id', { length: 512 }).notNull().unique(),

  /** Source type: relay or PDS. */
  sourceType: varchar('source_type', { length: 16 }).notNull().default('relay'),

  /** Last committed cursor seq number. */
  committedSeq: integer('committed_seq'),

  /** Last hot cursor seq number. */
  hotSeq: integer('hot_seq'),

  /** Whether the source is currently connected. */
  isConnected: boolean('is_connected').notNull().default(false),

  /** ISO-8601 timestamp of last event received. */
  lastEventAt: timestamp('last_event_at', { withTimezone: true }),

  /** ISO-8601 timestamp of last cursor commit. */
  lastCommitAt: timestamp('last_commit_at', { withTimezone: true }),

  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

// ---------------------------------------------------------------------------
// Unified Feed View (AT + ActivityPods posts)
// ---------------------------------------------------------------------------

/**
 * A unified view combining ActivityPods posts and AT Protocol posts for the
 * memory UI's home feed.  Both sources are normalised to the same shape.
 */
export const unifiedFeedView = pgView('unified_feed_view', {
  id: serial().primaryKey(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }),
  isPublic: boolean('is_public').notNull(),
  authorId: integer('author_id'),
  authorName: text('author_name').notNull(),
  authorWebId: text('author_web_id').notNull(),
  authorProviderEndpoint: text('author_provider_endpoint').notNull(),
  /** 'activitypods' | 'atproto' */
  source: varchar('source', { length: 32 }).notNull(),
  /** AT URI for ATProto posts, null for ActivityPods posts. */
  atUri: varchar('at_uri', { length: 3072 }),
}).as(sql`
  SELECT
    posts.id,
    posts.content,
    posts.created_at,
    posts.is_public,
    posts.author_id,
    users.name as author_name,
    users.web_id as author_web_id,
    users.provider_endpoint as author_provider_endpoint,
    'activitypods' as source,
    NULL::varchar as at_uri
  FROM posts
  INNER JOIN users ON posts.author_id = users.id
  WHERE posts.is_public = true

  UNION ALL

  SELECT
    at_posts.id,
    at_posts.content,
    at_posts.created_at,
    at_posts.is_public,
    NULL::integer as author_id,
    COALESCE(at_identities.handle, at_posts.author_did) as author_name,
    at_posts.author_did as author_web_id,
    '' as author_provider_endpoint,
    'atproto' as source,
    at_posts.at_uri
  FROM at_posts
  LEFT JOIN at_identities ON at_posts.author_did = at_identities.did
  WHERE at_posts.is_public = true
`)

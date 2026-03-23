-- V6.5 Phase 5.5: AT Protocol Bridge — Database Migration
-- Creates tables for AT Protocol federated content storage

-- AT Identities: DID → handle cache
CREATE TABLE IF NOT EXISTS at_identities (
  id SERIAL PRIMARY KEY,
  did VARCHAR(2048) NOT NULL UNIQUE,
  handle VARCHAR(512),
  did_document JSONB,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  resolved_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  local_user_id INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_at_identities_did ON at_identities(did);
CREATE INDEX IF NOT EXISTS idx_at_identities_handle ON at_identities(handle);

-- AT Posts: federated content from the AT firehose
CREATE TABLE IF NOT EXISTS at_posts (
  id SERIAL PRIMARY KEY,
  author_did VARCHAR(2048) NOT NULL,
  rkey VARCHAR(512) NOT NULL,
  at_uri VARCHAR(3072) NOT NULL UNIQUE,
  cid VARCHAR(512),
  content TEXT NOT NULL,
  is_public BOOLEAN NOT NULL DEFAULT TRUE,
  facets JSONB,
  embeds JSONB,
  reply_parent_uri VARCHAR(3072),
  reply_root_uri VARCHAR(3072),
  created_at TIMESTAMPTZ,
  ingested_at TIMESTAMPTZ DEFAULT NOW(),
  source_relay VARCHAR(512),
  firehose_seq INTEGER
);

CREATE INDEX IF NOT EXISTS idx_at_posts_author_did ON at_posts(author_did);
CREATE INDEX IF NOT EXISTS idx_at_posts_at_uri ON at_posts(at_uri);
CREATE INDEX IF NOT EXISTS idx_at_posts_created_at ON at_posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_at_posts_firehose_seq ON at_posts(firehose_seq);

-- AT Firehose Cursors: ingestion health tracking
CREATE TABLE IF NOT EXISTS at_firehose_cursors (
  id SERIAL PRIMARY KEY,
  source_id VARCHAR(512) NOT NULL UNIQUE,
  source_type VARCHAR(16) NOT NULL DEFAULT 'relay',
  committed_seq INTEGER,
  hot_seq INTEGER,
  is_connected BOOLEAN NOT NULL DEFAULT FALSE,
  last_event_at TIMESTAMPTZ,
  last_commit_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_at_firehose_cursors_source_id ON at_firehose_cursors(source_id);

-- Unified Feed View: AT + ActivityPods posts
CREATE OR REPLACE VIEW unified_feed_view AS
  SELECT
    posts.id,
    posts.content,
    posts.created_at,
    posts.is_public,
    posts.author_id,
    users.name as author_name,
    users.web_id as author_web_id,
    users.provider_endpoint as author_provider_endpoint,
    'activitypods'::varchar as source,
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
    ''::text as author_provider_endpoint,
    'atproto'::varchar as source,
    at_posts.at_uri
  FROM at_posts
  LEFT JOIN at_identities ON at_posts.author_did = at_identities.did
  WHERE at_posts.is_public = true;

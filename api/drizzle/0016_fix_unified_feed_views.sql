-- Recreate unified_feed_view with full column set (hashtags, post_type,
-- reply_parent_uri, reply_root_uri, author_avatar, canonical_url, etc.)
-- and create the missing unified_feed_candidates_view.

DROP VIEW IF EXISTS unified_feed_candidates_view;
DROP VIEW IF EXISTS unified_feed_view;

CREATE VIEW unified_feed_view AS
  SELECT
    posts.id,
    posts.content,
    posts.hashtags,
    posts.post_type,
    posts.name as title,
    posts.summary,
    COALESCE(posts.canonical_url, posts.object_uri) as canonical_url,
    posts.created_at,
    posts.is_public,
    posts.author_id,
    users.name as author_name,
    users.web_id as author_web_id,
    users.provider_endpoint as author_provider_endpoint,
    NULL::varchar as author_avatar,
    'activitypods' as source,
    NULL::varchar as at_uri,
    posts.object_uri,
    posts.reply_parent_uri,
    posts.reply_root_uri
  FROM posts
  INNER JOIN users ON posts.author_id = users.id
  WHERE posts.is_public = true

  UNION ALL

  SELECT
    at_posts.id,
    at_posts.content,
    COALESCE(
      ARRAY(
        SELECT DISTINCT '#' || lower(trim(feature->>'tag'))
        FROM jsonb_array_elements(COALESCE(at_posts.facets, '[]'::jsonb)) facet,
             jsonb_array_elements(COALESCE(facet->'features', '[]'::jsonb)) feature
        WHERE feature ? 'tag' AND length(trim(feature->>'tag')) > 0
      ),
      ARRAY[]::text[]
    ) as hashtags,
    at_posts.post_type,
    at_posts.title,
    at_posts.summary,
    at_posts.canonical_url,
    at_posts.created_at,
    at_posts.is_public,
    NULL::integer as author_id,
    COALESCE(at_identities.handle, at_posts.author_did) as author_name,
    at_posts.author_did as author_web_id,
    '' as author_provider_endpoint,
    at_identities.avatar_url as author_avatar,
    'atproto' as source,
    at_posts.at_uri,
    NULL::text as object_uri,
    at_posts.reply_parent_uri,
    at_posts.reply_root_uri
  FROM at_posts
  LEFT JOIN at_identities ON at_posts.author_did = at_identities.did
  WHERE at_posts.is_public = true

  UNION ALL

  SELECT
    ap_remote_posts.id,
    ap_remote_posts.content,
    COALESCE(ap_remote_posts.hashtags, ARRAY[]::text[]) as hashtags,
    ap_remote_posts.post_type,
    ap_remote_posts.title,
    ap_remote_posts.summary,
    COALESCE(ap_remote_posts.canonical_url, ap_remote_posts.object_uri) as canonical_url,
    ap_remote_posts.created_at,
    ap_remote_posts.is_public,
    NULL::integer as author_id,
    ap_remote_posts.author_name as author_name,
    ap_remote_posts.author_web_id as author_web_id,
    COALESCE(ap_remote_posts.author_domain, '') as author_provider_endpoint,
    ap_actor_cache.avatar_url as author_avatar,
    'activitypods' as source,
    NULL::varchar as at_uri,
    ap_remote_posts.object_uri,
    ap_remote_posts.reply_parent_uri,
    ap_remote_posts.reply_root_uri
  FROM ap_remote_posts
  LEFT JOIN ap_actor_cache ON ap_remote_posts.author_web_id = ap_actor_cache.actor_uri
  WHERE ap_remote_posts.is_public = true;

CREATE VIEW unified_feed_candidates_view AS
  SELECT
    ufv.*,
    COALESCE(ufv.at_uri, ufv.object_uri) AS candidate_uri,
    te.parent_author_id AS thread_parent_author_id,
    te.root_author_id AS thread_root_author_id,
    ts.reply_count AS thread_reply_count,
    ts.participant_count AS thread_participant_count,
    ts.last_activity_at AS thread_last_activity_at
  FROM unified_feed_view ufv
  LEFT JOIN thread_edges te ON te.item_uri = COALESCE(ufv.at_uri, ufv.object_uri)
  LEFT JOIN thread_stats ts ON ts.root_uri = COALESCE(te.root_uri, COALESCE(ufv.at_uri, ufv.object_uri));

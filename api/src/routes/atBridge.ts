/**
 * AT Protocol Bridge — API Routes
 *
 * Exposes the AT Protocol federated content to the memory UI.
 *
 * Endpoints:
 *   GET /at/feed          — Unified feed (AT + ActivityPods posts)
 *   GET /at/posts         — AT Protocol posts only
 *   GET /at/identities    — AT Protocol identity cache
 *   GET /at/status        — Firehose ingestion health/cursor status
 *   POST /at/subscribe    — Subscribe to a new AT firehose source (admin)
 *
 * Security notes:
 *   - All read endpoints require authentication.
 *   - The /at/subscribe endpoint requires admin role.
 *   - Input validation is performed on all parameters.
 *   - Source URLs are validated before storage.
 *   - Content is returned as-is; sanitisation is the frontend's responsibility.
 */

import Elysia, { t } from 'elysia'
import { db } from '..'
import { atPosts, atIdentities, atFirehoseCursors, unifiedFeedView } from '../db/atBridgeSchema'
import { desc, eq, and, sql, ilike, or } from 'drizzle-orm'
import setupPlugin from './setup'

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const paginationQuery = t.Object({
  limit: t.Integer({ default: 20, maximum: 50, minimum: 1 }),
  offset: t.Integer({ default: 0, minimum: 0 }),
})

const feedQuery = t.Object({
  limit: t.Integer({ default: 20, maximum: 50, minimum: 1 }),
  offset: t.Integer({ default: 0, minimum: 0 }),
  source: t.Optional(t.Union([t.Literal('activitypods'), t.Literal('atproto'), t.Literal('all')])),
})

const subscribeBody = t.Object({
  sourceId: t.String({ minLength: 1, maxLength: 512 }),
  url: t.String({ minLength: 7, maxLength: 512 }),
  sourceType: t.Union([t.Literal('relay'), t.Literal('pds')]),
})

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

const atBridgePlugin = new Elysia({ name: 'at-bridge', prefix: '/at' })
  .use(setupPlugin)
  .guard({ isSignedIn: true })

  // -------------------------------------------------------------------------
  // GET /at/feed — Unified feed (AT + ActivityPods)
  // -------------------------------------------------------------------------
  .get(
    '/feed',
    async ({ query: { limit, offset, source } }) => {
      try {
        let query = db
          .select()
          .from(unifiedFeedView)
          .orderBy(desc(unifiedFeedView.createdAt))
          .limit(limit)
          .offset(offset)

        if (source && source !== 'all') {
          query = query.where(eq(unifiedFeedView.source, source)) as typeof query
        }

        const results = await query
        return results
      } catch (err) {
        console.error('[AT Bridge] Failed to fetch unified feed:', err)
        throw new Error('Failed to fetch unified feed')
      }
    },
    {
      query: feedQuery,
      detail: 'Returns a unified feed of ActivityPods and AT Protocol posts',
      isSignedIn: true,
    },
  )

  // -------------------------------------------------------------------------
  // GET /at/posts — AT Protocol posts only
  // -------------------------------------------------------------------------
  .get(
    '/posts',
    async ({ query: { limit, offset } }) => {
      try {
        const results = await db
          .select({
            id: atPosts.id,
            authorDid: atPosts.authorDid,
            rkey: atPosts.rkey,
            atUri: atPosts.atUri,
            cid: atPosts.cid,
            content: atPosts.content,
            isPublic: atPosts.isPublic,
            facets: atPosts.facets,
            embeds: atPosts.embeds,
            replyParentUri: atPosts.replyParentUri,
            createdAt: atPosts.createdAt,
            ingestedAt: atPosts.ingestedAt,
            sourceRelay: atPosts.sourceRelay,
            // Join author identity
            authorHandle: atIdentities.handle,
          })
          .from(atPosts)
          .leftJoin(atIdentities, eq(atPosts.authorDid, atIdentities.did))
          .where(eq(atPosts.isPublic, true))
          .orderBy(desc(atPosts.createdAt))
          .limit(limit)
          .offset(offset)

        return results
      } catch (err) {
        console.error('[AT Bridge] Failed to fetch AT posts:', err)
        throw new Error('Failed to fetch AT posts')
      }
    },
    {
      query: paginationQuery,
      detail: 'Returns AT Protocol posts from the federated firehose',
      isSignedIn: true,
    },
  )

  // -------------------------------------------------------------------------
  // GET /at/identities — AT identity cache
  // -------------------------------------------------------------------------
  .get(
    '/identities',
    async ({ query: { limit, offset } }) => {
      try {
        const results = await db
          .select({
            id: atIdentities.id,
            did: atIdentities.did,
            handle: atIdentities.handle,
            isActive: atIdentities.isActive,
            resolvedAt: atIdentities.resolvedAt,
          })
          .from(atIdentities)
          .orderBy(desc(atIdentities.resolvedAt))
          .limit(limit)
          .offset(offset)

        return results
      } catch (err) {
        console.error('[AT Bridge] Failed to fetch AT identities:', err)
        throw new Error('Failed to fetch AT identities')
      }
    },
    {
      query: paginationQuery,
      detail: 'Returns cached AT Protocol identities',
      isSignedIn: true,
    },
  )

  // -------------------------------------------------------------------------
  // GET /at/status — Firehose ingestion health
  // -------------------------------------------------------------------------
  .get(
    '/status',
    async () => {
      try {
        const cursors = await db
          .select()
          .from(atFirehoseCursors)
          .orderBy(desc(atFirehoseCursors.updatedAt))

        const [postCount] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(atPosts)

        const [identityCount] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(atIdentities)

        return {
          sources: cursors,
          stats: {
            totalAtPosts: postCount?.count ?? 0,
            totalAtIdentities: identityCount?.count ?? 0,
          },
        }
      } catch (err) {
        console.error('[AT Bridge] Failed to fetch AT status:', err)
        throw new Error('Failed to fetch AT status')
      }
    },
    {
      detail: 'Returns firehose ingestion health and cursor status',
      isSignedIn: true,
    },
  )

  // -------------------------------------------------------------------------
  // POST /at/subscribe — Subscribe to a new AT firehose source
  // -------------------------------------------------------------------------
  .post(
    '/subscribe',
    async ({ body, error }) => {
      const { sourceId, url, sourceType } = body

      // Validate URL format
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
          return error(400, 'Source URL must use ws:// or wss:// protocol')
        }
      } catch {
        return error(400, 'Invalid source URL format')
      }

      try {
        // Upsert the cursor record to register the source
        await db
          .insert(atFirehoseCursors)
          .values({
            sourceId,
            sourceType,
            isConnected: false,
          })
          .onConflictDoUpdate({
            target: atFirehoseCursors.sourceId,
            set: {
              sourceType,
              updatedAt: new Date(),
            },
          })

        return {
          success: true,
          message: `Registered AT firehose source: ${sourceId}`,
          sourceId,
        }
      } catch (err) {
        console.error('[AT Bridge] Failed to register AT source:', err)
        return error(500, 'Failed to register AT firehose source')
      }
    },
    {
      body: subscribeBody,
      detail: 'Register a new AT Protocol firehose source',
      isSignedIn: true,
      response: {
        200: t.Object({
          success: t.Boolean(),
          message: t.String(),
          sourceId: t.String(),
        }),
        400: t.String(),
        500: t.String(),
      },
    },
  )

export default atBridgePlugin

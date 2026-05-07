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
import { db } from '../db/client'
import { atPosts, atIdentities, atFirehoseCursors, unifiedFeedView, atRecords, unifiedFeedCandidatesView, apRemotePosts, apActorCache } from '../db/atBridgeSchema'
import { desc, eq, and, sql, ilike, or, gt, inArray, type SQL } from 'drizzle-orm'
import setupPlugin from './setup'
import { extractHashtagsFromFacets, normalizeHashtag } from '../utils/hashtags'
import { mapFeedMetricCounts } from '../utils/feedMetrics'
import { applyFollowedReplyThreadBumps, type ThreadBumpMeta } from '../utils/threadBumps'
import crypto from 'crypto'
import {
  applyViewerThreadMetrics,
  applyViewerWarningFlags,
  appendVisibleThreadWindow,
  buildViewerThreadMetrics,
  filterViewerModeratedRows as filterViewerModeratedRowsBase,
  finalizeVisibleThreadWindow,
  getThreadRootUri,
  isRowHiddenForViewer,
  type ModerationVisibilityAction,
  type ViewerModerationFilter,
  type ViewerModerationState,
  type ViewerThreadMetrics,
} from './atBridgeViewerProjection'
import {
  groupRepostsBySubject,
  REPOST_RECORD_COLLECTIONS,
  type RepostGroup,
  type RepostRecordInput,
} from '../utils/repostGroups'
import ActivityPod from '../services/ActivityPod'

type UnifiedFeedRow = {
  id: number
  content: string
  hashtags: string[]
  postType: 'note' | 'article'
  title: string | null
  summary: string | null
  canonicalUrl: string | null
  hasMedia?: boolean
  moderationWarning?: {
    reason: 'sensitive-media' | 'atproto-labeler'
    message: string
  } | null
  createdAt: Date | null
  isPublic: boolean
  authorId: number | null
  authorName: string
  authorWebId: string
  authorProviderEndpoint: string
  authorAvatar: string | null
  source: 'activitypods' | 'atproto'
  atUri: string | null
  objectUri: string | null
  replyParentUri: string | null
  replyRootUri: string | null
  candidateUri?: string | null
  threadParentAuthorId?: string | null
  threadRootAuthorId?: string | null
  threadReplyCount?: number | null
  threadParticipantCount?: number | null
  threadLastActivityAt?: Date | null
  repostGroup?: RepostGroup | null
  repostCount?: number | null
  likeCount?: number | null
  quoteCount?: number | null
  viewerHasReposted?: boolean
  feedSortAt?: Date | null
}

type FeedItemType = 'post' | 'thread_summary'

type UnifiedFeedResponseItem = Omit<UnifiedFeedRow, 'feedSortAt'> & {
  type: FeedItemType
}

type ThreadContextResponse = {
  rootUri: string
  root: UnifiedFeedResponseItem | null
  items: UnifiedFeedResponseItem[]
  nextCursor: string | null
  hasMore: boolean
  replyCount: number
  participantCount: number
  lastActivityAt: Date | null
}

type FeedCursorPayload = {
  v: 1
  createdAt: string
  id: number
}

type FeedPageResponse = {
  items: UnifiedFeedResponseItem[]
  nextCursor: string | null
  hasMore: boolean
}

type TimelineMode = 'chronological' | 'balanced' | 'following'

type LexiconFamily = 'bsky' | 'standard.site' | 'other'

type AtRecordSummary = {
  title: string | null
  text: string | null
  subjectUri: string | null
  replyParentUri: string | null
  replyRootUri: string | null
  tags: string[]
  languages: string[]
  hasMedia: boolean
}

type AtRecordResponseItem = {
  id: number
  authorDid: string
  collection: string
  lexiconFamily: LexiconFamily
  recordType: string
  rkey: string
  atUri: string
  cid: string | null
  operation: string
  isActive: boolean
  createdAt: Date | null
  ingestedAt: Date | null
  sourceRelay: string | null
  firehoseSeq: number | null
  summary: AtRecordSummary
  record?: Record<string, unknown> | null
}

type ViewershipResolveResponse = {
  viewedObjectIds?: string[]
}

type ViewerModerationAction = 'block' | 'mute'

type DashboardListResponse = {
  data?: Array<Record<string, unknown>>
}

const activityPodsBaseUrl = (process.env.ACTIVITYPODS_URL || '').replace(/\/$/, '')
const activityPodsToken = process.env.ACTIVITYPODS_TOKEN || process.env.INTERNAL_API_TOKEN || ''

function isViewershipIntegrationEnabled(): boolean {
  return activityPodsBaseUrl.length > 0 && activityPodsToken.length > 0
}

const NETWORK_TIMEOUT_MS = 3500
const NETWORK_MAX_RETRIES = 2
const RETRY_BASE_DELAY_MS = 200

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchWithBackoff(url: string, init: RequestInit, timeoutMs = NETWORK_TIMEOUT_MS): Promise<Response> {
  let lastError: unknown = null

  for (let attempt = 0; attempt <= NETWORK_MAX_RETRIES; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, { ...init, signal: controller.signal })
      clearTimeout(timeout)

      // Retry transient upstream failures; preserve immediate failure for client errors.
      if (response.status >= 500 && attempt < NETWORK_MAX_RETRIES) {
        const jitter = Math.floor(Math.random() * 75)
        await delay(RETRY_BASE_DELAY_MS * (2 ** attempt) + jitter)
        continue
      }

      return response
    } catch (error) {
      clearTimeout(timeout)
      lastError = error
      if (attempt >= NETWORK_MAX_RETRIES) {
        throw error
      }
      const jitter = Math.floor(Math.random() * 75)
      await delay(RETRY_BASE_DELAY_MS * (2 ** attempt) + jitter)
    }
  }

  throw (lastError instanceof Error ? lastError : new Error('Network request failed'))
}

function normalizeThreadUri(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 3072) return null
  if (/\s/.test(trimmed)) return null
  return trimmed
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
    const parsed = Number.parseInt(decoded, 10)
    if (!Number.isFinite(parsed) || parsed < 0) return 0
    return parsed
  } catch {
    return 0
  }
}

function encodeFeedCursor(row: UnifiedFeedRow): string | null {
  const createdAt = row.feedSortAt ?? row.createdAt
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) return null

  const payload: FeedCursorPayload = {
    v: 1,
    createdAt: createdAt.toISOString(),
    id: row.id,
  }

  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function decodeFeedCursor(cursor: string | undefined): FeedCursorPayload | null {
  if (!cursor) return null

  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const parsed = JSON.parse(raw) as Partial<FeedCursorPayload>
    if (parsed?.v !== 1) return null
    if (typeof parsed.createdAt !== 'string') return null

    const parsedId = parsed.id
    if (typeof parsedId !== 'number' || !Number.isFinite(parsedId)) return null

    const date = new Date(parsed.createdAt)
    if (Number.isNaN(date.getTime())) return null

    return {
      v: 1,
      createdAt: date.toISOString(),
      id: Math.floor(parsedId),
    }
  } catch {
    return null
  }
}

function isBeforeFeedCursor(row: UnifiedFeedRow, cursor: FeedCursorPayload): boolean {
  const sortAt = row.feedSortAt ?? row.createdAt
  if (!(sortAt instanceof Date) || Number.isNaN(sortAt.getTime())) return false

  const cursorTime = new Date(cursor.createdAt).getTime()
  const rowTime = sortAt.getTime()

  if (rowTime < cursorTime) return true
  if (rowTime > cursorTime) return false
  return row.id < cursor.id
}

function mapFeedItemType(row: UnifiedFeedRow): FeedItemType {
  if (row.replyParentUri || row.replyRootUri) {
    return 'post'
  }

  const replyCount = typeof row.threadReplyCount === 'number' ? row.threadReplyCount : 0
  return replyCount >= 6 ? 'thread_summary' : 'post'
}

function mapFeedItemForResponse(row: UnifiedFeedRow): UnifiedFeedResponseItem {
  const { feedSortAt: _feedSortAt, ...responseRow } = row
  return {
    ...responseRow,
    type: mapFeedItemType(row),
  }
}

function getUserDashboardBaseUrl(user: { endpoint?: string | null }): string | null {
  const endpoint = normalizeString(user.endpoint)
  if (!endpoint) return null
  return endpoint.replace(/\/$/, '')
}

async function fetchViewerDashboardList(
  user: { endpoint?: string | null; token?: string | null },
  container: 'blocks' | 'mutes' | 'filters' | 'preferences' | 'trust-sources',
): Promise<Array<Record<string, unknown>>> {
  const baseUrl = getUserDashboardBaseUrl(user)
  const accessToken = normalizeString(user.token)
  if (!baseUrl || !accessToken) {
    return []
  }

  const response = await fetchWithBackoff(`${baseUrl}/api/dashboard/apps/moderation/${container}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  })

  if (!response.ok) {
    throw new Error(`Viewer moderation lookup failed (${container}): ${response.status}`)
  }

  const payload = (await response.json()) as DashboardListResponse
  return Array.isArray(payload.data)
    ? payload.data.filter((value): value is Record<string, unknown> => !!value && typeof value === 'object')
    : []
}

function normalizeModerationSubjectKey(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : null
}

function normalizeViewerFilter(value: Record<string, unknown>): ViewerModerationFilter | null {
  const action = normalizeString(value.action)?.toLowerCase()
  if (action !== 'hide' && action !== 'warn' && action !== 'filter') {
    return null
  }

  const rawTerms = Array.isArray(value.terms)
    ? value.terms.filter((term): term is string => typeof term === 'string' && term.trim().length > 0)
    : []
  const fallbackPattern = normalizeString(value.pattern)
  const terms = rawTerms.length > 0 ? rawTerms : (fallbackPattern ? [fallbackPattern] : [])
  if (terms.length === 0) return null

  const matchType = normalizeString(value.matchType)?.toLowerCase() === 'phrase' ? 'phrase' : 'word'

  return {
    action,
    matchType,
    terms: terms.map(term => term.trim().toLowerCase()),
    includeHashtagVariants: value.includeHashtagVariants !== false,
  }
}

function normalizeVisibilityAction(value: unknown, fallback: ModerationVisibilityAction): ModerationVisibilityAction {
  if (value === 'off' || value === 'warn' || value === 'hide') {
    return value
  }
  return fallback
}

function getStringPreference(
  preferences: Array<Record<string, unknown>>,
  category: string,
): string | null {
  for (const item of preferences) {
    if (normalizeString(item.category) !== category) continue
    return normalizeString(item.value)
  }
  return null
}

function hasEnabledAtprotoLabelerSource(trustSources: Array<Record<string, unknown>>): boolean {
  return trustSources.some(source => {
    if (normalizeString(source.sourceType) !== 'atproto-labeler') return false
    if (source.enabled === false) return false
    return true
  })
}

async function resolveViewerModerationState(
  user: { endpoint?: string | null; token?: string | null },
): Promise<ViewerModerationState | null> {
  const baseUrl = getUserDashboardBaseUrl(user)
  const accessToken = normalizeString(user.token)
  if (!baseUrl || !accessToken) {
    return null
  }

  const [blocks, mutes, filters, preferences, trustSources] = await Promise.all([
    fetchViewerDashboardList(user, 'blocks'),
    fetchViewerDashboardList(user, 'mutes'),
    fetchViewerDashboardList(user, 'filters'),
    fetchViewerDashboardList(user, 'preferences'),
    fetchViewerDashboardList(user, 'trust-sources'),
  ])

  const hiddenSubjectKeys = new Set<string>()
  for (const item of [...blocks, ...mutes]) {
    const key = normalizeModerationSubjectKey(item.subjectCanonicalId)
    if (key) hiddenSubjectKeys.add(key)
  }

  const sensitiveMediaAction = normalizeVisibilityAction(
    getStringPreference(preferences, 'sensitive-media-display'),
    'warn',
  )

  const atprotoLabelerAction = normalizeVisibilityAction(
    getStringPreference(preferences, 'atproto-labeler-default-action')
      ?? getStringPreference(preferences, 'atproto-labeler-action'),
    sensitiveMediaAction,
  )

  return {
    hiddenSubjectKeys,
    filters: filters
      .map(normalizeViewerFilter)
      .filter((value): value is ViewerModerationFilter => value !== null),
    sensitiveMediaAction,
    atprotoLabelerAction,
    hasEnabledAtprotoLabelers: hasEnabledAtprotoLabelerSource(trustSources),
  }
}

const BSKY_PUBLIC_API = 'https://public.api.bsky.app/xrpc'
const BSKY_PROFILE_BATCH_SIZE = 25

/**
 * For AT rows whose author_name is still a raw DID (handle not yet resolved),
 * batch-fetch handles from the Bluesky public API and upsert into at_identities.
 * Returns a map of did → handle for all DIDs successfully resolved in this call.
 */
async function resolveAndCacheHandles(dids: string[]): Promise<Map<string, string>> {
  const resolved = new Map<string, string>()
  if (dids.length === 0) return resolved

  // Process in batches of BSKY_PROFILE_BATCH_SIZE (API limit is 25).
  for (let i = 0; i < dids.length; i += BSKY_PROFILE_BATCH_SIZE) {
    const batch = dids.slice(i, i + BSKY_PROFILE_BATCH_SIZE)
    const params = batch.map(d => `actors[]=${encodeURIComponent(d)}`).join('&')
    try {
      const resp = await fetch(`${BSKY_PUBLIC_API}/app.bsky.actor.getProfiles?${params}`, {
        signal: AbortSignal.timeout(4000),
        headers: { 'Accept': 'application/json' },
      })
      if (!resp.ok) {
        console.warn('[AT Bridge] getProfiles returned', resp.status, 'for batch', batch.slice(0, 3))
        continue
      }
      const data = await resp.json() as {
        profiles?: Array<{
          did: string
          handle: string
          displayName?: string
          avatar?: string
          banner?: string
          followersCount?: number
          followsCount?: number
          postsCount?: number
        }>
      }
      const profiles = data?.profiles ?? []
      for (const profile of profiles) {
        if (!profile.did || !profile.handle) continue
        resolved.set(profile.did, profile.handle)
      }
      // Upsert resolved handles + profile data into at_identities cache (fire-and-forget; don't block response).
      const upsertValues = profiles
        .filter(p => p.did && p.handle)
        .map(p => ({
          did: p.did,
          handle: p.handle,
          displayName: p.displayName ?? null,
          avatarUrl: p.avatar ?? null,
          bannerUrl: p.banner ?? null,
          followersCount: typeof p.followersCount === 'number' ? p.followersCount : null,
          followsCount: typeof p.followsCount === 'number' ? p.followsCount : null,
          postsCount: typeof p.postsCount === 'number' ? p.postsCount : null,
          isActive: true,
          resolvedAt: new Date(),
          updatedAt: new Date(),
        }))
      if (upsertValues.length > 0) {
        db.insert(atIdentities)
          .values(upsertValues)
          .onConflictDoUpdate({
            target: atIdentities.did,
            set: {
              handle: sql`EXCLUDED.handle`,
              displayName: sql`EXCLUDED.display_name`,
              avatarUrl: sql`EXCLUDED.avatar_url`,
              bannerUrl: sql`EXCLUDED.banner_url`,
              followersCount: sql`EXCLUDED.followers_count`,
              followsCount: sql`EXCLUDED.follows_count`,
              postsCount: sql`EXCLUDED.posts_count`,
              resolvedAt: new Date(),
              updatedAt: new Date(),
            },
          })
          .catch(err => console.warn('[AT Bridge] Failed to cache resolved handles:', err))
      }
    } catch (err) {
      console.warn('[AT Bridge] resolveAndCacheHandles batch failed:', err)
    }
  }
  return resolved
}

function hasEmbedsMedia(embeds: unknown): boolean {
  if (!embeds) return false
  if (Array.isArray(embeds)) return embeds.length > 0
  if (typeof embeds === 'object') return Object.keys(embeds as Record<string, unknown>).length > 0
  return false
}

async function applyAtprotoMediaFlags(rows: UnifiedFeedRow[]): Promise<UnifiedFeedRow[]> {
  const atUris = [...new Set(
    rows
      .filter(row => row.source === 'atproto' && typeof row.atUri === 'string' && row.atUri.length > 0)
      .map(row => row.atUri as string),
  )]

  if (atUris.length === 0) {
    return rows.map(row => ({ ...row, hasMedia: row.hasMedia === true }))
  }

  const atRows = await db
    .select({ atUri: atPosts.atUri, embeds: atPosts.embeds })
    .from(atPosts)
    .where(inArray(atPosts.atUri, atUris))

  const mediaByUri = new Map<string, boolean>()
  for (const row of atRows) {
    mediaByUri.set(row.atUri, hasEmbedsMedia(row.embeds))
  }

  return rows.map(row => {
    if (row.source !== 'atproto') {
      return { ...row, hasMedia: row.hasMedia === true }
    }

    const uri = row.atUri ?? ''
    return {
      ...row,
      hasMedia: mediaByUri.get(uri) === true,
    }
  })
}

/**
 * Maps a raw node-postgres row (snake_case keys) to the typed UnifiedFeedRow shape.
 */
function mapDbRowToFeedRow(row: Record<string, unknown>): UnifiedFeedRow {
  const metrics = mapFeedMetricCounts(row)
  const parseDate = (v: unknown): Date | null => {
    if (!v) return null
    if (v instanceof Date) return v
    const d = new Date(v as string)
    return isNaN(d.getTime()) ? null : d
  }
  return {
    id: row['id'] as number,
    content: row['content'] as string,
    hashtags: (row['hashtags'] as string[] | null) ?? [],
    postType: row['post_type'] as 'note' | 'article',
    title: row['title'] as string | null,
    summary: row['summary'] as string | null,
    canonicalUrl: row['canonical_url'] as string | null,
    hasMedia: row['has_media'] === true,
    createdAt: parseDate(row['created_at']),
    isPublic: row['is_public'] as boolean,
    authorId: row['author_id'] as number | null,
    authorName: row['author_name'] as string,
    authorWebId: row['author_web_id'] as string,
    authorProviderEndpoint: row['author_provider_endpoint'] as string,
    authorAvatar: (row['author_avatar'] as string | null) ?? null,
    source: row['source'] as 'activitypods' | 'atproto',
    atUri: row['at_uri'] as string | null,
    objectUri: row['object_uri'] as string | null,
    replyParentUri: row['reply_parent_uri'] as string | null,
    replyRootUri: row['reply_root_uri'] as string | null,
    candidateUri: row['candidate_uri'] as string | null,
    threadParentAuthorId: row['thread_parent_author_id'] as string | null,
    threadRootAuthorId: row['thread_root_author_id'] as string | null,
    threadReplyCount: row['thread_reply_count'] as number | null,
    threadParticipantCount: row['thread_participant_count'] as number | null,
    threadLastActivityAt: parseDate(row['thread_last_activity_at']),
    likeCount: metrics.likeCount,
    quoteCount: metrics.quoteCount,
  }
}

function feedRowUri(row: UnifiedFeedRow): string | null {
  return normalizeString(row.atUri) ?? normalizeString(row.objectUri) ?? normalizeString(row.candidateUri)
}

function applyRepostGroupToRow(row: UnifiedFeedRow, repostGroup: RepostGroup): UnifiedFeedRow {
  return {
    ...row,
    repostGroup,
    repostCount: repostGroup.count,
    viewerHasReposted: repostGroup.viewerHasReposted,
    feedSortAt: repostGroup.boostedAt > (row.feedSortAt ?? row.createdAt ?? new Date(0))
      ? repostGroup.boostedAt
      : row.feedSortAt,
  }
}

function mergeRepostRows(baseRows: UnifiedFeedRow[], repostRows: UnifiedFeedRow[], fetchLimit: number): UnifiedFeedRow[] {
  const byUri = new Map<string, UnifiedFeedRow>()
  const fallbackRows: UnifiedFeedRow[] = []

  for (const row of baseRows) {
    const uri = feedRowUri(row)
    const normalized = { ...row, feedSortAt: row.feedSortAt ?? row.createdAt }
    if (uri) byUri.set(uri, normalized)
    else fallbackRows.push(normalized)
  }

  for (const row of repostRows) {
    const uri = feedRowUri(row)
    if (!uri) {
      fallbackRows.push(row)
      continue
    }

    const existing = byUri.get(uri)
    if (!existing) {
      byUri.set(uri, row)
      continue
    }

    if (row.repostGroup) {
      byUri.set(uri, applyRepostGroupToRow(existing, row.repostGroup))
    }
  }

  return [...byUri.values(), ...fallbackRows]
    .sort((a, b) => feedSortTimestamp(b) - feedSortTimestamp(a))
    .slice(0, fetchLimit)
}

async function loadRepostCandidateRows(params: {
  fetchLimit: number
  source?: string | null
  hashtag?: string | null
  sinceDate?: Date | null
  viewerIds?: ReadonlySet<string>
}): Promise<UnifiedFeedRow[]> {
  const { fetchLimit, source, hashtag, sinceDate, viewerIds = new Set<string>() } = params

  const recordFilters: SQL[] = [
    eq(atRecords.isActive, true),
    inArray(atRecords.collection, [...REPOST_RECORD_COLLECTIONS]),
  ]
  if (sinceDate) {
    recordFilters.push(gt(atRecords.createdAt, sinceDate))
  }

  const boostRecords = await db
    .select({
      authorId: atRecords.authorDid,
      authorDisplayName: atIdentities.handle,
      collection: atRecords.collection,
      record: atRecords.record,
      createdAt: atRecords.createdAt,
      repostUri: atRecords.atUri,
    })
    .from(atRecords)
    .leftJoin(atIdentities, eq(atRecords.authorDid, atIdentities.did))
    .where(and(...recordFilters))
    .orderBy(desc(atRecords.createdAt))
    .limit(Math.min(500, fetchLimit * 5))

  const repostGroups = groupRepostsBySubject(boostRecords as RepostRecordInput[], viewerIds)
  if (repostGroups.size === 0) return []

  const subjectUris = [...repostGroups.keys()]
  const atSubjects = subjectUris.filter(uri => uri.startsWith('at://'))
  const apSubjects = subjectUris.filter(uri => !uri.startsWith('at://'))
  const subjectConditions: SQL[] = []

  if (atSubjects.length > 0) subjectConditions.push(inArray(unifiedFeedCandidatesView.atUri, atSubjects))
  if (apSubjects.length > 0) subjectConditions.push(inArray(unifiedFeedCandidatesView.objectUri, apSubjects))
  if (subjectConditions.length === 0) return []

  const rowFilters: SQL[] = [
    subjectConditions.length === 1 ? subjectConditions[0] : or(...subjectConditions)!,
    eq(unifiedFeedCandidatesView.isPublic, true),
  ]

  if (source && source !== 'all') {
    rowFilters.push(eq(unifiedFeedCandidatesView.source, source))
  }

  const normalizedTag = hashtag ? normalizeHashtag(hashtag) : null
  if (normalizedTag) {
    const tagPattern = `%${normalizedTag}%`
    rowFilters.push(or(
      ilike(unifiedFeedCandidatesView.content, tagPattern),
      sql`${unifiedFeedCandidatesView.hashtags} @> ARRAY[${normalizedTag}]::text[]`,
    )!)
  }

  const rows = (await db
    .select()
    .from(unifiedFeedCandidatesView)
    .where(and(...rowFilters))) as UnifiedFeedRow[]

  const repostRows: UnifiedFeedRow[] = []
  for (const row of rows) {
    const uri = feedRowUri(row)
    const repostGroup = uri ? repostGroups.get(uri) : null
    if (!repostGroup) continue
    repostRows.push({
        ...row,
        repostGroup,
        repostCount: repostGroup.count,
        viewerHasReposted: repostGroup.viewerHasReposted,
        feedSortAt: repostGroup.boostedAt,
    })
  }

  return repostRows
}

/**
 * Fast feed query using MATERIALIZED CTEs to push LIMIT before thread joins.
 * Prevents PostgreSQL from scanning all 3M+ rows before applying LIMIT — a
 * 530× improvement over the equivalent view-based query (36 s → ~70 ms).
 */
async function queryFeedCandidates(params: {
  fetchLimit: number
  source?: string | null
  hashtag?: string | null
  sinceDate?: Date | null
  viewerIds?: ReadonlySet<string>
}): Promise<UnifiedFeedRow[]> {
  const { fetchLimit, source, hashtag, sinceDate, viewerIds } = params
  const includeAt = !source || source === 'all' || source === 'atproto'
  const includeAp = !source || source === 'all' || source === 'activitypods'
  const normalizedTag = hashtag ? normalizeHashtag(hashtag) : null

  // Build query as a plain string with inline params to avoid Drizzle template
  // parser misinterpreting PostgreSQL array path literals like '{subject,uri}'
  const lim = String(fetchLimit) // safe integer, inline directly
  const esc = (v: string) => `'${v.replace(/'/g, "''")}'` // SQL string escape

  // Per-source WHERE clauses
  const atWhereParts: string[] = ['ap.is_public = true']
  const apWhereParts: string[] = ['p.is_public = true']

  if (normalizedTag) {
    const tagPattern = `%${normalizedTag}%`
    atWhereParts.push(`(ap.content ILIKE ${esc(tagPattern)} OR ap.hashtags @> ARRAY[${esc(normalizedTag)}]::text[])`)
    apWhereParts.push(`(p.content ILIKE ${esc(tagPattern)} OR p.hashtags @> ARRAY[${esc(normalizedTag)}]::text[])`)
  }
  if (sinceDate) {
    const isoDate = sinceDate.toISOString()
    atWhereParts.push(`ap.created_at > ${esc(isoDate)}::timestamptz`)
    apWhereParts.push(`p.created_at > ${esc(isoDate)}::timestamptz`)
  }

  const atWhere = atWhereParts.join(' AND ')
  const apWhere = apWhereParts.join(' AND ')

  const cteFragments: string[] = []
  const unionArms: string[] = []

  if (includeAt) {
    cteFragments.push(`at_limited AS MATERIALIZED (
      SELECT
        ap.id, ap.content, COALESCE(ap.hashtags, ARRAY[]::text[]) AS hashtags,
        ap.post_type, ap.title, ap.summary, ap.canonical_url,
        (CASE
          WHEN jsonb_typeof(ap.embeds) = 'array' THEN jsonb_array_length(ap.embeds) > 0
          WHEN jsonb_typeof(ap.embeds) = 'object' THEN (SELECT COUNT(*) > 0 FROM jsonb_object_keys(ap.embeds))
          ELSE false
        END) AS has_media,
        ap.created_at, ap.is_public,
        NULL::integer AS author_id,
        COALESCE(ai.handle, ap.author_did) AS author_name,
        ap.author_did AS author_web_id,
        ''::text AS author_provider_endpoint,
        'atproto'::text AS source,
        ap.at_uri, NULL::text AS object_uri,
        ap.reply_parent_uri, ap.reply_root_uri,
        ap.at_uri AS candidate_uri
      FROM at_posts ap
      LEFT JOIN at_identities ai ON ap.author_did = ai.did
      WHERE ${atWhere}
      ORDER BY LEAST(ap.created_at, NOW()) DESC
      LIMIT ${lim}
    )`)
    unionArms.push('SELECT * FROM at_limited')
  }

  if (includeAp) {
    cteFragments.push(`ap_limited AS MATERIALIZED (
      SELECT
        p.id, p.content, p.hashtags,
        p.post_type, p.name AS title, p.summary,
        COALESCE(p.canonical_url, p.object_uri) AS canonical_url,
        false AS has_media,
        p.created_at, p.is_public, p.author_id,
        u.name AS author_name, u.web_id AS author_web_id,
        u.provider_endpoint AS author_provider_endpoint,
        'activitypods'::text AS source,
        NULL::varchar AS at_uri, p.object_uri,
        p.reply_parent_uri, p.reply_root_uri,
        p.object_uri AS candidate_uri
      FROM posts p
      JOIN users u ON p.author_id = u.id
      WHERE ${apWhere}
      ORDER BY p.created_at DESC
      LIMIT ${lim}
    )`)
    unionArms.push('SELECT * FROM ap_limited')

    cteFragments.push(`ap_remote_limited AS MATERIALIZED (
      SELECT
        apr.id, apr.content,
        COALESCE(apr.hashtags, ARRAY[]::text[]) AS hashtags,
        apr.post_type, apr.title, apr.summary,
        COALESCE(apr.canonical_url, apr.object_uri) AS canonical_url,
        false AS has_media,
        LEAST(apr.created_at, NOW()) AS created_at,
        apr.is_public, NULL::integer AS author_id,
        apr.author_name, apr.author_web_id,
        COALESCE(apr.author_domain, '')::text AS author_provider_endpoint,
        'activitypods'::text AS source,
        NULL::varchar AS at_uri, apr.object_uri,
        apr.reply_parent_uri, apr.reply_root_uri,
        apr.object_uri AS candidate_uri
      FROM ap_remote_posts apr
      WHERE apr.is_public = true
      ORDER BY apr.created_at DESC
      LIMIT ${lim}
    )`)
    unionArms.push('SELECT * FROM ap_remote_limited')
  }

  cteFragments.push(`combined AS MATERIALIZED (
    ${unionArms.join(' UNION ALL ')}
  )`)

  cteFragments.push(`candidate_uris AS MATERIALIZED (
    SELECT DISTINCT c.candidate_uri
    FROM combined c
    WHERE c.candidate_uri IS NOT NULL
  )`)

  cteFragments.push(`like_counts AS MATERIALIZED (
    SELECT
      ar.record #>> '{subject,uri}' AS subject_uri,
      COUNT(*)::integer AS like_count
    FROM at_records ar
    WHERE ar.is_active = true
      AND ar.collection = 'app.bsky.feed.like'
      AND (ar.record #>> '{subject,uri}') IN (SELECT candidate_uri FROM candidate_uris)
    GROUP BY 1
  )`)

  cteFragments.push(`quote_counts AS MATERIALIZED (
    SELECT subject_uri, SUM(quote_count)::integer AS quote_count
    FROM (
      SELECT
        COALESCE(
          ap.embeds #>> '{record,uri}',
          ap.embeds #>> '{record,record,uri}',
          ap.embeds #>> '{embed,record,uri}',
          ap.embeds #>> '{embed,record,record,uri}'
        ) AS subject_uri,
        COUNT(*)::integer AS quote_count
      FROM at_posts ap
      WHERE ap.is_public = true
        AND COALESCE(
          ap.embeds #>> '{record,uri}',
          ap.embeds #>> '{record,record,uri}',
          ap.embeds #>> '{embed,record,uri}',
          ap.embeds #>> '{embed,record,record,uri}'
        ) IS NOT NULL
        AND COALESCE(
          ap.embeds #>> '{record,uri}',
          ap.embeds #>> '{record,record,uri}',
          ap.embeds #>> '{embed,record,uri}',
          ap.embeds #>> '{embed,record,record,uri}'
        ) IN (SELECT candidate_uri FROM candidate_uris)
      GROUP BY 1
      UNION ALL
      SELECT
        apr.quoted_post_uri AS subject_uri,
        COUNT(*)::integer AS quote_count
      FROM ap_remote_posts apr
      WHERE apr.quoted_post_uri IS NOT NULL
        AND apr.quoted_post_uri IN (SELECT candidate_uri FROM candidate_uris)
      GROUP BY 1
    ) sub
    GROUP BY subject_uri
  )`)

  const fullQueryText = `
    WITH ${cteFragments.join(', ')}
    SELECT
      c.*,
      te.parent_author_id AS thread_parent_author_id,
      te.root_author_id   AS thread_root_author_id,
      ts.reply_count      AS thread_reply_count,
      ts.participant_count AS thread_participant_count,
      ts.last_activity_at AS thread_last_activity_at,
      COALESCE(lc.like_count, 0)::integer AS like_count,
      COALESCE(qc.quote_count, 0)::integer AS quote_count
    FROM combined c
    LEFT JOIN thread_edges te ON te.item_uri = c.candidate_uri
    LEFT JOIN thread_stats  ts ON ts.root_uri = COALESCE(te.root_uri, c.candidate_uri)
    LEFT JOIN like_counts lc ON lc.subject_uri = c.candidate_uri
    LEFT JOIN quote_counts qc ON qc.subject_uri = c.candidate_uri
    ORDER BY LEAST(c.created_at, NOW()) DESC
    LIMIT ${lim}
  `

  const result = await db.execute(sql.raw(fullQueryText))
  const rows = (result as unknown as { rows: Record<string, unknown>[] }).rows
  const postRows = rows.map(mapDbRowToFeedRow)
  const repostRows = await loadRepostCandidateRows({
    fetchLimit,
    source,
    hashtag,
    sinceDate,
    viewerIds,
  })

  return mergeRepostRows(postRows, repostRows, fetchLimit)
}

function filterViewerModeratedRows(
  rows: UnifiedFeedRow[],
  state: ViewerModerationState | null,
): { visible: UnifiedFeedRow[]; hiddenCount: number } {
  return filterViewerModeratedRowsBase(rows, state)
}

async function loadViewerThreadMetricsByRootUri(
  rootUris: string[],
  moderationState: ViewerModerationState | null,
): Promise<Map<string, ViewerThreadMetrics>> {
  const uniqueRootUris = [...new Set(rootUris.map(uri => uri.trim()).filter(uri => uri.length > 0))]
  const metricsByRootUri = new Map<string, ViewerThreadMetrics>()

  if (uniqueRootUris.length === 0) {
    return metricsByRootUri
  }

  const replyRows = (await db
    .select()
    .from(unifiedFeedCandidatesView)
    .where(
      and(
        or(
          inArray(unifiedFeedCandidatesView.replyRootUri, uniqueRootUris),
          inArray(unifiedFeedCandidatesView.replyParentUri, uniqueRootUris),
        ),
        eq(unifiedFeedCandidatesView.isPublic, true),
      ),
    )
    .orderBy(desc(unifiedFeedCandidatesView.createdAt), desc(unifiedFeedCandidatesView.id))) as UnifiedFeedRow[]

  const visibleRowsByRootUri = new Map<string, UnifiedFeedRow[]>()

  for (const row of replyRows) {
    const rootUri = normalizeString(row.replyRootUri) ?? normalizeString(row.replyParentUri)
    if (!rootUri) continue
    if (moderationState && isRowHiddenForViewer(row, moderationState)) continue

    const existing = visibleRowsByRootUri.get(rootUri)
    if (existing) {
      existing.push(row)
    } else {
      visibleRowsByRootUri.set(rootUri, [row])
    }
  }

  for (const rootUri of uniqueRootUris) {
    metricsByRootUri.set(rootUri, buildViewerThreadMetrics(visibleRowsByRootUri.get(rootUri) ?? []))
  }

  return metricsByRootUri
}

async function applyViewerModerationProjection(
  rows: UnifiedFeedRow[],
  user: { endpoint?: string | null; token?: string | null },
): Promise<{ visible: UnifiedFeedRow[]; hiddenCount: number }> {
  if (rows.length === 0) return { visible: rows, hiddenCount: 0 }

  try {
    const state = await resolveViewerModerationState(user)
    return filterViewerModeratedRows(rows, state)
  } catch (error) {
    console.warn('[AT Bridge] Viewer moderation projection unavailable:', error)
    return { visible: rows, hiddenCount: 0 }
  }
}

async function safeResolveViewerModerationState(
  user: { endpoint?: string | null; token?: string | null },
  contextLabel: 'feed' | 'thread',
): Promise<ViewerModerationState | null> {
  try {
    return await resolveViewerModerationState(user)
  } catch (error) {
    console.warn(`[AT Bridge] ${contextLabel} moderation projection unavailable:`, error)
    return null
  }
}

function deriveModerationSubject(body: {
  source: 'activitypods' | 'atproto'
  authorWebId: string
  atUri?: string | null
}): { subjectCanonicalId: string; subjectProtocol: string } | null {
  if (body.source === 'atproto') {
    const did = body.atUri ? parseAtUri(body.atUri)?.did : null
    const canonical = normalizeString(did) ?? normalizeString(body.authorWebId)
    if (!canonical) return null
    return {
      subjectCanonicalId: canonical,
      subjectProtocol: 'atproto',
    }
  }

  const canonical = normalizeString(body.authorWebId)
  if (!canonical) return null
  return {
    subjectCanonicalId: canonical,
    subjectProtocol: 'activitypub',
  }
}

async function createViewerModerationDecision(
  user: { endpoint?: string | null; token?: string | null },
  action: ViewerModerationAction,
  subject: { subjectCanonicalId: string; subjectProtocol: string },
): Promise<void> {
  const baseUrl = getUserDashboardBaseUrl(user)
  const accessToken = normalizeString(user.token)
  if (!baseUrl || !accessToken) {
    throw new Error('Viewer moderation is unavailable for the current session')
  }

  const container = action === 'block' ? 'blocks' : 'mutes'
  const response = await fetchWithBackoff(`${baseUrl}/api/dashboard/apps/moderation/${container}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ data: subject }),
  })

  if (!response.ok) {
    throw new Error(`Viewer moderation create failed (${action}): ${response.status}`)
  }
}

async function resolveViewedObjectIds(actorId: string, objectIds: string[]): Promise<Set<string>> {
  if (!isViewershipIntegrationEnabled() || objectIds.length === 0) {
    return new Set<string>()
  }

  const response = await fetchWithBackoff(`${activityPodsBaseUrl}/api/internal/viewership-history/resolve`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${activityPodsToken}`,
      'X-API-Key': activityPodsToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ actorId, objectIds })
  })

  if (!response.ok) {
    throw new Error(`Viewership resolve failed: ${response.status}`)
  }

  const payload = (await response.json()) as ViewershipResolveResponse
  const values = Array.isArray(payload.viewedObjectIds)
    ? payload.viewedObjectIds.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : []
  return new Set(values)
}

async function recordViewedObjectIds(actorId: string, objectIds: string[], viewedAt?: string): Promise<void> {
  if (!isViewershipIntegrationEnabled() || objectIds.length === 0) {
    return
  }

  const body: Record<string, unknown> = { actorId, objectIds }
  if (typeof viewedAt === 'string' && viewedAt.trim().length > 0) {
    body.viewedAt = viewedAt
  }

  const response = await fetchWithBackoff(`${activityPodsBaseUrl}/api/internal/viewership-history/record`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${activityPodsToken}`,
      'X-API-Key': activityPodsToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })

  if (!response.ok) {
    throw new Error(`Viewership record failed: ${response.status}`)
  }
}

function feedItemObjectId(row: UnifiedFeedRow): string | null {
  if (typeof row.objectUri === 'string' && row.objectUri.length > 0) {
    return row.objectUri
  }
  if (typeof row.atUri === 'string' && row.atUri.length > 0) {
    return row.atUri
  }
  return null
}

function isRepostableTargetUri(value: string): boolean {
  if (value.startsWith('at://')) return parseAtUri(value) !== null
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

function normalizeRepostTarget(body: { objectUri?: string | null; atUri?: string | null }): string | null {
  const target = normalizeString(body.atUri) ?? normalizeString(body.objectUri)
  if (!target || !isRepostableTargetUri(target)) return null
  return target
}

function stableRepostId(actorId: string, subjectUri: string): string {
  return crypto
    .createHash('sha256')
    .update(`${actorId}\0${subjectUri}`)
    .digest('hex')
    .slice(0, 32)
}

function canonicalRepostUri(actorId: string, subjectUri: string): string {
  return `canonical://share/${stableRepostId(actorId, subjectUri)}`
}

function buildCanonicalShareRecord(
  user: { atprotoDid?: string | null; userName?: string | null; getWebId?: (() => string) | undefined },
  subjectUri: string,
  kind: 'ShareAdd' | 'ShareRemove',
  createdAt: Date,
): Record<string, unknown> {
  const actorWebId = typeof user.getWebId === 'function' ? user.getWebId() : null
  const actorIdentity = normalizeString(user.atprotoDid) ?? normalizeString(actorWebId) ?? 'unknown-actor'
  const actorHandle = normalizeString(user.userName) ?? normalizeString(actorWebId) ?? actorIdentity

  return {
    kind,
    sourceProtocol: subjectUri.startsWith('at://') ? 'atproto' : 'activitypub',
    sourceEventId: canonicalRepostUri(actorIdentity, subjectUri),
    sourceAccountRef: {
      canonicalAccountId: actorIdentity,
      did: normalizeString(user.atprotoDid),
      webId: normalizeString(actorWebId),
      activityPubActorUri: normalizeString(actorWebId),
      handle: actorHandle,
    },
    object: {
      canonicalObjectId: subjectUri,
      atUri: subjectUri.startsWith('at://') ? subjectUri : null,
      activityPubObjectId: subjectUri.startsWith('at://') ? null : subjectUri,
    },
    createdAt: createdAt.toISOString(),
    observedAt: createdAt.toISOString(),
    visibility: { public: true },
    provenance: {
      originProtocol: subjectUri.startsWith('at://') ? 'atproto' : 'activitypub',
      originEventId: subjectUri,
      projectionMode: 'native',
    },
    warnings: [],
    _ingestContract: 'MemoryRepost',
  }
}

function getLexiconFamily(collection: string): LexiconFamily {
  if (collection.startsWith('app.bsky.')) return 'bsky'
  if (collection.startsWith('standard.site.')) return 'standard.site'
  return 'other'
}

function getRecordType(collection: string): string {
  switch (collection) {
    case 'app.bsky.feed.post':
      return 'post'
    case 'app.bsky.feed.like':
      return 'like'
    case 'app.bsky.feed.repost':
      return 'repost'
    case 'app.bsky.graph.follow':
      return 'follow'
    case 'app.bsky.graph.block':
      return 'block'
    case 'app.bsky.actor.profile':
      return 'profile'
    default: {
      const parts = collection.split('.')
      return parts[parts.length - 1] || collection
    }
  }
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
}

function hasMediaEmbed(embed: unknown): boolean {
  if (!embed || typeof embed !== 'object') return false
  const record = embed as Record<string, unknown>
  if (Array.isArray(record.images) && record.images.length > 0) return true
  if (record.external && typeof record.external === 'object') return true
  if (record.media && typeof record.media === 'object') return true
  if (record.video && typeof record.video === 'object') return true
  if (record.type === 'Image' || record.type === 'Video') return true
  return false
}

function summarizeRecord(record: unknown): AtRecordSummary {
  const source = record && typeof record === 'object' ? (record as Record<string, unknown>) : {}
  const canonicalContent = source.content && typeof source.content === 'object'
    ? (source.content as Record<string, unknown>)
    : null
  const title =
    normalizeString(source.title) ||
    normalizeString(canonicalContent?.title) ||
    normalizeString(source.name) ||
    normalizeString(source.headline)
  const text =
    normalizeString(source.text) ||
    normalizeString(canonicalContent?.plaintext) ||
    normalizeString(canonicalContent?.summary) ||
    normalizeString(source.content) ||
    normalizeString(source.body) ||
    normalizeString(source.description)
  const subject = source.subject && typeof source.subject === 'object'
    ? (source.subject as Record<string, unknown>)
    : null
  const reply = source.reply && typeof source.reply === 'object'
    ? (source.reply as Record<string, unknown>)
    : null
  const replyParent = reply?.parent && typeof reply.parent === 'object'
    ? (reply.parent as Record<string, unknown>)
    : null
  const replyRoot = reply?.root && typeof reply.root === 'object'
    ? (reply.root as Record<string, unknown>)
    : null
  const tags = [
    ...normalizeStringArray(source.tags),
    ...extractHashtagsFromFacets(source.facets)
  ]

  return {
    title,
    text,
    subjectUri:
      normalizeString(subject?.uri) ||
      normalizeString(subject?.atUri) ||
      normalizeString(subject?.id),
    replyParentUri:
      normalizeString(replyParent?.uri) ||
      normalizeString(replyParent?.atUri) ||
      null,
    replyRootUri:
      normalizeString(replyRoot?.uri) ||
      normalizeString(replyRoot?.atUri) ||
      null,
    tags: [...new Set(tags)],
    languages: normalizeStringArray(source.langs),
    hasMedia: hasMediaEmbed(source.embed) || hasMediaEmbed(source.embeds),
  }
}

function mapRecordForResponse(row: typeof atRecords.$inferSelect, includeRaw: boolean): AtRecordResponseItem {
  const summary = summarizeRecord(row.record)
  const mapped: AtRecordResponseItem = {
    id: row.id,
    authorDid: row.authorDid,
    collection: row.collection,
    lexiconFamily: getLexiconFamily(row.collection),
    recordType: getRecordType(row.collection),
    rkey: row.rkey,
    atUri: row.atUri,
    cid: row.cid,
    operation: row.operation,
    isActive: row.isActive,
    createdAt: row.createdAt,
    ingestedAt: row.ingestedAt,
    sourceRelay: row.sourceRelay,
    firehoseSeq: row.firehoseSeq,
    summary,
  }
  if (includeRaw) {
    mapped.record = (row.record as Record<string, unknown> | null) ?? null
  }
  return mapped
}

function toTimestamp(value: Date | null): number {
  if (!value) return 0
  return value.getTime()
}

function feedSortTimestamp(item: UnifiedFeedRow): number {
  return toTimestamp(item.feedSortAt ?? item.createdAt)
}

function parseAtUri(value: string): { did: string; collection?: string; rkey?: string } | null {
  if (!value.startsWith('at://')) return null
  const parts = value.replace('at://', '').split('/').filter(Boolean)
  if (parts.length < 1) return null
  return {
    did: parts[0],
    collection: parts[1],
    rkey: parts[2],
  }
}

function collectActorIds(value: unknown): string[] {
  const ids = new Set<string>()

  if (typeof value === 'string') {
    const normalized = normalizeString(value)
    if (normalized) ids.add(normalized)
    if (normalized?.startsWith('at://')) {
      const did = parseAtUri(normalized)?.did
      if (did) ids.add(did)
    }
    return [...ids]
  }

  if (!value || typeof value !== 'object') return []

  const record = value as Record<string, unknown>
  const directFields = [
    record.canonicalAccountId,
    record.did,
    record.webId,
    record.activityPubActorUri,
    record.handle,
    record.uri,
    record.atUri,
    record.id,
  ]

  for (const field of directFields) {
    const normalized = normalizeString(field)
    if (!normalized) continue
    ids.add(normalized)
    if (normalized.startsWith('at://')) {
      const did = parseAtUri(normalized)?.did
      if (did) ids.add(did)
    }
  }

  return [...ids]
}

function extractFollowSubjectIds(record: unknown): string[] {
  if (!record || typeof record !== 'object') return []
  return collectActorIds((record as Record<string, unknown>).subject)
}

function extractFollowAuthorIds(record: unknown): string[] {
  if (!record || typeof record !== 'object') return []
  return collectActorIds((record as Record<string, unknown>).sourceAccountRef)
}

function extractCurrentUserIds(user: { atprotoDid?: string | null; getWebId?: (() => string) | undefined }): Set<string> {
  const ids = new Set<string>()

  const did = normalizeString(user.atprotoDid)
  if (did) ids.add(did)

  const webId = typeof user.getWebId === 'function' ? normalizeString(user.getWebId()) : null
  if (webId) ids.add(webId)

  return ids
}

async function resolveFollowedAuthorIds(user: { atprotoDid?: string | null; getWebId?: (() => string) | undefined }): Promise<Set<string>> {
  const currentUserIds = extractCurrentUserIds(user)
  if (currentUserIds.size === 0) return new Set<string>()

  const followRecords = await db
    .select({
      authorDid: atRecords.authorDid,
      collection: atRecords.collection,
      record: atRecords.record,
    })
    .from(atRecords)
    .where(
      and(
        eq(atRecords.isActive, true),
        or(
          eq(atRecords.collection, 'app.bsky.graph.follow'),
          eq(atRecords.collection, 'canonical.follow'),
        ),
      ),
    )
    .limit(5000)

  const followed = new Set<string>()
  for (const row of followRecords) {
    const authorIds = new Set<string>([row.authorDid, ...extractFollowAuthorIds(row.record)])
    const isCurrentUsersFollow = [...authorIds].some(id => currentUserIds.has(id))
    if (!isCurrentUsersFollow) continue

    for (const followedId of extractFollowSubjectIds(row.record)) {
      followed.add(followedId)
    }
  }

  return followed
}

function loadReplyThreadMeta(items: UnifiedFeedRow[]): Map<number, ThreadBumpMeta> {
  return new Map(items
    .filter(item => item.replyParentUri || item.replyRootUri)
    .map(item => [item.id, {
      replyParentUri: item.replyParentUri,
      replyRootUri: item.replyRootUri,
    }]))
}

async function loadThreadAnchorRows(items: UnifiedFeedRow[], metaById: ReadonlyMap<number, ThreadBumpMeta>): Promise<Map<string, UnifiedFeedRow>> {
  const anchors = new Map<string, UnifiedFeedRow>()

  for (const item of items) {
    if (item.atUri) anchors.set(item.atUri, item)
    if (item.objectUri) anchors.set(item.objectUri, item)
  }

  const missingUris = new Set<string>()
  for (const item of items) {
    const meta = metaById.get(item.id)
    const anchorUri = meta?.replyRootUri ?? meta?.replyParentUri
    if (anchorUri && !anchors.has(anchorUri)) missingUris.add(anchorUri)
  }

  if (missingUris.size === 0) return anchors

  const atUris = [...missingUris].filter(uri => uri.startsWith('at://'))
  const objectUris = [...missingUris].filter(uri => !uri.startsWith('at://'))
  const conditions = []

  if (atUris.length > 0) conditions.push(inArray(unifiedFeedView.atUri, atUris))
  if (objectUris.length > 0) conditions.push(inArray(unifiedFeedView.objectUri, objectUris))
  if (conditions.length === 0) return anchors

  const fetched = await db
    .select()
    .from(unifiedFeedView)
    .where(conditions.length === 1 ? conditions[0] : or(...conditions))

  for (const row of fetched as UnifiedFeedRow[]) {
    if (row.atUri) anchors.set(row.atUri, row)
    if (row.objectUri) anchors.set(row.objectUri, row)
  }

  return anchors
}

async function applyReplyThreadBumps(items: UnifiedFeedRow[], user: { atprotoDid?: string | null; getWebId?: (() => string) | undefined }): Promise<UnifiedFeedRow[]> {
  if (items.length === 0) return items

  const followedAuthors = await resolveFollowedAuthorIds(user)
  if (followedAuthors.size === 0) return items

  const metaById = loadReplyThreadMeta(items)
  if (metaById.size === 0) return items

  const anchorByUri = await loadThreadAnchorRows(items, metaById)
  return applyFollowedReplyThreadBumps(items, followedAuthors, metaById, anchorByUri)
}

function preferDifferentAuthor(
  items: UnifiedFeedRow[],
  lastAuthor: string | null,
): UnifiedFeedRow | undefined {
  if (items.length === 0) return undefined
  if (!lastAuthor) return items.shift()

  const nextIndex = items.findIndex(item => item.authorWebId !== lastAuthor)
  if (nextIndex === -1) {
    return items.shift()
  }
  return items.splice(nextIndex, 1)[0]
}

function buildBalancedFeed(
  items: UnifiedFeedRow[],
  limit: number,
  offset: number,
  apWeight: number,
  atWeight: number,
): UnifiedFeedRow[] {
  const sorted = [...items].sort((a, b) => feedSortTimestamp(b) - feedSortTimestamp(a))
  const apQueue = sorted.filter(item => item.source === 'activitypods')
  const atQueue = sorted.filter(item => item.source === 'atproto')
  const result: UnifiedFeedRow[] = []

  const totalWeight = Math.max(1, apWeight + atWeight)
  const apTargetRatio = apWeight / totalWeight
  const atTargetRatio = atWeight / totalWeight

  let apCount = 0
  let atCount = 0
  let lastAuthor: string | null = null
  let sameAuthorRun = 0

  while (apQueue.length > 0 || atQueue.length > 0) {
    // Keep source representation balanced using user-selected protocol weights.
    const currentSize = result.length
    const apTargetCount = currentSize * apTargetRatio
    const atTargetCount = currentSize * atTargetRatio
    const apDeficit = apTargetCount - apCount
    const atDeficit = atTargetCount - atCount

    const apPreferred = apDeficit >= atDeficit
    const primary = apPreferred ? apQueue : atQueue
    const secondary = apPreferred ? atQueue : apQueue

    let picked = preferDifferentAuthor(primary, lastAuthor)
    if (!picked) {
      picked = preferDifferentAuthor(secondary, lastAuthor)
    }
    if (!picked) break

    // Prevent long consecutive runs from a single author where possible.
    if (lastAuthor && picked.authorWebId === lastAuthor && sameAuthorRun >= 2) {
      const alternate = preferDifferentAuthor(secondary, lastAuthor)
      if (alternate) {
        if (picked.source === 'activitypods') apQueue.unshift(picked)
        else atQueue.unshift(picked)
        picked = alternate
      }
    }

    result.push(picked)

    if (picked.source === 'activitypods') apCount += 1
    else atCount += 1

    if (picked.authorWebId === lastAuthor) {
      sameAuthorRun += 1
    } else {
      lastAuthor = picked.authorWebId
      sameAuthorRun = 1
    }

    // Build enough ranked candidates for the requested page window.
    if (result.length >= offset + limit) {
      break
    }
  }

  return result.slice(offset, offset + limit)
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const paginationQuery = t.Object({
  limit: t.Integer({ default: 20, maximum: 50, minimum: 1 }),
  offset: t.Integer({ default: 0, minimum: 0 }),
  hashtag: t.Optional(t.String({ minLength: 2, maxLength: 65 })),
})

const recordsQuery = t.Object({
  limit: t.Integer({ default: 20, maximum: 100, minimum: 1 }),
  offset: t.Integer({ default: 0, minimum: 0 }),
  collection: t.Optional(t.String({ minLength: 3, maxLength: 512 })),
  did: t.Optional(t.String({ minLength: 3, maxLength: 2048 })),
  family: t.Optional(t.Union([t.Literal('all'), t.Literal('bsky'), t.Literal('standard.site')])),
  recordType: t.Optional(t.String({ minLength: 2, maxLength: 128 })),
  search: t.Optional(t.String({ minLength: 2, maxLength: 200 })),
  includeRaw: t.Optional(t.Boolean({ default: false })),
})

const feedQuery = t.Object({
  limit: t.Integer({ default: 20, maximum: 50, minimum: 1 }),
  offset: t.Integer({ default: 0, minimum: 0 }),
  cursor: t.Optional(t.String({ minLength: 1, maxLength: 512 })),
  source: t.Optional(t.Union([t.Literal('activitypods'), t.Literal('atproto'), t.Literal('all')])),
  hashtag: t.Optional(t.String({ minLength: 2, maxLength: 65 })),
  mode: t.Optional(t.Union([t.Literal('chronological'), t.Literal('balanced'), t.Literal('following')])),
  apWeight: t.Optional(t.Integer({ default: 50, minimum: 1, maximum: 99 })),
  atWeight: t.Optional(t.Integer({ default: 50, minimum: 1, maximum: 99 })),
  excludeViewed: t.Optional(t.Boolean({ default: false })),
  /** ISO-8601 timestamp — return only posts created after this value (delta sync cursor). */
  since: t.Optional(t.String({ minLength: 10, maxLength: 64 })),
})

const threadQuery = t.Object({
  rootUri: t.String({ minLength: 3, maxLength: 3072 }),
  limit: t.Integer({ default: 20, maximum: 50, minimum: 1 }),
  cursor: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
})

const feedViewedBody = t.Object({
  objectId: t.Optional(t.String({ minLength: 1, maxLength: 2048 })),
  objectIds: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 2048 }), { minItems: 1, maxItems: 100 })),
  viewedAt: t.Optional(t.String({ minLength: 1, maxLength: 64 }))
})

const repostBody = t.Object({
  objectUri: t.Optional(t.Union([t.String({ minLength: 1, maxLength: 3072 }), t.Null()])),
  atUri: t.Optional(t.Union([t.String({ minLength: 1, maxLength: 3072 }), t.Null()])),
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
  .guard({ as: 'scoped', isSignedIn: true })

  // -------------------------------------------------------------------------
  // GET /at/feed — Unified feed (AT + ActivityPods)
  // -------------------------------------------------------------------------
  .get(
    '/feed',
    async ({ query: { limit, offset, cursor, source, hashtag, mode, apWeight, atWeight, excludeViewed, since }, user }) => {
      const feedStartTime = Date.now()
      try {
        console.log('[AT Bridge /feed] Request started', { limit, offset, cursor: !!cursor, source, hashtag, mode })

        const moderationState = await safeResolveViewerModerationState(user, 'feed')
        const timelineMode: TimelineMode = mode ?? 'balanced'
        const normalizedApWeight = apWeight ?? 50
        const normalizedAtWeight = atWeight ?? 50
        const keysetCursor = decodeFeedCursor(cursor)
        const useCursorPaging = keysetCursor !== null
        // Keep the initial candidate window modest for local dev responsiveness.
        const fetchLimit = useCursorPaging
          ? Math.min(300, Math.max(60, limit * 6))
          : Math.min(200, Math.max(40, offset + limit * 3))

        const queryStartTime = Date.now()

        const sinceDate = since
          ? (() => { const d = new Date(since); return isNaN(d.getTime()) ? null : d })()
          : null

        const candidateRows = await queryFeedCandidates({
          fetchLimit,
          source: source && source !== 'all' ? source : null,
          hashtag: hashtag?.trim().length ? hashtag : null,
          sinceDate,
          viewerIds: extractCurrentUserIds(user),
        })
        const queryDuration = Date.now() - queryStartTime
        console.log('[AT Bridge /feed] Query executed', { duration: queryDuration, rows: candidateRows.length })

        // Resolve handles for AT rows whose author_name is still a raw DID.
        const unresolvedDids = [...new Set(
          candidateRows
            .filter(r => r.source === 'atproto' && r.authorName === r.authorWebId && r.authorWebId.startsWith('did:'))
            .map(r => r.authorWebId),
        )]
        if (unresolvedDids.length > 0) {
          try {
            const handleMap = await resolveAndCacheHandles(unresolvedDids)
            if (handleMap.size > 0) {
              for (const row of candidateRows) {
                const resolved = handleMap.get(row.authorWebId)
                if (resolved) row.authorName = resolved
              }
            }
          } catch (err) {
            console.warn('[AT Bridge] Inline handle resolution failed:', err)
          }
        }

        const bumpStartTime = Date.now()
        const bumpedResults = await applyReplyThreadBumps(candidateRows, user)
        console.log('[AT Bridge /feed] Thread bumps applied', { duration: Date.now() - bumpStartTime, results: bumpedResults.length })

        const mediaFlaggedResults = await applyAtprotoMediaFlags(bumpedResults)
        const warningResults = applyViewerWarningFlags(mediaFlaggedResults, moderationState)
        const { visible: moderatedResults } = filterViewerModeratedRows(warningResults, moderationState)
        console.log('[AT Bridge /feed] Moderation filtered', { visible: moderatedResults.length, hidden: warningResults.length - moderatedResults.length })

        // For the following mode, filter down to only posts from followed authors.
        let results = moderatedResults
        if (timelineMode === 'following') {
          const followedIds = await resolveFollowedAuthorIds(user)
          if (followedIds.size > 0) {
            results = moderatedResults.filter(row => {
              // Match ATProto author DID or ActivityPub webId against followed set.
              return followedIds.has(row.authorWebId) ||
                (row.atUri != null && followedIds.has(row.authorWebId))
            })
          }
        }

        const cursorScopedResults = useCursorPaging
          ? results.filter(row => isBeforeFeedCursor(row, keysetCursor!))
          : results

        const rawPage = timelineMode === 'chronological' || timelineMode === 'following' || source === 'activitypods' || source === 'atproto'
          ? (useCursorPaging
            ? cursorScopedResults.slice(0, limit + 1)
            : cursorScopedResults.slice(offset, offset + limit))
          : (useCursorPaging
            ? buildBalancedFeed(cursorScopedResults, limit + 1, 0, normalizedApWeight, normalizedAtWeight)
            : buildBalancedFeed(cursorScopedResults, limit, offset, normalizedApWeight, normalizedAtWeight))

        const hasMore = useCursorPaging ? rawPage.length > limit : false
        let output = useCursorPaging ? rawPage.slice(0, limit) : rawPage

        if (excludeViewed && isViewershipIntegrationEnabled()) {
          const objectIds = [...new Set(output.map(feedItemObjectId).filter((value): value is string => !!value))]
          if (objectIds.length > 0) {
            try {
              const viewed = await resolveViewedObjectIds(user.getWebId(), objectIds)
              output = output.filter(item => {
                const objectId = feedItemObjectId(item)
                return !objectId || !viewed.has(objectId)
              })
            } catch (error) {
              console.warn('[AT Bridge] Viewership filtering unavailable:', error)
            }
          }
        }

        let metricsByRootUri = new Map<string, ViewerThreadMetrics>()
        try {
          metricsByRootUri = await loadViewerThreadMetricsByRootUri(
            output
              .map(getThreadRootUri)
              .filter((value): value is string => !!value),
            moderationState,
          )
        } catch (error) {
          console.warn('[AT Bridge] Thread metrics unavailable for feed response:', error)
        }

        const finalOutput = applyViewerThreadMetrics(output, metricsByRootUri).map(mapFeedItemForResponse)
        const nextCursor = useCursorPaging && hasMore && output.length > 0
          ? encodeFeedCursor(output[output.length - 1])
          : null

        const totalDuration = Date.now() - feedStartTime
        console.log('[AT Bridge /feed] Response ready', {
          items: finalOutput.length,
          totalDuration,
          timeline: timelineMode,
          source: source ?? 'all',
          hasMore,
          cursorMode: useCursorPaging,
        })

        if (useCursorPaging) {
          const paged: FeedPageResponse = {
            items: finalOutput,
            nextCursor,
            hasMore: hasMore && nextCursor !== null,
          }
          return paged
        }

        return finalOutput
      } catch (err) {
        const totalDuration = Date.now() - feedStartTime
        console.error('[AT Bridge /feed] Error after', totalDuration, 'ms:', err)
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

  .get(
    '/thread',
    async ({ query: { rootUri, limit, cursor }, error, user }) => {
      const normalizedRootUri = normalizeThreadUri(rootUri)
      if (!normalizedRootUri) {
        return error(400, 'Invalid rootUri')
      }

      const offset = decodeCursor(cursor)

      try {
        const [rootRow] = await db
          .select()
          .from(unifiedFeedCandidatesView)
          .where(
            or(
              eq(unifiedFeedCandidatesView.atUri, normalizedRootUri),
              eq(unifiedFeedCandidatesView.objectUri, normalizedRootUri),
            ),
          )
          .limit(1)

        const moderationState = await safeResolveViewerModerationState(user, 'thread')

        let window = { page: [] as UnifiedFeedRow[], nextOffset: offset }
        let hasMore = false
        let exhausted = false
        const batchSize = Math.min(100, Math.max(limit * 3, 25))
        const maxScannedRows = Math.min(500, Math.max(limit * 12, 100))

        while (window.page.length < limit + 1 && window.nextOffset - offset < maxScannedRows) {
          const batch = (await db
            .select()
            .from(unifiedFeedCandidatesView)
            .where(
              and(
                or(
                  eq(unifiedFeedCandidatesView.replyRootUri, normalizedRootUri),
                  eq(unifiedFeedCandidatesView.replyParentUri, normalizedRootUri),
                ),
                eq(unifiedFeedCandidatesView.isPublic, true),
              ),
            )
            .orderBy(desc(unifiedFeedCandidatesView.createdAt), desc(unifiedFeedCandidatesView.id))
            .limit(batchSize)
            .offset(window.nextOffset)) as UnifiedFeedRow[]

          if (batch.length === 0) {
            exhausted = true
            break
          }

          window = appendVisibleThreadWindow(window, batch, limit, moderationState)

          if (batch.length < batchSize) {
            exhausted = true
            break
          }
        }

        const finalizedWindow = finalizeVisibleThreadWindow(window.page, window.nextOffset, limit, exhausted)
        hasMore = finalizedWindow.hasMore
        const visiblePage = finalizedWindow.visiblePage
        const nextCursor = finalizedWindow.nextCursorOffset !== null ? encodeCursor(finalizedWindow.nextCursorOffset) : null

        const visibleRoot = rootRow && !isRowHiddenForViewer(rootRow as UnifiedFeedRow, moderationState)
          ? mapFeedItemForResponse(rootRow as UnifiedFeedRow)
          : null

        const metricsByRootUri = await loadViewerThreadMetricsByRootUri([normalizedRootUri], moderationState)
        const threadMetrics = metricsByRootUri.get(normalizedRootUri) ?? buildViewerThreadMetrics([])

        const response: ThreadContextResponse = {
          rootUri: normalizedRootUri,
          root: visibleRoot,
          items: applyViewerThreadMetrics(visiblePage, metricsByRootUri).map(mapFeedItemForResponse),
          nextCursor,
          hasMore,
          replyCount: threadMetrics.replyCount,
          participantCount: threadMetrics.participantCount,
          lastActivityAt: threadMetrics.lastActivityAt,
        }

        return response
      } catch (err) {
        console.error('[AT Bridge] Failed to fetch thread context:', err)
        return error(500, 'Failed to fetch thread context')
      }
    },
    {
      query: threadQuery,
      detail: 'Returns paginated thread context for a root URI',
      isSignedIn: true,
      response: {
        200: t.Object({
          rootUri: t.String(),
          root: t.Union([
            t.Null(),
            t.Object({
              id: t.Number(),
              content: t.String(),
              hashtags: t.Array(t.String()),
              postType: t.String(),
              title: t.Union([t.String(), t.Null()]),
              summary: t.Union([t.String(), t.Null()]),
              canonicalUrl: t.Union([t.String(), t.Null()]),
              createdAt: t.Union([t.Date(), t.Null()]),
              isPublic: t.Boolean(),
              authorId: t.Union([t.Number(), t.Null()]),
              authorName: t.String(),
              authorWebId: t.String(),
              authorProviderEndpoint: t.String(),
              authorAvatar: t.Union([t.String(), t.Null()]),
              source: t.Union([t.Literal('activitypods'), t.Literal('atproto')]),
              atUri: t.Union([t.String(), t.Null()]),
              objectUri: t.Union([t.String(), t.Null()]),
              replyParentUri: t.Union([t.String(), t.Null()]),
              replyRootUri: t.Union([t.String(), t.Null()]),
              type: t.Union([t.Literal('post'), t.Literal('thread_summary')]),
            }),
          ]),
          items: t.Array(t.Object({
            id: t.Number(),
            content: t.String(),
            hashtags: t.Array(t.String()),
            postType: t.String(),
            title: t.Union([t.String(), t.Null()]),
            summary: t.Union([t.String(), t.Null()]),
            canonicalUrl: t.Union([t.String(), t.Null()]),
            createdAt: t.Union([t.Date(), t.Null()]),
            isPublic: t.Boolean(),
            authorId: t.Union([t.Number(), t.Null()]),
            authorName: t.String(),
            authorWebId: t.String(),
            authorProviderEndpoint: t.String(),
            authorAvatar: t.Union([t.String(), t.Null()]),
            source: t.Union([t.Literal('activitypods'), t.Literal('atproto')]),
            atUri: t.Union([t.String(), t.Null()]),
            objectUri: t.Union([t.String(), t.Null()]),
            replyParentUri: t.Union([t.String(), t.Null()]),
            replyRootUri: t.Union([t.String(), t.Null()]),
            type: t.Union([t.Literal('post'), t.Literal('thread_summary')]),
          })),
          nextCursor: t.Union([t.String(), t.Null()]),
          hasMore: t.Boolean(),
          replyCount: t.Number(),
          participantCount: t.Number(),
          lastActivityAt: t.Union([t.Date(), t.Null()]),
        }),
        400: t.String(),
        500: t.String(),
      },
    },
  )

  .post(
    '/reposts',
    async ({ body, user, error }) => {
      const targetUri = normalizeRepostTarget(body)
      if (!targetUri) {
        return error(400, 'Choose a valid ActivityPub object URL or AT URI to repost')
      }

      const actorId = normalizeString(user.atprotoDid) ?? user.getWebId()
      const now = new Date()
      const repostUri = canonicalRepostUri(actorId, targetUri)
      const record = buildCanonicalShareRecord(user, targetUri, 'ShareAdd', now)
      let nativeAnnounced = false

      if (!targetUri.startsWith('at://')) {
        try {
          await ActivityPod.announceObject(user, targetUri)
          nativeAnnounced = true
        } catch (err) {
          console.warn('[AT Bridge] Native ActivityPub announce failed; preserving canonical repost:', err)
        }
      }

      await db
        .insert(atRecords)
        .values({
          authorDid: actorId,
          collection: 'canonical.share',
          rkey: stableRepostId(actorId, targetUri),
          atUri: repostUri,
          cid: null,
          operation: 'create',
          record,
          isActive: true,
          createdAt: now,
          ingestedAt: now,
          sourceRelay: 'memory:ui',
          firehoseSeq: null,
        })
        .onConflictDoUpdate({
          target: atRecords.atUri,
          set: {
            operation: 'create',
            record,
            isActive: true,
            createdAt: now,
            ingestedAt: now,
            sourceRelay: 'memory:ui',
          },
        })

      return {
        ok: true,
        subjectUri: targetUri,
        repostUri,
        reposted: true,
        nativeAnnounced,
      }
    },
    {
      body: repostBody,
      detail: 'Create a canonical repost/boost for a feed object',
      isSignedIn: true,
      response: {
        200: t.Object({
          ok: t.Boolean(),
          subjectUri: t.String(),
          repostUri: t.String(),
          reposted: t.Boolean(),
          nativeAnnounced: t.Boolean(),
        }),
        400: t.String(),
      },
    },
  )

  .post(
    '/reposts/remove',
    async ({ body, user, error }) => {
      const targetUri = normalizeRepostTarget(body)
      if (!targetUri) {
        return error(400, 'Choose a valid ActivityPub object URL or AT URI to remove from reposts')
      }

      const actorId = normalizeString(user.atprotoDid) ?? user.getWebId()
      const now = new Date()
      const repostUri = canonicalRepostUri(actorId, targetUri)
      const record = buildCanonicalShareRecord(user, targetUri, 'ShareRemove', now)

      await db
        .insert(atRecords)
        .values({
          authorDid: actorId,
          collection: 'canonical.share',
          rkey: stableRepostId(actorId, targetUri),
          atUri: repostUri,
          cid: null,
          operation: 'delete',
          record,
          isActive: false,
          createdAt: now,
          ingestedAt: now,
          sourceRelay: 'memory:ui',
          firehoseSeq: null,
        })
        .onConflictDoUpdate({
          target: atRecords.atUri,
          set: {
            operation: 'delete',
            record,
            isActive: false,
            createdAt: now,
            ingestedAt: now,
            sourceRelay: 'memory:ui',
          },
        })

      return {
        ok: true,
        subjectUri: targetUri,
        repostUri,
        reposted: false,
      }
    },
    {
      body: repostBody,
      detail: 'Remove the current viewer canonical repost/boost for a feed object',
      isSignedIn: true,
      response: {
        200: t.Object({
          ok: t.Boolean(),
          subjectUri: t.String(),
          repostUri: t.String(),
          reposted: t.Boolean(),
        }),
        400: t.String(),
      },
    },
  )

  .post(
    '/moderation/author',
    async ({ body, user, error }) => {
      const subject = deriveModerationSubject(body)
      if (!subject) {
        return error(400, 'Unable to determine moderation subject')
      }

      try {
        await createViewerModerationDecision(user, body.action, subject)
        return {
          ok: true,
          action: body.action,
          subjectCanonicalId: subject.subjectCanonicalId,
          subjectProtocol: subject.subjectProtocol,
        }
      } catch (err) {
        console.error('[AT Bridge] Failed to create viewer moderation decision:', err)
        return error(502, 'Failed to create viewer moderation decision')
      }
    },
    {
      body: t.Object({
        action: t.Union([t.Literal('block'), t.Literal('mute')]),
        source: t.Union([t.Literal('activitypods'), t.Literal('atproto')]),
        authorWebId: t.String({ minLength: 1, maxLength: 2048 }),
        atUri: t.Optional(t.Union([t.String({ minLength: 1, maxLength: 3072 }), t.Null()])),
      }),
      detail: 'Create a viewer-specific block or mute for a feed author',
      isSignedIn: true,
      response: {
        200: t.Object({
          ok: t.Boolean(),
          action: t.Union([t.Literal('block'), t.Literal('mute')]),
          subjectCanonicalId: t.String(),
          subjectProtocol: t.String(),
        }),
        400: t.String(),
        502: t.String(),
      },
    },
  )

  .post(
    '/feed/viewed',
    async ({ body, user, error }) => {
      const objectIds = [...new Set([body.objectId, ...(body.objectIds ?? [])].filter((value): value is string => !!value && value.trim().length > 0))]
      if (objectIds.length === 0) {
        return error(400, 'objectId or objectIds is required')
      }

      try {
        await recordViewedObjectIds(user.getWebId(), objectIds, body.viewedAt)
        return { ok: true, recorded: objectIds.length }
      } catch (err) {
        console.error('[AT Bridge] Failed to record viewed feed objects:', err)
        return error(502, 'Failed to record viewed feed objects')
      }
    },
    {
      body: feedViewedBody,
      detail: 'Record viewed objects for the signed-in user',
      isSignedIn: true,
      response: {
        200: t.Object({
          ok: t.Boolean(),
          recorded: t.Number(),
        }),
        400: t.String(),
        502: t.String(),
      },
    },
  )

  // -------------------------------------------------------------------------
  // GET /at/posts — AT Protocol posts only
  // -------------------------------------------------------------------------
  // Note: AT-native notification events (likes/reposts from pure Bluesky users)
  // are not surfaced here directly. The correct path is for the AT→AP bridge
  // to translate those events into AP activities so they flow through the
  // canonical ActivityPods notification pipeline.
  // -------------------------------------------------------------------------
  .get(
    '/posts',
    async ({ query: { limit, offset, hashtag } }) => {
      try {
        const conditions = [eq(atPosts.isPublic, true)]

        if (hashtag && hashtag.trim().length > 0) {
          const normalizedHashtag = normalizeHashtag(hashtag)
          if (normalizedHashtag) {
            const pattern = `%${normalizedHashtag}%`
            conditions.push(
              or(
                ilike(atPosts.content, pattern),
                sql`EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(COALESCE(${atPosts.facets}, '[]'::jsonb)) facet,
                       jsonb_array_elements(COALESCE(facet->'features', '[]'::jsonb)) feature
                  WHERE feature ? 'tag' AND '#' || lower(trim(feature->>'tag')) = ${normalizedHashtag}
                )`
              ) as any
            )
          }
        }

        const query = db
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
          .where(and(...conditions))

        const results = await query.orderBy(desc(atPosts.createdAt)).limit(limit).offset(offset)

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
  // GET /at/records — Supported lexicon records (raw projection)
  // -------------------------------------------------------------------------
  .get(
    '/records',
    async ({ query: { limit, offset, collection, did, family, recordType, search, includeRaw } }) => {
      try {
        const conditions = [eq(atRecords.isActive, true)]

        if (collection && collection.trim().length > 0) {
          conditions.push(eq(atRecords.collection, collection.trim()))
        }

        if (did && did.trim().length > 0) {
          conditions.push(eq(atRecords.authorDid, did.trim()))
        }

        if (family && family !== 'all') {
          if (family === 'bsky') {
            conditions.push(sql`${atRecords.collection} LIKE 'app.bsky.%'`)
          }
          if (family === 'standard.site') {
            conditions.push(sql`${atRecords.collection} LIKE 'standard.site.%'`)
          }
        }

        if (recordType && recordType.trim().length > 0) {
          conditions.push(sql`split_part(${atRecords.collection}, '.', 3) = ${recordType.trim()}`)
        }

        if (search && search.trim().length > 0) {
          const pattern = `%${search.trim()}%`
          conditions.push(
            or(
              ilike(sql`coalesce(${atRecords.record}::jsonb ->> 'text', '')`, pattern),
              ilike(sql`coalesce(${atRecords.record}::jsonb ->> 'content', '')`, pattern),
              ilike(sql`coalesce(${atRecords.record}::jsonb ->> 'name', '')`, pattern),
              ilike(sql`coalesce(${atRecords.record}::jsonb ->> 'title', '')`, pattern)
            ) as any
          )
        }

        const rows = await db
          .select()
          .from(atRecords)
          .where(and(...conditions))
          .orderBy(desc(atRecords.createdAt), desc(atRecords.id))
          .limit(limit)
          .offset(offset)

        return rows.map(row => mapRecordForResponse(row, includeRaw ?? false))
      } catch (err) {
        console.error('[AT Bridge] Failed to fetch AT records:', err)
        throw new Error('Failed to fetch AT records')
      }
    },
    {
      query: recordsQuery,
      detail: 'Returns raw records for supported Bluesky and standard.site lexicons',
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

        const [recordCount] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(atRecords)

        return {
          sources: cursors,
          stats: {
            totalAtPosts: postCount?.count ?? 0,
            totalAtIdentities: identityCount?.count ?? 0,
            totalAtRecords: recordCount?.count ?? 0,
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

// ---------------------------------------------------------------------------
// XRPC — app.bsky.feed.getFeedSkeleton
//
// Public endpoint that lets Bluesky clients and PDS instances treat Memory
// as an AT Protocol custom feed generator.  Clients send the AT URI of the
// feed (e.g. at://did:web:memory.social/app.bsky.feed.generator/unified)
// and receive a skeleton: an ordered list of { post: atUri } objects.
//
// Supported feed aliases:
//   *:memory-unified   → balanced algorithmic feed (mode=balanced)
//   *:memory-following → following-only chronological feed (mode=following)
//   *:memory-latest    → pure chronological feed (mode=chronological)
// ---------------------------------------------------------------------------

export const xrpcFeedPlugin = new Elysia({ name: 'xrpc-feed', prefix: '/xrpc' })
  .use(setupPlugin)
  .get(
    '/app.bsky.feed.getFeedSkeleton',
    async ({ query: { feed, limit, cursor }, error: elysiaError }) => {
      // Determine mode from the feed AT URI's rkey.
      const feedRkey = (() => {
        if (!feed) return 'memory-unified'
        const parts = feed.split('/')
        return parts[parts.length - 1] ?? 'memory-unified'
      })()

      type XrpcMode = 'balanced' | 'chronological' | 'following'
      const modeMap: Record<string, XrpcMode> = {
        'memory-unified': 'balanced',
        'memory-following': 'following',
        'memory-latest': 'chronological',
      }
      const timelineMode: XrpcMode = modeMap[feedRkey] ?? 'balanced'

      const normalizedLimit = Math.min(100, Math.max(1, limit ?? 30))
      const keysetCursor = decodeFeedCursor(cursor)
      const fetchLimit = Math.min(300, Math.max(60, normalizedLimit * 6))

      try {
        const candidateRows = await queryFeedCandidates({
          fetchLimit,
          source: null,
          hashtag: null,
          sinceDate: null,
        })

        const cursorScopedRows = keysetCursor !== null
          ? candidateRows.filter(row => isBeforeFeedCursor(row, keysetCursor))
          : candidateRows

        const pageRows = timelineMode === 'balanced'
          ? buildBalancedFeed(cursorScopedRows, normalizedLimit + 1, 0, 50, 50)
          : cursorScopedRows.slice(0, normalizedLimit + 1)

        const hasMore = pageRows.length > normalizedLimit
        const resultRows = pageRows.slice(0, normalizedLimit)

        const feedItems = resultRows
          .filter(row => typeof row.atUri === 'string' && row.atUri.startsWith('at://'))
          .map(row => ({ post: row.atUri as string }))

        const nextCursor = hasMore && resultRows.length > 0
          ? encodeFeedCursor(resultRows[resultRows.length - 1])
          : null

        return {
          feed: feedItems,
          ...(nextCursor ? { cursor: nextCursor } : {}),
        }
      } catch (err) {
        console.error('[XRPC getFeedSkeleton] Failed:', err)
        return elysiaError(500, 'Feed skeleton generation failed')
      }
    },
    {
      query: t.Object({
        feed: t.Optional(t.String({ minLength: 1, maxLength: 512 })),
        limit: t.Optional(t.Integer({ default: 30, minimum: 1, maximum: 100 })),
        cursor: t.Optional(t.String({ minLength: 1, maxLength: 512 })),
      }),
      detail: 'AT Protocol feed generator skeleton — returns an ordered list of post AT URIs for Bluesky clients',
    },
  )

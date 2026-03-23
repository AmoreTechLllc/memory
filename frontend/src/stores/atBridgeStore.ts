/**
 * AT Protocol Bridge — Frontend Pinia Store
 *
 * Manages AT Protocol federated content state in the memory UI.
 *
 * State:
 *   - atPosts: AT Protocol posts from the federated firehose
 *   - unifiedFeed: Combined AT + ActivityPods posts
 *   - firehoseStatus: Ingestion health per source relay
 *   - feedSource: Active filter ('all' | 'activitypods' | 'atproto')
 *
 * Design principles:
 *   - Mirrors the postsStore API for drop-in composability.
 *   - Errors are handled gracefully and surfaced to the UI.
 *   - Pagination is supported for all feed types.
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useAuthStore } from './authStore'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AtPost {
  id: number
  authorDid: string
  rkey: string
  atUri: string
  cid: string | null
  content: string
  isPublic: boolean
  facets: unknown | null
  embeds: unknown | null
  replyParentUri: string | null
  createdAt: string | null
  ingestedAt: string | null
  sourceRelay: string | null
  authorHandle: string | null
}

export interface UnifiedFeedItem {
  id: number
  content: string
  createdAt: string | null
  isPublic: boolean
  authorId: number | null
  authorName: string
  authorWebId: string
  authorProviderEndpoint: string
  source: 'activitypods' | 'atproto'
  atUri: string | null
}

export interface FirehoseStatus {
  sourceId: string
  sourceType: string
  committedSeq: number | null
  hotSeq: number | null
  isConnected: boolean
  lastEventAt: string | null
}

export type FeedSource = 'all' | 'activitypods' | 'atproto'

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useAtBridgeStore = defineStore('atBridge', () => {
  const authStore = useAuthStore()

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  const atPosts = ref<AtPost[]>([])
  const unifiedFeed = ref<UnifiedFeedItem[]>([])
  const firehoseStatus = ref<{
    sources: FirehoseStatus[]
    stats: { totalAtPosts: number; totalAtIdentities: number }
  }>({ sources: [], stats: { totalAtPosts: 0, totalAtIdentities: 0 } })

  const feedSource = ref<FeedSource>('all')
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  // Pagination
  const unifiedFeedOffset = ref(0)
  const atPostsOffset = ref(0)
  const PAGE_SIZE = 20

  // -------------------------------------------------------------------------
  // Computed
  // -------------------------------------------------------------------------

  const hasAtContent = computed(() => atPosts.value.length > 0)
  const isFirehoseConnected = computed(() =>
    firehoseStatus.value.sources.some(s => s.isConnected),
  )

  // -------------------------------------------------------------------------
  // API helpers
  // -------------------------------------------------------------------------

  function getApiBase(): string {
    return import.meta.env.VITE_API_URL || 'http://localhost:8796'
  }

  function getHeaders(): HeadersInit {
    return {
      'Content-Type': 'application/json',
      auth: authStore.token,
    }
  }

  async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`${getApiBase()}${path}`, {
      ...options,
      headers: { ...getHeaders(), ...(options?.headers ?? {}) },
    })

    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error')
      throw new Error(`API error ${response.status}: ${text}`)
    }

    return response.json() as Promise<T>
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /**
   * Fetch the unified feed (AT + ActivityPods).
   * Appends to existing items for infinite scroll.
   */
  async function fetchUnifiedFeed(append = false): Promise<void> {
    if (isLoading.value) return

    isLoading.value = true
    error.value = null

    try {
      const offset = append ? unifiedFeedOffset.value : 0
      const sourceParam = feedSource.value !== 'all' ? `&source=${feedSource.value}` : ''

      const items = await apiFetch<UnifiedFeedItem[]>(
        `/at/feed?limit=${PAGE_SIZE}&offset=${offset}${sourceParam}`,
      )

      if (append) {
        unifiedFeed.value.push(...items)
      } else {
        unifiedFeed.value = items
        unifiedFeedOffset.value = 0
      }

      unifiedFeedOffset.value = offset + items.length
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to fetch unified feed'
      console.error('[AtBridgeStore] fetchUnifiedFeed error:', err)
    } finally {
      isLoading.value = false
    }
  }

  /**
   * Fetch AT Protocol posts only.
   */
  async function fetchAtPosts(append = false): Promise<void> {
    if (isLoading.value) return

    isLoading.value = true
    error.value = null

    try {
      const offset = append ? atPostsOffset.value : 0
      const posts = await apiFetch<AtPost[]>(
        `/at/posts?limit=${PAGE_SIZE}&offset=${offset}`,
      )

      if (append) {
        atPosts.value.push(...posts)
      } else {
        atPosts.value = posts
        atPostsOffset.value = 0
      }

      atPostsOffset.value = offset + posts.length
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to fetch AT posts'
      console.error('[AtBridgeStore] fetchAtPosts error:', err)
    } finally {
      isLoading.value = false
    }
  }

  /**
   * Fetch firehose ingestion health status.
   */
  async function fetchFirehoseStatus(): Promise<void> {
    try {
      const status = await apiFetch<typeof firehoseStatus.value>('/at/status')
      firehoseStatus.value = status
    } catch (err) {
      console.error('[AtBridgeStore] fetchFirehoseStatus error:', err)
    }
  }

  /**
   * Subscribe to a new AT firehose source.
   */
  async function subscribeToSource(
    sourceId: string,
    url: string,
    sourceType: 'relay' | 'pds' = 'relay',
  ): Promise<{ success: boolean; message: string }> {
    try {
      const result = await apiFetch<{ success: boolean; message: string; sourceId: string }>(
        '/at/subscribe',
        {
          method: 'POST',
          body: JSON.stringify({ sourceId, url, sourceType }),
        },
      )
      await fetchFirehoseStatus()
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to subscribe to source'
      console.error('[AtBridgeStore] subscribeToSource error:', err)
      return { success: false, message }
    }
  }

  /**
   * Set the active feed source filter and refresh the unified feed.
   */
  async function setFeedSource(source: FeedSource): Promise<void> {
    feedSource.value = source
    await fetchUnifiedFeed(false)
  }

  /**
   * Reset all state (e.g. on logout).
   */
  function reset(): void {
    atPosts.value = []
    unifiedFeed.value = []
    firehoseStatus.value = { sources: [], stats: { totalAtPosts: 0, totalAtIdentities: 0 } }
    feedSource.value = 'all'
    error.value = null
    unifiedFeedOffset.value = 0
    atPostsOffset.value = 0
  }

  return {
    // State
    atPosts,
    unifiedFeed,
    firehoseStatus,
    feedSource,
    isLoading,
    error,

    // Computed
    hasAtContent,
    isFirehoseConnected,

    // Actions
    fetchUnifiedFeed,
    fetchAtPosts,
    fetchFirehoseStatus,
    subscribeToSource,
    setFeedSource,
    reset,
  }
})

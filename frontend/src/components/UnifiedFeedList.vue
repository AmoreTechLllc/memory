<script setup lang="ts">
/**
 * UnifiedFeedList — Renders the combined AT Protocol + ActivityPods feed.
 *
 * Features:
 *   - Source filter tabs (All / ActivityPods / AT Protocol)
 *   - Infinite scroll (load more on button click)
 *   - Loading and error states
 *   - Firehose connection indicator
 */
import { onMounted } from 'vue'
import { useAtBridgeStore, type FeedSource } from '@/stores/atBridgeStore'
import UnifiedFeedItem from './UnifiedFeedItem.vue'

const store = useAtBridgeStore()

onMounted(async () => {
  await store.fetchUnifiedFeed()
  await store.fetchFirehoseStatus()
})

const sources: { label: string; value: FeedSource }[] = [
  { label: 'All', value: 'all' },
  { label: 'ActivityPods', value: 'activitypods' },
  { label: 'AT Protocol', value: 'atproto' },
]
</script>

<template>
  <div class="UnifiedFeedList flex flex-col gap-[var(--gap-default)] py-[var(--gap-default)]">
    <!-- Firehose status indicator -->
    <div v-if="store.firehoseStatus.sources.length > 0" class="flex items-center gap-2 text-caption">
      <span
        class="inline-block h-2 w-2 rounded-full"
        :class="store.isFirehoseConnected ? 'bg-green-500' : 'bg-red-400'"
      ></span>
      <span>
        AT Firehose: {{ store.isFirehoseConnected ? 'Connected' : 'Disconnected' }}
        &nbsp;·&nbsp;
        {{ store.firehoseStatus.stats.totalAtPosts }} federated posts
      </span>
    </div>

    <!-- Source filter tabs -->
    <div class="flex gap-2">
      <button
        v-for="src in sources"
        :key="src.value"
        class="rounded px-3 py-1 text-sm font-medium transition-colors"
        :class="store.feedSource === src.value
          ? 'bg-blue-600 text-white'
          : 'bg-pastel-light text-gray-700 hover:bg-blue-100'"
        @click="store.setFeedSource(src.value)"
      >
        {{ src.label }}
      </button>
    </div>

    <!-- Loading state -->
    <div v-if="store.isLoading && store.unifiedFeed.length === 0" class="text-center text-caption py-4">
      Loading feed…
    </div>

    <!-- Error state -->
    <div v-else-if="store.error" class="rounded bg-red-50 p-3 text-sm text-red-700">
      {{ store.error }}
    </div>

    <!-- Empty state -->
    <div
      v-else-if="!store.isLoading && store.unifiedFeed.length === 0"
      class="text-center text-caption py-8"
    >
      No posts yet.
      <span v-if="store.feedSource === 'atproto'">
        Subscribe to an AT Protocol relay to start receiving federated content.
      </span>
    </div>

    <!-- Feed items -->
    <UnifiedFeedItem
      v-for="item in store.unifiedFeed"
      :key="`${item.source}-${item.id}`"
      :item="item"
    />

    <!-- Load more -->
    <div v-if="store.unifiedFeed.length > 0" class="text-center py-2">
      <button
        class="rounded px-4 py-2 text-sm font-medium bg-pastel-light hover:bg-blue-100 transition-colors"
        :disabled="store.isLoading"
        @click="store.fetchUnifiedFeed(true)"
      >
        {{ store.isLoading ? 'Loading…' : 'Load more' }}
      </button>
    </div>
  </div>
</template>

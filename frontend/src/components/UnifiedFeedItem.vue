<script setup lang="ts">
/**
 * UnifiedFeedItem — Renders a single post from either ActivityPods or AT Protocol.
 *
 * The source badge distinguishes between the two federation protocols,
 * and AT Protocol posts include a link to the original record.
 */
import { DateTime } from 'luxon'
import MemoryButton from './MemoryButton.vue'
import type { UnifiedFeedItem } from '@/stores/atBridgeStore'

const props = defineProps<{
  item: UnifiedFeedItem
}>()

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Unknown time'
  return DateTime.fromISO(dateStr).toRelative() ?? dateStr
}

function getAtProfileUrl(webId: string): string {
  // Link to Bluesky profile if it looks like a DID
  if (webId.startsWith('did:')) {
    return `https://bsky.app/profile/${webId}`
  }
  return webId
}
</script>

<template>
  <div class="rounded-default bg-pastel-light p-[var(--padding-main)]">
    <!-- Author row -->
    <div class="user flex flex-row gap-[var(--gap-default)]">
      <box-icon class="h-[27px] w-[27px]" type="solid" name="user-circle"></box-icon>
      <div class="w-full">
        <div class="flex items-center gap-2">
          <p class="text-footnote font-bold">{{ item.authorName }}</p>
          <!-- Source badge -->
          <span
            v-if="item.source === 'atproto'"
            class="rounded px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
            style="background: #0085ff; color: white;"
          >
            AT
          </span>
          <span
            v-else
            class="rounded px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
            style="background: #6366f1; color: white;"
          >
            AP
          </span>
        </div>
        <p class="text-caption">
          <a
            v-if="item.source === 'atproto'"
            :href="getAtProfileUrl(item.authorWebId)"
            target="_blank"
            rel="noopener noreferrer"
            class="underline"
          >
            {{ item.authorWebId }}
          </a>
          <span v-else>{{ item.authorWebId }}</span>
          &nbsp;•&nbsp;
          {{ formatRelativeTime(item.createdAt) }}
        </p>
      </div>
      <MemoryButton v-if="item.source === 'activitypods'">Follow</MemoryButton>
      <a
        v-if="item.source === 'atproto' && item.atUri"
        :href="`https://bsky.app/profile/${item.authorWebId}/post/${item.atUri.split('/').pop()}`"
        target="_blank"
        rel="noopener noreferrer"
        class="text-caption underline self-start"
      >
        View on Bluesky
      </a>
    </div>

    <!-- Content -->
    <p class="mt-2 whitespace-pre-wrap break-words">{{ item.content }}</p>
  </div>
</template>

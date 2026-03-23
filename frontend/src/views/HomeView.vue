<script setup lang="ts">
import CreatePostForm from '@/components/CreatePostForm.vue'
import PostList from '@/components/PostList.vue'
import UnifiedFeedList from '@/components/UnifiedFeedList.vue'
import { ref } from 'vue'

type Tab = 'my-posts' | 'federated'
const activeTab = ref<Tab>('federated')
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- Tab switcher -->
    <div class="flex gap-2 border-b border-gray-200 pb-2">
      <button
        class="rounded-t px-4 py-2 text-sm font-semibold transition-colors"
        :class="activeTab === 'federated'
          ? 'border-b-2 border-blue-600 text-blue-600'
          : 'text-gray-500 hover:text-gray-700'"
        @click="activeTab = 'federated'"
      >
        🌐 Federated Feed
      </button>
      <button
        class="rounded-t px-4 py-2 text-sm font-semibold transition-colors"
        :class="activeTab === 'my-posts'
          ? 'border-b-2 border-blue-600 text-blue-600'
          : 'text-gray-500 hover:text-gray-700'"
        @click="activeTab = 'my-posts'"
      >
        ✍️ My Posts
      </button>
    </div>

    <!-- Federated Feed (AT Protocol + ActivityPods) -->
    <div v-if="activeTab === 'federated'">
      <UnifiedFeedList />
    </div>

    <!-- My Posts -->
    <div v-if="activeTab === 'my-posts'">
      <CreatePostForm />
      <PostList />
    </div>
  </div>
</template>

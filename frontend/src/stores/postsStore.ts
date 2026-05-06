import type { App, CreatePost, CreatePoll } from '@/types'
import { buildApiHeaders, getApiBaseUrl } from '@/controller/http'
import { treaty } from '@elysiajs/eden'
import { defineStore } from 'pinia'
import { useAuthStore } from './authStore'
import { ref } from 'vue'
import type { SelectPost } from '#api/types'

export const usePostsStore = defineStore('posts', () => {
  // Default state
  const posts = ref<SelectPost[]>([])
  const hashtagFilter = ref('')
  // Stores
  const authStore = useAuthStore()
  // API
  const client = treaty<App>(getApiBaseUrl(), {
    onRequest() {
      return {
        headers: buildApiHeaders({ authToken: authStore.token || undefined })
      }
    }
  })

  // Util Functions
  /**
   * Fetches posts from the API
   */
  async function fetchPosts() {
    const { data: postResponse, status } = (await client.posts.get({
      query: {
        limit: 10,
        offset: 0,
        ...(hashtagFilter.value ? { hashtag: hashtagFilter.value } : {})
      }
    })) as unknown as { data: SelectPost[]; status: number }
    if (status === 401) {
      await authStore.logout('private')
    } else if (status === 200) {
      const newPosts = postResponse as SelectPost[]
      posts.value = newPosts
    }
  }

  interface CreatePostInput {
    content: string
    hashtags?: string[]
    poll?: CreatePoll | null
    postType?: 'note' | 'article'
    name?: string | null
    summary?: string | null
  }

  /**
   * Create a new post using the API's unified request shape.
   * Polls remain note-only in the current UI, while articles can include
   * a title and summary for long-form publishing.
   */
  async function createPost({
    content,
    hashtags = [],
    poll = null,
    postType = 'note',
    name = null,
    summary = null,
  }: CreatePostInput): Promise<SelectPost | null> {
    const requestBody: CreatePost = {
      content,
      ...(hashtags.length > 0 ? { hashtags } : {}),
      isPublic: true,
      postType,
      ...(name ? { name } : {}),
      ...(summary ? { summary } : {}),
      ...(poll ? { poll } : {}),
    }
    const postResponse = await client.posts.post(requestBody)
    if (postResponse.status === 200) {
      const newPost = postResponse.data as SelectPost
      posts.value.push(newPost)
      return newPost
    }
    return null
  }

  async function setHashtagFilter(hashtag: string) {
    hashtagFilter.value = hashtag
    await fetchPosts()
  }

  async function clearHashtagFilter() {
    if (!hashtagFilter.value) return
    hashtagFilter.value = ''
    await fetchPosts()
  }

  console.log('posts: ', posts)
  console.log('posts: ', posts.value.length)
  // Init store
  if (posts.value.length === 0) {
    fetchPosts()
  }

  return {
    posts,
    hashtagFilter,
    fetchPosts,
    createPost,
    setHashtagFilter,
    clearHashtagFilter
  }
})

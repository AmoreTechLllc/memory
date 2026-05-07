<script setup lang="ts">
import { useI18n } from '@/i18n'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { useAuthStore } from '@/stores/authStore'

const { availableLocales, locale, setLocale, t } = useI18n()
const notificationsStore = useNotificationsStore()
const authStore = useAuthStore()

function onLocaleChange(event: Event) {
  const target = event.target as HTMLSelectElement | null
  if (target) {
    setLocale(target.value)
  }
}

function onIncludeFollowsChange(event: Event) {
  const target = event.target as HTMLInputElement | null
  if (target) {
    void notificationsStore.setGroupingPreferences({ includeFollows: target.checked })
  }
}

function onIncludeMentionsChange(event: Event) {
  const target = event.target as HTMLInputElement | null
  if (target) {
    void notificationsStore.setGroupingPreferences({ includeMentions: target.checked })
  }
}

function onWindowHoursChange(event: Event) {
  const target = event.target as HTMLSelectElement | null
  if (target) {
    const windowHours = Number.parseInt(target.value, 10)
    if (Number.isFinite(windowHours)) {
      void notificationsStore.setGroupingPreferences({ windowHours })
    }
  }
}
</script>

<template>
  <div class="flex flex-col gap-4 py-4">
    <h2 class="text-xl font-semibold">{{ t('settings.title') }}</h2>

    <section class="rounded-default bg-pastel-light p-[var(--padding-main)]">
      <label class="flex flex-col gap-2 text-sm font-medium">
        {{ t('common.language') }}
        <select
          :value="locale"
          class="rounded border border-gray-300 bg-white px-3 py-2 font-normal"
          @change="onLocaleChange"
        >
          <option v-for="availableLocale in availableLocales" :key="availableLocale" :value="availableLocale">
            {{ t(`common.languages.${availableLocale}`) }}
          </option>
        </select>
      </label>
      <p class="text-caption mt-2">{{ t('settings.language.description') }}</p>
      <p class="text-caption mt-1">{{ t('settings.language.updatesImmediately') }}</p>
    </section>

    <section class="rounded-default bg-pastel-light p-[var(--padding-main)] flex flex-col gap-3">
      <h3 class="text-base font-semibold">{{ t('settings.appearance.title') }}</h3>
      <p class="text-caption">{{ t('settings.appearance.description') }}</p>

      <label class="flex items-center justify-between gap-3 text-sm">
        <span>{{ t('settings.appearance.notifications.groupFollows') }}</span>
        <input
          type="checkbox"
          :checked="notificationsStore.groupingPreferences.includeFollows"
          @change="onIncludeFollowsChange"
        >
      </label>

      <label class="flex items-center justify-between gap-3 text-sm">
        <span>{{ t('settings.appearance.notifications.groupMentions') }}</span>
        <input
          type="checkbox"
          :checked="notificationsStore.groupingPreferences.includeMentions"
          @change="onIncludeMentionsChange"
        >
      </label>

      <label class="flex flex-col gap-2 text-sm">
        <span>{{ t('settings.appearance.notifications.groupWindow') }}</span>
        <select
          :value="notificationsStore.groupingPreferences.windowHours"
          class="rounded border border-gray-300 bg-white px-3 py-2 font-normal"
          @change="onWindowHoursChange"
        >
          <option :value="24">{{ t('settings.appearance.notifications.window.24h') }}</option>
          <option :value="72">{{ t('settings.appearance.notifications.window.72h') }}</option>
          <option :value="168">{{ t('settings.appearance.notifications.window.168h') }}</option>
          <option :value="336">{{ t('settings.appearance.notifications.window.336h') }}</option>
        </select>
      </label>
    </section>

    <RouterLink
      to="/settings/profile"
      class="rounded-default bg-pastel-light p-[var(--padding-main)] hover:bg-blue-100 transition-colors"
    >
      <h3 class="text-base font-semibold">{{ t('settings.cards.profile.title') }}</h3>
      <p class="text-caption mt-1">{{ t('settings.cards.profile.description') }}</p>
    </RouterLink>
    <RouterLink
      to="/settings/feed-controls"
      class="rounded-default bg-pastel-light p-[var(--padding-main)] hover:bg-blue-100 transition-colors"
    >
      <h3 class="text-base font-semibold">{{ t('settings.cards.feedControls.title') }}</h3>
      <p class="text-caption mt-1">{{ t('settings.cards.feedControls.description') }}</p>
    </RouterLink>
    <RouterLink
      to="/settings/moderation"
      class="rounded-default bg-pastel-light p-[var(--padding-main)] hover:bg-blue-100 transition-colors"
    >
      <h3 class="text-base font-semibold">{{ t('settings.cards.moderation.title') }}</h3>
      <p class="text-caption mt-1">{{ t('settings.cards.moderation.description') }}</p>
    </RouterLink>

    <button
      class="rounded-default bg-red-50 p-[var(--padding-main)] hover:bg-red-100 transition-colors text-left w-full"
      @click="authStore.logout()"
    >
      <h3 class="text-base font-semibold text-red-600">Sign out</h3>
      <p class="text-caption mt-1 text-red-400">Sign out of your account</p>
    </button>
  </div>
</template>

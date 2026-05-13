<script setup lang="ts">
import MemoryButton from '@/components/MemoryButton.vue'
import { useI18n } from '@/i18n'

const { t } = useI18n()
</script>

<template>
  <div class="welcome">
    <div class="welcome__ambient" aria-hidden="true">
      <div class="welcome__glow welcome__glow--pink" />
      <div class="welcome__glow welcome__glow--blue" />
      <div class="welcome__glow welcome__glow--cream" />
    </div>

    <div class="welcome__shell">
      <header class="welcome__brand-wrap">
        <p class="welcome__brand">memory.</p>
      </header>

      <div class="welcome__content text-white">
        <div class="welcome__copy">
          <p class="welcome__eyebrow">Welcome to</p>
          <h1 class="welcome__title">Memory.</h1>
          <p class="welcome__tagline">
            {{ t('welcome.tagline') }}
          </p>
        </div>

        <div class="welcome__actions">
          <MemoryButton class="welcome__button welcome__button--primary" success @click="$router.push({ name: 'signin' })">
            {{ t('common.actions.signUp') }}
          </MemoryButton>
          <MemoryButton class="welcome__button welcome__button--secondary" success @click="$router.push({ name: 'signin' })">
            {{ t('common.actions.signIn') }}
          </MemoryButton>
        </div>

        <div class="welcome__footer">
          <p>{{ t('welcome.terms') }}</p>
          <span class="welcome__footer-dot" aria-hidden="true">·</span>
          <p>{{ t('welcome.imprint') }}</p>
          <span class="welcome__footer-dot" aria-hidden="true">·</span>
          <p>{{ t('welcome.about') }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.welcome {
  position: relative;
  min-height: 100dvh;
  overflow: hidden;
  background:
    linear-gradient(180deg, #f7efe7 0%, #f4ecf0 16%, #d88eff 58%, #5d74ff 100%);
}

.welcome__ambient {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

.welcome__glow {
  position: absolute;
  border-radius: 999px;
  filter: blur(18px);
  opacity: 0.8;
}

.welcome__glow--cream {
  top: 6%;
  left: 16%;
  width: 62%;
  height: 22%;
  background: radial-gradient(circle, rgb(255 250 244 / 88%) 0%, rgb(255 250 244 / 0%) 72%);
}

.welcome__glow--pink {
  left: -18%;
  bottom: 18%;
  width: 72%;
  height: 40%;
  background: radial-gradient(circle, rgb(239 127 255 / 82%) 0%, rgb(239 127 255 / 0%) 72%);
}

.welcome__glow--blue {
  right: -10%;
  bottom: 8%;
  width: 68%;
  height: 42%;
  background: radial-gradient(circle, rgb(99 168 255 / 82%) 0%, rgb(99 168 255 / 0%) 70%);
}

.welcome__shell {
  position: relative;
  z-index: 1;
  display: flex;
  min-height: 100dvh;
  width: 100%;
  max-width: 28rem;
  margin: 0 auto;
  flex-direction: column;
  padding:
    calc(env(safe-area-inset-top, 0px) + 1.2rem)
    1.5rem
    calc(env(safe-area-inset-bottom, 0px) + 1.5rem);
}

.welcome__brand-wrap {
  display: flex;
  justify-content: center;
}

.welcome__brand {
  font-family: Butler, serif;
  font-size: 2rem;
  line-height: 1;
  color: rgb(31 25 30 / 0.92);
  letter-spacing: -0.04em;
}

.welcome__content {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  padding-bottom: 0.5rem;
}

.welcome__copy {
  display: flex;
  max-width: 18rem;
  flex-direction: column;
  gap: 0.5rem;
}

.welcome__eyebrow {
  font-size: 2rem;
  line-height: 0.95;
  font-weight: 500;
  letter-spacing: -0.04em;
}

.welcome__title {
  font-family: Butler, serif;
  font-size: clamp(3.8rem, 14vw, 4.8rem);
  line-height: 0.9;
  letter-spacing: -0.06em;
}

.welcome__tagline {
  max-width: 17rem;
  font-size: 1.1rem;
  line-height: 1.15;
  color: rgb(255 255 255 / 0.94);
}

.welcome__actions {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.welcome__button {
  min-height: 3.6rem;
  width: 100%;
  border-radius: 1.2rem;
  font-size: 1.05rem;
  font-weight: 600;
  box-shadow: 0 10px 28px rgb(38 28 71 / 0.12);
}

.welcome__button--primary {
  background: rgb(255 255 255 / 0.96);
  color: rgb(31 25 30 / 0.96);
}

.welcome__button--secondary {
  background: rgb(255 255 255 / 0.16);
  color: rgb(255 255 255 / 0.98);
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
}

.welcome__footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.35rem;
  padding-top: 0.45rem;
  font-size: 0.78rem;
  color: rgb(255 255 255 / 0.9);
}

.welcome__footer-dot {
  padding: 0 0.25rem;
}

@media (min-width: 640px) {
  .welcome__shell {
    padding-bottom: max(2rem, calc(env(safe-area-inset-bottom, 0px) + 2rem));
  }

  .welcome__content {
    gap: 1.75rem;
  }
}
</style>

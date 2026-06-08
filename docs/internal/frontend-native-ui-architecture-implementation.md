# Frontend Native UI Architecture Implementation Plan

Status: internal implementation planning
Scope: `frontend/`
Goal: move Memory from a mostly custom mobile-web interface to an adaptive semantic UI system that feels native on iOS, Android, installed PWA, browser PWA, and desktop web.

> Git note: `docs/internal/` is ignored for future local planning notes. `.gitignore` does not hide a file that is already committed, so do not place secrets, credentials, private endpoints, or unreleased business details in committed docs.

---

## 1. Current frontend baseline

The current app is a Vue 3, Vite, TypeScript, Pinia, Vue Router, Tailwind, Konsta, and Capacitor frontend.

Strengths:

- Vue 3 Composition API is already established.
- Pinia stores already separate data/state from most UI.
- Capacitor is already installed for native and PWA capabilities.
- `App.vue` centralizes shell layout, route transitions, status bar behavior, Android back handling, and the shared scroll container.
- `AppTopBar` and `AppTabBar` already provide shell abstractions.
- `frontend/src/assets/theme.css` already contains design tokens.
- `UnifiedFeedList` and `UnifiedFeedItem` already split feed list and feed-card rendering.
- TanStack Virtual is already used for feed performance.

Weaknesses:

- The UI is not yet a true platform-adaptive native system.
- Many views recreate native controls with Tailwind instead of using semantic native-pattern components.
- `ExploreView.vue` is too large and mixes state, mock data, repeated rows, search UI, and presentation.
- There is no single platform profile for iOS, Android, installed PWA, browser PWA, and desktop web.
- Icon selection is not yet platform-semantic.
- Keyboard, haptics, safe areas, and motion are not governed by one clear policy.
- Native emoji and native keyboard behavior are not explicitly protected as default behavior.

---

## 2. Target stack

Preferred long-term stack:

```txt
Vue 3
Vite
TypeScript
Pinia
Vue Router
Framework7 Vue
Capacitor
Tailwind CSS v4 for tokens/layout only
Iconoir behind AppIcon as default/fallback icon source
Native OS emoji and keyboard behavior by default
```

Konsta should be removed after Framework7 shell parity exists. Keeping Framework7 and Konsta as peer UI systems would create duplicated shell components, duplicated theme rules, and inconsistent native behavior.

Tailwind remains useful for spacing, layout, and token composition, but it should not be used to recreate native lists, search bars, sheets, dialogs, tab bars, or navigation bars from scratch.

---

## 3. Architecture model

Target flow:

```txt
Device/runtime detection
  -> Native UI profile
  -> Semantic design components
  -> Route screens / feature components
  -> Pinia stores / API services
```

Route components should declare intent, not visual implementation. For example, a route should ask for `AppSearchBar`, `AppGroupedList`, `AppActionSheet`, or `AppComposer`; the design layer decides how that maps to iOS, Android, installed PWA, browser PWA, or desktop web.

---

## 4. Platform adaptation rules

### iOS and iPadOS

- Prefer Framework7 iOS theme.
- Use iOS-style navbars, large titles, tab bars, grouped/inset lists, action sheets, modal sheets, swipe-back navigation, photo browser patterns, and segmented controls.
- Respect safe-area insets and dynamic viewport behavior.
- Use native iOS emoji rendering.
- Use native iOS keyboard behavior whenever possible.
- Use Capacitor Keyboard only for composer avoidance, bottom inset calculation, and reliable viewport handling.
- Use haptics sparingly for meaningful state changes: tab selection, successful post, destructive confirmation, long-press reveal, story boundary.
- Avoid replacing native input/textarea behavior with custom contenteditable unless a feature requires it.

### Android

- Prefer Framework7 Material theme.
- Respect Android hardware back and gesture navigation.
- Use Material nav, lists, sheets/dialogs, ripples, and Android keyboard behavior.
- Use native Android emoji rendering.
- Use Android IME action semantics through correct input attributes.
- Keep haptics meaningful and restrained.

### Installed PWA

- Treat installed PWA as app-like but capability-limited.
- Detect standalone display mode.
- Respect safe-area CSS variables, especially on iOS.
- Use web APIs first where they map to OS behavior, such as native share when available.

### Browser / desktop web

- Do not force iOS visual conventions on desktop.
- Keep mobile shell on narrow breakpoints.
- Use desktop-friendly hover states, focus rings, keyboard navigation, and menu behavior.
- Preserve accessibility semantics.

---

## 5. Platform profile modules

Add a canonical platform/capability layer:

```txt
frontend/src/platform/nativeUiProfile.ts
frontend/src/platform/capabilityDetection.ts
frontend/src/platform/platformIcons.ts
frontend/src/platform/keyboardPolicy.ts
frontend/src/platform/hapticPolicy.ts
frontend/src/platform/safeAreaPolicy.ts
frontend/src/platform/motionPolicy.ts
```

Suggested profile types:

```ts
export type MemoryOsFamily = 'ios' | 'android' | 'macos' | 'windows' | 'linux' | 'unknown'
export type MemoryRuntime = 'capacitor-native' | 'installed-pwa' | 'browser-pwa' | 'browser'
export type MemoryUiDialect = 'ios' | 'material' | 'desktop'

export interface NativeUiProfile {
  osFamily: MemoryOsFamily
  runtime: MemoryRuntime
  uiDialect: MemoryUiDialect
  isTouchFirst: boolean
  isStandalone: boolean
  supportsSafeAreaInsets: boolean
  supportsNativeShare: boolean
  supportsFilePicker: boolean
  supportsPushNotifications: boolean
  supportsLocalNotifications: boolean
  supportsHaptics: boolean
  supportsKeyboardPlugin: boolean
  prefersReducedMotion: boolean
  prefersContrastMore: boolean
  pointer: 'coarse' | 'fine' | 'none' | 'unknown'
}
```

Detection inputs:

- Capacitor platform when available.
- Browser platform hints where available.
- User agent fallback only when necessary.
- `(display-mode: standalone)` media query.
- iOS standalone fallback when available.
- pointer, reduced-motion, and contrast media queries.
- feature detection for native share, notifications, clipboard, file picker, and related web APIs.

Privacy rules:

- Keep platform detection local unless there is a documented product need.
- Store only coarse capability flags needed for UI behavior.
- Do not use UI detection data as an analytics identifier.

Framework7 theme selection should be derived from this profile:

```ts
const framework7Theme = computed(() => {
  if (profile.uiDialect === 'ios') return 'ios'
  if (profile.uiDialect === 'material') return 'md'
  return 'auto'
})
```

---

## 6. Semantic design layer

Create semantic wrappers so most product code does not directly import Framework7 internals.

Suggested folder:

```txt
frontend/src/design/semantic/
  AppRoot.vue
  AppPage.vue
  AppNavbar.vue
  AppTabBar.vue
  AppToolbar.vue
  AppList.vue
  AppListItem.vue
  AppGroupedList.vue
  AppSearchBar.vue
  AppSegmentedControl.vue
  AppButton.vue
  AppIcon.vue
  AppSheet.vue
  AppActionSheet.vue
  AppDialog.vue
  AppPopover.vue
  AppToast.vue
  AppComposer.vue
  AppTextField.vue
  AppTextArea.vue
  AppMediaViewer.vue
  AppPullToRefresh.vue
  AppVirtualList.vue
```

Rules:

- Route screens import semantic components.
- Raw Framework7 imports should live mainly inside `design/semantic`.
- Raw Iconoir imports should live behind `AppIcon`.
- Raw Capacitor plugin calls should live behind platform composables.

Example route style:

```vue
<AppPage title="memory." large-title>
  <AppSegmentedControl v-model="activeTab" :items="tabs" />
  <StoryRail />
  <UnifiedFeedList mode="balanced" />
</AppPage>
```

---

## 7. Icon strategy

Use semantic icon names rather than direct library names.

Selection order:

1. Platform-specific semantic mapping.
2. Framework7 built-in icon if it better matches the platform.
3. Iconoir fallback.
4. Minimal inline SVG fallback for critical icons.

Suggested files:

```txt
frontend/src/components/AppIcon.vue
frontend/src/components/AppIcon.types.ts
frontend/src/design/icons/iconRegistry.ts
frontend/src/design/icons/platformIconMap.ts
```

Suggested semantic names:

```ts
export type AppIconName =
  | 'home'
  | 'explore'
  | 'messages'
  | 'notifications'
  | 'profile'
  | 'settings'
  | 'back'
  | 'close'
  | 'compose'
  | 'reply'
  | 'repost'
  | 'quote'
  | 'like'
  | 'bookmark'
  | 'share'
  | 'more'
  | 'search'
  | 'camera'
  | 'photo'
  | 'video'
  | 'microphone'
  | 'poll'
  | 'shield'
  | 'mute'
  | 'block'
  | 'report'
  | 'trash'
```

Accessibility:

- Decorative icons are `aria-hidden`.
- Icon-only buttons require localized `aria-label`.
- Destructive actions must not rely on icon shape alone.

---

## 8. Native emoji and keyboard policy

Memory should use native emoji and native keyboards by default.

Emoji rules:

- Do not globally replace platform emoji fonts.
- Use system font stacks that allow Apple Color Emoji, Segoe UI Emoji, and platform fallbacks.
- Preserve Unicode emoji sequences including skin tone, gender, ZWJ, and variation selectors.
- Do not rewrite emoji presentation unless required by a protocol boundary and documented.

Recommended font stack:

```css
font-family:
  -apple-system,
  BlinkMacSystemFont,
  "SF Pro Text",
  "Segoe UI",
  Roboto,
  Helvetica,
  Arial,
  "Apple Color Emoji",
  "Segoe UI Emoji",
  "Segoe UI Symbol",
  sans-serif;
```

Keyboard rules:

- Prefer native `<input>` and `<textarea>`.
- Avoid custom composers unless necessary.
- Use `inputmode`, `autocomplete`, `autocapitalize`, `enterkeyhint`, and `spellcheck` intentionally.
- Respect OS autocorrect, predictive text, dictation, emoji picker, and accessibility input systems.
- Do not block paste unless there is a documented security reason.

Composer defaults:

```html
<textarea
  inputmode="text"
  enterkeyhint="send"
  autocapitalize="sentences"
  autocomplete="off"
  spellcheck="true"
/>
```

Search defaults:

```html
<input
  type="search"
  inputmode="search"
  enterkeyhint="search"
  autocapitalize="none"
  autocomplete="off"
  spellcheck="false"
/>
```

Keyboard state abstraction:

```ts
export interface KeyboardState {
  isOpen: boolean
  height: number
  safeAreaBottom: number
  effectiveBottomInset: number
}
```

Use it for post composer, inline reply composer, message composer, story composer, bottom sheets with text input, and search pages.

---

## 9. Motion and gestures

Framework7 should be the default gesture/motion provider.

Use Framework7 for:

- swipe-back navigation
- page transitions
- tab transitions
- sheets
- dialogs
- popovers
- action sheets
- panels
- pull-to-refresh
- swipeable list rows
- sortable lists
- messages/messagebar interactions
- photo browser gestures
- touch-hold behavior

Use CSS transitions for small fades, title transitions, chip selection, button press states, and simple expand/collapse.

Use Motion for Vue or another Vue-native motion layer only for advanced cases Framework7 does not cover: shared-element transitions, gesture-driven story viewer transitions, spring media dismissal, composer expansion, and reaction bursts.

Requirements:

- Respect reduced motion.
- Do not animate virtualized feed layout in ways that cause jank.
- Keep gesture animations interruptible where possible.
- Trigger haptics only for meaningful state changes.

---

## 10. Migration phases

### Phase 0: Lock current behavior

- Run frontend typecheck/build/tests.
- Capture screenshots of Home, Explore, Settings, Profile, Notifications, Messages, Thread, Sign In, Signup, and Welcome.
- Confirm auth guard behavior.
- Do not change API contracts or Pinia store behavior.

### Phase 1: Add Framework7 root

- Add Framework7 dependencies.
- Create `design/semantic/AppRoot.vue`.
- Replace Konsta `kApp` only after Framework7 root parity exists.
- Preserve route guards, document titles, Android back behavior, status bar setup, and scroll behavior.

### Phase 2: Replace shell navigation

- Replace `AppTopBar` internals with Framework7 Navbar semantics.
- Replace `AppTabBar` internals with Framework7 Toolbar/Tabbar semantics.
- Keep public component names initially.
- Preserve notification badge and haptic tab feedback.

### Phase 3: Semantic forms and keyboard

- Add `AppTextField`, `AppTextArea`, `AppSearchBar`, and `AppComposer`.
- Move keyboard-aware behavior into platform policy/composables.
- Replace custom search and composer controls route by route.

### Phase 4: Settings and lists

- Convert Settings, Feed Controls, and Moderation screens to semantic grouped/inset lists.
- Use native-style toggles, radios, check rows, sliders, and destructive actions.

### Phase 5: Explore refactor

Split `ExploreView.vue` into:

```txt
frontend/src/features/explore/
  ExploreSearchHeader.vue
  ExploreSearchResults.vue
  ExploreSearchHistory.vue
  ExploreTrendingTags.vue
  ExploreRecommendedTags.vue
  ExploreRecommendedPeople.vue
  ExploreLatestPosts.vue
  useExploreSearch.ts
```

Use `AppSearchBar`, semantic list rows, and isolated demo/mock data where needed.

### Phase 6: Feed native polish

- Keep `UnifiedFeedList` and `UnifiedFeedItem` contracts stable.
- Add pull-to-refresh.
- Keep TanStack Virtual unless Framework7 proves equally stable for variable-height posts.
- Convert `MoreActionsSheet` to semantic action sheet.
- Add swipe/context actions only with accessible fallback.

### Phase 7: Stories and media

- Add tap next/previous, hold pause, swipe dismiss, and horizontal group navigation.
- Use Framework7 Photo Browser or `AppMediaViewer` wrapper.
- Respect safe areas and reduced motion.

### Phase 8: Messages

- Use Framework7 Messages/Messagebar patterns or semantic wrappers.
- Use `AppComposer` and keyboard-aware layout.
- Use action sheets/context menus for message actions with non-gesture fallback.

### Phase 9: Remove Konsta

- Remove Konsta imports.
- Remove Konsta dependency.
- Remove Konsta CSS import.
- Run typecheck/build/tests.
- Confirm no active `konsta` imports remain.

---

## 11. Route targets

Home:

- `AppPage` with large title.
- Semantic segmented control.
- Story rail.
- Composer entry/sheet.
- Unified feed with pull-to-refresh.

Explore:

- Native search page behavior.
- Search history as native list rows.
- Trending tags, recommended tags, people, and latest posts as separate feature components.

Messages:

- Native conversation list.
- Framework7-style message thread.
- Keyboard-aware composer.

Notifications:

- Native list surface.
- Group by date if useful.
- Badge count remains store-driven.

Profile/User Profile:

- Native profile header.
- Segmented tabs.
- Native share/action sheet behavior.

Thread:

- Native push transition.
- Root post and replies.
- Keyboard-aware inline reply composer.

Settings:

- Grouped/inset native settings lists.
- Native toggles and destructive action patterns.

Auth:

- Full-screen onboarding/auth pages.
- Native forms and autofill/passkey-friendly attributes.

---

## 12. Accessibility requirements

- Every interactive icon button has an accessible label.
- Swipe-only actions have visible or menu-based alternatives.
- Reduced motion is respected globally.
- Text contrast should meet WCAG AA where possible.
- Dynamic text scaling should not break shell, cards, or composer.
- Focus rings remain visible on desktop/web.
- Inputs preserve labels and descriptions.
- Destructive actions require clear confirmation or undo where appropriate.

---

## 13. Security and privacy requirements

- Do not store secrets in frontend docs or UI code.
- Keep platform detection local unless there is a documented product reason.
- Clipboard, file/photo selection, and native share must be user-triggered.
- Notification permission prompts should be contextual, not on first load.
- Do not log post content, message content, auth tokens, WebIDs, DIDs, or private user text in UI debugging.

---

## 14. Testing strategy

Minimum checks per phase:

```sh
cd frontend
bun install
bun run type-check
bun run build
bun run test:unit
```

Manual device matrix:

- iPhone Safari browser
- iPhone installed PWA
- iPhone Capacitor build
- Android Chrome browser
- Android installed PWA
- Android Capacitor build
- Desktop Safari
- Desktop Chrome
- Desktop Firefox

Critical scenarios:

- Auth routes hide shell.
- Logged-out protected routes redirect correctly.
- Root tabs navigate correctly.
- Back navigation works.
- Android hardware back works.
- iOS swipe-back works where enabled.
- Feed loads, filters, paginates, and virtualizes.
- Search opens native search keyboard.
- Composer opens native text/emoji keyboard.
- Keyboard does not cover composer.
- Safe areas are respected.
- Pull-to-refresh does not fight scrolling.
- Reduced motion disables nonessential animation.
- Native share uses OS sheet where supported.
- Unsupported haptics fail silently.

---

## 15. Definition of done

Done means:

- Framework7 is the primary native UI runtime.
- Konsta has no active imports or dependency usage.
- Route screens use semantic design primitives for shell, lists, search, forms, sheets, dialogs, and action menus.
- Platform profile drives iOS, Android, desktop, installed PWA, and browser UI choices.
- Native emoji rendering is preserved.
- Native keyboard behavior is preserved and enhanced only for safe-area/composer handling.
- Icon usage goes through `AppIcon` semantic mapping.
- Haptics go through policy-based composables.
- Safe areas are respected.
- Reduced motion is respected.
- Typecheck, build, and tests pass.
- Manual device checks show no shell, keyboard, navigation, or feed-blocking regressions.

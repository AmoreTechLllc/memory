# Memory Frontend Native Architecture Implementation Plan

Status: internal implementation document
Audience: frontend, mobile/PWA, product, design, QA
Scope: `frontend/` Vue 3 application in `AmoreTechLllc/memory`

> Important repository note: `docs/internal/` is intentionally added to `.gitignore` so future local drafts, migration checklists, screenshots, and working notes are not added accidentally. A file already committed to Git remains tracked even if its path matches `.gitignore`; use this document as the canonical implementation reference and keep volatile follow-up notes local unless they are intentionally reviewed.

## 1. Executive summary

Memory should move from a mostly custom Tailwind/Konsta mobile UI into a Framework7-first, OS-adaptive semantic frontend architecture.

The target is not merely an iOS-looking website. The target is an adaptive app runtime that:

1. Detects the user's actual environment: iOS Safari, iOS installed PWA, iOS Capacitor shell, Android Chrome, Android installed PWA, Android Capacitor shell, desktop browser, tablet, reduced-motion user, high-contrast user, touch vs pointer, keyboard capabilities, safe-area support, notification support, share support, file/media support, and haptic availability.
2. Chooses semantic UI behavior from that environment: iOS-like navigation and lists on Apple platforms; Material/Android patterns on Android where appropriate; desktop-appropriate density and keyboard navigation on desktop.
3. Leans on native platform features wherever allowed by web/PWA/Capacitor capabilities: system emoji, system keyboard behavior, native input types, native share sheets, native haptics, native status bar behavior, safe-area insets, local/push notifications, installed-PWA display modes, platform gestures, platform motion expectations, and OS-specific icon semantics.
4. Uses Framework7 as the primary mobile UI/UX system, Iconoir as the open-source fallback/default icon library behind a semantic `AppIcon` abstraction, Capacitor as the native bridge, and Tailwind only as a layout/token utility layer.
5. Removes Konsta once Framework7 equivalents are in place, avoiding two competing mobile UI systems.

The current frontend is already Vue 3, Vite, Pinia, Vue Router, Tailwind, Konsta, and Capacitor. That is close enough to migrate in phases without rewriting the data layer. The core change is the frontend architecture and UI system, not the feed store or API layer.

## 2. Current frontend baseline

Current stack observed in the repository:

- Vue 3
- Vite
- TypeScript
- Pinia
- Vue Router
- Tailwind CSS v4
- Konsta Vue
- Capacitor 7
- PGlite / Drizzle
- TanStack Vue Virtual
- VueUse
- custom components and composables

Current app shell:

- `frontend/src/main.ts` bootstraps Vue, Pinia, router, local DB, i18n, platform capabilities, session policy logging, service worker registration, and global styles.
- `frontend/src/App.vue` uses `kApp`, `AppTopBar`, `AppTabBar`, a shared scroll container, route transitions, reduced-motion handling, native status bar setup, and Android hardware back handling.
- `frontend/src/router/index.ts` defines home, auth, settings, feed controls, moderation, thread, explore, messages, notifications, experience, profile, and user profile routes.

Current UI/component pattern:

- `design/components/` contains shell/design primitives such as `AppTopBar`, `AppTabBar`, and segmented controls.
- `components/` contains product components such as feed items, story rails, composer, media carousel, link preview, poll, thread summary, and more-actions sheet.
- `views/` contains route-level screens. Some are already too large and mix state, mock/demo data, styling, and product layout.
- `stores/` contains Pinia stores. `atBridgeStore` is a major feed/orchestration store and already includes timeout/retry/backoff behavior for API calls.

Core frontend issue:

The app has native-adjacent pieces, but it is not yet a semantic native UI system. Many screens still manually recreate mobile UI with Tailwind classes. This produces inconsistent native feel, inconsistent spacing, custom controls where OS-native patterns should be used, and makes it harder to adapt to platform differences.

## 3. Target architecture

Target stack:

```txt
Vue 3
Vite
TypeScript
Pinia
Vue Router or Framework7 Router integration, decided during migration spike
Framework7 Vue
Capacitor
Tailwind CSS v4 for tokens/layout only
Iconoir behind AppIcon fallback
Native Web APIs where available
PWA service worker/manifest
```

Libraries to avoid as primary UI systems:

```txt
Konsta, after Framework7 shell is stable
ad hoc Tailwind recreations of native controls
heavy global animation engines as first step
multiple competing icon libraries imported directly across components
```

Primary architectural rule:

> Product components must express semantic intent. Platform adapters choose the closest available native-feeling implementation.

Do not build components like `RoundedWhiteSearchInput.vue` or `IosLookingButton.vue` as the core abstraction.

Build components like:

```txt
AppPage
AppNavbar
AppTabBar
AppToolbar
AppSearchBar
AppList
AppListItem
AppInsetGroup
AppSheet
AppActionSheet
AppDialog
AppComposer
AppMessageBar
AppMediaViewer
AppContextMenu
AppSegmentedControl
AppPullToRefresh
AppVirtualFeed
AppIcon
```

Each wrapper can render Framework7 iOS, Framework7 Material, browser-native fallback, or custom fallback as needed.

## 4. Proposed folder structure

Recommended frontend layout after migration:

```txt
frontend/src/
  app/
    AppShell.vue
    AppProviders.vue
    routes.ts
    routeMeta.ts

  platform/
    capabilities.ts
    detectPlatform.ts
    nativeUiProfile.ts
    keyboard.ts
    haptics.ts
    safeArea.ts
    displayMode.ts
    share.ts
    notifications.ts
    media.ts
    browser.ts
    input.ts

  design/
    tokens/
      semantic.css
      ios.css
      android.css
      desktop.css
      motion.css
    adapters/
      framework7.ts
      icons.ts
    components/
      AppPage.vue
      AppNavbar.vue
      AppTabBar.vue
      AppToolbar.vue
      AppSearchBar.vue
      AppList.vue
      AppListItem.vue
      AppInsetGroup.vue
      AppButton.vue
      AppIcon.vue
      AppSheet.vue
      AppActionSheet.vue
      AppDialog.vue
      AppSegmentedControl.vue
      AppPullToRefresh.vue
      AppComposer.vue
      AppMediaViewer.vue
      AppContextMenu.vue
      AppSkeleton.vue
      AppEmptyState.vue
      AppErrorState.vue

  features/
    feed/
      components/
      composables/
      stores/
    stories/
    explore/
    messages/
    notifications/
    profile/
    settings/
    auth/

  stores/
    authStore.ts
    atBridgeStore.ts
    notificationsStore.ts

  composables/
    retained shared composables only
```

Migration principle:

- Do not move every file immediately.
- Add the semantic layer first.
- Migrate one screen at a time.
- Avoid breaking the existing Pinia/API contracts.
- Remove Konsta only after all Konsta shell/components have Framework7 replacements.

## 5. Platform detection and adaptive UI profile

Create a single source of truth:

```txt
frontend/src/platform/nativeUiProfile.ts
```

This should expose a composable such as:

```ts
export type NativePlatform = 'ios' | 'android' | 'macos' | 'windows' | 'linux' | 'unknown'
export type RuntimeShell = 'capacitor' | 'installed-pwa' | 'browser'
export type UiIdiom = 'phone' | 'tablet' | 'desktop'
export type UiTheme = 'ios' | 'material' | 'desktop'

export interface NativeUiProfile {
  platform: NativePlatform
  runtime: RuntimeShell
  idiom: UiIdiom
  theme: UiTheme
  isTouchPrimary: boolean
  hasHover: boolean
  hasFinePointer: boolean
  supportsSafeArea: boolean
  supportsHaptics: boolean
  supportsNativeShare: boolean
  supportsPushNotifications: boolean
  supportsLocalNotifications: boolean
  supportsFilePicker: boolean
  supportsCameraCapture: boolean
  supportsKeyboardResizeControl: boolean
  prefersReducedMotion: boolean
  prefersContrastMore: boolean
  displayMode: 'browser' | 'standalone' | 'fullscreen' | 'minimal-ui' | 'unknown'
}
```

Detection sources:

- Capacitor runtime: `Capacitor.isNativePlatform()`, `Capacitor.getPlatform()`.
- Browser UA/client hints where available.
- `navigator.userAgentData` when available, with safe fallback.
- `navigator.platform` and user agent heuristics for iPadOS edge cases.
- `window.matchMedia('(display-mode: standalone)')` for installed PWA.
- `window.navigator.standalone` for legacy iOS standalone PWA detection.
- `matchMedia('(hover: hover)')`, `matchMedia('(pointer: fine)')`, `matchMedia('(prefers-reduced-motion: reduce)')`, `matchMedia('(prefers-contrast: more)')`.
- CSS env safe-area support by applying variables, not brittle JS-only checks.
- Feature detection: `navigator.share`, Notification API, service worker, File System Access where applicable, media capture support.

Rules:

1. Capability detection beats OS detection.
2. OS detection informs design defaults, not security decisions.
3. Never assume an iPhone browser has every native capability.
4. Never assume an installed PWA has Capacitor capabilities.
5. Never fork product behavior unnecessarily; fork UI affordances and platform integration.

Default mapping:

```txt
iOS Capacitor       -> theme: ios, runtime: capacitor, idiom from viewport/device
iOS installed PWA  -> theme: ios, runtime: installed-pwa
iOS browser        -> theme: ios, runtime: browser
Android Capacitor   -> theme: material, runtime: capacitor
Android installed PWA -> theme: material, runtime: installed-pwa
Android browser    -> theme: material, runtime: browser
Desktop browser    -> theme: desktop unless touch-tablet profile suggests ios/material
```

Memory default product direction:

- Apple/iOS should be the primary visual reference.
- Android should not be forced into fake iOS where native Android conventions are expected by users.
- Desktop should be treated as an adaptive web app, not a stretched phone UI.

## 6. Native icons strategy

Goal:

Use OS-native semantic iconography where possible, and Iconoir as the open-source fallback/default library.

Do not import icons directly inside product components except inside the icon adapter.

Create:

```txt
frontend/src/design/components/AppIcon.vue
frontend/src/design/adapters/icons.ts
```

Semantic icon names should reflect meaning, not library identity:

```ts
export type AppIconName =
  | 'home'
  | 'search'
  | 'compose'
  | 'reply'
  | 'repost'
  | 'quote'
  | 'like'
  | 'share'
  | 'bookmark'
  | 'more'
  | 'close'
  | 'back'
  | 'settings'
  | 'notifications'
  | 'messages'
  | 'profile'
  | 'visibility'
  | 'moderation'
  | 'camera'
  | 'photo'
  | 'gif'
  | 'poll'
  | 'link'
```

Resolution policy:

```txt
1. If running in a native Capacitor shell and platform-native icon assets are bundled, use platform asset mapping.
2. If running as iOS/iPadOS PWA/browser, use iOS-aligned glyph choices and stroke weights from the semantic mapping.
3. If running as Android PWA/browser, use Android/Material-aligned glyph choices where the semantic mapping differs.
4. Else use Iconoir fallback.
```

Important distinction:

Browsers cannot import SF Symbols as a system icon font. Do not rely on private Apple font assets or ship Apple-owned symbol fonts without an explicit license path. The safe strategy is semantic mapping plus open-source fallback icons styled to platform expectations.

Implementation notes:

- Use Iconoir Vue package or local tree-shaken imports.
- Keep icon stroke width, cap style, optical size, and filled/outline mode controlled centrally.
- Avoid mixing Ionicons, Lucide, inline SVG, and Iconoir across product code.
- Audit existing `AppIcon` and consolidate current icon imports into the new adapter.

Acceptance criteria:

- Product components pass `name`, `size`, `tone`, `filled`, and `label` to `AppIcon`.
- No feature component imports Iconoir directly.
- No feature component includes raw inline SVG unless it is a one-off illustration or documented exception.

## 7. Native emoji strategy

Goal:

Memory should use the user's system emoji presentation by default.

Rules:

1. Do not ship a custom emoji font as the default.
2. Use CSS font stacks that allow the OS emoji font to win.
3. Preserve native emoji picker/keyboard behavior by using real text inputs/textareas where possible.
4. Do not replace typed emoji with images in editable text.
5. For custom/federated emoji, render them as explicit custom emoji entities after parsing, not as a replacement for system emoji.

Recommended CSS token:

```css
--font-ui: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
--font-emoji: "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
```

Use:

```css
font-family: var(--font-ui), var(--font-emoji);
```

Composer rules:

- Let iOS show its native emoji keyboard.
- Let Android show its native emoji keyboard.
- Do not force a web emoji picker as the primary path on mobile.
- A custom emoji picker may exist for federated/custom emoji, but it must be supplemental.
- Insert emoji through normal text insertion APIs so undo/redo and cursor behavior stay native.

## 8. Native keyboard and input strategy

Goal:

Use native keyboards, native input affordances, and native text-editing behavior wherever PWA/Capacitor allows.

Core rule:

> Prefer real `<input>`, `<textarea>`, and platform-native input attributes over contenteditable unless rich text absolutely requires contenteditable.

Native input attributes to use semantically:

```txt
inputmode
enterkeyhint
autocomplete
autocapitalize
autocorrect
spellcheck
required
maxlength
minlength
pattern
accept
capture
multiple
```

Examples:

Search:

```html
<input type="search" inputmode="search" enterkeyhint="search" autocomplete="off" autocapitalize="none" spellcheck="false" />
```

Post composer:

```html
<textarea enterkeyhint="newline" autocapitalize="sentences" autocorrect="on" spellcheck="true"></textarea>
```

DM composer:

```html
<textarea enterkeyhint="send" autocapitalize="sentences" autocorrect="on" spellcheck="true"></textarea>
```

URL field:

```html
<input type="url" inputmode="url" enterkeyhint="go" autocapitalize="none" autocomplete="url" />
```

Email/login:

```html
<input type="email" inputmode="email" autocomplete="email" autocapitalize="none" />
```

Keyboard handling:

Create:

```txt
frontend/src/platform/keyboard.ts
```

Responsibilities:

- Subscribe to Capacitor Keyboard events in native shell.
- Track keyboard visibility, height, animation state, and focused element.
- Avoid duplicate keyboard state listeners across components.
- Provide CSS variables:

```css
--keyboard-height
--keyboard-visible
--composer-bottom-inset
```

- Apply safe fallback on web/PWA using `visualViewport` when available.
- Avoid layout jumps by using a single app-level keyboard manager.

Rules:

1. Composer bars must stay above keyboard.
2. Bottom tab bar should hide or adapt when text entry is active, depending on screen semantics.
3. Search pages should keep the searchbar visible and avoid scroll traps.
4. Messages should use keyboard-aware scroll anchoring.
5. Do not manually scroll repeatedly on every key event; use focus and viewport events.
6. Respect iOS Safari visual viewport quirks.

Acceptance criteria:

- Composer works on iOS Safari, iOS installed PWA, iOS Capacitor, Android Chrome, Android installed PWA, Android Capacitor.
- No hidden focused input behind keyboard.
- No double bottom padding when safe-area and keyboard are both active.
- Back button/dismiss behavior feels native on Android.

## 9. Safe area, status bar, and viewport strategy

Goal:

Memory must feel full-bleed and native while avoiding notch/home-indicator overlap.

Use CSS env variables:

```css
padding-top: env(safe-area-inset-top);
padding-right: env(safe-area-inset-right);
padding-bottom: env(safe-area-inset-bottom);
padding-left: env(safe-area-inset-left);
```

Create semantic variables:

```css
--safe-top: env(safe-area-inset-top, 0px);
--safe-right: env(safe-area-inset-right, 0px);
--safe-bottom: env(safe-area-inset-bottom, 0px);
--safe-left: env(safe-area-inset-left, 0px);
--app-bottom-bar-height: 56px;
--app-bottom-interactive-inset: calc(var(--app-bottom-bar-height) + var(--safe-bottom));
```

Status bar rules:

- Capacitor shell: use Capacitor StatusBar plugin.
- iOS PWA/browser: rely on manifest/theme color/meta tags and CSS layout.
- Android PWA/browser: use theme-color where possible.
- Keep status bar color tied to active surface, not hardcoded globally.

Viewport rules:

- Prefer `100dvh`/`100svh`/`100lvh` carefully.
- Avoid `100vh` for keyboard-sensitive screens.
- Test iOS Safari bottom bar behavior.
- Treat landscape as a first-class layout for media and composer screens.

## 10. Framework7 architecture

Framework7 should become the primary mobile UI layer.

Framework7 responsibilities:

- App root and theme selection
- Pages/views
- Navbar/nav transitions
- Tabbar
- Toolbar
- Searchbar
- Lists and grouped/inset list styles
- Sheet modal
- Popup/modal
- Dialog/action sheet
- Pull-to-refresh
- Swipeout list actions
- Messages/messagebar where appropriate
- Photo browser/media viewer where appropriate
- Preloader/skeleton states
- Touch/gesture primitives where suitable

Do not use Framework7 as a random component bucket. Wrap it.

Example wrappers:

```txt
AppPage.vue -> f7-page
AppNavbar.vue -> f7-navbar
AppTabBar.vue -> f7-toolbar/f7-link tabbar
AppSearchBar.vue -> f7-searchbar with native input config
AppList.vue -> f7-list
AppListItem.vue -> f7-list-item
AppSheet.vue -> f7-sheet
AppActionSheet.vue -> f7-actions
AppDialog.vue -> f7-dialog
AppComposer.vue -> f7-messagebar or custom textarea wrapper
```

Why wrap Framework7:

- Prevent direct Framework7 usage from leaking everywhere.
- Allow future native-shell optimizations.
- Allow platform-specific variants.
- Keep Memory design tokens consistent.
- Avoid hard-coding iOS assumptions into every feature.

Konsta migration:

Current Konsta usage should be replaced once Framework7 shell is stable:

- `kApp` -> Framework7 app root
- `kNavbar` -> semantic `AppNavbar` backed by Framework7 navbar
- `kTabbar`/`kTabbarLink` -> semantic `AppTabBar` backed by Framework7 toolbar/tabbar
- `AppSegmentedControl` -> semantic wrapper backed by Framework7 segmented controls or a controlled custom component

Keep Konsta only temporarily during migration. The end state should not require Konsta.

## 11. Gestures and motion

Framework7 provides many required mobile gestures and transitions:

- iOS-style swipe-back navigation
- page transitions
- sheet/popup/dialog transitions
- swipeout list actions
- pull-to-refresh
- sortable/reorderable list gestures
- touch hold / long press patterns
- tab transitions
- photo browser/media gestures depending on component choice

Do not add a separate gesture framework first.

Recommended motion stack:

```txt
1. Framework7 transitions and gestures
2. CSS transitions/animations using design tokens
3. Web Animations API for controlled one-off effects
4. View Transitions API where browser support and route architecture allow
5. Motion for Vue only for advanced spring/shared-element interactions after the semantic migration
```

Avoid initially:

- GSAP as a global dependency for basic app motion
- custom gesture engines
- React Framer Motion; this is a Vue app
- complex shared-element transitions before navigation/list architecture is stable

Motion principles:

1. Respect `prefers-reduced-motion` globally.
2. Gesture-driven transitions must be interruptible or feel interruptible.
3. Use spring-like easing for Apple-feeling interactions, but keep it subtle.
4. Avoid animating layout-heavy properties for long lists.
5. Feed performance matters more than decorative animation.
6. Motion must never block accessibility or keyboard users.

Suggested semantic motion tokens:

```css
--motion-duration-fast: 120ms;
--motion-duration-default: 220ms;
--motion-duration-slow: 360ms;
--motion-ease-standard: cubic-bezier(0.2, 0, 0, 1);
--motion-ease-ios: cubic-bezier(0.32, 0.72, 0, 1);
--motion-ease-emphasized: cubic-bezier(0.2, 0, 0, 1);
```

## 12. Haptics strategy

Use haptics as platform enhancement, never core feedback.

Create/extend:

```txt
frontend/src/platform/haptics.ts
```

Rules:

- Use Capacitor Haptics only when available.
- No-op safely on unsupported platforms.
- Centralize impact types:

```ts
selectionChanged()
lightImpact()
mediumImpact()
heavyImpact()
successNotification()
warningNotification()
errorNotification()
```

Usage:

- Tab switch: light or selection
- Pull refresh completion: success or light
- Like/repost/bookmark: light/selection
- Destructive action confirmation: warning or medium
- Error validation: error notification, sparingly

Do not vibrate on every scroll, hover, or passive interaction.

## 13. Native share, browser, files, camera, and media

Platform wrappers:

```txt
platform/share.ts
platform/browser.ts
platform/media.ts
```

Share rules:

- Use Capacitor Share in native shell.
- Use `navigator.share` in browser/PWA where available.
- Fallback to copy-link UI.
- Do not show unavailable share options.

Browser/link rules:

- External links should open through Capacitor Browser in native shell where appropriate.
- PWA/browser should use normal links with `rel="noopener noreferrer"`.
- In-app article/readable surfaces must respect legal/source policy and not scrape restricted content.

File/media rules:

- Use native file inputs with `accept` and `capture` attributes where PWA allows.
- Use Capacitor Camera/File APIs only when intentionally introduced and permission UX is handled.
- Keep media attachments privacy-aware and permission-aware.

## 14. PWA capability model

Memory must distinguish:

```txt
Browser tab
Installed PWA
Capacitor native shell
```

These are not equivalent.

Installed PWA may allow better standalone UI and push behavior, but not all native Capacitor APIs.

Create:

```txt
platform/displayMode.ts
```

Expose:

```ts
isStandalonePwa
isBrowserTab
isFullscreen
canPromptInstall
```

PWA-specific UI:

- Installed PWA: reduce browser chrome assumptions; use app-like top/bottom safe areas.
- Browser tab: avoid pretending browser controls do not exist; handle Safari bottom bar/Chrome toolbar.
- Desktop: provide desktop navigation affordances and keyboard shortcuts only where they do not conflict with mobile.

## 15. Semantic component migration plan

### Phase 0: Guardrails and documentation

- Add this implementation doc.
- Add `.gitignore` entry for internal docs.
- Open PR for review.
- Confirm Framework7 Vue version compatibility with current Vue/Vite/Bun setup.
- Confirm dependency licenses.
- Confirm package size impact.

### Phase 1: Platform profile foundation

Implement:

```txt
platform/detectPlatform.ts
platform/nativeUiProfile.ts
platform/safeArea.ts
platform/keyboard.ts
platform/haptics.ts
platform/displayMode.ts
```

Acceptance criteria:

- One app-level native UI profile exists.
- Components no longer independently guess platform.
- Keyboard/safe-area/haptic state is centralized.
- Unit tests cover iOS/Android/desktop profile detection with mocked environments.

### Phase 2: Framework7 app shell

Implement semantic wrappers:

```txt
AppShell
AppPage
AppNavbar
AppTabBar
AppToolbar
AppButton
AppIcon
```

Migrate:

- `App.vue`
- `AppTopBar.vue`
- `AppTabBar.vue`

Acceptance criteria:

- App boots.
- Auth routes still full-screen.
- Main routes still use top/bottom navigation.
- Android back button still works.
- iOS-style route transitions work where expected.
- Reduced motion disables or simplifies route animation.
- Konsta shell dependency no longer required by shell.

### Phase 3: Design tokens and theme cleanup

Update:

```txt
design/tokens/semantic.css
design/tokens/ios.css
design/tokens/android.css
design/tokens/desktop.css
design/tokens/motion.css
```

Rules:

- Keep Memory brand accent.
- Use Apple-like default spacing and surfaces on iOS.
- Use Material-appropriate behavior on Android.
- Avoid hardcoded colors inside feature components.
- Keep Tailwind utilities, but use semantic CSS variables.

Acceptance criteria:

- Feature components do not define repeated inline color strings for primary surfaces/actions.
- Common colors/radii/spacing live in tokens.
- App supports at least light theme consistently.
- Dark mode can be added later without rewriting components.

### Phase 4: Search and Explore migration

Break `ExploreView` into feature components:

```txt
features/explore/ExplorePage.vue
features/explore/ExploreSearchHeader.vue
features/explore/SearchHistoryList.vue
features/explore/SearchResultsView.vue
features/explore/TrendingTagsList.vue
features/explore/RecommendedPeopleList.vue
features/explore/RecommendedTagsList.vue
```

Use semantic components:

- `AppPage`
- `AppNavbar`
- `AppSearchBar`
- `AppList`
- `AppListItem`
- `AppButton`
- `AppEmptyState`

Acceptance criteria:

- Searchbar uses native `type="search"`, search keyboard, and search return key.
- Search history uses native-feeling list rows.
- Tag/person rows are reusable, not duplicated blocks.
- Mock/demo data is separated from UI or replaced by store/API data.

### Phase 5: Feed UI migration

Migrate:

```txt
UnifiedFeedList
UnifiedFeedItem
PostMetadataRow
PostMediaCarousel
PostLinkPreview
PostPoll
PostEmbedCard
ThreadSummary
MoreActionsSheet
InlineReplyComposer
```

Use:

- Framework7 pull-to-refresh where appropriate.
- Framework7/semantic sheet for more actions.
- Semantic media viewer.
- Semantic action buttons.
- Existing TanStack Virtual if Framework7 virtual list is insufficient for complex dynamic feed cards.

Important performance rule:

Do not replace TanStack Virtual blindly. The current virtual feed handles a shared scroll container and dynamic item measurement. Keep it unless Framework7 virtual list can match the dynamic content requirements without regressions.

Acceptance criteria:

- Feed scroll remains smooth with media, polls, link previews, embeds, and thread summaries.
- More actions are native-feeling action sheets.
- Pull refresh is native-feeling.
- Swipe/hold interactions are added only after basic feed stability.
- No feed action loses current API behavior.

### Phase 6: Composer and keyboard-native posting

Migrate:

```txt
CreatePostForm
InlineReplyComposer
StoryComposer
future DM composer
```

Use:

- Real textarea where possible.
- Native keyboard attributes.
- Keyboard-aware bottom inset.
- Native media file pickers where possible.
- Supplemental custom emoji/federated emoji picker only when needed.

Acceptance criteria:

- iOS keyboard does not cover composer.
- Android keyboard does not cover composer.
- Native emoji keyboard works.
- Return/send behavior is deliberate per composer type.
- Haptics are used sparingly on successful post/send.

### Phase 7: Settings, profile, notifications, messages

Settings:

- Use grouped/inset native lists.
- Destructive actions use action sheets/dialogs.
- Toggles use Framework7 native-looking toggles.

Profile:

- Native large title / profile header behavior.
- Segmented control for posts/media/replies if needed.

Notifications:

- Grouped lists.
- Swipe actions only where safe.

Messages:

- Framework7 messages/messagebar pattern should be evaluated strongly.
- Keyboard-aware scroll anchoring is mandatory.

### Phase 8: Remove Konsta

After all shell and components no longer use Konsta:

- Remove `konsta` dependency from `frontend/package.json`.
- Remove Konsta imports from styles.
- Remove Konsta-specific composables such as `useKonstaTheme` if no longer needed.
- Run typecheck/build.
- Audit bundle size.

### Phase 9: Advanced motion and gestures

After semantic migration:

- Add View Transitions API where safe.
- Add Motion for Vue only for advanced, isolated transitions.
- Add shared-element transitions for media/profile/story transitions if performance allows.
- Add drag-to-dismiss media/story interactions if Framework7 component does not already cover the need.

## 16. Testing strategy

Unit tests:

- Platform detection variants.
- Native UI profile mapping.
- Icon semantic mapping.
- Keyboard state manager.
- Haptic no-op fallback.
- Safe-area variable calculation helpers if any JS exists.

Component tests:

- App shell renders iOS/material/desktop variants.
- AppIcon resolves fallback correctly.
- Searchbar emits submit/clear/focus correctly.
- Composer respects disabled/loading/error states.
- Action sheet emits safe actions and confirms destructive actions.

E2E/manual device matrix:

```txt
iPhone Safari
iPhone installed PWA
iPhone Capacitor shell
iPad Safari
iPad installed PWA
Android Chrome
Android installed PWA
Android Capacitor shell
Desktop Safari
Desktop Chrome
Desktop Firefox
```

Critical manual checks:

- First load
- Sign in/out
- Route back/forward
- Hardware back on Android
- Tab switching
- Feed scrolling
- Pull to refresh
- Create post
- Reply
- More actions
- Search
- Keyboard open/close
- Emoji input
- Media picker
- Share sheet
- Notification permission flow
- Reduced motion
- Screen reader labels
- High contrast where available

CI checks:

- `bun run type-check`
- `bun run build`
- unit tests
- lint/format if enforced
- bundle size review after Framework7 install

## 17. Accessibility and inclusivity requirements

Native-feeling does not mean inaccessible custom UI.

Rules:

1. Use real buttons, links, inputs, and labels.
2. Every icon-only button needs an accessible label.
3. Action sheets/dialogs must trap focus correctly where applicable.
4. Keyboard navigation must work on desktop/tablet keyboards.
5. Respect reduced motion.
6. Preserve sufficient contrast.
7. Dynamic text should be supported where web allows.
8. Hit targets should be at least mobile-friendly size.
9. Do not encode state by color alone.
10. Media and custom emoji require alt/label handling.

## 18. Security and privacy requirements

UI migration must not weaken security.

Rules:

- Do not expose auth tokens to new third-party UI or analytics libraries.
- Do not add remote icon/font loading without explicit review.
- Prefer bundled open-source assets.
- Validate external links.
- Keep `rel="noopener noreferrer"` for external web links.
- Do not scrape user clipboard.
- Clipboard writes require user action.
- Permission prompts must be user-initiated and contextual.
- Media/camera access must be explicit and scoped.
- Avoid storing sensitive drafts in persistent storage unless intentionally encrypted or privacy-reviewed.

## 19. Dependency policy

Preferred additions:

```txt
framework7
framework7-vue
iconoir-vue or equivalent tree-shakeable Iconoir Vue package
```

Review before adding:

```txt
Motion for Vue
additional gesture libraries
additional icon libraries
GSAP
custom emoji picker libraries
```

Avoid:

```txt
React-only animation libraries
closed-source UI dependencies
heavy design systems duplicating Framework7
remote CDN icon/font runtime dependencies
```

## 20. Implementation acceptance criteria

The migration is successful when:

1. App shell is Framework7-first and platform-adaptive.
2. Konsta is removed or isolated only as a temporary migration dependency.
3. UI components are semantic wrappers rather than hand-built native lookalikes.
4. iOS devices get iOS-style navigation, sheets, lists, search, keyboard behavior, safe areas, emoji, haptics, and motion where supported.
5. Android devices get Android-appropriate behavior rather than forced fake iOS.
6. Installed PWA behavior is distinct from browser-tab behavior.
7. Capacitor native shell gets native plugins where available.
8. Icon usage is centralized through `AppIcon` with native/platform mapping and Iconoir fallback.
9. Native emoji and keyboard behavior are preserved by default.
10. Feed performance does not regress.
11. Auth, routing, posting, stories, search, notifications, and settings continue to work.
12. Typecheck/build/test pass.
13. Reduced motion and accessibility remain supported.
14. No sensitive implementation notes are added accidentally outside reviewed docs.

## 21. Immediate next implementation tasks

Recommended first PR after this document:

```txt
1. Add Framework7 dependencies.
2. Add platform/nativeUiProfile.ts with tests.
3. Add design/components/AppIcon.vue adapter backed by existing icons first.
4. Add design/components/AppPage.vue and AppButton.vue wrappers.
5. Add a small Framework7 migration spike behind a feature flag or isolated test route.
```

Recommended second PR:

```txt
1. Replace App.vue shell with Framework7 app shell.
2. Replace AppTopBar/AppTabBar internals with semantic Framework7 wrappers.
3. Preserve route guards, auth routes, Android back button, document title behavior, reduced motion, and shared scroll behavior.
4. Run typecheck/build and manually verify mobile viewport.
```

Recommended third PR:

```txt
1. Refactor ExploreView into feature components.
2. Replace custom search UI with AppSearchBar.
3. Replace repeated person/tag row blocks with AppList/AppListItem-based components.
4. Remove mock data from the route component.
```

Recommended fourth PR:

```txt
1. Start feed component migration.
2. Keep TanStack Virtual until Framework7 virtual list is proven equivalent.
3. Convert more-actions to AppActionSheet.
4. Convert reply composer to keyboard-aware AppComposer.
```

## 22. Non-goals

This plan does not require:

- Rewriting the app in SwiftUI.
- Rewriting the API or feed store.
- Removing Tailwind entirely.
- Forcing Android users into an iOS-only UX.
- Shipping Apple private assets.
- Adding a heavy animation framework before the component architecture is fixed.

## 23. Final architectural position

Memory should become a semantic adaptive app, not a website styled like an app.

The clearest path is:

```txt
Framework7-first UI shell and controls
Capacitor-native capabilities when available
PWA/browser capabilities where available
Iconoir fallback behind semantic AppIcon
native OS emoji and keyboard by default
Tailwind for tokens/layout only
Pinia/API layer preserved
Konsta removed after migration
```

This is the closest practical route to a native Apple-feeling Vue PWA/Capacitor app while preserving open-source tooling, cross-platform reach, and the current project architecture.

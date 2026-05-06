import { createRouter, createWebHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'
import { useAuthStore } from '@/stores/authStore'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    // ── Dashboard (provider admin panel) ──────────────────────────────────────
    {
      path: '/dashboard',
      component: () => import('../views/dashboard/DashboardLayout.vue'),
      meta: { titleKey: 'app.title.dashboard' },
      children: [
        {
          path: '',
          name: 'dashboard',
          component: () => import('../views/dashboard/DashboardOverviewView.vue'),
          meta: { titleKey: 'app.title.dashboard' },
        },
        // Top-level sections
        {
          path: 'network',
          name: 'dashboard-network',
          component: () => import('../views/dashboard/DashboardNetworkView.vue'),
          meta: { titleKey: 'app.title.dashboard' },
        },
        {
          path: 'applications',
          name: 'dashboard-applications',
          component: () => import('../views/dashboard/DashboardApplicationsView.vue'),
          meta: { titleKey: 'app.title.dashboard' },
        },
        {
          path: 'data',
          name: 'dashboard-data',
          component: () => import('../views/dashboard/DashboardDataView.vue'),
          meta: { titleKey: 'app.title.dashboard' },
        },
        // Dashboard sub-section
        {
          path: 'pods',
          name: 'dashboard-pods',
          component: () => import('../views/dashboard/DashboardPodsView.vue'),
          meta: { titleKey: 'app.title.dashboard' },
        },
        {
          path: 'federation',
          name: 'dashboard-federation',
          component: () => import('../views/dashboard/DashboardFederationView.vue'),
          meta: { titleKey: 'app.title.dashboard' },
        },
        {
          path: 'incidents',
          name: 'dashboard-incidents',
          component: () => import('../views/dashboard/DashboardIncidentsView.vue'),
          meta: { titleKey: 'app.title.dashboard' },
        },
        {
          path: 'system-config',
          name: 'dashboard-system-config',
          component: () => import('../views/dashboard/DashboardSystemConfigView.vue'),
          meta: { titleKey: 'app.title.dashboard' },
        },
        {
          path: 'billing',
          name: 'dashboard-billing',
          component: () => import('../views/dashboard/DashboardBillingView.vue'),
          meta: { titleKey: 'app.title.dashboard' },
        },
        {
          path: 'audit',
          name: 'dashboard-audit',
          component: () => import('../views/dashboard/DashboardAuditView.vue'),
          meta: { titleKey: 'app.title.dashboard' },
        },
      ],
    },

    // ── Standard app routes ───────────────────────────────────────────────────
    {
      path: '/',
      name: 'home',
      component: HomeView,
      meta: { titleKey: 'app.title.home' }
    },
    {
      path: '/signin',
      name: 'signin',
      // route level code-splitting
      // this generates a separate chunk (About.[hash].js) for this route
      // which is lazy-loaded when the route is visited.
      component: () => import('../views/SingInView.vue'),
      meta: { titleKey: 'app.title.signin' }
    },
    {
      path: '/signup',
      name: 'signup',
      component: () => import('../views/SignupView.vue'),
      meta: { titleKey: 'app.title.signup' }
    },
    {
      path: '/welcome',
      name: 'welcome',
      component: () => import('../views/WelcomeView.vue'),
      meta: { titleKey: 'app.title.welcome' }
    },
    {
      path: '/auth/callback',
      name: 'auth-callback',
      component: () => import('../views/AuthCallbackView.vue'),
      meta: { titleKey: 'app.title.authCallback' }
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('../views/SettingsView.vue'),
      meta: { titleKey: 'app.title.settings' }
    },
    {
      path: '/settings/feed-controls',
      name: 'feed-controls',
      component: () => import('../views/FeedControlsView.vue'),
      meta: { titleKey: 'app.title.feedControls' }
    },
    {
      path: '/settings/moderation',
      name: 'settings-moderation',
      component: () => import('../views/ModerationSettingsView.vue'),
      meta: { titleKey: 'app.title.moderation' }
    },
    {
      path: '/settings/profile',
      name: 'settings-profile',
      component: () => import('../views/SettingsProfileView.vue'),
      meta: { titleKey: 'app.title.profileSettings' }
    },
    {
      path: '/thread/:id',
      name: 'thread',
      component: () => import('../views/ThreadView.vue'),
      meta: { titleKey: 'app.title.thread' }
    },
    {
      path: '/explore',
      name: 'explore',
      component: () => import('../views/ExploreView.vue'),
      meta: { titleKey: 'app.title.explore' }
    },
    {
      path: '/messages',
      name: 'messages',
      component: () => import('../views/MessagesView.vue'),
      meta: { titleKey: 'app.title.messages' }
    },
    {
      path: '/notifications',
      name: 'notifications',
      component: () => import('../views/NotificationsView.vue'),
      meta: { titleKey: 'app.title.notifications' }
    },
    {
      path: '/experience',
      name: 'experience',
      component: () => import('../views/ExperienceView.vue'),
      meta: { titleKey: 'app.title.experience' }
    }
  ]
})

const PUBLIC_ROUTES = new Set(['signin', 'signup', 'welcome', 'auth-callback'])

router.beforeEach((to, _, next) => {
  const authStore = useAuthStore()

  // Fail closed: when secure logout cleanup failed, keep user on sign-in
  // until local cleanup succeeds via retry.
  if (authStore.logoutBlocked && to.name !== 'signin') {
    return next({ name: 'signin' })
  }

  if (!PUBLIC_ROUTES.has(String(to.name))) {
    if (!authStore.isLoggedIn) {
      return next({ name: 'welcome' })
    }
  }
  return next()
})

export default router

import type { SignInBody, SignUpBody, SignInResponse } from '#api/types'
import { ApiClient } from '@/controller/api'
import { buildApiHeaders, getApiBaseUrl } from '@/controller/http'
import { beginOidcSignIn, finishOidcSignIn, DEFAULT_PROVIDER_ENDPOINT } from '@/controller/oidc'
import { type ApiErrors, type App, type ProviderEndpoints, type User } from '@/types'
import { treaty } from '@elysiajs/eden'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { getSessionPolicyConfig } from '@/utils/sessionPolicy'
import { t } from '@/i18n'
import { clearLocalData, clearAllAppStorage } from '@/db/localDb'

/**
 * Logout mode controls how aggressively local data is cleared on sign-out.
 *
 * standard     — revoke session/tokens; keep local PGlite cache intact so the
 *                next sign-in on the same device loads instantly.
 * private      — revoke session/tokens + wipe all user-scoped PGlite tables
 *                (fail-closed: blocks re-auth until wipe succeeds).
 * device-reset — sign out all state, drop the entire IndexedDB database, and
 *                clear all app local/session storage keys.
 */
export type LogoutMode = 'standard' | 'private' | 'device-reset'
type BlockedLogoutMode = Extract<LogoutMode, 'private' | 'device-reset'>

const SESSION_STARTED_AT_KEY = 'memory.session.startedAt'
const LOGOUT_BLOCKED_KEY = 'memory.logout.blocked'
const LOGOUT_BLOCKED_MODE_KEY = 'memory.logout.blockedMode'
const AUTH_USER_KEY = 'user'
const AUTH_LOGGED_IN_KEY = 'loggedIn'
const AUTH_TOKEN_KEY = 'token'
const STORAGE_PREFIX = 'memory.'
const OIDC_TRANSACTION_KEY = 'memory.oidc.transaction'

const LOGOUT_MAX_ATTEMPTS = 4
const LOGOUT_BACKOFF_BASE_MS = 180
const LOGOUT_BACKOFF_JITTER_MS = 120

const AUTH_STORAGE_KEYS = [AUTH_USER_KEY, AUTH_LOGGED_IN_KEY, AUTH_TOKEN_KEY, SESSION_STARTED_AT_KEY, LOGOUT_BLOCKED_KEY, LOGOUT_BLOCKED_MODE_KEY] as const
const sessionPolicyConfig = getSessionPolicyConfig()

export const useAuthStore = defineStore('auth', () => {
  // Default state
  const user = ref<User>()
  const isLoggedIn = ref<boolean>(false)
  const token = ref<string>('')
  const authError = ref<string>('')
  const logoutBlocked = ref<boolean>(false)
  const logoutBlockedMode = ref<BlockedLogoutMode | null>(null)
  // API
  const client = treaty<App>(getApiBaseUrl(), {
    onRequest() {
      return {
        headers: buildApiHeaders({ authToken: token.value || undefined })
      }
    }
  })
  const apiClient = new ApiClient()
  // Vue Hooks
  const router = useRouter()

  function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  function getBackoffDelayMs(attempt: number) {
    const expo = LOGOUT_BACKOFF_BASE_MS * (2 ** attempt)
    const jitter = Math.floor(Math.random() * LOGOUT_BACKOFF_JITTER_MS)
    return expo + jitter
  }

  async function withExponentialBackoff<T>(operation: () => Promise<T>, label: string, maxAttempts = LOGOUT_MAX_ATTEMPTS): Promise<T> {
    let lastError: unknown = null

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await operation()
      } catch (err) {
        lastError = err
        if (attempt === maxAttempts - 1) break
        await sleep(getBackoffDelayMs(attempt))
      }
    }

    throw new Error(`[authStore] ${label} failed after ${maxAttempts} attempts`, { cause: lastError })
  }

  function removeStorageKey(storage: Storage, key: string) {
    try {
      storage.removeItem(key)
    } catch {
      // Ignore storage availability and quota exceptions.
    }
  }

  function clearAuthStorageKeys() {
    for (const key of AUTH_STORAGE_KEYS) {
      removeStorageKey(localStorage, key)
    }
    removeStorageKey(sessionStorage, OIDC_TRANSACTION_KEY)
  }

  function clearMemoryScopedStorage() {
    const localKeysToRemove: string[] = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (!key) continue
      if (key.startsWith(STORAGE_PREFIX) || AUTH_STORAGE_KEYS.includes(key as typeof AUTH_STORAGE_KEYS[number])) {
        localKeysToRemove.push(key)
      }
    }
    for (const key of localKeysToRemove) {
      removeStorageKey(localStorage, key)
    }

    const sessionKeysToRemove: string[] = []
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i)
      if (!key) continue
      if (key.startsWith(STORAGE_PREFIX)) {
        sessionKeysToRemove.push(key)
      }
    }
    for (const key of sessionKeysToRemove) {
      removeStorageKey(sessionStorage, key)
    }
  }

  async function clearBrowserCaches() {
    if (typeof caches === 'undefined') return
    try {
      const cacheKeys = await caches.keys()
      await Promise.all(cacheKeys.map(key => caches.delete(key)))
    } catch {
      // Best effort only; do not block logout if browser cache API is unavailable.
    }
  }

  function applySignedOutState() {
    logoutBlocked.value = false
    logoutBlockedMode.value = null
    isLoggedIn.value = false
    token.value = ''
    user.value = undefined
    clearAuthStorageKeys()
  }

  async function routeToSignIn() {
    if (router.currentRoute.value.name === 'signin') return
    await router.push({ name: 'signin' })
  }

  function normalizeUserShape(value: User | SignInResponse['user'] | undefined): User | undefined {
    if (!value) return undefined
    return {
      ...value,
      // Do not persist pod token in client-auth state.
      podToken: null,
    }
  }

  function clearSessionStorage() {
    removeStorageKey(localStorage, SESSION_STARTED_AT_KEY)
  }

  function setLogoutBlocked(newValue: boolean, mode: BlockedLogoutMode | null = null) {
    logoutBlocked.value = newValue
    localStorage.setItem(LOGOUT_BLOCKED_KEY, newValue.toString())
    logoutBlockedMode.value = newValue ? mode : null
    if (newValue && mode) {
      localStorage.setItem(LOGOUT_BLOCKED_MODE_KEY, mode)
    } else {
      removeStorageKey(localStorage, LOGOUT_BLOCKED_MODE_KEY)
    }
  }

  function markSessionStartedNow() {
    localStorage.setItem(SESSION_STARTED_AT_KEY, String(Date.now()))
  }

  function getSessionStartedAt(): number | null {
    const raw = localStorage.getItem(SESSION_STARTED_AT_KEY)
    if (!raw) return null
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed <= 0) return null
    return parsed
  }

  function hasFreshBrowserSession() {
    if (!isLoggedIn.value || !token.value) return false
    const startedAt = getSessionStartedAt()
    if (!startedAt) return false
    return Date.now() - startedAt <= sessionPolicyConfig.sessionMaxAgeMs
  }

  // Setters
  function setUser(newValue: User | SignInResponse['user'] | undefined) {
    const normalized = normalizeUserShape(newValue)
    user.value = normalized
    if (!normalized) {
      removeStorageKey(localStorage, AUTH_USER_KEY)
      return
    }
    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(normalized))
  }

  function setLoggedIn(newValue: boolean) {
    isLoggedIn.value = newValue
    if (!newValue) {
      removeStorageKey(localStorage, AUTH_LOGGED_IN_KEY)
      return
    }
    localStorage.setItem(AUTH_LOGGED_IN_KEY, 'true')
  }

  function setToken(newValue: string) {
    token.value = newValue
    if (!newValue) {
      removeStorageKey(localStorage, AUTH_TOKEN_KEY)
      return
    }
    localStorage.setItem(AUTH_TOKEN_KEY, newValue)
  }

  function setAuthError(newValue: string) {
    authError.value = newValue
  }

  // Util Functions
  /**
   * Check if there is a user in the local storage
   */
  function initStore() {
    const localUser = localStorage.getItem(AUTH_USER_KEY)
    if (localUser && localUser !== 'undefined') {
      user.value = normalizeUserShape(JSON.parse(localUser) as User)
    }

    const localLoggedIn = localStorage.getItem(AUTH_LOGGED_IN_KEY)
    if (localLoggedIn) {
      isLoggedIn.value = JSON.parse(localLoggedIn)
    }

    const localToken = localStorage.getItem(AUTH_TOKEN_KEY)
    if (localToken && localToken !== '') {
      token.value = localToken
    }

    const localLogoutBlocked = localStorage.getItem(LOGOUT_BLOCKED_KEY)
    if (localLogoutBlocked) {
      logoutBlocked.value = JSON.parse(localLogoutBlocked)
    }

    const localBlockedMode = localStorage.getItem(LOGOUT_BLOCKED_MODE_KEY)
    if (localBlockedMode === 'private' || localBlockedMode === 'device-reset') {
      logoutBlockedMode.value = localBlockedMode
    }

    // Fail closed when session age is missing/stale so users are only kept signed
    // in for a bounded period unless they re-authenticate.
    if (isLoggedIn.value && !hasFreshBrowserSession()) {
      applySignedOutState()
    }
  }
  /**
   * Trys to signIn the user with the given username and password and endpoint
   * @param username - username
   * @param password - password
   * @param providerEndpoint - endpoint
   */
  async function signin(username: string, password: string, providerEndpoint: ProviderEndpoints) {
    if (logoutBlocked.value) {
      setAuthError(t('errors.secureLogoutRetryRequired'))
      return
    }

    try {
      setAuthError('')
      const body: SignInBody = { username, password, providerEndpoint }
      const { data: response, status } = await client.signin.post(body)
      if (status === 200) {
        const signInResponse = response as SignInResponse

        setLoggedIn(true)
        setToken(signInResponse.token)
        setUser(signInResponse.user)
        markSessionStartedNow()
        router.push({ name: 'home' })
      }
    } catch (error) {
      console.error('error when trying to signIn: ', error)
      setAuthError(t('errors.unableToSignIn'))
    }
  }

  async function signinWithOidc(providerEndpoint: ProviderEndpoints = DEFAULT_PROVIDER_ENDPOINT as ProviderEndpoints) {
    if (logoutBlocked.value) {
      setAuthError(t('errors.secureLogoutRetryRequired'))
      return
    }

    setAuthError('')
    try {
      await beginOidcSignIn(providerEndpoint)
    } catch (error) {
      const message = error instanceof Error ? error.message : t('errors.unableToSignIn')
      console.error('error when trying to begin OIDC signIn: ', error)
      setAuthError(message)
    }
  }

  async function completeOidcSignin(search: string) {
    if (logoutBlocked.value) {
      const message = t('errors.secureLogoutRetryRequired')
      setAuthError(message)
      await router.replace({ name: 'signin' })
      throw new Error(message)
    }

    setAuthError('')

    try {
      const signInResponse = await finishOidcSignIn(search)
      setLoggedIn(true)
      setToken(signInResponse.token)
      setUser(signInResponse.user)
      markSessionStartedNow()
      await router.replace({ name: 'home' })
    } catch (error) {
      const message = error instanceof Error ? error.message : t('errors.unableToFinishSignIn')
      setAuthError(message)
      await router.replace({ name: 'signin' })
      throw error
    }
  }
  /**
   * Signup a new user
   * @param email - email
   * @param username - username
   * @param password - password
   * @param providerEndpoint - provider
   */
  async function signup(
    email: string,
    username: string,
    password: string,
    providerEndpoint: ProviderEndpoints
  ): Promise<void | ApiErrors> {
    if (logoutBlocked.value) {
      setAuthError(t('errors.secureLogoutRetryRequired'))
      return
    }

    const body: SignUpBody = { username, password, email, providerEndpoint }
    const { data: response, status } = await apiClient.signup(body)
    if (status === 200) {
      const signupResponse = response as SignInResponse
      setLoggedIn(true)
      setToken(signupResponse.token)
      setUser(signupResponse.user)
      markSessionStartedNow()
      router.push({ name: 'home' })
    } else if (status === 500) {
      return response as ApiErrors
    }
  }

  /**
   * Checks if user is Currently logged in
   */
  function authenticateUser() {
    return isLoggedIn.value
  }

  /**
   * Logout
   *
   * @param mode  Controls how aggressively local data is cleared:
   *   - 'standard'     Keep PGlite cache; only clear tokens/session.
   *   - 'private'      Wipe PGlite tables (fail-closed before token clear).
   *   - 'device-reset' Drop IndexedDB entirely + clear memory scoped storage.
   */
  async function logout(mode: LogoutMode = 'standard'): Promise<boolean> {
    setAuthError('')

    if (mode === 'private') {
      try {
        await withExponentialBackoff(() => clearLocalData(), 'clearLocalData')
      } catch (err) {
        console.warn('[authStore] clearLocalData failed on private logout:', err)
        setLogoutBlocked(true, 'private')
        setAuthError(t('errors.secureLogoutFailed'))
        await routeToSignIn()
        return false
      }
    }

    if (mode === 'device-reset') {
      try {
        await withExponentialBackoff(() => clearAllAppStorage(), 'clearAllAppStorage')
      } catch (err) {
        console.warn('[authStore] clearAllAppStorage failed on device-reset:', err)
        setLogoutBlocked(true, 'device-reset')
        setAuthError(t('errors.deviceResetFailed'))
        await routeToSignIn()
        return false
      }

      clearMemoryScopedStorage()
      await clearBrowserCaches()
      applySignedOutState()
      await routeToSignIn()
      return true
    }

    applySignedOutState()
    clearSessionStorage()
    await routeToSignIn()
    return true
  }

  async function retrySecureLogout(): Promise<boolean> {
    return logout(logoutBlockedMode.value ?? 'private')
  }

  initStore()
  return {
    user,
    isLoggedIn,
    token,
    authError,
    logoutBlocked,
    logoutBlockedMode,
    // functions
    signin,
    signinWithOidc,
    completeOidcSignin,
    signup,
    logout,
    retrySecureLogout,
    deviceReset: () => logout('device-reset'),
    authenticateUser,
    hasFreshBrowserSession,
    setAuthError
  }
})

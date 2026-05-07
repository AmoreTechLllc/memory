import Elysia from 'elysia'
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { users } from '../db/schema'
import setupPlugin from './setup'
import User from '../decorater/User'
import { getTokenObject } from '../services/jwt'
import { syncAtprotoIdentity } from '../services/WebIdProfileService'
import { localeFromHeaders, translate } from '../i18n'
import { toPublicUser } from '../services/PodTokenService'
import { encryptToken } from '../services/TokenVault'

/**
 * How long (in ms) to wait for the ATProto identity link before issuing the
 * session token without it.  The link will be retried on the next sign-in.
 * Kept short so authentication latency stays acceptable.
 */
const ATPROTO_LINK_DEADLINE_MS = 1_500
const SERVER_SIDE_PROVIDER_HOST_FALLBACK = 'host.docker.internal'

const oidcAuthPlugin = new Elysia({ prefix: '/oidc-auth' })
  .use(setupPlugin)
  .post('/callback', async ({ body, jwt, set, headers }) => {
    const locale = localeFromHeaders(headers)
    const fail = (status: number, key: string) => {
      set.status = status
      return translate(locale, key)
    }

    const payload = body as Record<string, unknown>

    // -----------------------------------------------------------------------
    // Phase 1 — OIDC Prepare
    // When `code` is absent the client is initiating the flow.  We fetch the
    // provider's OIDC discovery document and construct the authorization URL
    // using the Memory app's stable client_id (its Solid OIDC client document).
    // -----------------------------------------------------------------------
    if (typeof payload.code !== 'string') {
      const providerEndpoint = String(payload.providerEndpoint || '')
      const redirectUri = String(payload.redirectUri || '')
      const state = String(payload.state || '')
      const codeChallenge = String(payload.codeChallenge || '')

      if (!providerEndpoint || !redirectUri || !state || !codeChallenge) {
        return fail(400, 'oidc.missingPrepareParams')
      }

      try {
          const { metadata } = await fetchOidcDiscovery(providerEndpoint)

        // Use the Memory app's stable Solid OIDC client document URL as client_id.
        // The pod provider fetches this document to verify redirect_uris instead of
        // relying on dynamic client registration (which creates a new client ID each
        // time and is not how Solid OIDC apps are supposed to identify themselves).
        const apiUrl = (process.env.API_URL || `http://localhost:${process.env.API_PORT || 8794}`).replace(/\/$/, '')
        const clientId = `${apiUrl}/oauth/client.json`

        const authorizationUrl = new URL(metadata.authorization_endpoint)
        authorizationUrl.searchParams.set('client_id', clientId)
        authorizationUrl.searchParams.set('redirect_uri', redirectUri)
        authorizationUrl.searchParams.set('response_type', 'code')
        authorizationUrl.searchParams.set('scope', 'openid profile webid offline_access')
        authorizationUrl.searchParams.set('code_challenge', codeChallenge)
        authorizationUrl.searchParams.set('code_challenge_method', 'S256')
        authorizationUrl.searchParams.set('state', state)

        return {
          authorizationUrl: authorizationUrl.toString(),
          clientId
        }
      } catch (e) {
        console.error('Error while preparing OIDC login: ', e)
        return fail(500, 'oidc.unableToPrepare')
      }
    }

    // -----------------------------------------------------------------------
    // Phase 2 — OIDC Callback (authorization code exchange)
    // -----------------------------------------------------------------------
    const providerEndpoint = String(payload.providerEndpoint || '')
    const redirectUri = String(payload.redirectUri || '')
    const clientId = String(payload.clientId || '')
    const code = String(payload.code || '')
    const codeVerifier = String(payload.codeVerifier || '')

    if (!providerEndpoint || !redirectUri || !clientId || !code || !codeVerifier) {
      return fail(400, 'oidc.missingCallbackParams')
    }

    try {
      const { metadata, resolvedProviderEndpoint } = await fetchOidcDiscovery(providerEndpoint)

      const tokenBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: codeVerifier
      })

      const tokens = await fetch(rewriteUrlOrigin(metadata.token_endpoint, resolvedProviderEndpoint), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: tokenBody
      }).then(async response => {
        if (!response.ok) {
          throw new Error(await response.text())
        }
        return response.json() as Promise<{ access_token: string; id_token?: string }>
      })

      const claims = decodeJwtPayload(tokens.id_token || tokens.access_token)
      const webId = claims.webid || claims.sub || claims.azp

      if (!tokens.access_token || !webId) {
        return fail(400, 'oidc.unusableAccessToken')
      }

      // Upsert the local user record keyed on WebID.
      let dbUserRows = await db.select().from(users).where(eq(users.webId, webId))
      if (dbUserRows.length === 0) {
        dbUserRows = await db
          .insert(users)
          .values({
            name: getNameFromWebId(webId),
            email: `${Buffer.from(webId).toString('base64url')}@memory.local`,
            webId,
            providerEndpoint,
            // Store the OIDC access_token as a fallback pod token.
            // If the pod accepts Solid OIDC tokens for outbox writes this will
            // work; otherwise the user must also sign in via /signin to store
            // the pod-native JWT.
            podToken: encryptToken(tokens.access_token)
          })
          .returning()
      } else {
        // Only update the pod token if the existing one is missing/empty.
        // The pod-native JWT (stored by /signin) takes priority over the OIDC
        // access_token because ActivityPods outbox writes require the native JWT.
        const existingToken = dbUserRows[0].podToken
        if (!existingToken) {
          dbUserRows = await db
            .update(users)
            .set({ podToken: encryptToken(tokens.access_token) })
            .where(eq(users.webId, webId))
            .returning()
        }
        // If a pod-native token already exists, leave it untouched.
      }
      let dbUser = dbUserRows[0]

      // -----------------------------------------------------------------------
      // ATProto identity linking
      //
      // Attempt to link the user's ATProto DID/handle by fetching their WebID
      // profile and reading the schema:sameAs / alsoKnownAs triples written by
      // the mastopod federation sidecar.
      //
      // We race against ATPROTO_LINK_DEADLINE_MS so sign-in latency stays
      // acceptable.  If the deadline is exceeded the token is issued without
      // ATProto data; the identity will be linked on the next sign-in.
      // Authentication MUST succeed regardless of whether linking succeeds.
      // -----------------------------------------------------------------------
      const syncPromise = syncAtprotoIdentity(dbUser, webId, tokens.access_token)
      const deadline = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), ATPROTO_LINK_DEADLINE_MS)
      )
      const synced = await Promise.race([syncPromise, deadline])
      if (synced) {
        dbUser = synced
      }

      // Pod-native write credentials stay server-side. Protected handlers
      // hydrate them from the encrypted users.pod_token column when needed.
      const tokenObject = getTokenObject(new User(dbUser))
      const token = await jwt.sign(tokenObject)

      return {
        token,
        user: toPublicUser(dbUser)
      }
    } catch (e) {
      console.error('Error while completing OIDC login: ', e)
      return fail(500, 'oidc.unableToComplete')
    }
  })

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function decodeJwtPayload(token: string): Record<string, string> {
  const [, payload] = token.split('.')
  if (!payload) throw new Error('Invalid JWT payload')
  const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, string>
}

function getNameFromWebId(webId: string): string {
  try {
    const url = new URL(webId)
    const segment = url.pathname.split('/').filter(Boolean).at(-1)
    return segment || url.hostname
  } catch {
    return webId
  }
}

async function fetchOidcDiscovery(providerEndpoint: string): Promise<{
  metadata: Record<string, string>
  resolvedProviderEndpoint: string
}> {
  const candidateEndpoints = [providerEndpoint]

  try {
    const parsed = new URL(providerEndpoint)
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      parsed.hostname = SERVER_SIDE_PROVIDER_HOST_FALLBACK
      candidateEndpoints.push(parsed.toString().replace(/\/$/, ''))
    }
  } catch {
    // Fall through to the original endpoint only.
  }

  let lastError: unknown
  for (const endpoint of candidateEndpoints) {
    try {
      const response = await fetch(`${endpoint.replace(/\/$/, '')}/.well-known/openid-configuration`)
      if (!response.ok) {
        throw new Error(await response.text())
      }

      return {
        metadata: (await response.json()) as Record<string, string>,
        resolvedProviderEndpoint: endpoint.replace(/\/$/, '')
      }
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Unable to fetch OIDC discovery document')
}

function rewriteUrlOrigin(url: string, newOrigin: string) {
  try {
    const parsed = new URL(url)
    const replacement = new URL(newOrigin)
    parsed.protocol = replacement.protocol
    parsed.hostname = replacement.hostname
    parsed.port = replacement.port
    return parsed.toString()
  } catch {
    return url
  }
}

export default oidcAuthPlugin

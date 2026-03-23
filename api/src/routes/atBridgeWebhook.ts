/**
 * AT Protocol Bridge — Ingress Webhook
 *
 * Receives trusted at.ingress.v1 events from the mastopod-federation-architecture
 * ingress pipeline via HTTP webhook and writes them to the memory database.
 *
 * This webhook is the integration point between the Phase 5.5 pipeline and
 * the memory UI.  In production, this would be replaced by a direct RedPanda
 * consumer group subscription.  The webhook approach is used here for
 * simplicity and to avoid requiring a full RedPanda setup for the memory app.
 *
 * Authentication:
 *   - All requests must include the FIREHOSE_BRIDGE_SECRET in the
 *     X-Bridge-Secret header.
 *   - Requests without a valid secret are rejected with 401.
 *
 * Security notes:
 *   - The bridge secret is validated using a constant-time comparison to
 *     prevent timing attacks.
 *   - Request bodies are validated against the expected schema.
 *   - Individual event processing failures do not fail the entire batch.
 */

import Elysia, { t } from 'elysia'
import { atBridgeIngestionService } from '../services/AtBridgeIngestionService'
import crypto from 'crypto'

// ---------------------------------------------------------------------------
// Constant-time string comparison to prevent timing attacks
// ---------------------------------------------------------------------------

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

// ---------------------------------------------------------------------------
// Webhook route
// ---------------------------------------------------------------------------

const atBridgeWebhookPlugin = new Elysia({ name: 'at-bridge-webhook', prefix: '/at/webhook' })

  // -------------------------------------------------------------------------
  // POST /at/webhook/ingress — Receive trusted ingress events
  // -------------------------------------------------------------------------
  .post(
    '/ingress',
    async ({ body, headers, error }) => {
      // Authenticate the request
      const bridgeSecret = process.env.FIREHOSE_BRIDGE_SECRET
      if (!bridgeSecret) {
        console.error('[AtBridgeWebhook] FIREHOSE_BRIDGE_SECRET is not configured')
        return error(503, 'Bridge not configured')
      }

      const providedSecret = headers['x-bridge-secret'] as string | undefined
      if (!providedSecret || !safeCompare(providedSecret, bridgeSecret)) {
        return error(401, 'Unauthorized')
      }

      // Process events
      const events = Array.isArray(body) ? body : [body]
      const results = {
        processed: 0,
        failed: 0,
        total: events.length,
      }

      for (const event of events) {
        const success = await atBridgeIngestionService.processIngressEvent(event as any)
        if (success) {
          results.processed++
        } else {
          results.failed++
        }
      }

      return results
    },
    {
      body: t.Union([
        t.Object({
          seq: t.Number(),
          did: t.String(),
          eventType: t.String(),
          verifiedAt: t.String(),
          source: t.String(),
          commit: t.Optional(t.Any()),
          identity: t.Optional(t.Any()),
          account: t.Optional(t.Any()),
        }),
        t.Array(t.Object({
          seq: t.Number(),
          did: t.String(),
          eventType: t.String(),
          verifiedAt: t.String(),
          source: t.String(),
          commit: t.Optional(t.Any()),
          identity: t.Optional(t.Any()),
          account: t.Optional(t.Any()),
        })),
      ]),
      detail: 'Receive trusted AT Protocol ingress events from the federation pipeline',
      response: {
        200: t.Object({
          processed: t.Number(),
          failed: t.Number(),
          total: t.Number(),
        }),
        401: t.String(),
        503: t.String(),
      },
    },
  )

  // -------------------------------------------------------------------------
  // GET /at/webhook/health — Webhook health check
  // -------------------------------------------------------------------------
  .get(
    '/health',
    () => ({
      status: 'ok',
      timestamp: new Date().toISOString(),
      bridgeConfigured: !!process.env.FIREHOSE_BRIDGE_SECRET,
    }),
    {
      detail: 'AT Protocol bridge webhook health check',
    },
  )

export default atBridgeWebhookPlugin

/**
 * AT Protocol Bridge — Ingestion Service
 *
 * Consumes trusted at.ingress.v1 events from the Phase 5.5 pipeline and
 * writes them to the memory app's database for display in the UI.
 *
 * This service is the bridge between the mastopod-federation-architecture
 * ingress pipeline and the memory UI's data layer.
 *
 * Event handling:
 *   #commit  → upsert AT post into at_posts table
 *   #identity → upsert identity into at_identities table
 *   #account  → update is_active flag in at_identities table
 *
 * Design principles:
 *   - Idempotent: all writes use upsert semantics (ON CONFLICT DO UPDATE).
 *   - Non-destructive: delete operations mark records as inactive rather
 *     than hard-deleting them.
 *   - Resilient: individual event failures are logged but do not crash the
 *     service; the consumer group will retry failed events.
 *
 * Security notes:
 *   - Content is stored as received; no sanitisation is performed here.
 *   - AT URIs are validated before storage to prevent injection.
 *   - DID values are validated against the did: prefix.
 *   - The FIREHOSE_BRIDGE_SECRET env var must be set to authenticate
 *     incoming webhook calls from the ingress pipeline.
 */

import { db } from '..'
import { atPosts, atIdentities, atFirehoseCursors } from '../db/atBridgeSchema'
import { eq } from 'drizzle-orm'

// ---------------------------------------------------------------------------
// Types (mirrors at.ingress.v1 event schema)
// ---------------------------------------------------------------------------

export interface AtIngressCommitEvent {
  seq: number
  did: string
  eventType: '#commit'
  verifiedAt: string
  source: string
  commit: {
    rev: string
    operation: 'create' | 'update' | 'delete'
    collection: string
    rkey: string
    cid: string | null
    record?: Record<string, unknown> | null
    signatureValid: true
  }
}

export interface AtIngressIdentityEvent {
  seq: number
  did: string
  eventType: '#identity'
  verifiedAt: string
  source: string
  identity: {
    handle?: string
    didDocument: Record<string, unknown>
  }
}

export interface AtIngressAccountEvent {
  seq: number
  did: string
  eventType: '#account'
  verifiedAt: string
  source: string
  account: {
    active: boolean
    status?: 'takendown' | 'suspended' | 'deleted' | 'deactivated'
  }
}

export type AtIngressEvent =
  | AtIngressCommitEvent
  | AtIngressIdentityEvent
  | AtIngressAccountEvent

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const AT_URI_PATTERN = /^at:\/\/did:[a-zA-Z0-9:._-]{1,2000}\/[a-zA-Z0-9.]{1,500}\/[a-zA-Z0-9._-]{1,512}$/
const DID_PATTERN = /^did:[a-zA-Z0-9]+:[a-zA-Z0-9._:-]{1,2000}$/

function isValidDid(did: string): boolean {
  return DID_PATTERN.test(did)
}

function isValidAtUri(uri: string): boolean {
  return AT_URI_PATTERN.test(uri)
}

function buildAtUri(did: string, collection: string, rkey: string): string {
  return `at://${did}/${collection}/${rkey}`
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AtBridgeIngestionService {
  /**
   * Process a single trusted at.ingress.v1 event.
   * Returns true if processed successfully, false on error.
   */
  async processIngressEvent(event: AtIngressEvent): Promise<boolean> {
    try {
      switch (event.eventType) {
        case '#commit':
          await this.handleCommit(event)
          break
        case '#identity':
          await this.handleIdentity(event)
          break
        case '#account':
          await this.handleAccount(event)
          break
        default:
          console.warn('[AtBridgeIngestion] Unknown event type:', (event as any).eventType)
      }

      // Update cursor tracking
      await this.updateCursorState(event.source, event.seq)
      return true
    } catch (err) {
      console.error('[AtBridgeIngestion] Failed to process event:', {
        seq: event.seq,
        did: event.did,
        eventType: event.eventType,
        error: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }

  private async handleCommit(event: AtIngressCommitEvent): Promise<void> {
    const { commit, did, source, seq } = event

    // Only handle app.bsky.feed.post records
    if (commit.collection !== 'app.bsky.feed.post') {
      return
    }

    if (!isValidDid(did)) {
      console.warn('[AtBridgeIngestion] Invalid DID in commit event:', did)
      return
    }

    const atUri = buildAtUri(did, commit.collection, commit.rkey)
    if (!isValidAtUri(atUri)) {
      console.warn('[AtBridgeIngestion] Invalid AT URI constructed:', atUri)
      return
    }

    if (commit.operation === 'delete') {
      // Soft-delete: mark as not public rather than hard-deleting
      await db
        .update(atPosts)
        .set({ isPublic: false })
        .where(eq(atPosts.atUri, atUri))
      return
    }

    const record = commit.record as any
    const content = record?.text ?? ''
    if (typeof content !== 'string') return

    const createdAt = record?.createdAt
      ? new Date(record.createdAt)
      : new Date()

    await db
      .insert(atPosts)
      .values({
        authorDid: did,
        rkey: commit.rkey,
        atUri,
        cid: commit.cid,
        content,
        isPublic: true,
        facets: record?.facets ?? null,
        embeds: record?.embed ?? null,
        replyParentUri: record?.reply?.parent?.uri ?? null,
        replyRootUri: record?.reply?.root?.uri ?? null,
        createdAt,
        ingestedAt: new Date(),
        sourceRelay: source,
        firehoseSeq: seq,
      })
      .onConflictDoUpdate({
        target: atPosts.atUri,
        set: {
          content,
          cid: commit.cid,
          facets: record?.facets ?? null,
          embeds: record?.embed ?? null,
          isPublic: true,
          firehoseSeq: seq,
        },
      })
  }

  private async handleIdentity(event: AtIngressIdentityEvent): Promise<void> {
    const { did, identity } = event

    if (!isValidDid(did)) {
      console.warn('[AtBridgeIngestion] Invalid DID in identity event:', did)
      return
    }

    await db
      .insert(atIdentities)
      .values({
        did,
        handle: identity.handle ?? null,
        didDocument: identity.didDocument as any,
        isActive: true,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: atIdentities.did,
        set: {
          handle: identity.handle ?? null,
          didDocument: identity.didDocument as any,
          isActive: true,
          resolvedAt: new Date(),
          updatedAt: new Date(),
        },
      })
  }

  private async handleAccount(event: AtIngressAccountEvent): Promise<void> {
    const { did, account } = event

    if (!isValidDid(did)) {
      console.warn('[AtBridgeIngestion] Invalid DID in account event:', did)
      return
    }

    await db
      .insert(atIdentities)
      .values({
        did,
        isActive: account.active,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: atIdentities.did,
        set: {
          isActive: account.active,
          updatedAt: new Date(),
        },
      })
  }

  private async updateCursorState(sourceId: string, seq: number): Promise<void> {
    try {
      await db
        .insert(atFirehoseCursors)
        .values({
          sourceId,
          isConnected: true,
          hotSeq: seq,
          lastEventAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: atFirehoseCursors.sourceId,
          set: {
            isConnected: true,
            hotSeq: seq,
            lastEventAt: new Date(),
            updatedAt: new Date(),
          },
        })
    } catch (err) {
      // Non-fatal: cursor tracking failure should not block event processing
      console.error('[AtBridgeIngestion] Failed to update cursor state:', err)
    }
  }
}

export const atBridgeIngestionService = new AtBridgeIngestionService()

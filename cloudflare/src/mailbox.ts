/**
 * Internal-only, ciphertext-only Durable Object storage primitive.
 *
 * WARNING: No public API may call putEnvelope/listEnvelopes/ackEnvelopes
 * without verifying authenticated sender/recipient permissions, anti-replay
 * signatures, quotas, and the complete client E2EE protocol. The Worker
 * router intentionally does not expose these methods yet.
 *
 * Ciphertext is an opaque base64url envelope produced on a client. Calling
 * this store does NOT prove the sender actually encrypted anything.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index.ts";

export const MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PENDING = 500;
export const MAX_ENVELOPE_CHARS = 22_000;

export type EnvelopeInput = { id: string; ciphertext: string };
export type EnvelopeRecord = EnvelopeInput & { createdAt: number; expiresAt: number };

const ID = /^[0-9a-f]{32}$/;
const OPAQUE = /^[A-Za-z0-9_-]+$/;

function validate(input: EnvelopeInput): void {
  if (!input || typeof input.id !== "string" || !ID.test(input.id) ||
      typeof input.ciphertext !== "string" ||
      input.ciphertext.length < 24 ||
      input.ciphertext.length > MAX_ENVELOPE_CHARS ||
      !OPAQUE.test(input.ciphertext)) {
    throw new TypeError("invalid_ciphertext_envelope");
  }
}

export class EncryptedMailbox extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS messages (" +
      "id TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, " +
      "created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)"
    );
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS messages_expiry ON messages(expires_at)"
    );
  }

  private prune(now: number): void {
    this.ctx.storage.sql.exec("DELETE FROM messages WHERE expires_at <= ?", now);
  }

  private async scheduleExpiry(): Promise<void> {
    const rows = this.ctx.storage.sql
      .exec<{ next_expiry: number | null }>(
        "SELECT MIN(expires_at) AS next_expiry FROM messages"
      ).toArray();
    const next = rows[0]?.next_expiry;
    if (next != null) {
      await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1000));
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  async putEnvelope(input: EnvelopeInput): Promise<{ status: "stored" | "duplicate" }> {
    validate(input);
    const now = Date.now();
    this.prune(now);
    const existing = this.ctx.storage.sql.exec<{ id: string }>(
      "SELECT id FROM messages WHERE id = ?", input.id
    ).toArray();
    if (existing.length) return { status: "duplicate" };
    const count = this.ctx.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM messages"
    ).one().count;
    if (count >= MAX_PENDING) throw new Error("mailbox_full");

    this.ctx.storage.sql.exec(
      "INSERT INTO messages(id,ciphertext,created_at,expires_at) VALUES(?,?,?,?)",
      input.id, input.ciphertext, now, now + MESSAGE_TTL_MS
    );
    await this.scheduleExpiry();
    return { status: "stored" };
  }

  async listEnvelopes(limit = 100): Promise<EnvelopeRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("invalid_limit");
    }
    this.prune(Date.now());
    const rows = this.ctx.storage.sql.exec<{
      id: string; ciphertext: string; created_at: number; expires_at: number
    }>(
      "SELECT id,ciphertext,created_at,expires_at FROM messages " +
      "ORDER BY created_at,id LIMIT ?", limit
    ).toArray();
    return rows.map(row => ({
      id: row.id, ciphertext: row.ciphertext,
      createdAt: row.created_at, expiresAt: row.expires_at
    }));
  }

  async ackEnvelopes(ids: string[]): Promise<{ ok: true }> {
    if (!Array.isArray(ids) || ids.length > 100 ||
        ids.some(id => typeof id !== "string" || !ID.test(id))) {
      throw new TypeError("invalid_ack_ids");
    }
    for (const id of new Set(ids)) {
      this.ctx.storage.sql.exec("DELETE FROM messages WHERE id=?", id);
    }
    await this.scheduleExpiry();
    return { ok: true };
  }

  async alarm(): Promise<void> {
    this.prune(Date.now());
    await this.scheduleExpiry();
  }
}

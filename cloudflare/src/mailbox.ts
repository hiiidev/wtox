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
import { MESSAGE_TTL_MS, MAX_PENDING, assertEnvelope, assertAckIds, assertReadLimit, type EnvelopeInput, type EnvelopeRecord } from "../../packages/protocol/src/mailbox.ts";

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
    assertEnvelope(input);
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
    assertReadLimit(limit);
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
    assertAckIds(ids);
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

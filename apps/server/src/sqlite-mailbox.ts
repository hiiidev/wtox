/**
 * Local SQLite equivalent of the Cloudflare internal-only encrypted mailbox.
 * This class is NOT wired into a public HTTP route. Shape checks are not E2EE.
 *
 * node:sqlite is experimental in Node 22 and release-candidate in Node 24.
 * Use Node 24 LTS for Docker; keep migration testing before production.
 */
import { DatabaseSync } from "node:sqlite";
import {
  MESSAGE_TTL_MS, MAX_PENDING, assertAckIds, assertEnvelope,
  assertReadLimit, assertRecipient,
  type EnvelopeInput, type EnvelopeRecord,
  type MailboxStore, type PutResult
} from "../../../packages/protocol/src/mailbox.ts";

export interface LocalMailbox extends MailboxStore {
  close(): void;
}

export function openSqliteMailbox(file: string, now: () => number = Date.now): LocalMailbox {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout=5000;");
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec(
    "CREATE TABLE IF NOT EXISTS messages (" +
    "recipient TEXT NOT NULL, id TEXT NOT NULL, ciphertext TEXT NOT NULL, " +
    "created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, " +
    "PRIMARY KEY (recipient,id))"
  );
  db.exec("CREATE INDEX IF NOT EXISTS messages_expiry ON messages(expires_at)");

  const purge = db.prepare("DELETE FROM messages WHERE expires_at <= ?");
  const count = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE recipient=?");
  const exists = db.prepare("SELECT id FROM messages WHERE recipient=? AND id=?");
  const insert = db.prepare(
    "INSERT INTO messages(recipient,id,ciphertext,created_at,expires_at) VALUES(?,?,?,?,?)"
  );
  const query = db.prepare(
    "SELECT id,ciphertext,created_at,expires_at FROM messages " +
    "WHERE recipient=? AND expires_at > ? ORDER BY created_at,id LIMIT ?"
  );
  const del = db.prepare("DELETE FROM messages WHERE recipient=? AND id=?");

  return {
    async put(recipient: string, input: EnvelopeInput): Promise<PutResult> {
      assertRecipient(recipient);
      assertEnvelope(input);
      db.exec("BEGIN IMMEDIATE");
      try {
        purge.run(now());
        if (exists.get(recipient, input.id)) {
          db.exec("COMMIT");
          return { status: "duplicate" };
        }
        const n = (count.get(recipient) as { n: number }).n;
        if (n >= MAX_PENDING) throw new Error("mailbox_full");
        const timestamp = now();
        insert.run(recipient, input.id, input.ciphertext, timestamp, timestamp + MESSAGE_TTL_MS);
        db.exec("COMMIT");
        return { status: "stored" };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    async list(recipient: string, limit = 100): Promise<EnvelopeRecord[]> {
      assertRecipient(recipient);
      assertReadLimit(limit);
      const rows = query.all(recipient, now(), limit) as Array<{
        id: string; ciphertext: string; created_at: number; expires_at: number
      }>;
      return rows.map(row => ({
        id: row.id, ciphertext: row.ciphertext,
        createdAt: row.created_at, expiresAt: row.expires_at
      }));
    },

    async ack(recipient: string, ids: string[]): Promise<void> {
      assertRecipient(recipient);
      assertAckIds(ids);
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const id of new Set(ids)) del.run(recipient, id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    async pruneExpired(): Promise<number> {
      const result = purge.run(now());
      return Number(result.changes);
    },
    close(): void { db.close(); }
  };
}

/**
 * Shared envelope contract across Cloudflare DO and self-hosted Node.js.
 * IMPORTANT: Shape validation is NOT proof of E2EE or sender authorization.
 * This module does not contain a cipher or accept plaintext.
 */
export const MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PENDING = 500;
export const MAX_ENVELOPE_CHARS = 22_000;
export const MAX_READ = 100;

export interface EnvelopeInput {
  id: string;
  ciphertext: string;
}

export interface EnvelopeRecord extends EnvelopeInput {
  createdAt: number;
  expiresAt: number;
}

export type PutResult = { status: "stored" | "duplicate" };

const ENVELOPE_ID = /^[0-9a-f]{32}$/;
const RECIPIENT_ID = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function assertRecipient(recipient: unknown): asserts recipient is string {
  if (typeof recipient !== "string" || !RECIPIENT_ID.test(recipient)) {
    throw new TypeError("invalid_recipient");
  }
}

export function assertEnvelope(input: unknown): asserts input is EnvelopeInput {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("invalid_ciphertext_envelope");
  }
  const item = input as Record<string, unknown>;
  if (typeof item.id !== "string" || !ENVELOPE_ID.test(item.id) ||
      typeof item.ciphertext !== "string" ||
      item.ciphertext.length < 24 ||
      item.ciphertext.length > MAX_ENVELOPE_CHARS ||
      !BASE64URL.test(item.ciphertext)) {
    throw new TypeError("invalid_ciphertext_envelope");
  }
}

export function assertReadLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ) {
    throw new RangeError("invalid_limit");
  }
}

export function assertAckIds(ids: unknown): asserts ids is string[] {
  if (!Array.isArray(ids) || ids.length > MAX_READ ||
      ids.some(id => typeof id !== "string" || !ENVELOPE_ID.test(id))) {
    throw new TypeError("invalid_ack_ids");
  }
}

export interface MailboxStore {
  put(recipient: string, input: EnvelopeInput): Promise<PutResult>;
  list(recipient: string, limit?: number): Promise<EnvelopeRecord[]>;
  ack(recipient: string, ids: string[]): Promise<void>;
  pruneExpired(): Promise<number>;
}

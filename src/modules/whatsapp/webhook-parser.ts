import { createHmac, timingSafeEqual } from 'node:crypto';

import { MessageStatus, MessageType } from '@prisma/client';

/**
 * Verifies Meta's `x-hub-signature-256` header.
 *
 * Format is `sha256=<hex>` — HMAC-SHA256 of the **raw request bytes**, keyed with
 * the app secret. Exported as a free function rather than a service method
 * because it is pure, security-critical, and deserves to be tested in isolation
 * with no DI ceremony in the way.
 */
export function verifyMetaSignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  // Fail closed. A missing secret must never mean "accept everything".
  if (!header || !appSecret) return false;

  const [algorithm, provided] = header.split('=');
  if (algorithm !== 'sha256' || !provided) return false;

  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const providedNormalised = provided.trim().toLowerCase();

  // Length check first: `timingSafeEqual` throws on a mismatch, and that throw
  // would itself be an observable timing/behaviour difference.
  if (expected.length !== providedNormalised.length) return false;

  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(providedNormalised, 'utf8'));
}

/** A message extracted from a webhook, in our vocabulary. */
export interface InboundMessage {
  wamid: string;
  /** Sender, E.164 normalised by the caller. */
  from: string;
  /** The business number that received it (Meta's id). */
  phoneNumberId: string;
  /** Customer's WhatsApp profile name. Customer-controlled — display only. */
  profileName?: string;
  type: MessageType;
  /** Extracted plain text, where the type has any. */
  text?: string;
  /** wamid this message quotes, if it is a reply. */
  replyToWamid?: string;
  timestamp: Date;
  /** The verbatim message object, so nothing is lost. */
  raw: Record<string, unknown>;
}

/** A delivery-status callback for a message we sent. */
export interface StatusUpdate {
  wamid: string;
  status: MessageStatus;
  timestamp: Date;
  recipientPhone: string;
  errorCode?: number;
  errorTitle?: string;
}

export interface ParsedWebhook {
  messages: InboundMessage[];
  statuses: StatusUpdate[];
}

/** Meta's message `type` string → our enum. Unknown types are preserved, not dropped. */
const TYPE_MAP: Record<string, MessageType> = {
  text: MessageType.TEXT,
  image: MessageType.IMAGE,
  video: MessageType.VIDEO,
  audio: MessageType.AUDIO,
  document: MessageType.DOCUMENT,
  sticker: MessageType.STICKER,
  location: MessageType.LOCATION,
  contacts: MessageType.CONTACTS,
  interactive: MessageType.INTERACTIVE,
  button: MessageType.BUTTON,
  reaction: MessageType.REACTION,
  order: MessageType.ORDER,
  system: MessageType.SYSTEM,
};

const STATUS_MAP: Record<string, MessageStatus> = {
  sent: MessageStatus.SENT,
  delivered: MessageStatus.DELIVERED,
  read: MessageStatus.READ,
  failed: MessageStatus.FAILED,
};

/**
 * Flattens Meta's deeply nested webhook envelope into flat lists.
 *
 * The payload is `entry[] → changes[] → value → {messages[], statuses[]}`, and a
 * single POST can legitimately carry several entries, several changes, and a mix
 * of new messages and status callbacks. Handling only `entry[0].changes[0]` —
 * which is what most integrations do — silently drops messages under load,
 * exactly when it is least likely to be noticed.
 *
 * Never throws on unfamiliar shapes: Meta adds fields and message types without
 * notice, and a parse error would mean returning non-2xx, which makes Meta retry
 * the batch forever and eventually disable the subscription.
 */
export function parseWebhook(payload: unknown): ParsedWebhook {
  const messages: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];

  const entries = asArray((payload as Record<string, unknown>)?.entry);

  for (const entry of entries) {
    for (const change of asArray(asRecord(entry).changes)) {
      const value = asRecord(asRecord(change).value);

      // The business number that received this batch.
      const metadata = asRecord(value.metadata);
      const phoneNumberId = asString(metadata.phone_number_id);
      if (!phoneNumberId) continue;

      // Profile names arrive in a parallel `contacts` array keyed by wa_id.
      const profileNames = new Map<string, string>();
      for (const contact of asArray(value.contacts)) {
        const record = asRecord(contact);
        const waId = asString(record.wa_id);
        const name = asString(asRecord(record.profile).name);
        if (waId && name) profileNames.set(waId, name);
      }

      for (const raw of asArray(value.messages)) {
        const message = parseMessage(asRecord(raw), phoneNumberId, profileNames);
        if (message) messages.push(message);
      }

      for (const raw of asArray(value.statuses)) {
        const status = parseStatus(asRecord(raw));
        if (status) statuses.push(status);
      }
    }
  }

  return { messages, statuses };
}

function parseMessage(
  raw: Record<string, unknown>,
  phoneNumberId: string,
  profileNames: Map<string, string>,
): InboundMessage | undefined {
  const wamid = asString(raw.id);
  const from = asString(raw.from);
  if (!wamid || !from) return undefined;

  const rawType = asString(raw.type) ?? 'unknown';

  return {
    wamid,
    from,
    phoneNumberId,
    profileName: profileNames.get(from),
    // An unmodelled type is stored as UNSUPPORTED with its payload intact, so a
    // new Meta message type is a display gap rather than data loss.
    type: TYPE_MAP[rawType] ?? MessageType.UNSUPPORTED,
    text: extractText(raw, rawType),
    replyToWamid: asString(asRecord(raw.context).id),
    // Meta sends Unix seconds as a string.
    timestamp: parseTimestamp(raw.timestamp),
    raw,
  };
}

/**
 * Pulls displayable text out of whichever field the type puts it in.
 *
 * Worth doing eagerly: it powers inbox previews, search, and — for this product —
 * the command parsing that lets a customer type "balance".
 */
function extractText(raw: Record<string, unknown>, type: string): string | undefined {
  switch (type) {
    case 'text':
      return asString(asRecord(raw.text).body);

    case 'button':
      return asString(asRecord(raw.button).text);

    case 'interactive': {
      const interactive = asRecord(raw.interactive);
      // A tapped reply is the customer's answer; its title is what they saw.
      return (
        asString(asRecord(interactive.button_reply).title) ??
        asString(asRecord(interactive.list_reply).title)
      );
    }

    case 'image':
    case 'video':
    case 'document':
      return asString(asRecord(raw[type]).caption);

    case 'reaction':
      return asString(asRecord(raw.reaction).emoji);

    default:
      return undefined;
  }
}

function parseStatus(raw: Record<string, unknown>): StatusUpdate | undefined {
  const wamid = asString(raw.id);
  const status = STATUS_MAP[asString(raw.status) ?? ''];
  if (!wamid || !status) return undefined;

  // Meta sends an array of errors; the first is the actionable one.
  const error = asRecord(asArray(raw.errors)[0]);

  return {
    wamid,
    status,
    timestamp: parseTimestamp(raw.timestamp),
    recipientPhone: asString(raw.recipient_id) ?? '',
    errorCode: typeof error.code === 'number' ? error.code : undefined,
    errorTitle: asString(error.title) ?? asString(error.message),
  };
}

// -- Defensive accessors ------------------------------------------------------
// Every field in Meta's payload is treated as absent-or-wrong-typed until proven
// otherwise. This is untrusted input from a system that changes without notice.

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseTimestamp(value: unknown): Date {
  const seconds = Number(value);
  // A missing or malformed timestamp must not produce an Invalid Date that then
  // fails at the database; "now" is the honest fallback.
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
}

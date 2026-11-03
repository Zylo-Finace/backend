import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { RequestContext } from '../../../core/context/request-context';
import { InjectPrisma } from '../../../infrastructure/database/prisma.module';
import type { ExtendedPrismaClient } from '../../../infrastructure/database/prisma.service';

/** Field-level before/after, already stripped of secrets by {@link redact}. */
export type AuditChanges = Record<string, { from: unknown; to: unknown }>;

export interface AuditEntry {
  /** Dot-namespaced past-tense fact, e.g. `role.updated`. */
  action: string;
  resourceType: string;
  resourceId?: string;
  changes?: AuditChanges;
  metadata?: Record<string, unknown>;
}

/**
 * Keys whose values never reach the audit table.
 *
 * Matched on a normalised substring, so `passwordHash`, `refreshTokenHash` and
 * `twoFactorSecret` are all caught without enumerating every field name. An
 * audit log is a high-value target precisely because it is retained longest and
 * read by the most people — writing a credential into it converts a durable
 * compliance record into a durable credential store.
 */
const REDACTED_KEY_FRAGMENTS = [
  'password',
  'pin',
  'secret',
  'token',
  'hash',
  'credential',
  'authorization',
  'apikey',
  'accesstoken',
] as const;

const REDACTED = '[redacted]';

/**
 * Writes the append-only audit trail.
 *
 * ## Why failures are swallowed
 *
 * `record` never throws. The alternative — letting an audit write fail the
 * business operation — means a full disk or a slow index turns "you cannot see
 * who changed this" into "nobody can change anything", and the operation the
 * operator was performing is very often the one fixing the outage. The
 * compromise is that a failed write is logged at `error` with the full entry, so
 * the fact survives in the log pipeline even when the row does not.
 *
 * The corollary: this is an audit trail, not a ledger. Money movement is
 * recorded in `wallet_ledger_entries` inside the same transaction as the balance
 * change, and that write is *not* allowed to fail silently.
 */
@Injectable()
export class AuditService {
  constructor(
    @InjectPrisma() private readonly db: ExtendedPrismaClient,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AuditService.name);
  }

  async record(entry: AuditEntry): Promise<void> {
    const context = RequestContext.get();
    const tenantId = context?.tenantId;

    if (!tenantId) {
      this.logger.error({ entry }, 'Audit entry dropped: no tenant on the request context');
      return;
    }

    try {
      await this.db.auditLog.create({
        data: {
          tenantId,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId,
          actorType: context?.actorType ?? 'system',
          actorId: context?.userId,
          changes: entry.changes ? (redact(entry.changes) as never) : undefined,
          metadata: entry.metadata ? (redact(entry.metadata) as never) : undefined,
          ip: context?.ip,
          userAgent: context?.userAgent?.slice(0, 512),
          requestId: context?.requestId,
        },
      });
    } catch (error) {
      this.logger.error({ err: error, entry }, 'Failed to write audit entry');
    }
  }

  /**
   * Builds a `changes` map from a before/after pair, keeping only what moved.
   *
   * Storing the whole row on every edit makes the audit UI useless — a reviewer
   * scrolls thirty unchanged fields looking for the one that moved — and bloats
   * a table that is already the largest in the schema.
   */
  static diff<T extends Record<string, unknown>>(before: T, after: Partial<T>): AuditChanges {
    const changes: AuditChanges = {};

    for (const [key, next] of Object.entries(after)) {
      const previous = before[key];
      if (next === undefined || equivalent(previous, next)) continue;
      changes[key] = { from: previous, to: next };
    }

    return changes;
  }
}

function equivalent(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => equivalent(item, b[index]));
  }
  return false;
}

/** Recursively replaces sensitive values. Depth-limited against hostile nesting. */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }

  const output: Record<string, unknown> = {};

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSensitiveKey(key) ? REDACTED : redact(nested, depth + 1);
  }

  return output;
}

function isSensitiveKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[_-]/g, '');
  return REDACTED_KEY_FRAGMENTS.some((fragment) => normalised.includes(fragment));
}

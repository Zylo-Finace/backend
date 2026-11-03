import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { InjectPrisma } from '../../infrastructure/database/prisma.module';
import type { ExtendedPrismaClient } from '../../infrastructure/database/prisma.service';

const TTL_HOURS = 24;

/** A failure after funds may have left the wallet. The key stays burned so a retry cannot send twice. */
export class OutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutcomeUnknownError';
  }
}

/**
 * Runs a money-moving portal action at most once per `Idempotency-Key`.
 *
 * - Same key + same request, already completed → the stored response is returned.
 * - Same key while the first request is still running → IDEMPOTENT_REQUEST_IN_PROGRESS.
 * - Same key with a different request → IDEMPOTENCY_KEY_CONFLICT.
 * - A failure that proves nothing moved (validation, PIN, balance…) releases the
 *   key so the customer can correct and retry. An {@link OutcomeUnknownError}
 *   keeps it burned.
 *
 * The request hash never includes the PIN.
 */
@Injectable()
export class RampPortalIdempotency {
  constructor(@InjectPrisma() private readonly db: ExtendedPrismaClient) {}

  async run<T extends object>(
    params: { key: string | undefined; endpoint: string; userId: string; request: unknown },
    action: () => Promise<T>,
  ): Promise<T> {
    const key = params.key?.trim();
    if (!key || key.length < 8 || key.length > 255) {
      throw new AppException(ErrorCode.IDEMPOTENCY_KEY_REQUIRED, {
        message: 'Send an Idempotency-Key header (8–255 characters) with this request.',
      });
    }
    // Scope keys to the customer, so one customer's key can never replay another's response.
    const scopedKey = `${params.userId}:${key}`.slice(0, 255);
    const requestHash = createHash('sha256').update(JSON.stringify(params.request)).digest('hex');

    const existing = await this.db.idempotencyRecord.findFirst({
      where: { key: scopedKey, endpoint: params.endpoint },
    });

    if (existing && existing.expiresAt > new Date()) {
      if (existing.requestHash !== requestHash) {
        throw new AppException(ErrorCode.IDEMPOTENCY_KEY_CONFLICT, {
          message: 'This Idempotency-Key was already used for a different request.',
        });
      }
      if (existing.status === 'completed' && existing.responseBody) {
        return existing.responseBody as T;
      }
      if (existing.status === 'outcome_unknown') {
        throw new AppException(ErrorCode.PAYOUT_UNKNOWN_OUTCOME, {
          message:
            'This request was submitted but its outcome is not confirmed yet. Check Activity before trying again.',
        });
      }
      throw new AppException(ErrorCode.IDEMPOTENT_REQUEST_IN_PROGRESS, {
        message: 'This request is still being processed.',
      });
    }

    if (existing) {
      await this.db.idempotencyRecord.delete({ where: { id: existing.id } });
    }

    let recordId: string;
    try {
      const created = await this.db.idempotencyRecord.create({
        data: {
          key: scopedKey,
          endpoint: params.endpoint,
          requestHash,
          status: 'in_progress',
          expiresAt: new Date(Date.now() + TTL_HOURS * 3_600_000),
        } as Prisma.IdempotencyRecordUncheckedCreateInput,
        select: { id: true },
      });
      recordId = created.id;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new AppException(ErrorCode.IDEMPOTENT_REQUEST_IN_PROGRESS, {
          message: 'This request is still being processed.',
        });
      }
      throw e;
    }

    try {
      const result = await action();
      await this.db.idempotencyRecord.update({
        where: { id: recordId },
        data: {
          status: 'completed',
          responseCode: 200,
          responseBody: result as Prisma.InputJsonValue,
        },
      });
      return result;
    } catch (e) {
      if (e instanceof OutcomeUnknownError) {
        await this.db.idempotencyRecord.update({
          where: { id: recordId },
          data: { status: 'outcome_unknown' },
        });
      } else {
        await this.db.idempotencyRecord.delete({ where: { id: recordId } }).catch(() => undefined);
      }
      throw e;
    }
  }
}

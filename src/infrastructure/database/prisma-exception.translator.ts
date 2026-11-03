import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import type { ExceptionTranslator } from '../../core/errors/exception-translator';

/**
 * Turns Prisma driver errors into domain errors.
 *
 * Two reasons this exists rather than `try/catch` in every service:
 *
 * 1. **Leakage.** A raw `PrismaClientKnownRequestError` message embeds table
 *    names, column names and constraint names. Returning that to a client hands
 *    an attacker the schema for free.
 * 2. **Consistency.** A unique-constraint violation should be one `409
 *    RESOURCE_ALREADY_EXISTS` everywhere, not a 500 in whichever service forgot
 *    to catch it.
 *
 * Registered as an `EXCEPTION_TRANSLATORS` contribution, so `core` never imports
 * Prisma and stays infrastructure-agnostic.
 */
@Injectable()
export class PrismaExceptionTranslator implements ExceptionTranslator {
  translate(error: unknown): AppException | undefined {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return this.fromKnownRequestError(error);
    }

    if (error instanceof Prisma.PrismaClientValidationError) {
      // The caller built a structurally invalid query — our bug, not theirs, but
      // it is triggered by input shape, so surface it as a 422 without detail.
      return new AppException(ErrorCode.VALIDATION_FAILED, {
        message: 'The request could not be processed as written',
        cause: error,
      });
    }

    if (error instanceof Prisma.PrismaClientInitializationError) {
      return new AppException(ErrorCode.DATABASE_ERROR, {
        message: 'The database is not available',
        cause: error,
        retryable: true,
      });
    }

    if (error instanceof Prisma.PrismaClientRustPanicError) {
      // The query engine died; the client is unusable until the process restarts.
      return new AppException(ErrorCode.DATABASE_ERROR, {
        message: 'The database engine encountered a fatal error',
        cause: error,
        retryable: false,
      });
    }

    return undefined;
  }

  private fromKnownRequestError(error: Prisma.PrismaClientKnownRequestError): AppException {
    const target = extractTarget(error.meta);

    switch (error.code) {
      // Unique constraint failed.
      case 'P2002':
        return new AppException(ErrorCode.RESOURCE_ALREADY_EXISTS, {
          message: target
            ? `A record with this ${target} already exists`
            : 'A record with these values already exists',
          details: target ? { fields: target.split(', ') } : undefined,
          cause: error,
        });

      // Foreign key constraint failed.
      case 'P2003':
        return new AppException(ErrorCode.RESOURCE_CONFLICT, {
          message: 'A referenced record does not exist or is still in use',
          cause: error,
        });

      // Constraint violation (check/exclusion).
      case 'P2004':
        return new AppException(ErrorCode.VALIDATION_FAILED, {
          message: 'The operation violates a database constraint',
          cause: error,
        });

      // Value too long for column.
      case 'P2000':
        return new AppException(ErrorCode.VALIDATION_FAILED, {
          message: target ? `The value for ${target} is too long` : 'A value is too long',
          details: target ? { field: target } : undefined,
          cause: error,
        });

      // Record required by the query was not found (update/delete on missing row).
      case 'P2025':
      case 'P2001':
        return new AppException(ErrorCode.RESOURCE_NOT_FOUND, {
          message: 'The requested record does not exist',
          cause: error,
        });

      // Required relation violation — deleting a parent that children depend on.
      case 'P2014':
        return new AppException(ErrorCode.RESOURCE_CONFLICT, {
          message: 'The change would break a required relation between records',
          cause: error,
        });

      // Transaction failed due to a write conflict or deadlock. Retryable: the
      // caller (or BullMQ) can replay it and will usually win the second time.
      case 'P2034':
        return new AppException(ErrorCode.OPTIMISTIC_LOCK_FAILED, {
          message: 'The record was modified concurrently; please retry',
          cause: error,
          retryable: true,
        });

      // Connection pool timeout — every connection is busy.
      case 'P2024':
        return new AppException(ErrorCode.DATABASE_ERROR, {
          message: 'The database is under heavy load; please retry',
          cause: error,
          retryable: true,
          retryAfterSeconds: 2,
        });

      // Raw query failed.
      case 'P2010':
        return new AppException(ErrorCode.DATABASE_ERROR, {
          message: 'A database query failed',
          cause: error,
        });

      default:
        return new AppException(ErrorCode.DATABASE_ERROR, {
          message: 'A database error occurred',
          details: { prismaCode: error.code },
          cause: error,
        });
    }
  }
}

/** Prisma reports the offending columns in `meta.target`, shape varying by driver. */
function extractTarget(meta: Record<string, unknown> | undefined): string | undefined {
  const target = meta?.target;
  if (Array.isArray(target)) {
    return target.filter((entry): entry is string => typeof entry === 'string').join(', ');
  }
  return typeof target === 'string' ? target : undefined;
}

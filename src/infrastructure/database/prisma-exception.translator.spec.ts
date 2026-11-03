import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ErrorCode } from '../../core/errors/error-code.enum';
import { PrismaExceptionTranslator } from './prisma-exception.translator';

function knownError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError('raw driver message', {
    code,
    clientVersion: '6.0.0',
    meta,
  });
}

describe('PrismaExceptionTranslator', () => {
  const translator = new PrismaExceptionTranslator();

  it('ignores errors it does not recognise so other translators can try', () => {
    expect(translator.translate(new Error('boom'))).toBeUndefined();
    expect(translator.translate('a string')).toBeUndefined();
  });

  describe('constraint violations', () => {
    it('maps a unique violation to 409 and names the conflicting fields', () => {
      const result = translator.translate(knownError('P2002', { target: ['tenantId', 'email'] }));

      expect(result?.code).toBe(ErrorCode.RESOURCE_ALREADY_EXISTS);
      expect(result?.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(result?.details).toEqual({ fields: ['tenantId', 'email'] });
    });

    it('handles a unique violation whose target is a bare string', () => {
      const result = translator.translate(knownError('P2002', { target: 'email' }));
      expect(result?.details).toEqual({ fields: ['email'] });
    });

    it('maps a foreign key violation to 409', () => {
      expect(translator.translate(knownError('P2003'))?.code).toBe(ErrorCode.RESOURCE_CONFLICT);
    });

    it('maps a missing record to 404', () => {
      const result = translator.translate(knownError('P2025'));

      expect(result?.code).toBe(ErrorCode.RESOURCE_NOT_FOUND);
      expect(result?.getStatus()).toBe(HttpStatus.NOT_FOUND);
    });
  });

  describe('transient failures', () => {
    it('marks a write conflict as retryable', () => {
      const result = translator.translate(knownError('P2034'));

      expect(result?.code).toBe(ErrorCode.OPTIMISTIC_LOCK_FAILED);
      expect(result?.retryable).toBe(true);
    });

    it('marks pool exhaustion as retryable with a Retry-After hint', () => {
      const result = translator.translate(knownError('P2024'));

      expect(result?.retryable).toBe(true);
      expect(result?.retryAfterSeconds).toBe(2);
    });

    it('marks an unreachable database as retryable', () => {
      const result = translator.translate(
        new Prisma.PrismaClientInitializationError('connect ECONNREFUSED', '6.0.0'),
      );

      expect(result?.code).toBe(ErrorCode.DATABASE_ERROR);
      expect(result?.retryable).toBe(true);
    });
  });

  describe('information leakage', () => {
    it('never surfaces the raw driver message to the client', () => {
      // The raw text embeds table, column and constraint names.
      const result = translator.translate(knownError('P2002', { target: ['email'] }));

      expect(result?.message).not.toContain('raw driver message');
    });

    it('exposes only the Prisma code for unmapped errors', () => {
      const result = translator.translate(knownError('P2027'));

      expect(result?.code).toBe(ErrorCode.DATABASE_ERROR);
      expect(result?.details).toEqual({ prismaCode: 'P2027' });
      expect(result?.message).toBe('A database error occurred');
    });

    it('retains the original error as `cause` for the logs', () => {
      const original = knownError('P2002', { target: ['email'] });
      const result = translator.translate(original);

      expect(result?.cause).toBe(original);
    });
  });
});

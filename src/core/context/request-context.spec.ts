import { setTimeout as delay } from 'node:timers/promises';

import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-code.enum';
import { ActorType, RequestContext } from './request-context';

describe('RequestContext', () => {
  it('returns undefined outside any context', () => {
    expect(RequestContext.get()).toBeUndefined();
    expect(RequestContext.tenantId).toBeUndefined();
  });

  it('generates a request id and defaults the correlation id to match', () => {
    RequestContext.run({}, () => {
      const context = RequestContext.getOrThrow();
      expect(context.requestId).toHaveLength(36);
      expect(context.correlationId).toBe(context.requestId);
      expect(context.actorType).toBe(ActorType.Anonymous);
    });
  });

  it('preserves an inbound correlation id across a differing request id', () => {
    RequestContext.run({ requestId: 'req-1', correlationId: 'chain-9' }, () => {
      expect(RequestContext.requestId).toBe('req-1');
      expect(RequestContext.correlationId).toBe('chain-9');
    });
  });

  it('throws a diagnosable error when required outside a context', () => {
    expect(() => RequestContext.getOrThrow()).toThrow(AppException);
  });

  describe('tenant resolution', () => {
    it('exposes the active tenant', () => {
      RequestContext.run({ tenantId: 't1' }, () => {
        expect(RequestContext.requireTenantId()).toBe('t1');
      });
    });

    it('fails closed when no tenant is present', () => {
      RequestContext.run({}, () => {
        expect(() => RequestContext.requireTenantId()).toThrow(
          expect.objectContaining({ code: ErrorCode.TENANT_NOT_RESOLVED }) as Error,
        );
      });
    });
  });

  describe('isolation between concurrent requests', () => {
    it('keeps interleaved async work on separate contexts', async () => {
      // The property that makes ALS safe to rely on: two requests suspended at an
      // await must not observe each other's tenant.
      const observed: string[] = [];

      const handle = (tenantId: string, ms: number) =>
        RequestContext.run({ tenantId }, async () => {
          await delay(ms);
          observed.push(RequestContext.requireTenantId());
        });

      await Promise.all([handle('tenant-a', 20), handle('tenant-b', 5), handle('tenant-c', 10)]);

      expect(observed.sort()).toEqual(['tenant-a', 'tenant-b', 'tenant-c']);
    });

    it('does not leak context out of run()', () => {
      RequestContext.run({ tenantId: 't1' }, () => undefined);
      expect(RequestContext.tenantId).toBeUndefined();
    });
  });

  describe('patch', () => {
    it('enriches the context after authentication resolves the principal', () => {
      RequestContext.run({}, () => {
        RequestContext.patch({
          tenantId: 't1',
          userId: 'u1',
          actorType: ActorType.User,
          permissions: new Set(['contacts:read']),
        });

        expect(RequestContext.tenantId).toBe('t1');
        expect(RequestContext.userId).toBe('u1');
        expect(RequestContext.hasPermission('contacts:read')).toBe(true);
        expect(RequestContext.hasPermission('contacts:write')).toBe(false);
      });
    });

    it('is a no-op outside a context rather than throwing', () => {
      // Called from shared code that may run in or out of a request; throwing
      // here would turn a logging concern into an outage.
      expect(() => RequestContext.patch({ userId: 'u1' })).not.toThrow();
    });

    it('merges log fields cumulatively', () => {
      RequestContext.run({}, () => {
        RequestContext.addLogFields({ campaignId: 'c1' });
        RequestContext.addLogFields({ batch: 3 });

        expect(RequestContext.getOrThrow().logFields).toEqual({ campaignId: 'c1', batch: 3 });
      });
    });
  });

  describe('runAsSystem', () => {
    it('marks the context as platform-level', () => {
      RequestContext.runAsSystem({}, () => {
        expect(RequestContext.isSystem).toBe(true);
        expect(RequestContext.getOrThrow().actorType).toBe(ActorType.System);
      });
    });

    it('does not affect the surrounding request context', () => {
      RequestContext.run({ tenantId: 't1' }, () => {
        RequestContext.runAsSystem({}, () => {
          expect(RequestContext.isSystem).toBe(true);
        });
        expect(RequestContext.isSystem).toBe(false);
        expect(RequestContext.tenantId).toBe('t1');
      });
    });
  });
});

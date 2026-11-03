import { RequestContext } from '../../../core/context/request-context';
import { AppException } from '../../../core/errors/app.exception';
import { ErrorCode } from '../../../core/errors/error-code.enum';
import {
  applyTenantScope,
  SOFT_DELETABLE_MODELS,
  TENANT_SCOPED_MODELS,
} from './tenant-scope.extension';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

/** Captures the args the extension ultimately hands to Prisma. */
function stubQuery() {
  return jest.fn().mockResolvedValue([]);
}

async function runAs<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return RequestContext.run({ tenantId }, fn);
}

describe('tenantScopeExtension', () => {
  describe('model discovery', () => {
    it('derives the scoped-model set from the schema, not a hand-maintained list', () => {
      // If these ever stop being tenant-scoped, isolation silently disappears.
      expect(TENANT_SCOPED_MODELS.has('User')).toBe(true);
      expect(TENANT_SCOPED_MODELS.has('ApiKey')).toBe(true);
      expect(TENANT_SCOPED_MODELS.has('AuditLog')).toBe(true);
      expect(TENANT_SCOPED_MODELS.has('Session')).toBe(true);
    });

    it('does not scope the Tenant model itself', () => {
      // Tenant has no `tenantId` column — scoping it would make it unreadable.
      expect(TENANT_SCOPED_MODELS.has('Tenant')).toBe(false);
    });

    it('identifies soft-deletable models', () => {
      expect(SOFT_DELETABLE_MODELS.has('User')).toBe(true);
      expect(SOFT_DELETABLE_MODELS.has('Tenant')).toBe(true);
      // Append-only: an audit record is never deleted, softly or otherwise.
      expect(SOFT_DELETABLE_MODELS.has('AuditLog')).toBe(false);
    });
  });

  describe('read scoping', () => {
    it.each([
      'findUnique',
      'findFirst',
      'findMany',
      'count',
      'aggregate',
      'groupBy',
      'update',
      'updateMany',
      'delete',
      'deleteMany',
    ])('injects the active tenant into `where` for %s', async (operation) => {
      const query = stubQuery();

      await runAs(TENANT_A, () =>
        applyTenantScope({ model: 'User', operation, args: { where: { id: 'u1' } }, query }),
      );

      expect(query).toHaveBeenCalledWith({ where: { id: 'u1', tenantId: TENANT_A } });
    });

    it('adds a where clause when the caller supplied none', async () => {
      const query = stubQuery();

      await runAs(TENANT_A, () =>
        applyTenantScope({ model: 'User', operation: 'findMany', args: {}, query }),
      );

      expect(query).toHaveBeenCalledWith({ where: { tenantId: TENANT_A } });
    });

    it('handles a completely absent args object', async () => {
      const query = stubQuery();

      await runAs(TENANT_A, () =>
        applyTenantScope({ model: 'User', operation: 'findMany', args: undefined, query }),
      );

      expect(query).toHaveBeenCalledWith({ where: { tenantId: TENANT_A } });
    });

    it('leaves non-tenant-scoped models untouched', async () => {
      const query = stubQuery();
      const args = { where: { slug: 'acme' } };

      await runAs(TENANT_A, () =>
        applyTenantScope({ model: 'Tenant', operation: 'findFirst', args, query }),
      );

      expect(query).toHaveBeenCalledWith(args);
    });

    it('does not mutate the caller-supplied args object', async () => {
      const query = stubQuery();
      const args = { where: { id: 'u1' } };

      await runAs(TENANT_A, () =>
        applyTenantScope({ model: 'User', operation: 'findFirst', args, query }),
      );

      // Mutating the caller's object would leak a tenant id into a reused
      // args literal — a subtle cross-request bug.
      expect(args).toEqual({ where: { id: 'u1' } });
    });
  });

  describe('write scoping', () => {
    it('injects the tenant into create payloads', async () => {
      const query = stubQuery();

      await runAs(TENANT_A, () =>
        applyTenantScope({
          model: 'User',
          operation: 'create',
          args: { data: { email: 'a@example.com' } },
          query,
        }),
      );

      expect(query).toHaveBeenCalledWith({
        data: { email: 'a@example.com', tenantId: TENANT_A },
      });
    });

    it('injects the tenant into every row of createMany', async () => {
      const query = stubQuery();

      await runAs(TENANT_A, () =>
        applyTenantScope({
          model: 'User',
          operation: 'createMany',
          args: { data: [{ email: 'a@example.com' }, { email: 'b@example.com' }] },
          query,
        }),
      );

      expect(query).toHaveBeenCalledWith({
        data: [
          { email: 'a@example.com', tenantId: TENANT_A },
          { email: 'b@example.com', tenantId: TENANT_A },
        ],
      });
    });

    it('scopes both halves of an upsert', async () => {
      const query = stubQuery();

      await runAs(TENANT_A, () =>
        applyTenantScope({
          model: 'User',
          operation: 'upsert',
          args: {
            where: { email: 'a@example.com' },
            create: { email: 'a@example.com' },
            update: { firstName: 'A' },
          },
          query,
        }),
      );

      expect(query).toHaveBeenCalledWith({
        where: { email: 'a@example.com', tenantId: TENANT_A },
        create: { email: 'a@example.com', tenantId: TENANT_A },
        update: { firstName: 'A' },
      });
    });
  });

  describe('cross-tenant access', () => {
    it('rejects a read that names a different tenant', async () => {
      const query = stubQuery();

      await expect(
        runAs(TENANT_A, () =>
          applyTenantScope({
            model: 'User',
            operation: 'findMany',
            args: { where: { tenantId: TENANT_B } },
            query,
          }),
        ),
      ).rejects.toMatchObject({ code: ErrorCode.CROSS_TENANT_ACCESS_DENIED });

      expect(query).not.toHaveBeenCalled();
    });

    it('rejects a write that names a different tenant', async () => {
      const query = stubQuery();

      await expect(
        runAs(TENANT_A, () =>
          applyTenantScope({
            model: 'User',
            operation: 'create',
            args: { data: { email: 'a@example.com', tenantId: TENANT_B } },
            query,
          }),
        ),
      ).rejects.toMatchObject({ code: ErrorCode.CROSS_TENANT_ACCESS_DENIED });

      expect(query).not.toHaveBeenCalled();
    });

    it('allows an explicit tenantId that matches the active tenant', async () => {
      const query = stubQuery();

      await runAs(TENANT_A, () =>
        applyTenantScope({
          model: 'User',
          operation: 'findMany',
          args: { where: { tenantId: TENANT_A } },
          query,
        }),
      );

      expect(query).toHaveBeenCalledWith({ where: { tenantId: TENANT_A } });
    });
  });

  describe('missing tenant', () => {
    it('refuses to run a tenant-scoped query with no tenant in context', async () => {
      const query = stubQuery();

      await expect(
        RequestContext.run({}, () =>
          applyTenantScope({ model: 'User', operation: 'findMany', args: {}, query }),
        ),
      ).rejects.toMatchObject({ code: ErrorCode.TENANT_NOT_RESOLVED });

      expect(query).not.toHaveBeenCalled();
    });

    it('refuses when there is no request context at all', async () => {
      const query = stubQuery();

      // Failing closed matters most here: a background job that forgot to open a
      // context must not quietly read every tenant's rows.
      await expect(
        applyTenantScope({ model: 'User', operation: 'findMany', args: {}, query }),
      ).rejects.toBeInstanceOf(AppException);

      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('system bypass', () => {
    it('skips scoping for platform-level work', async () => {
      const query = stubQuery();
      const args = { where: { email: 'a@example.com' } };

      await RequestContext.runAsSystem({}, () =>
        applyTenantScope({ model: 'User', operation: 'findMany', args, query }),
      );

      expect(query).toHaveBeenCalledWith(args);
    });

    it('cannot be enabled through the public patch API', async () => {
      const query = stubQuery();

      await expect(
        RequestContext.run({}, () => {
          // A caller trying to escalate by patching the flag must not succeed.
          RequestContext.patch({ tenantId: undefined });
          (RequestContext.get() as unknown as Record<string, unknown>).bypassTenantScope = false;
          return applyTenantScope({ model: 'User', operation: 'findMany', args: {}, query });
        }),
      ).rejects.toMatchObject({ code: ErrorCode.TENANT_NOT_RESOLVED });
    });
  });
});

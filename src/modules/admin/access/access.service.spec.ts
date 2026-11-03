import { Permission, SYSTEM_ROLES } from '../../../core/authorization/permission.enum';
import { grants } from '../../../core/authorization/permission.resolver';
import { AppException } from '../../../core/errors/app.exception';
import { ErrorCode } from '../../../core/errors/error-code.enum';
import { CacheNamespace } from '../../../infrastructure/cache/cache-key';
import { AccessService } from './access.service';

const TENANT = 'tenant-1';
const USER = 'user-1';

const membership = (overrides: Record<string, unknown> = {}) => ({
  id: 'membership-1',
  roleId: 'role-1',
  isOwner: false,
  extraPermissions: [],
  deniedPermissions: [],
  role: { key: 'agent', permissions: [Permission.ConversationsRead], deletedAt: null },
  ...overrides,
});

describe('AccessService', () => {
  let db: {
    membership: { findFirst: jest.Mock };
    role: { createMany: jest.Mock };
  };
  let cache: {
    get: jest.Mock;
    set: jest.Mock;
    delete: jest.Mock;
    invalidateTenantNamespace: jest.Mock;
    keys: { tenant: jest.Mock };
  };
  let service: AccessService;

  beforeEach(() => {
    db = {
      membership: { findFirst: jest.fn().mockResolvedValue(membership()) },
      role: { createMany: jest.fn().mockResolvedValue({ count: SYSTEM_ROLES.length }) },
    };
    cache = {
      get: jest.fn().mockResolvedValue(undefined),
      set: jest.fn().mockResolvedValue(true),
      delete: jest.fn().mockResolvedValue(1),
      invalidateTenantNamespace: jest.fn().mockResolvedValue(3),
      keys: { tenant: jest.fn((tenantId, ns, part) => `${ns}:${tenantId}:${part}`) },
    };

    service = new AccessService(db as never, cache as never);
  });

  describe('resolve', () => {
    it('flattens the role into literal slugs for the UI', async () => {
      const access = await service.resolve(TENANT, USER);

      expect(access.roleKey).toBe('agent');
      expect(access.permissions).toEqual([Permission.ConversationsRead]);
    });

    it('applies per-member extras and denials on top of the role', async () => {
      db.membership.findFirst.mockResolvedValue(
        membership({
          extraPermissions: [Permission.WalletsRead],
          deniedPermissions: [Permission.ConversationsRead],
        }),
      );

      const access = await service.resolve(TENANT, USER);

      expect(grants(access.effective, Permission.WalletsRead)).toBe(true);
      expect(grants(access.effective, Permission.ConversationsRead)).toBe(false);
    });

    it('expands an owner wildcard to the whole catalogue', async () => {
      db.membership.findFirst.mockResolvedValue(
        membership({ isOwner: true, role: { key: 'owner', permissions: ['*'], deletedAt: null } }),
      );

      const access = await service.resolve(TENANT, USER);

      expect(access.isOwner).toBe(true);
      expect(access.permissions).toContain(Permission.WalletsAdjust);
      expect(access.permissions).toContain(Permission.RolesDelete);
    });

    it('caches the resolved grant under a tenant-scoped key', async () => {
      await service.resolve(TENANT, USER);

      expect(cache.keys.tenant).toHaveBeenCalledWith(TENANT, CacheNamespace.Permissions, USER);
      expect(cache.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ roleKey: 'agent' }),
        expect.objectContaining({ ttlSeconds: expect.any(Number) }),
      );
    });

    it('serves a second call from cache without touching the database', async () => {
      cache.get.mockResolvedValue({
        membershipId: 'membership-1',
        roleId: 'role-1',
        roleKey: 'agent',
        isOwner: false,
        rolePermissions: [Permission.MembersRead],
        extraPermissions: [],
        deniedPermissions: [],
      });

      const access = await service.resolve(TENANT, USER);

      expect(db.membership.findFirst).not.toHaveBeenCalled();
      expect(access.permissions).toEqual([Permission.MembersRead]);
    });

    it('refuses a user with no membership in this workspace', async () => {
      db.membership.findFirst.mockResolvedValue(null);

      await expect(service.resolve(TENANT, USER)).rejects.toMatchObject({
        code: ErrorCode.ROLE_REQUIRED,
      });
    });

    it('refuses when the assigned role has been deleted', async () => {
      // A soft-deleted role must not keep granting what it used to.
      db.membership.findFirst.mockResolvedValue(
        membership({ role: { key: 'agent', permissions: ['*'], deletedAt: new Date() } }),
      );

      await expect(service.resolve(TENANT, USER)).rejects.toBeInstanceOf(AppException);
    });

    it('does not cache the refusal, so a new membership takes effect at once', async () => {
      db.membership.findFirst.mockResolvedValue(null);

      await expect(service.resolve(TENANT, USER)).rejects.toBeInstanceOf(AppException);
      expect(cache.set).not.toHaveBeenCalled();
    });
  });

  describe('can / require', () => {
    it('answers false for a permission the role omits', async () => {
      expect(await service.can(TENANT, USER, Permission.WalletsAdjust)).toBe(false);
    });

    it('throws INSUFFICIENT_PERMISSIONS naming the requirement', async () => {
      await expect(service.require(TENANT, USER, Permission.WalletsAdjust)).rejects.toMatchObject({
        code: ErrorCode.INSUFFICIENT_PERMISSIONS,
        details: { required: Permission.WalletsAdjust },
      });
    });

    it('passes for a permission the role grants', async () => {
      await expect(
        service.require(TENANT, USER, Permission.ConversationsRead),
      ).resolves.toBeUndefined();
    });
  });

  describe('invalidation', () => {
    it('drops one member’s grant', async () => {
      await service.invalidate(TENANT, USER);

      expect(cache.delete).toHaveBeenCalledWith(`${CacheNamespace.Permissions}:${TENANT}:${USER}`);
    });

    it('clears the whole namespace when a role changes', async () => {
      // Editing a role changes everyone's grant without touching a membership
      // row, so there is nothing to invalidate per user.
      await service.invalidateTenant(TENANT);

      expect(cache.invalidateTenantNamespace).toHaveBeenCalledWith(
        TENANT,
        CacheNamespace.Permissions,
      );
    });
  });

  describe('seedSystemRoles', () => {
    it('creates every seeded role, marked as system', async () => {
      await service.seedSystemRoles(TENANT);

      const [args] = db.role.createMany.mock.calls[0] as [
        { data: { key: string; isSystem: boolean }[]; skipDuplicates: boolean },
      ];

      expect(args.data).toHaveLength(SYSTEM_ROLES.length);
      expect(args.data.every((role) => role.isSystem)).toBe(true);
      expect(args.data.map((role) => role.key)).toContain('owner');
    });

    it('is idempotent, because provisioning gets retried', async () => {
      await service.seedSystemRoles(TENANT);

      const [args] = db.role.createMany.mock.calls[0] as [{ skipDuplicates: boolean }];
      expect(args.skipDuplicates).toBe(true);
    });
  });
});

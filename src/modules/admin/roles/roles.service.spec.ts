import { Permission } from '../../../core/authorization/permission.enum';
import { resolveEffectivePermissions } from '../../../core/authorization/permission.resolver';
import { RequestContext } from '../../../core/context/request-context';
import { ErrorCode } from '../../../core/errors/error-code.enum';
import { RolesService } from './roles.service';

const callerHolding = (permissions: string[]) => ({
  membershipId: 'm1',
  roleId: 'r1',
  roleKey: 'admin',
  isOwner: false,
  effective: resolveEffectivePermissions({ rolePermissions: permissions }),
  permissions,
});

const roleRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'role-1',
  key: 'billing-manager',
  name: 'Billing manager',
  description: null,
  permissions: [Permission.WalletsRead],
  isSystem: false,
  isDefault: false,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  _count: { memberships: 0 },
  ...overrides,
});

describe('RolesService', () => {
  let db: {
    role: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    membership: { count: jest.Mock };
    $transaction: jest.Mock;
  };
  let access: { resolve: jest.Mock; invalidateTenant: jest.Mock };
  let audit: { record: jest.Mock };
  let service: RolesService;

  const run = <T>(fn: () => Promise<T>) =>
    RequestContext.run({ tenantId: 'tenant-1', userId: 'user-1' }, fn);

  beforeEach(() => {
    db = {
      role: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue(roleRow()),
        update: jest.fn().mockResolvedValue(roleRow()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      membership: { count: jest.fn().mockResolvedValue(0) },
      // Runs the callback inline against the same stub, so a service that opens
      // a transaction is exercised exactly like one that does not.
      $transaction: jest.fn((fn: (tx: unknown) => unknown) => Promise.resolve(fn(db))),
    };
    access = {
      resolve: jest.fn().mockResolvedValue(callerHolding(['*'])),
      invalidateTenant: jest.fn().mockResolvedValue(undefined),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };

    service = new RolesService(db as never, access as never, audit as never);
  });

  describe('privilege escalation', () => {
    it('refuses to grant a permission the caller does not hold', async () => {
      access.resolve.mockResolvedValue(callerHolding([Permission.RolesWrite]));

      await expect(
        run(() =>
          service.create({
            key: 'sneaky',
            name: 'Sneaky',
            permissions: [Permission.WalletsAdjust],
          }),
        ),
      ).rejects.toMatchObject({
        code: ErrorCode.INSUFFICIENT_PERMISSIONS,
        details: { permissions: [Permission.WalletsAdjust] },
      });

      expect(db.role.create).not.toHaveBeenCalled();
    });

    it('allows granting a permission the caller does hold', async () => {
      access.resolve.mockResolvedValue(
        callerHolding([Permission.RolesWrite, Permission.WalletsRead]),
      );

      await expect(
        run(() =>
          service.create({ key: 'reader', name: 'Reader', permissions: [Permission.WalletsRead] }),
        ),
      ).resolves.toMatchObject({ key: 'billing-manager' });
    });

    it('refuses the wildcard from a caller who is not themselves a superset', async () => {
      // Otherwise `roles:write` plus one request is a promotion to full control.
      access.resolve.mockResolvedValue(
        callerHolding([Permission.RolesWrite, Permission.WalletsRead]),
      );

      await expect(
        run(() => service.create({ key: 'god', name: 'God', permissions: ['*'] })),
      ).rejects.toMatchObject({ code: ErrorCode.INSUFFICIENT_PERMISSIONS });
    });

    it('lets an owner grant the wildcard', async () => {
      await expect(
        run(() => service.create({ key: 'god', name: 'God', permissions: ['*'] })),
      ).resolves.toBeDefined();
    });

    it('rejects a permission slug that is not in the catalogue', async () => {
      await expect(
        run(() => service.create({ key: 'typo', name: 'Typo', permissions: ['members:writ'] })),
      ).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_FAILED,
        details: { unknown: ['members:writ'] },
      });
    });
  });

  describe('system roles', () => {
    it('refuses to edit a seeded role', async () => {
      db.role.findFirst.mockResolvedValue(roleRow({ isSystem: true, key: 'owner' }));

      await expect(run(() => service.update('role-1', { name: 'Renamed' }))).rejects.toMatchObject({
        code: ErrorCode.FORBIDDEN,
      });
    });

    it('refuses to delete a seeded role', async () => {
      db.role.findFirst.mockResolvedValue(roleRow({ isSystem: true }));

      await expect(run(() => service.remove('role-1'))).rejects.toMatchObject({
        code: ErrorCode.FORBIDDEN,
      });
    });
  });

  describe('remove', () => {
    it('refuses while members still hold the role', async () => {
      db.role.findFirst.mockResolvedValue(roleRow());
      db.membership.count.mockResolvedValue(3);

      await expect(run(() => service.remove('role-1'))).rejects.toMatchObject({
        code: ErrorCode.RESOURCE_CONFLICT,
        details: { memberCount: 3 },
      });
    });

    it('refuses to delete the default role', async () => {
      db.role.findFirst.mockResolvedValue(roleRow({ isDefault: true }));

      await expect(run(() => service.remove('role-1'))).rejects.toMatchObject({
        code: ErrorCode.RESOURCE_CONFLICT,
      });
    });

    it('soft-deletes an unused role and clears cached grants', async () => {
      db.role.findFirst.mockResolvedValue(roleRow());

      await run(() => service.remove('role-1'));

      expect(db.role.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { deletedAt: expect.any(Date) } }),
      );
      expect(access.invalidateTenant).toHaveBeenCalledWith('tenant-1');
    });
  });

  describe('update', () => {
    it('clears cached grants, because every holder’s access just changed', async () => {
      db.role.findFirst.mockResolvedValue(roleRow());

      await run(() => service.update('role-1', { name: 'Renamed' }));

      expect(access.invalidateTenant).toHaveBeenCalledWith('tenant-1');
    });

    it('unsets the previous default when a new one is named', async () => {
      db.role.findFirst.mockResolvedValue(roleRow());

      await run(() => service.update('role-1', { isDefault: true }));

      expect(db.role.updateMany).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-1', isDefault: true },
        data: { isDefault: false },
      });
    });

    it('records the change in the audit trail', async () => {
      db.role.findFirst.mockResolvedValue(roleRow());

      await run(() => service.update('role-1', { name: 'Renamed' }));

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'role.updated', resourceId: 'role-1' }),
      );
    });
  });

  describe('create', () => {
    it('refuses a duplicate key', async () => {
      db.role.findFirst.mockResolvedValue({ id: 'existing' });

      await expect(
        run(() => service.create({ key: 'billing-manager', name: 'Dupe', permissions: [] })),
      ).rejects.toMatchObject({ code: ErrorCode.RESOURCE_ALREADY_EXISTS });
    });
  });
});

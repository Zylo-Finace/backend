import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import { Permission } from '../../../core/authorization/permission.enum';
import { resolveEffectivePermissions } from '../../../core/authorization/permission.resolver';
import { RequestContext } from '../../../core/context/request-context';
import { ErrorCode } from '../../../core/errors/error-code.enum';
import { PermissionsGuard } from './permissions.guard';
import { REQUIRED_PERMISSIONS, REQUIRED_PERMISSIONS_MODE } from './require-permissions.decorator';

const httpContext = () =>
  ({
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => class {},
  }) as unknown as ExecutionContext;

const accessWith = (permissions: string[]) => ({
  membershipId: 'm1',
  roleId: 'r1',
  roleKey: 'custom',
  isOwner: false,
  effective: resolveEffectivePermissions({ rolePermissions: permissions }),
  permissions,
});

describe('PermissionsGuard', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let access: { resolve: jest.Mock };
  let guard: PermissionsGuard;

  const metadata = (required?: string[], mode?: string) => {
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === REQUIRED_PERMISSIONS) return required;
      if (key === REQUIRED_PERMISSIONS_MODE) return mode;
      return undefined;
    });
  };

  const run = <T>(fn: () => Promise<T>) =>
    RequestContext.run({ tenantId: 'tenant-1', userId: 'user-1' }, fn);

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    access = { resolve: jest.fn().mockResolvedValue(accessWith([Permission.MembersRead])) };
    guard = new PermissionsGuard(reflector as unknown as Reflector, access as never);
  });

  it('is inert on a route that declares no permission', async () => {
    metadata(undefined);

    await expect(run(() => guard.canActivate(httpContext()))).resolves.toBe(true);
    // RBAC is opt-in: an unannotated route must not pay for a membership lookup.
    expect(access.resolve).not.toHaveBeenCalled();
  });

  it('allows a caller holding the required permission', async () => {
    metadata([Permission.MembersRead]);

    await expect(run(() => guard.canActivate(httpContext()))).resolves.toBe(true);
  });

  it('refuses a caller missing the required permission', async () => {
    metadata([Permission.WalletsAdjust]);

    await expect(run(() => guard.canActivate(httpContext()))).rejects.toMatchObject({
      code: ErrorCode.INSUFFICIENT_PERMISSIONS,
    });
  });

  it('requires every permission by default', async () => {
    metadata([Permission.MembersRead, Permission.RolesWrite]);

    await expect(run(() => guard.canActivate(httpContext()))).rejects.toMatchObject({
      code: ErrorCode.INSUFFICIENT_PERMISSIONS,
    });
  });

  it('requires only one when the route asks for any', async () => {
    metadata([Permission.MembersRead, Permission.RolesWrite], 'any');

    await expect(run(() => guard.canActivate(httpContext()))).resolves.toBe(true);
  });

  it('echoes the requirement so the UI can name the missing permission', async () => {
    metadata([Permission.WalletsAdjust]);

    await expect(run(() => guard.canActivate(httpContext()))).rejects.toMatchObject({
      details: { required: [Permission.WalletsAdjust], mode: 'all' },
    });
  });

  it('publishes the resolved grant so services need not re-query', async () => {
    metadata([Permission.MembersRead]);

    await RequestContext.run({ tenantId: 'tenant-1', userId: 'user-1' }, async () => {
      await guard.canActivate(httpContext());
      expect(RequestContext.hasPermission(Permission.MembersRead)).toBe(true);
    });
  });

  it('refuses when no principal reached the context', async () => {
    // A permission-guarded route that is also @Public() is a wiring bug; the
    // guard must not resolve permissions for an undefined user.
    metadata([Permission.MembersRead]);

    await expect(
      RequestContext.run({}, () => guard.canActivate(httpContext())),
    ).rejects.toMatchObject({ code: ErrorCode.UNAUTHENTICATED });
  });

  it('ignores non-HTTP execution contexts', async () => {
    metadata([Permission.MembersRead]);
    const rpc = { getType: () => 'rpc' } as unknown as ExecutionContext;

    await expect(run(() => guard.canActivate(rpc))).resolves.toBe(true);
  });
});

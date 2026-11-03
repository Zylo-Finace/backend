import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { Permission } from '../../../core/authorization/permission.enum';
import { grants } from '../../../core/authorization/permission.resolver';
import { RequestContext } from '../../../core/context/request-context';
import { AppException } from '../../../core/errors/app.exception';
import { ErrorCode } from '../../../core/errors/error-code.enum';
import { AccessService } from './access.service';
import {
  REQUIRED_PERMISSIONS,
  REQUIRED_PERMISSIONS_MODE,
  type PermissionMode,
} from './require-permissions.decorator';

/**
 * Enforces `@RequirePermissions` and publishes the caller's grant to the context.
 *
 * Registered globally but inert on routes that declare no permission: RBAC is
 * opt-in per route, unlike authentication, because most of the surface here is
 * customer-facing and has no membership to resolve at all.
 *
 * Runs *after* `JwtAuthGuard` — Nest executes global guards in registration
 * order — so the tenant and user are already on the context. That ordering is
 * load-bearing and is asserted below rather than assumed: with no principal the
 * guard refuses instead of resolving permissions for `undefined`.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: AccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const required = this.reflector.getAllAndOverride<Permission[]>(REQUIRED_PERMISSIONS, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required?.length) return true;

    const { tenantId, userId } = RequestContext.getOrThrow();

    if (!tenantId || !userId) {
      // A permission-guarded route that is also @Public() is a wiring bug, not a
      // client error — but refusing is still the safe response.
      throw AppException.unauthenticated('This resource requires an authenticated member');
    }

    const resolved = await this.access.resolve(tenantId, userId);

    const mode =
      this.reflector.getAllAndOverride<PermissionMode>(REQUIRED_PERMISSIONS_MODE, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'all';

    const satisfied =
      mode === 'any'
        ? required.some((permission) => grants(resolved.effective, permission))
        : required.every((permission) => grants(resolved.effective, permission));

    if (!satisfied) {
      throw new AppException(ErrorCode.INSUFFICIENT_PERMISSIONS, {
        message: 'You do not have permission to perform this action',
        // The requirement is echoed so the UI can explain *which* permission to
        // ask an owner for. It reveals nothing a member could not read off the
        // role editor they already have access to.
        details: { required, mode },
      });
    }

    // Published so services deeper in the stack can branch on a second
    // permission without re-querying — the expensive part is the join, and it
    // has already happened.
    RequestContext.patch({
      permissions: resolved.effective.slugs,
      roles: [resolved.roleKey],
    });

    return true;
  }
}

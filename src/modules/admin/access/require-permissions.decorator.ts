import { applyDecorators, SetMetadata } from '@nestjs/common';

import type { Permission } from '../../../core/authorization/permission.enum';

export const REQUIRED_PERMISSIONS = 'requiredPermissions';
export const REQUIRED_PERMISSIONS_MODE = 'requiredPermissionsMode';

export type PermissionMode = 'all' | 'any';

/**
 * Requires every listed permission.
 *
 * Typed against the {@link Permission} catalogue, so a typo is a build error
 * rather than a route nobody can reach — the failure mode of stringly-typed
 * authorization is that the guard denies everyone and it looks like a
 * configuration problem in production.
 */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);

/**
 * Requires at least one of the listed permissions.
 *
 * For endpoints that serve more than one job — a dashboard tile that either kind
 * of reader may see.
 */
export const RequireAnyPermission = (...permissions: Permission[]) =>
  applyDecorators(
    SetMetadata(REQUIRED_PERMISSIONS, permissions),
    SetMetadata(REQUIRED_PERMISSIONS_MODE, 'any' satisfies PermissionMode),
  );

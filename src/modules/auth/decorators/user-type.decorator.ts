import { SetMetadata } from '@nestjs/common';
import type { UserType } from '@prisma/client';

export const REQUIRED_USER_TYPES = 'requiredUserTypes';

/**
 * Restricts a route to specific principal types.
 *
 * This is coarse-grained and orthogonal to RBAC permissions: it separates the two
 * *populations* (customers vs back-office), which is a different question from
 * what a given admin is allowed to do. A customer token must never reach an admin
 * route even if permissions were somehow misconfigured.
 */
export const RequireUserType = (...types: UserType[]) => SetMetadata(REQUIRED_USER_TYPES, types);

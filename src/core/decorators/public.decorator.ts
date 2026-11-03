import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';

/**
 * Marks a route as reachable without authentication.
 *
 * Required because `JwtAuthGuard` is registered globally — protection is the
 * default and exposure is the explicit, greppable exception. Auditing "what is
 * public?" is then one search, rather than a reading of every controller.
 *
 * Lives in `core` rather than the auth module so that operational controllers
 * (health, metrics) can opt out without importing a feature module — a module
 * depending on another module is the coupling this architecture avoids. Auth owns
 * the guard that *reads* this metadata; core owns the contract.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);

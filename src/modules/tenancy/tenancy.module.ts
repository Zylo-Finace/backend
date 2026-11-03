import { Module } from '@nestjs/common';

import { TenantResolutionMiddleware } from './tenant-resolution.middleware';

/**
 * Tenant resolution.
 *
 * The middleware is exported rather than applied here so that `AppModule` owns
 * middleware ordering in one place — resolution must run after the request
 * context is opened and before any guard needs a tenant.
 */
@Module({
  providers: [TenantResolutionMiddleware],
  exports: [TenantResolutionMiddleware],
})
export class TenancyModule {}

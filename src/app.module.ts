import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { AppConfigModule } from './config/config.module';
import { CoreModule } from './core/core.module';
import { RequestContextMiddleware } from './core/context/request-context.middleware';
import { AllExceptionsFilter } from './core/filters/all-exceptions.filter';
import { ResponseTransformInterceptor } from './core/interceptors/response-transform.interceptor';
import { TimeoutInterceptor } from './core/interceptors/timeout.interceptor';
import { CacheModule } from './infrastructure/cache/cache.module';
import { PrismaModule } from './infrastructure/database/prisma.module';
import { MetricsInterceptor } from './infrastructure/observability/metrics.interceptor';
import { ObservabilityModule } from './infrastructure/observability/observability.module';
import { SecurityModule } from './infrastructure/security/security.module';
import { AdminModule } from './modules/admin/admin.module';
import { PermissionsGuard } from './modules/admin/access/permissions.guard';
import { AuthModule } from './modules/auth/auth.module';
import { BillsModule } from './modules/bills/bills.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { HealthModule } from './modules/health/health.module';
import { KycModule } from './modules/kyc/kyc.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { ProfileModule } from './modules/profile/profile.module';
import { RampModule } from './modules/ramp/ramp.module';
import { RewardsModule } from './modules/rewards/rewards.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { WhatsAppModule } from './modules/whatsapp/whatsapp.module';
import { TenancyModule } from './modules/tenancy/tenancy.module';
import { TenantResolutionMiddleware } from './modules/tenancy/tenant-resolution.middleware';

/**
 * Composition root.
 *
 * Layering, outermost to innermost:
 *   config → observability → infrastructure (db, cache) → feature modules
 *
 * Feature modules may depend on infrastructure; infrastructure never depends on a
 * feature module. That one rule is what keeps the modular monolith extractable —
 * when a module becomes a service, it takes its own folder and nothing else.
 *
 * Interceptor order is significant. Nest runs global interceptors in registration
 * order on the way in and unwinds them in reverse on the way out:
 *
 *   Metrics → Timeout → ResponseTransform → handler
 *
 * so metrics observe the *total* time including the timeout, and the timeout fires
 * before the envelope is built (a timed-out request has no body to wrap).
 */
@Module({
  imports: [
    AppConfigModule,
    CoreModule,
    ObservabilityModule,
    PrismaModule,
    CacheModule,
    SecurityModule,
    TenancyModule,
    AuthModule,
    WalletModule,
    KycModule,
    ProfileModule,
    RewardsModule,
    PaymentsModule,
    BillsModule,
    WhatsAppModule,
    RampModule,
    AdminModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TimeoutInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseTransformInterceptor },
    // Authentication is the default. Routes opt *out* with `@Public()`, so a new
    // endpoint is protected from the moment it exists rather than from the moment
    // someone remembers to add a guard.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Registered after the authentication guard because Nest runs global guards
    // in registration order: this one reads the principal that one resolves.
    // Inert on routes with no `@RequirePermissions`, so RBAC stays opt-in while
    // authentication stays opt-out.
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Order is significant and enforced here rather than scattered across modules:
    //
    //   RequestContext  — opens the ALS store; everything below writes into it.
    //   TenantResolution — needs the store, and must precede the guard because
    //                      login endpoints resolve a user *within* a tenant and
    //                      have no token to read the tenant from.
    //
    // Guards run after all middleware, so `JwtAuthGuard` always sees a resolved
    // tenant to cross-check the token against.
    consumer.apply(RequestContextMiddleware, TenantResolutionMiddleware).forRoutes('{*path}');
  }
}

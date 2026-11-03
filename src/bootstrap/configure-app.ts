import { RequestMethod, ValidationPipe, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import helmet from 'helmet';

import type { AppConfig } from '../config/app.config';

/**
 * Applies every piece of application-level HTTP configuration.
 *
 * Extracted from `main.ts` so end-to-end tests run against the *same* pipeline
 * the server runs. When this lives inline in `bootstrap()`, e2e suites end up
 * hand-rebuilding an approximation of it, and the approximation drifts — which is
 * how "all tests green" coexists with a broken validation pipe in production.
 */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  // ---------------------------------------------------------------------------
  // Proxy awareness
  // ---------------------------------------------------------------------------
  // Behind nginx, `req.ip` is the proxy's address unless Express is told how many
  // hops to trust. Rate limiting and audit logs are worthless without this — and
  // trusting *all* proxies (`true`) lets a client forge X-Forwarded-For and evade
  // per-IP limits entirely. Hence a specific hop count.
  app.set('trust proxy', config.app.trustProxyHops);
  app.disable('x-powered-by');

  // ---------------------------------------------------------------------------
  // Security headers
  // ---------------------------------------------------------------------------
  app.use(
    helmet({
      // This is a JSON API: it never renders HTML, so a restrictive CSP costs
      // nothing. The Swagger UI route relaxes it locally (see swagger.ts).
      contentSecurityPolicy: {
        directives: {
          defaultSrc: [`'self'`],
          scriptSrc: [`'self'`],
          styleSrc: [`'self'`],
          imgSrc: [`'self'`, 'data:'],
          objectSrc: [`'none'`],
          frameAncestors: [`'none'`],
        },
      },
      crossOriginEmbedderPolicy: false,
      hsts: config.app.isProduction
        ? { maxAge: 63_072_000, includeSubDomains: true, preload: true }
        : false,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  app.enableCors({
    origin: config.app.corsOrigins.length > 0 ? config.app.corsOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-API-Key',
      'X-Request-Id',
      'X-Correlation-Id',
      'Idempotency-Key',
      // Tenant resolution for the Next.js app and API clients.
      'X-Tenant-Id',
      'X-Tenant-Slug',
    ],
    exposedHeaders: [
      'X-Request-Id',
      'X-Correlation-Id',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'Retry-After',
    ],
    maxAge: 86_400,
  });

  // gzip above 1KB. Below that the CPU cost outweighs the bytes saved, and it
  // interferes with streaming responses.
  app.use(compression({ threshold: 1024 }));

  // ---------------------------------------------------------------------------
  // Routing & versioning
  // ---------------------------------------------------------------------------
  // Named excludes avoid Nest 11 / path-to-regexp v8 warnings for `/api/*`.
  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'health', method: RequestMethod.ALL },
      { path: 'health/live', method: RequestMethod.ALL },
      { path: 'health/ready', method: RequestMethod.ALL },
      { path: 'metrics', method: RequestMethod.ALL },
    ],
  });
  // URI versioning: explicit, cacheable, and visible in every log line and CDN
  // rule. Header-based versioning hides the version from exactly the places that
  // need it most during an incident.
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------
  app.useGlobalPipes(
    new ValidationPipe({
      // Strip unknown properties instead of trusting them...
      whitelist: true,
      // ...and reject outright, so a client sending `isAdmin: true` gets a clear
      // 422 rather than silently having it dropped.
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      validationError: { target: false, value: false },
      stopAtFirstError: false,
    }),
  );

  // Runs `onModuleDestroy`/`onApplicationShutdown` on SIGTERM: the pool drains,
  // in-flight requests finish, and queue workers stop claiming new jobs.
  app.enableShutdownHooks();
}

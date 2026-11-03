import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';
import { RequestContext } from '../../core/context/request-context';
import { MetricsService } from '../observability/metrics.service';
import { softDeleteExtension } from './extensions/soft-delete.extension';
import { tenantScopeExtension } from './extensions/tenant-scope.extension';

/**
 * The tenant-scoped client every repository uses.
 *
 * Derived from the extension chain so the type stays accurate as extensions
 * change — writing it out by hand would drift the first time one is added.
 */
export type ExtendedPrismaClient = ReturnType<PrismaService['buildScopedClient']>;

/**
 * Owns the single `PrismaClient` — and therefore the single connection pool —
 * for the process.
 *
 * ## Connection pooling
 *
 * Prisma's pool is per-`PrismaClient`. Total connections against Postgres are
 * `DB_POOL_SIZE × replicas × (api + worker processes)`, and exceeding
 * `max_connections` fails the *healthy* requests too, so the pool is sized from
 * config rather than left at Prisma's `num_cpus × 2 + 1` default. Above roughly
 * 20 application processes, put PgBouncer in transaction mode in front and drop
 * this to a small number.
 *
 * ## Statement timeout
 *
 * Set at the connection level so a pathological query cannot hold a pool slot
 * indefinitely. A saturated pool is indistinguishable from a total outage.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private scopedClient?: ExtendedPrismaClient;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
    private readonly metrics: MetricsService,
  ) {
    super({
      datasources: { db: { url: buildConnectionUrl(config) } },
      // `event` routing keeps Prisma's output inside our structured logger rather
      // than letting it write unformatted lines straight to stdout.
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
      errorFormat: config.app.isProduction ? 'minimal' : 'pretty',
      transactionOptions: {
        maxWait: 5_000,
        timeout: 15_000,
        // Postgres' default. Serializable would be safer but retry-on-conflict
        // must then be handled everywhere; specific transactions raise it locally.
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      },
    });

    this.logger.setContext(PrismaService.name);
    // Register before Nest wraps this instance in a Proxy — `$on` is missing on
    // the proxy and would throw `client.$on is not a function` during onModuleInit.
    this.registerLogListeners();
  }

  onModuleInit(): void {
    // Do not block Nest boot on the first `$connect()`. Railway's proxy reports
    // "Failed to connect before the deadline" when nothing listens on PORT yet,
    // and a cold Postgres on the private network can take several seconds.
    void this.connectWithRetry();
  }

  /** Retries `$connect()` in the background until Postgres is reachable. */
  private async connectWithRetry(): Promise<void> {
    const delaysMs = [0, 2_000, 5_000, 10_000, 15_000];
    for (let attempt = 0; attempt < delaysMs.length; attempt++) {
      if (attempt > 0) {
        await sleep(delaysMs[attempt]!);
      }
      try {
        await this.$connect();
        this.logger.info(
          { poolSize: this.config.database.poolSize, attempt: attempt + 1 },
          'Database connection pool established',
        );
        return;
      } catch (error) {
        this.logger.warn(
          {
            err: error instanceof Error ? error.message : String(error),
            attempt: attempt + 1,
            maxAttempts: delaysMs.length,
          },
          'Database connect failed; retrying',
        );
      }
    }
    this.logger.error(
      'Database connect failed after retries — requests needing Postgres will fail until it recovers',
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.info('Database connection pool closed');
  }

  /** Lazily built so the extension chain is constructed once per process. */
  get scoped(): ExtendedPrismaClient {
    this.scopedClient ??= this.buildScopedClient();
    return this.scopedClient;
  }

  /** Cheap liveness probe for the health module. */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }

  /**
   * Order matters. Tenant scoping runs first so that the soft-delete filter is
   * applied to an already tenant-narrowed query — and so a missing tenant fails
   * before any other work happens.
   */
  private buildScopedClient() {
    return this.$extends(tenantScopeExtension).$extends(softDeleteExtension);
  }

  private registerLogListeners(): void {
    const { logQueries, slowQueryMs } = this.config.database;

    // `$on` lives on the concrete PrismaClient instance. Guard in case a future
    // Prisma major removes the event API.
    const client = this as unknown as {
      $on?: (
        event: 'query' | 'warn' | 'error',
        callback: (event: {
          query?: string;
          params?: string;
          duration?: number;
          message?: string;
        }) => void,
      ) => void;
    };

    if (typeof client.$on !== 'function') {
      this.logger.warn('Prisma $on unavailable; query event logging disabled');
      return;
    }

    client.$on('query', (event) => {
      this.metrics.dbQueryDuration.observe(
        { model: 'unknown', operation: 'query' },
        (event.duration ?? 0) / 1000,
      );

      if (logQueries) {
        this.logger.debug({ query: event.query, durationMs: event.duration }, 'Prisma query');
        return;
      }

      // Slow-query logging is the cheapest early warning for a missing index.
      // Params are omitted deliberately — they routinely contain customer PII.
      if (slowQueryMs > 0 && (event.duration ?? 0) >= slowQueryMs) {
        this.logger.warn(
          {
            query: truncate(event.query ?? '', 512),
            durationMs: event.duration,
            tenantId: RequestContext.tenantId,
          },
          'Slow database query',
        );
      }
    });

    client.$on('warn', (event) => this.logger.warn({ prisma: event.message }, 'Prisma warning'));
    client.$on('error', (event) => this.logger.error({ prisma: event.message }, 'Prisma error'));
  }
}

/**
 * Appends pool and timeout parameters to the connection URL.
 *
 * Prisma exposes these only as URL query parameters, so they are applied here
 * rather than being duplicated into every deployment's `DATABASE_URL`.
 */
function buildConnectionUrl(config: AppConfig): string {
  const url = new URL(config.database.url);
  const params = url.searchParams;

  params.set('connection_limit', String(config.database.poolSize));
  params.set('pool_timeout', String(config.database.poolTimeoutSeconds));

  if (config.database.statementTimeoutMs > 0) {
    params.set('statement_timeout', String(config.database.statementTimeoutMs));
  }
  // Bound how long a connection attempt may hang before failing fast.
  params.set('connect_timeout', '10');

  url.search = params.toString();
  return url.toString();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

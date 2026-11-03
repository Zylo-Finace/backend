import { randomUUID } from 'node:crypto';

import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type Redis from 'ioredis';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';
import { RequestContext } from '../../core/context/request-context';
import { MetricsService } from '../observability/metrics.service';
import { CacheKey, type CacheNamespace } from './cache-key';
import { InjectRedis } from './redis.provider';

export interface CacheSetOptions {
  /** Time to live in seconds. Omitting it creates a key that never expires — avoid. */
  ttlSeconds?: number;
  /** Only set if the key does not already exist. */
  onlyIfAbsent?: boolean;
}

/** Lua: release a lock only if we still own it, atomically. */
const RELEASE_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end`;

/**
 * Redis-backed cache with a fail-open policy.
 *
 * ## Fail-open is a deliberate choice
 *
 * Every read path here swallows Redis errors and behaves as a miss. A cache is an
 * optimisation: if Redis is down, the correct behaviour is a slower service, not
 * an outage. Writes fail silently for the same reason. Errors are still logged and
 * counted (`cache_operations_total{result="error"}`) so the degradation is visible
 * — silent, *unmonitored* failure is the anti-pattern, not silent failure itself.
 *
 * The one exception is {@link acquireLock}, which must report failure honestly:
 * a lock that "succeeds" when Redis is unreachable is worse than no lock at all.
 */
@Injectable()
export class CacheService implements OnModuleDestroy {
  readonly keys: CacheKey;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly logger: PinoLogger,
    private readonly metrics: MetricsService,
  ) {
    this.keys = new CacheKey(`${config.redis.keyPrefix}:${config.app.env}`);
    this.logger.setContext(CacheService.name);
  }

  async onModuleDestroy(): Promise<void> {
    // `quit()` drains in-flight commands; `disconnect()` would drop them.
    await this.redis.quit().catch(() => this.redis.disconnect());
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const raw = await this.redis.get(key);
      if (raw === null) {
        this.metrics.cacheOperationsTotal.inc({ operation: 'get', result: 'miss' });
        return undefined;
      }
      this.metrics.cacheOperationsTotal.inc({ operation: 'get', result: 'hit' });
      return JSON.parse(raw) as T;
    } catch (error) {
      this.onError('get', key, error);
      return undefined;
    }
  }

  async set<T>(key: string, value: T, options: CacheSetOptions = {}): Promise<boolean> {
    try {
      const payload = JSON.stringify(value);
      const result = options.ttlSeconds
        ? options.onlyIfAbsent
          ? await this.redis.set(key, payload, 'EX', options.ttlSeconds, 'NX')
          : await this.redis.set(key, payload, 'EX', options.ttlSeconds)
        : options.onlyIfAbsent
          ? await this.redis.set(key, payload, 'NX')
          : await this.redis.set(key, payload);

      this.metrics.cacheOperationsTotal.inc({ operation: 'set', result: 'ok' });
      return result === 'OK';
    } catch (error) {
      this.onError('set', key, error);
      return false;
    }
  }

  async delete(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    try {
      return await this.redis.del(...keys);
    } catch (error) {
      this.onError('del', keys[0] ?? '', error);
      return 0;
    }
  }

  /**
   * Read-through cache.
   *
   * Note this does **not** protect against a stampede: N concurrent misses run N
   * loaders. That is the right default — the loader is usually a single indexed
   * query, and locking every read costs more than the duplicated work. For
   * genuinely expensive loaders, wrap the call in {@link withLock}.
   */
  async remember<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) return cached;

    const value = await loader();
    // `undefined` is not representable in JSON and would be cached as `null`,
    // turning "no value" into a poisoned hit.
    if (value !== undefined && value !== null) {
      await this.set(key, value, { ttlSeconds });
    }
    return value;
  }

  async increment(key: string, ttlSeconds?: number): Promise<number> {
    try {
      // Pipelined so the counter and its expiry are one round trip.
      const pipeline = this.redis.multi().incr(key);
      if (ttlSeconds) pipeline.expire(key, ttlSeconds, 'NX');
      const results = await pipeline.exec();
      const value = results?.[0]?.[1];
      return typeof value === 'number' ? value : 0;
    } catch (error) {
      this.onError('incr', key, error);
      return 0;
    }
  }

  /**
   * Deletes every key under a tenant namespace using `SCAN`.
   *
   * Never `KEYS`: Redis is single-threaded, and `KEYS` on a large keyspace blocks
   * every other tenant's commands for the duration of the scan.
   */
  async invalidateTenantNamespace(tenantId: string, namespace: CacheNamespace): Promise<number> {
    const pattern = this.keys.tenantPattern(tenantId, namespace);
    let deleted = 0;
    let cursor = '0';

    try {
      do {
        const [next, batch] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
        cursor = next;
        if (batch.length > 0) {
          deleted += await this.redis.unlink(...batch);
        }
      } while (cursor !== '0');
    } catch (error) {
      this.onError('scan', pattern, error);
    }

    return deleted;
  }

  /**
   * Acquires a distributed lock.
   *
   * Single-node Redis lock (not Redlock): sufficient because our failure model is
   * "prevent duplicate work", not "guarantee mutual exclusion under a Redis
   * partition". Anything that must be exactly-once is additionally protected by a
   * unique constraint in Postgres — the lock is an optimisation over that, never
   * the sole guarantee.
   *
   * @returns a release function, or `undefined` if the lock is held elsewhere.
   */
  async acquireLock(key: string, ttlSeconds: number): Promise<(() => Promise<void>) | undefined> {
    // A random token ensures we can only release *our* lock: without it, a slow
    // holder whose lock has already expired would delete the next holder's lock.
    const token = randomUUID();
    const acquired = await this.redis.set(key, token, 'EX', ttlSeconds, 'NX');
    if (acquired !== 'OK') return undefined;

    return async () => {
      try {
        await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, key, token);
      } catch (error) {
        this.onError('unlock', key, error);
      }
    };
  }

  /** Runs `fn` under a lock, or returns `undefined` if the lock is unavailable. */
  async withLock<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T | undefined> {
    const release = await this.acquireLock(key, ttlSeconds);
    if (!release) return undefined;
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  async ping(): Promise<void> {
    await this.redis.ping();
  }

  private onError(operation: string, key: string, error: unknown): void {
    this.metrics.cacheOperationsTotal.inc({ operation, result: 'error' });
    this.logger.warn(
      { err: error, operation, key, tenantId: RequestContext.tenantId },
      'Cache operation failed; continuing without cache',
    );
  }
}

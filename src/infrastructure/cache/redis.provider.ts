import { Inject, type Provider } from '@nestjs/common';
import Redis, { type RedisOptions } from 'ioredis';

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';

/** General-purpose cache/pubsub client. */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
export const InjectRedis = () => Inject(REDIS_CLIENT);

/**
 * Connection options shared by every Redis client in the process.
 *
 * `keyPrefix` is intentionally *not* set here: BullMQ manages its own key layout
 * and a global prefix corrupts it. Prefixing is applied by {@link CacheKey} instead.
 */
export function buildRedisOptions(config: AppConfig): RedisOptions {
  return {
    // Exponential backoff capped at 3s. Returning a number keeps ioredis
    // reconnecting forever, which is what we want — a Redis restart should heal
    // itself, not require a deploy.
    retryStrategy: (attempt: number) => Math.min(attempt * 200, 3_000),

    // Railway private DNS is IPv6 (or dual-stack). ioredis defaults to IPv4-only
    // lookups, which hang until connectTimeout and fail readiness probes.
    family: 0,

    // Fail fast on a dead node instead of queueing commands indefinitely; a
    // request should get a 503 in milliseconds, not hang until the client timeout.
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true,
    connectTimeout: 5_000,
    // Connect on first command so Nest can bind PORT before Redis DNS is warm.
    lazyConnect: true,

    // Reconnect when a replica is promoted and starts serving reads only.
    reconnectOnError: (error: Error) => {
      const message = error.message.toUpperCase();
      return message.includes('READONLY') || message.includes('MASTERDOWN');
    },

    // Keeps idle connections alive through cloud load balancers that drop them.
    keepAlive: 30_000,
    ...(config.redis.tls ? { tls: {} } : {}),
  };
}

export const redisProvider: Provider = {
  provide: REDIS_CLIENT,
  useFactory: (config: AppConfig): Redis => {
    const client = new Redis(config.redis.url, buildRedisOptions(config));

    // Without a listener, a connection failure emits `error` and Node treats it as
    // an uncaught exception — process exits after Nest has already mapped routes.
    client.on('error', (error: Error) => {
      console.error('[redis] connection error:', error.message);
    });

    return client;
  },
  inject: [APP_CONFIG],
};

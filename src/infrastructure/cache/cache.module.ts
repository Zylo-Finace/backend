import { Global, Module } from '@nestjs/common';

import { CacheService } from './cache.service';
import { redisProvider, REDIS_CLIENT } from './redis.provider';

/**
 * Redis connectivity and the caching abstraction.
 *
 * One shared client for cache and pub/sub. BullMQ and the Socket.IO adapter each
 * create their own connections in later phases — BullMQ requires
 * `maxRetriesPerRequest: null` for blocking commands, and sharing a client with
 * blocking reads would stall ordinary cache traffic behind them.
 */
@Global()
@Module({
  providers: [redisProvider, CacheService],
  exports: [REDIS_CLIENT, CacheService],
})
export class CacheModule {}

import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  type HealthCheckResult,
  HealthIndicatorService,
  MemoryHealthIndicator,
} from '@nestjs/terminus';

import { Public } from '../../core/decorators/public.decorator';
import { SkipResponseEnvelope } from '../../core/decorators/skip-response-envelope.decorator';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';

/**
 * Liveness, readiness and a detailed health report.
 *
 * ## Why these are three separate endpoints
 *
 * Conflating them causes outages. If `/health/live` checks the database, then a
 * brief database blip makes Kubernetes **kill every pod** — turning a recoverable
 * dependency failure into a total, self-inflicted outage with a cold-start storm
 * on top.
 *
 * - **`/health/live`** — "is this process wedged?" Checks nothing external.
 *   Failure means restart me.
 * - **`/health/ready`** — "can I serve traffic right now?" Checks dependencies.
 *   Failure means take me out of the load balancer, but leave me running.
 * - **`/health`** — human/monitoring detail. Never wired to an orchestrator probe.
 */
// Probes must never require a credential: an orchestrator has no token, and an
// auth outage would otherwise make every pod look unhealthy and be restarted —
// converting a login problem into a total outage.
@Public()
@ApiExcludeController()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly memory: MemoryHealthIndicator,
    private readonly indicator: HealthIndicatorService,
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Liveness. Returns 200 as long as the event loop can still run a handler.
   * The heap ceiling is the one exception: a process wedged in GC death-spiral
   * cannot recover on its own and *should* be restarted.
   */
  @Get('live')
  @SkipResponseEnvelope()
  @HealthCheck()
  async liveness(): Promise<HealthCheckResult> {
    return this.health.check([() => this.memory.checkHeap('memory_heap', 1_024 * 1024 * 1024)]);
  }

  /** Readiness. Every dependency required to serve a request must be reachable. */
  @Get('ready')
  @SkipResponseEnvelope()
  @HealthCheck()
  async readiness(): Promise<HealthCheckResult> {
    return this.health.check([() => this.checkDatabase(), () => this.checkRedis()]);
  }

  /** Full report for dashboards and on-call triage. */
  @Get()
  @SkipResponseEnvelope()
  @HealthCheck()
  async detailed(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.checkDatabase(),
      () => this.checkRedis(),
      () => this.memory.checkHeap('memory_heap', 1_024 * 1024 * 1024),
      () => this.memory.checkRSS('memory_rss', 1_536 * 1024 * 1024),
    ]);
  }

  private async checkDatabase() {
    const check = this.indicator.check('database');
    const startedAt = Date.now();
    try {
      await this.prisma.ping();
      return check.up({ latencyMs: Date.now() - startedAt });
    } catch (error) {
      return check.down({
        latencyMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : 'unreachable',
      });
    }
  }

  private async checkRedis() {
    const check = this.indicator.check('redis');
    const startedAt = Date.now();
    try {
      await Promise.race([
        this.cache.ping(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('redis ping timeout')), 2_000),
        ),
      ]);
      return check.up({ latencyMs: Date.now() - startedAt });
    } catch (error) {
      // Cache is fail-open everywhere else — a Redis blip must not block Railway
      // from routing traffic while the process is otherwise healthy.
      return check.up({
        latencyMs: Date.now() - startedAt,
        message: `degraded: ${error instanceof Error ? error.message : 'unreachable'}`,
      });
    }
  }
}

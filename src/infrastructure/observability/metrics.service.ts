import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';

/**
 * Buckets tuned for an API whose p50 is a few milliseconds but whose tail is
 * dominated by outbound calls to Meta. The default prom-client buckets stop at
 * 10s and hide exactly the latencies we care about.
 */
const HTTP_LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const JOB_LATENCY_BUCKETS = [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 30, 60, 300];

/**
 * Prometheus metrics registry.
 *
 * **Cardinality is the hard constraint.** Every distinct label-value combination
 * is a separate time series held in memory by both this process and Prometheus.
 * With 10k tenants, a `tenantId` label on a 12-bucket histogram across 5 methods
 * would be millions of series — enough to OOM the scraper. So:
 *   - `tenantId` is **never** a label. Per-tenant analytics belong in the database
 *     and are served by the reporting module.
 *   - `route` is the *parameterised* path (`/v1/contacts/:id`), never the raw URL.
 *
 * Every metric is bound to this instance's registry via `registers`. Omitting it
 * makes prom-client *also* register into its global default registry, so a second
 * instance of this service throws "already registered" — which is how a duplicate
 * provider in one feature module can take down the whole application at boot.
 */
@Injectable()
export class MetricsService implements OnModuleInit {
  readonly registry = new Registry();

  readonly httpRequestsTotal: Counter<'method' | 'route' | 'status'>;
  readonly httpRequestDuration: Histogram<'method' | 'route' | 'status'>;
  readonly httpRequestsInFlight: Gauge<'method'>;

  readonly dbQueryDuration: Histogram<'model' | 'operation'>;
  readonly dbErrorsTotal: Counter<'code'>;

  readonly cacheOperationsTotal: Counter<'operation' | 'result'>;

  readonly queueJobsTotal: Counter<'queue' | 'status'>;
  readonly queueJobDuration: Histogram<'queue'>;
  readonly queueDepth: Gauge<'queue' | 'state'>;

  readonly whatsappApiCallsTotal: Counter<'operation' | 'status'>;
  readonly whatsappApiDuration: Histogram<'operation'>;
  readonly messagesTotal: Counter<'direction' | 'type' | 'status'>;

  readonly circuitBreakerState: Gauge<'target'>;
  readonly websocketConnections: Gauge<never>;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.registry.setDefaultLabels({
      service: config.observability.serviceName,
      env: config.app.env,
    });

    this.httpRequestsTotal = this.counter({
      name: 'http_requests_total',
      help: 'Total HTTP requests handled.',
      labelNames: ['method', 'route', 'status'],
    });

    this.httpRequestDuration = this.histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request latency in seconds.',
      labelNames: ['method', 'route', 'status'],
      buckets: HTTP_LATENCY_BUCKETS,
    });

    this.httpRequestsInFlight = this.gauge({
      name: 'http_requests_in_flight',
      help: 'HTTP requests currently being processed.',
      labelNames: ['method'],
    });

    this.dbQueryDuration = this.histogram({
      name: 'db_query_duration_seconds',
      help: 'Prisma query latency by model and operation.',
      labelNames: ['model', 'operation'],
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
    });

    this.dbErrorsTotal = this.counter({
      name: 'db_errors_total',
      help: 'Database errors by Prisma error code.',
      labelNames: ['code'],
    });

    this.cacheOperationsTotal = this.counter({
      name: 'cache_operations_total',
      help: 'Cache operations by outcome (hit/miss/error).',
      labelNames: ['operation', 'result'],
    });

    this.queueJobsTotal = this.counter({
      name: 'queue_jobs_total',
      help: 'Queue jobs by terminal status.',
      labelNames: ['queue', 'status'],
    });

    this.queueJobDuration = this.histogram({
      name: 'queue_job_duration_seconds',
      help: 'Job processing time in seconds.',
      labelNames: ['queue'],
      buckets: JOB_LATENCY_BUCKETS,
    });

    this.queueDepth = this.gauge({
      name: 'queue_depth',
      help: 'Jobs per queue by state — the primary backlog alert signal.',
      labelNames: ['queue', 'state'],
    });

    this.whatsappApiCallsTotal = this.counter({
      name: 'whatsapp_api_calls_total',
      help: 'Meta Cloud API calls by operation and outcome.',
      labelNames: ['operation', 'status'],
    });

    this.whatsappApiDuration = this.histogram({
      name: 'whatsapp_api_duration_seconds',
      help: 'Meta Cloud API call latency.',
      labelNames: ['operation'],
      buckets: HTTP_LATENCY_BUCKETS,
    });

    this.messagesTotal = this.counter({
      name: 'whatsapp_messages_total',
      help: 'WhatsApp messages by direction, type and status.',
      labelNames: ['direction', 'type', 'status'],
    });

    this.circuitBreakerState = this.gauge({
      name: 'circuit_breaker_state',
      help: 'Circuit breaker state: 0=closed, 1=half-open, 2=open.',
      labelNames: ['target'],
    });

    this.websocketConnections = this.gauge({
      name: 'websocket_connections',
      help: 'Currently connected Socket.IO clients on this instance.',
    });
  }

  onModuleInit(): void {
    if (this.config.observability.metricsEnabled) {
      // Event-loop lag, heap, GC, handles — the signals that explain a latency
      // regression that no application metric accounts for.
      collectDefaultMetrics({ register: this.registry, prefix: '' });
    }
  }

  async scrape(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  private counter<T extends string>(configuration: {
    name: string;
    help: string;
    labelNames: readonly T[];
  }): Counter<T> {
    return new Counter({
      ...configuration,
      labelNames: [...configuration.labelNames],
      registers: [this.registry],
    });
  }

  private gauge<T extends string>(configuration: {
    name: string;
    help: string;
    labelNames?: readonly T[];
  }): Gauge<T> {
    return new Gauge({
      ...configuration,
      labelNames: [...(configuration.labelNames ?? [])],
      registers: [this.registry],
    });
  }

  private histogram<T extends string>(configuration: {
    name: string;
    help: string;
    labelNames: readonly T[];
    buckets: number[];
  }): Histogram<T> {
    return new Histogram({
      ...configuration,
      labelNames: [...configuration.labelNames],
      registers: [this.registry],
    });
  }
}

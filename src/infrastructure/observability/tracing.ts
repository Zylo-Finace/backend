import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | undefined;

/**
 * Starts OpenTelemetry **before anything else is imported**.
 *
 * Auto-instrumentation works by monkey-patching module exports as they are
 * required. If Express, `pg`, `ioredis` or `http` are loaded first, their exports
 * are already captured by other modules and the patches silently miss — you get a
 * running SDK and empty traces. Hence `main.ts` calls this on line one, before the
 * NestFactory import chain pulls those in.
 *
 * Reads raw `process.env` for the same reason: the validated config object lives
 * behind imports we must not trigger yet.
 */
export function startTracing(): void {
  if (process.env.TRACING_ENABLED !== 'true') return;
  if (sdk) return;

  const serviceName = process.env.OTEL_SERVICE_NAME ?? 'wabot-api';

  sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '0.0.0',
      'deployment.environment.name': process.env.NODE_ENV ?? 'development',
    }),
    traceExporter: new OTLPTraceExporter({
      url: `${(process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318').replace(/\/$/, '')}/v1/traces`,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Emits a span per file read — enormous volume, no diagnostic value.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        // We export traces over HTTP OTLP only. gRPC instrumentation can emit
        // "Failed to connect before the deadline" when OTEL_* vars point at a
        // dead collector on Railway.
        '@opentelemetry/instrumentation-grpc': { enabled: false },
        '@opentelemetry/instrumentation-http': {
          // Health and metrics probes would otherwise dominate the trace budget.
          ignoreIncomingRequestHook: (request) => {
            const path = (request.url ?? '').split('?')[0] ?? '';
            return path.startsWith('/health') || path === '/metrics';
          },
        },
      }),
    ],
  });

  sdk.start();

  process.once('SIGTERM', () => {
    void shutdownTracing();
  });
}

/** Flushes buffered spans. Called during graceful shutdown so the last traces survive. */
export async function shutdownTracing(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch (error) {
    console.error('OpenTelemetry shutdown failed', error);
  } finally {
    sdk = undefined;
  }
}

/**
 * Process entry point.
 *
 * The tracing import MUST stay first: OpenTelemetry patches modules as they are
 * required, so anything loaded before `startTracing()` runs is instrumented as a
 * no-op. See `infrastructure/observability/tracing.ts`.
 */
import { startTracing, shutdownTracing } from './infrastructure/observability/tracing';

startTracing();

import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { APP_CONFIG } from './config/config.module';
import type { AppConfig } from './config/app.config';
import { configureApp } from './bootstrap/configure-app';
import { setupSwagger } from './bootstrap/swagger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Nest's own logger writes unstructured lines; buffering defers startup logs
    // until Pino is available so that *every* line is structured JSON.
    bufferLogs: true,
    // The exception filter handles all error responses; Nest's default handler
    // would otherwise respond first for a few edge cases.
    abortOnError: false,
    // Retains the unparsed request body as `req.rawBody`.
    //
    // Mandatory for webhook signature verification: providers sign the exact
    // bytes they sent, and `JSON.parse` → `JSON.stringify` reorders keys and
    // normalises whitespace, producing a different HMAC. Without this, every
    // legitimate Paystack webhook would be rejected as a forgery.
    rawBody: true,
  });

  const config = app.get<AppConfig>(APP_CONFIG);
  const logger = app.get(Logger);
  app.useLogger(logger);
  app.flushLogs();

  configureApp(app, config);

  if (!config.app.isProduction) {
    setupSwagger(app, config);
  }

  const server = await app.listen(config.app.port, '0.0.0.0');
  // Slightly above a typical ALB idle timeout (60s) to avoid the race where the
  // balancer reuses a connection the server is simultaneously closing.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  logger.log(
    `${config.app.name} listening on port ${config.app.port} [env=${config.app.env}]`,
    'Bootstrap',
  );

  registerFatalHandlers(app, logger);
}

/**
 * Last-resort handlers.
 *
 * An unhandled rejection leaves the process in an unknown state; Node's default
 * for these is already to terminate, so we log first with full context and let
 * the orchestrator restart a clean process rather than serve from a corrupt one.
 */
function registerFatalHandlers(
  app: { close: () => Promise<void> },
  logger: { error: (message: unknown, ...optional: unknown[]) => void },
): void {
  const fatal = (reason: string) => (error: unknown) => {
    logger.error({ err: error, reason }, 'Fatal error — shutting down');
    void (async () => {
      try {
        await Promise.race([
          Promise.all([app.close(), shutdownTracing()]),
          new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]);
      } finally {
        process.exit(1);
      }
    })();
  };

  process.on('uncaughtException', fatal('uncaughtException'));
  process.on('unhandledRejection', fatal('unhandledRejection'));
}

void bootstrap().catch((error: unknown) => {
  // bufferLogs:true can swallow Nest startup errors if DI fails before Pino mounts.
  // Always dump to stderr so orchestrators (Railway) capture the real reason.
  console.error('Bootstrap failed:', error);
  process.exit(1);
});

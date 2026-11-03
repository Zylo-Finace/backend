import { randomUUID } from 'node:crypto';

import { Module } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';
import { LogFormat } from '../../config/env.validation';
import { HttpHeader } from '../../core/constants/http-header.constants';
import { RequestContext } from '../../core/context/request-context';

/**
 * Fields scrubbed from every log line, everywhere.
 *
 * This list is a security control, not a nicety: WhatsApp access tokens, refresh
 * tokens and API keys all transit this service, and a log aggregator is a far
 * softer target than the database. Redaction is applied by pino at serialisation
 * time, so a secret cannot leak through an accidental `logger.info(req.headers)`.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-hub-signature-256"]',
  'req.headers["x-paystack-signature"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.currentPassword',
  '*.newPassword',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.apiKey',
  '*.apiSecret',
  '*.secret',
  '*.clientSecret',
  '*.appSecret',
  '*.verifyToken',
  '*.encryptionKey',
  '*.otp',
  '*.twoFactorSecret',
  '*.pin',
  '*.pinHash',
  '*.currentPin',
  '*.newPin',
  '*.secretKey',
  '*.authorization',
  '*.creditCard',
  'body.password',
  'body.token',
];

/** Endpoints polled constantly by infrastructure; logging them is pure noise. */
const UNLOGGED_ROUTES = new Set(['/health', '/health/live', '/health/ready', '/metrics']);

/**
 * Structured logging for the whole platform.
 *
 * Pino writes NDJSON on a worker-thread-free fast path — roughly an order of
 * magnitude cheaper per line than Winston — which matters when every inbound
 * WhatsApp message produces log records.
 */
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.observability.logLevel,

          // Pretty-print only on a developer's TTY; production always emits NDJSON
          // for the log shipper to parse.
          transport:
            config.observability.logFormat === LogFormat.Pretty
              ? {
                  target: 'pino-pretty',
                  options: {
                    colorize: true,
                    singleLine: false,
                    translateTime: 'SYS:HH:MM:ss.l',
                    ignore: 'pid,hostname,req.headers,res.headers',
                  },
                }
              : undefined,

          redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },

          // Runs before our RequestContextMiddleware, so this is the authoritative
          // id; the middleware adopts `req.id` to keep logs, the response header
          // and the trace in agreement.
          genReqId: (req: IncomingMessage, res: ServerResponse): string => {
            const header = req.headers[HttpHeader.RequestId];
            const inbound = Array.isArray(header) ? header[0] : header;
            const id = inbound && /^[A-Za-z0-9._~-]{8,128}$/.test(inbound) ? inbound : randomUUID();
            res.setHeader(HttpHeader.RequestId, id);
            return id;
          },

          // Enrich the per-request completion log with tenancy and identity.
          customProps: () => {
            const context = RequestContext.get();
            if (!context) return {};
            return {
              tenantId: context.tenantId,
              userId: context.userId,
              actorType: context.actorType,
              correlationId: context.correlationId,
              ...context.logFields,
            };
          },

          customLogLevel: (_req, res, error) => {
            if (error || res.statusCode >= 500) return 'error';
            if (res.statusCode >= 400) return 'warn';
            return 'info';
          },

          autoLogging: {
            ignore: (req: IncomingMessage) => {
              const path = (req.url ?? '').split('?')[0] ?? '';
              return UNLOGGED_ROUTES.has(path);
            },
          },

          // Default serialisers dump every header on every line. These keep the
          // record small enough to be affordable at millions of requests/day.
          serializers: {
            req: (req: { method: string; url: string; id: string }) => ({
              id: req.id,
              method: req.method,
              url: req.url,
            }),
            res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
          },

          formatters: {
            level: (label: string) => ({ level: label }),
          },

          base: {
            service: config.observability.serviceName,
            env: config.app.env,
          },
        },
      }),
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}

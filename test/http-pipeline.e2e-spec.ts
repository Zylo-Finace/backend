import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { APP_CONFIG } from '../src/config/config.module';
import type { AppConfig } from '../src/config/app.config';
import { ErrorCode } from '../src/core/errors/error-code.enum';
import { REDIS_CLIENT } from '../src/infrastructure/cache/redis.provider';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import { ProbeController } from './probe.controller';

/** Minimal view of the response envelope, so assertions stay type-checked. */
interface Envelope<T = unknown> {
  success: boolean;
  data: T;
  meta?: Record<string, unknown>;
  error?: {
    code: ErrorCode;
    message: string;
    details?: { violations?: string[]; [key: string]: unknown };
    retryable: boolean;
  };
  requestId: string;
  timestamp: string;
}

interface HealthBody {
  status: string;
  info?: Record<string, unknown>;
}

/**
 * End-to-end coverage of the cross-cutting HTTP pipeline: request context,
 * validation, the response envelope, the exception filter and security headers.
 *
 * Postgres and Redis are stubbed at the module boundary rather than run for real.
 * This suite is about the *HTTP contract*, and keeping it infrastructure-free
 * means it runs on every commit in a few seconds. Repository and query behaviour
 * are covered separately by integration tests that do use a live database.
 */
describe('HTTP pipeline (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const prismaStub = {
      $connect: jest.fn().mockResolvedValue(undefined),
      $disconnect: jest.fn().mockResolvedValue(undefined),
      ping: jest.fn().mockResolvedValue(undefined),
      scoped: {},
      // Tenant resolution runs as middleware on every request and reads the
      // unscoped client directly.
      tenant: { findFirst: jest.fn().mockResolvedValue(null) },
      onModuleInit: jest.fn().mockResolvedValue(undefined),
      onModuleDestroy: jest.fn().mockResolvedValue(undefined),
    };

    const redisStub = {
      ping: jest.fn().mockResolvedValue('PONG'),
      quit: jest.fn().mockResolvedValue('OK'),
      disconnect: jest.fn(),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ProbeController],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .overrideProvider(REDIS_CLIENT)
      .useValue(redisStub)
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(app, app.get<AppConfig>(APP_CONFIG));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  const api = () => request(app.getHttpServer());

  describe('response envelope', () => {
    it('wraps a successful response', async () => {
      const response = await api().get('/api/v1/probe').expect(200);

      expect(response.body).toMatchObject({
        success: true,
        data: { message: 'ok' },
      });
      const body = response.body as Envelope<{ message: string }>;
      expect(body.requestId).toEqual(expect.any(String));
      expect(Date.parse(body.timestamp)).not.toBeNaN();
    });

    it('lifts `meta` out of the handler result and alongside `data`', async () => {
      const response = await api().get('/api/v1/probe/with-meta').expect(200);

      const body = response.body as Envelope<number[]>;
      expect(body.data).toEqual([1, 2, 3]);
      expect(body.meta).toEqual({ total: 3, hasNextPage: false });
    });

    it('normalises an undefined/null handler result to `data: null`', async () => {
      const response = await api().get('/api/v1/probe/null').expect(200);

      const body = response.body as Envelope;
      expect(body.success).toBe(true);
      expect(body.data).toBeNull();
    });

    it('honours @SkipResponseEnvelope for third-party-dictated responses', async () => {
      const response = await api().get('/api/v1/probe/raw').expect(200);

      // Meta's webhook verification echoes a bare challenge string; an envelope
      // here would fail their verification handshake.
      expect(response.text).toBe('plain-text-challenge');
      expect((response.body as Partial<Envelope>).success).toBeUndefined();
    });
  });

  describe('request correlation', () => {
    it('mints a request id and returns it as a header', async () => {
      const response = await api().get('/api/v1/probe').expect(200);

      const body = response.body as Envelope;
      expect(response.headers['x-request-id']).toEqual(expect.any(String));
      expect(body.requestId).toBe(response.headers['x-request-id']);
    });

    it('adopts a well-formed inbound request id', async () => {
      const response = await api()
        .get('/api/v1/probe/context')
        .set('x-request-id', 'inbound-request-id-1234')
        .expect(200);

      const body = response.body as Envelope<{ requestId: string }>;
      expect(body.data.requestId).toBe('inbound-request-id-1234');
    });

    it('rejects a malformed inbound id rather than echoing it back', async () => {
      // Echoing unvalidated client input into a header is a response-splitting
      // and log-injection vector.
      const response = await api()
        .get('/api/v1/probe/context')
        .set('x-request-id', 'bad id with spaces!')
        .expect(200);

      const body = response.body as Envelope<{ requestId: string }>;
      expect(body.data.requestId).not.toBe('bad id with spaces!');
    });

    it('preserves an inbound correlation id independently of the request id', async () => {
      const response = await api()
        .get('/api/v1/probe/context')
        .set('x-correlation-id', 'chain-abcdefgh')
        .expect(200);

      const body = response.body as Envelope<{ requestId: string; correlationId: string }>;
      expect(body.data.correlationId).toBe('chain-abcdefgh');
      expect(body.data.requestId).not.toBe('chain-abcdefgh');
    });
  });

  describe('validation', () => {
    it('rejects an invalid body with 422 and field-level detail', async () => {
      const response = await api()
        .post('/api/v1/probe')
        .send({ email: 'not-an-email' })
        .expect(422);

      const body = response.body as Envelope;
      expect(body.success).toBe(false);
      expect(body.error?.code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(body.error?.details?.violations?.join(' ')).toContain('email');
    });

    it('rejects unknown properties instead of silently dropping them', async () => {
      // Silently stripping `isAdmin` would leave a client believing it was applied.
      const response = await api()
        .post('/api/v1/probe')
        .send({ email: 'a@example.com', isAdmin: true })
        .expect(422);

      const body = response.body as Envelope;
      expect(body.error?.details?.violations?.join(' ')).toContain('isAdmin');
    });

    it('accepts a valid body and transforms declared types', async () => {
      const response = await api()
        .post('/api/v1/probe')
        .send({ email: 'a@example.com', age: '30' })
        .expect(201);

      const body = response.body as Envelope<{ email: string; age: number }>;
      expect(body.data).toEqual({ email: 'a@example.com', age: 30 });
    });

    it('returns a structured error for malformed JSON', async () => {
      const response = await api()
        .post('/api/v1/probe')
        .set('Content-Type', 'application/json')
        .send('{"email":')
        .expect(400);

      const body = response.body as Envelope;
      expect(body.success).toBe(false);
      expect(body.requestId).toEqual(expect.any(String));
    });
  });

  describe('error handling', () => {
    it('maps an AppException to its canonical status and code', async () => {
      const response = await api().get('/api/v1/probe/app-error').expect(404);

      expect(response.body).toMatchObject({
        success: false,
        error: {
          code: ErrorCode.RESOURCE_NOT_FOUND,
          message: 'Contact not found',
          details: { resource: 'contact', id: 'c-1' },
          retryable: false,
        },
      });
    });

    it('sets Retry-After when the error carries a retry hint', async () => {
      const response = await api().get('/api/v1/probe/rate-limited').expect(429);

      expect(response.headers['retry-after']).toBe('30');
      expect((response.body as Envelope).error?.retryable).toBe(true);
    });

    it('converts an unexpected throw into a structured 500', async () => {
      const response = await api().get('/api/v1/probe/boom').expect(500);

      const body = response.body as Envelope;
      expect(body.success).toBe(false);
      expect(body.error?.code).toBe(ErrorCode.INTERNAL_ERROR);
      expect(body.requestId).toEqual(expect.any(String));
    });

    it('never leaks a stack trace to the client', async () => {
      const response = await api().get('/api/v1/probe/boom').expect(500);

      expect(JSON.stringify(response.body)).not.toContain('at ');
      expect((response.body as Envelope).error).not.toHaveProperty('stack');
    });

    it('returns a structured 404 for an unknown route', async () => {
      const response = await api().get('/api/v1/does-not-exist').expect(404);

      const body = response.body as Envelope;
      expect(body.success).toBe(false);
      expect(body.error?.code).toBe(ErrorCode.ROUTE_NOT_FOUND);
    });

    it('enforces the per-handler request timeout', async () => {
      const response = await api().get('/api/v1/probe/slow').expect(408);

      const body = response.body as Envelope;
      expect(body.error?.code).toBe(ErrorCode.REQUEST_TIMEOUT);
      expect(body.error?.retryable).toBe(true);
    });
  });

  describe('versioning and routing', () => {
    it('serves the API under the versioned prefix', async () => {
      await api().get('/api/v1/probe').expect(200);
    });

    it('does not serve API routes off the unversioned prefix', async () => {
      await api().get('/api/probe').expect(404);
    });

    it('keeps operational endpoints outside the API prefix', async () => {
      await api().get('/health/live').expect(200);
      await api().get('/api/v1/health/live').expect(404);
    });
  });

  describe('health probes', () => {
    it('reports liveness without touching external dependencies', async () => {
      const response = await api().get('/health/live').expect(200);
      expect((response.body as HealthBody).status).toBe('ok');
    });

    it('reports readiness including dependency latency', async () => {
      const response = await api().get('/health/ready').expect(200);

      const body = response.body as HealthBody;
      expect(body.status).toBe('ok');
      expect(body.info).toHaveProperty('database');
      expect(body.info).toHaveProperty('redis');
    });

    it('fails readiness when a dependency is unreachable, but stays live', async () => {
      const prisma = app.get(PrismaService);
      jest.spyOn(prisma, 'ping').mockRejectedValueOnce(new Error('ECONNREFUSED'));

      // The critical property: a database outage must not make Kubernetes kill
      // every pod — it should only pull them out of the load balancer.
      await api().get('/health/ready').expect(503);
      await api().get('/health/live').expect(200);
    });
  });

  describe('security headers', () => {
    it('sets the standard hardening headers', async () => {
      const response = await api().get('/api/v1/probe').expect(200);

      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-security-policy']).toContain("default-src 'self'");
      expect(response.headers['referrer-policy']).toBe('no-referrer');
    });

    it('does not advertise the framework', async () => {
      const response = await api().get('/api/v1/probe').expect(200);
      expect(response.headers['x-powered-by']).toBeUndefined();
    });

    it('rejects an origin outside the allowlist', async () => {
      const response = await api()
        .get('/api/v1/probe')
        .set('Origin', 'https://evil.example.com')
        .expect(200);

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('allows a configured origin', async () => {
      const response = await api()
        .get('/api/v1/probe')
        .set('Origin', 'http://localhost:3000')
        .expect(200);

      expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    });
  });
});

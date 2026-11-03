import { Controller, Get } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import { UserStatus, UserType } from '@prisma/client';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { APP_CONFIG } from '../src/config/config.module';
import type { AppConfig } from '../src/config/app.config';
import { ErrorCode } from '../src/core/errors/error-code.enum';
import { REDIS_CLIENT } from '../src/infrastructure/cache/redis.provider';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import { CurrentUser } from '../src/modules/auth/decorators/current-user.decorator';
import { RequireUserType } from '../src/modules/auth/decorators/user-type.decorator';
import { TokenService } from '../src/modules/auth/token.service';

const TENANT_ID = '0195f2a0-0000-7000-8000-000000000001';
const OTHER_TENANT_ID = '0195f2a0-0000-7000-8000-0000000000ff';
const USER_ID = '0195f2a0-0000-7000-8000-000000000002';
const SESSION_ID = '0195f2a0-0000-7000-8000-000000000003';

/** Routes used to assert guard behaviour without depending on business endpoints. */
@Controller({ path: 'guarded', version: '1' })
class GuardedController {
  @Get('any')
  any(@CurrentUser('userId') userId: string) {
    return { userId };
  }

  @Get('admin-only')
  @RequireUserType(UserType.ADMIN)
  adminOnly() {
    return { ok: true };
  }

  @Get('customer-only')
  @RequireUserType(UserType.CUSTOMER)
  customerOnly() {
    return { ok: true };
  }
}

interface ErrorEnvelope {
  success: boolean;
  error?: { code: ErrorCode; message: string };
  data?: unknown;
}

/**
 * End-to-end coverage of the authentication guard and tenant resolution.
 *
 * The database is stubbed so the suite stays fast and hermetic; what is under
 * test is the *decision logic* — which requests are admitted, which are refused,
 * and with which stable error code. Credential storage and session persistence
 * are covered by the unit suites and by integration tests against a real database.
 */
describe('Authentication (e2e)', () => {
  let app: NestExpressApplication;
  let tokens: TokenService;

  const sessionRow = {
    id: SESSION_ID,
    revokedAt: null as Date | null,
    expiresAt: new Date(Date.now() + 86_400_000),
    user: {
      id: USER_ID,
      tenantId: TENANT_ID,
      type: UserType.CUSTOMER,
      status: UserStatus.ACTIVE,
      deletedAt: null as Date | null,
    },
  };

  const sessionFindFirst = jest.fn();

  beforeAll(async () => {
    const scoped = {
      session: { findFirst: sessionFindFirst },
      user: { findFirst: jest.fn() },
    };

    const prismaStub = {
      $connect: jest.fn().mockResolvedValue(undefined),
      $disconnect: jest.fn().mockResolvedValue(undefined),
      ping: jest.fn().mockResolvedValue(undefined),
      scoped,
      tenant: {
        findFirst: jest.fn().mockResolvedValue({
          id: TENANT_ID,
          slug: 'acme',
          status: 'ACTIVE',
          deletedAt: null,
        }),
      },
      onModuleInit: jest.fn().mockResolvedValue(undefined),
      onModuleDestroy: jest.fn().mockResolvedValue(undefined),
    };

    // No-op Redis: every cache read misses, so the guard always consults the
    // stubbed database and each test starts from a known state.
    const redisStub = {
      ping: jest.fn().mockResolvedValue('PONG'),
      quit: jest.fn().mockResolvedValue('OK'),
      disconnect: jest.fn(),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(0),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [GuardedController],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .overrideProvider(REDIS_CLIENT)
      .useValue(redisStub)
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(app, app.get<AppConfig>(APP_CONFIG));
    await app.init();

    tokens = app.get(TokenService);
  });

  beforeEach(() => {
    sessionFindFirst.mockReset();
    sessionFindFirst.mockResolvedValue(sessionRow);
  });

  afterAll(async () => {
    await app?.close();
  });

  const api = () => request(app.getHttpServer());

  const issueAccessToken = async (
    overrides: Partial<{ userId: string; tenantId: string; userType: UserType }> = {},
  ) => {
    const pair = await tokens.issuePair({
      userId: overrides.userId ?? USER_ID,
      tenantId: overrides.tenantId ?? TENANT_ID,
      userType: overrides.userType ?? UserType.CUSTOMER,
      sessionId: SESSION_ID,
      familyId: 'family-1',
    });
    return pair;
  };

  describe('protection is the default', () => {
    it('refuses a request with no token', async () => {
      const response = await api().get('/api/v1/guarded/any').expect(401);
      expect((response.body as ErrorEnvelope).error?.code).toBe(ErrorCode.UNAUTHENTICATED);
    });

    it('admits a request bearing a valid token', async () => {
      const { accessToken } = await issueAccessToken();

      const response = await api()
        .get('/api/v1/guarded/any')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect((response.body as { data: { userId: string } }).data.userId).toBe(USER_ID);
    });

    it('accepts a lowercase scheme', async () => {
      const { accessToken } = await issueAccessToken();
      await api()
        .get('/api/v1/guarded/any')
        .set('Authorization', `bearer ${accessToken}`)
        .expect(200);
    });

    it.each([
      ['garbage', 'Bearer not-a-jwt'],
      ['missing scheme', 'abc.def.ghi'],
      ['wrong scheme', 'Basic dXNlcjpwYXNz'],
      ['empty', ''],
    ])('rejects a malformed Authorization header (%s)', async (_label, header) => {
      await api().get('/api/v1/guarded/any').set('Authorization', header).expect(401);
    });

    it('rejects a token signed with the wrong secret', async () => {
      // A refresh token is signed with a *different* secret, so it must not be
      // usable as an access token — otherwise a 30-day credential is accepted
      // where a 15-minute one was intended.
      const { refreshToken } = await issueAccessToken();

      const response = await api()
        .get('/api/v1/guarded/any')
        .set('Authorization', `Bearer ${refreshToken}`)
        .expect(401);

      expect((response.body as ErrorEnvelope).error?.code).toBe(ErrorCode.TOKEN_INVALID);
    });
  });

  describe('session revocation', () => {
    it('rejects a token whose session was revoked', async () => {
      sessionFindFirst.mockResolvedValue({ ...sessionRow, revokedAt: new Date() });
      const { accessToken } = await issueAccessToken();

      const response = await api()
        .get('/api/v1/guarded/any')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(401);

      // A signed, unexpired JWT is not sufficient — logout has to take effect.
      expect((response.body as ErrorEnvelope).error?.code).toBe(ErrorCode.TOKEN_REVOKED);
    });

    it('rejects a token whose session has expired', async () => {
      sessionFindFirst.mockResolvedValue({ ...sessionRow, expiresAt: new Date(Date.now() - 1000) });
      const { accessToken } = await issueAccessToken();

      await api()
        .get('/api/v1/guarded/any')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(401);
    });

    it('rejects a token for a deleted user', async () => {
      sessionFindFirst.mockResolvedValue({
        ...sessionRow,
        user: { ...sessionRow.user, deletedAt: new Date() },
      });
      const { accessToken } = await issueAccessToken();

      await api()
        .get('/api/v1/guarded/any')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(401);
    });

    it('rejects a suspended account', async () => {
      sessionFindFirst.mockResolvedValue({
        ...sessionRow,
        user: { ...sessionRow.user, status: UserStatus.SUSPENDED },
      });
      const { accessToken } = await issueAccessToken();

      const response = await api()
        .get('/api/v1/guarded/any')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(403);

      expect((response.body as ErrorEnvelope).error?.code).toBe(ErrorCode.ACCOUNT_SUSPENDED);
    });
  });

  describe('principal type separation', () => {
    it('keeps a customer out of an admin route', async () => {
      const { accessToken } = await issueAccessToken({ userType: UserType.CUSTOMER });

      const response = await api()
        .get('/api/v1/guarded/admin-only')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(403);

      expect((response.body as ErrorEnvelope).error?.code).toBe(ErrorCode.FORBIDDEN);
    });

    it('lets a customer reach a customer route', async () => {
      const { accessToken } = await issueAccessToken({ userType: UserType.CUSTOMER });

      await api()
        .get('/api/v1/guarded/customer-only')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
    });

    it('reads the type from the session, not the token claim', async () => {
      // A token claiming ADMIN must not grant admin access when the stored user
      // is a customer — otherwise a forged or stale claim escalates privilege.
      const { accessToken } = await issueAccessToken({ userType: UserType.ADMIN });

      await api()
        .get('/api/v1/guarded/admin-only')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(403);
    });
  });

  describe('tenant isolation', () => {
    it('rejects a token issued for a different tenant than the one resolved', async () => {
      const { accessToken } = await issueAccessToken({ tenantId: OTHER_TENANT_ID });

      const response = await api()
        .get('/api/v1/guarded/any')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('x-tenant-id', TENANT_ID)
        .expect(403);

      expect((response.body as ErrorEnvelope).error?.code).toBe(ErrorCode.TENANT_MISMATCH);
    });

    it('admits a token whose tenant matches the resolved one', async () => {
      const { accessToken } = await issueAccessToken({ tenantId: TENANT_ID });

      await api()
        .get('/api/v1/guarded/any')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('x-tenant-id', TENANT_ID)
        .expect(200);
    });
  });

  describe('public routes', () => {
    it.each(['/health/live', '/health/ready', '/metrics'])(
      'serves %s without a token',
      async (path) => {
        // An orchestrator holds no credential; requiring one would turn an auth
        // outage into every pod being restarted.
        await api().get(path).expect(200);
      },
    );

    it('serves the login endpoint without a token', async () => {
      // Reaches validation rather than the guard — proof the route is public.
      const response = await api().post('/api/v1/auth/customer/login').send({}).expect(422);
      expect((response.body as ErrorEnvelope).error?.code).toBe(ErrorCode.VALIDATION_FAILED);
    });
  });

  describe('registration validation', () => {
    it.each([
      [
        'weak PIN',
        { phone: '08012345678', fullName: 'Ada Test', username: 'adatest', pin: '1234' },
      ],
      ['invalid phone', { phone: 'abc', fullName: 'Ada Test', username: 'adatest', pin: '7392' }],
      [
        'short username',
        { phone: '08012345678', fullName: 'Ada Test', username: 'ad', pin: '7392' },
      ],
      [
        'username starting with a digit',
        { phone: '08012345678', fullName: 'Ada Test', username: '1ada', pin: '7392' },
      ],
      [
        '3-digit PIN',
        { phone: '08012345678', fullName: 'Ada Test', username: 'adatest', pin: '123' },
      ],
      [
        '6-digit PIN (new PINs are exactly 4 digits)',
        { phone: '08012345678', fullName: 'Ada Test', username: 'adatest', pin: '739205' },
      ],
    ])('rejects registration with %s', async (_label, body) => {
      // The tenant header is required: registration resolves the customer within
      // a workspace, so `requireTenantId()` runs before any field check and would
      // otherwise mask these assertions with a TENANT_NOT_RESOLVED error.
      const response = await api()
        .post('/api/v1/auth/customer/register')
        .set('x-tenant-id', TENANT_ID)
        .send(body)
        .expect(422);

      expect((response.body as ErrorEnvelope).error?.code).toBe(ErrorCode.VALIDATION_FAILED);
    });

    it('refuses registration when no tenant can be resolved', async () => {
      // Failing closed matters: a customer created without a tenant would be a
      // row nobody owns, with a wallet nobody can reach.
      const response = await api()
        .post('/api/v1/auth/customer/register')
        .send({ phone: '08012345678', fullName: 'Ada Test', username: 'adatest', pin: '7392' })
        .expect(400);

      expect((response.body as ErrorEnvelope).error?.code).toBe(ErrorCode.TENANT_NOT_RESOLVED);
    });

    it('rejects unknown fields such as a self-assigned balance', async () => {
      // `forbidNonWhitelisted` is what stops a client smuggling privileged fields
      // into a create — critically important on a wallet product.
      await api()
        .post('/api/v1/auth/customer/register')
        .set('x-tenant-id', TENANT_ID)
        .send({
          phone: '08012345678',
          fullName: 'Ada Test',
          username: 'adatest',
          pin: '7392',
          balance: 1_000_000,
          type: 'ADMIN',
        })
        .expect(422);
    });
  });
});

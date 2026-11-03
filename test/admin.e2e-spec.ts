import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import { UserStatus, UserType } from '@prisma/client';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { APP_CONFIG } from '../src/config/config.module';
import type { AppConfig } from '../src/config/app.config';
import { Permission } from '../src/core/authorization/permission.enum';
import { ErrorCode } from '../src/core/errors/error-code.enum';
import { REDIS_CLIENT } from '../src/infrastructure/cache/redis.provider';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import { TokenService } from '../src/modules/auth/token.service';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const ADMIN_ID = '00000000-0000-4000-8000-000000000002';
const OTHER_ID = '00000000-0000-4000-8000-000000000003';
const SESSION_ID = '00000000-0000-4000-8000-000000000004';
const ROLE_ID = '00000000-0000-4000-8000-000000000005';

interface Envelope<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: ErrorCode; message: string; details?: Record<string, unknown> };
}

const membershipRow = (permissions: string[], overrides: Record<string, unknown> = {}) => ({
  id: 'membership-1',
  roleId: ROLE_ID,
  isOwner: false,
  joinedAt: new Date('2026-01-01'),
  extraPermissions: [],
  deniedPermissions: [],
  role: { id: ROLE_ID, key: 'custom', name: 'Custom', permissions, deletedAt: null },
  user: {
    id: ADMIN_ID,
    email: 'ada@example.com',
    fullName: 'Ada',
    avatarUrl: null,
    status: UserStatus.ACTIVE,
    lastLoginAt: null,
    teamMembers: [],
  },
  ...overrides,
});

/**
 * End-to-end coverage of the admin panel's access chain.
 *
 * The value here is the *composition*: `JwtAuthGuard` → `RequireUserType` →
 * `PermissionsGuard`, in that order, against real routes. Each is unit-tested in
 * isolation, but the ordering between them is expressed only in `AppModule`'s
 * provider list, and getting it wrong fails open rather than loudly.
 */
describe('Admin panel (e2e)', () => {
  let app: NestExpressApplication;
  let tokens: TokenService;

  const membershipFindFirst = jest.fn();
  const sessionFindFirst = jest.fn();

  beforeAll(async () => {
    const scoped = {
      session: { findFirst: sessionFindFirst },
      membership: {
        findFirst: membershipFindFirst,
        findMany: jest.fn().mockResolvedValue([membershipRow([])]),
        count: jest.fn().mockResolvedValue(1),
      },
      role: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      team: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findFirst: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0) },
      // The dashboard fans out across every pillar in one request, so it needs
      // the widest stub surface of any route here.
      invitation: { count: jest.fn().mockResolvedValue(0) },
      conversation: { count: jest.fn().mockResolvedValue(0) },
      message: { count: jest.fn().mockResolvedValue(0) },
      whatsAppPhoneNumber: { count: jest.fn().mockResolvedValue(0) },
      webhookEvent: { count: jest.fn().mockResolvedValue(0) },
      wallet: {
        count: jest.fn().mockResolvedValue(0),
        aggregate: jest.fn().mockResolvedValue({ _sum: { balance: 0n } }),
      },
      tenant: {
        findFirst: jest.fn().mockResolvedValue({
          id: TENANT_ID,
          slug: 'acme',
          name: 'Acme',
          status: 'ACTIVE',
          timezone: 'UTC',
          locale: 'en',
          planKey: 'trial',
          planExpiresAt: null,
          settings: {},
          suspendedAt: null,
          suspendedReason: null,
          createdAt: new Date('2026-01-01'),
        }),
      },
      auditLog: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const prismaStub = {
      $connect: jest.fn().mockResolvedValue(undefined),
      $disconnect: jest.fn().mockResolvedValue(undefined),
      ping: jest.fn().mockResolvedValue(undefined),
      scoped,
      tenant: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: TENANT_ID, slug: 'acme', status: 'ACTIVE', deletedAt: null }),
      },
      // Unscoped, on the root client rather than `scoped`: accepting an
      // invitation happens before any tenant is resolved, so the lookup runs
      // outside tenant scoping and the token itself selects the workspace.
      invitation: { findUnique: jest.fn().mockResolvedValue(null) },
      onModuleInit: jest.fn().mockResolvedValue(undefined),
      onModuleDestroy: jest.fn().mockResolvedValue(undefined),
    };

    // Every cache read misses, so the permission guard consults the stubbed
    // membership on each request and a test's grant never leaks into the next.
    const redisStub = {
      ping: jest.fn().mockResolvedValue('PONG'),
      quit: jest.fn().mockResolvedValue('OK'),
      disconnect: jest.fn(),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(0),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
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
    jest.clearAllMocks();
    sessionFindFirst.mockResolvedValue({
      id: SESSION_ID,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
      user: {
        id: ADMIN_ID,
        tenantId: TENANT_ID,
        type: UserType.ADMIN,
        status: UserStatus.ACTIVE,
        deletedAt: null,
      },
    });
    membershipFindFirst.mockResolvedValue(membershipRow([]));
  });

  afterAll(async () => {
    await app?.close();
  });

  const api = () => request(app.getHttpServer());

  const tokenFor = async (userType: UserType = UserType.ADMIN, userId = ADMIN_ID) => {
    const pair = await tokens.issuePair({
      userId,
      tenantId: TENANT_ID,
      userType,
      sessionId: SESSION_ID,
      familyId: 'family-1',
    });
    return pair.accessToken;
  };

  const grant = (...permissions: string[]) => {
    membershipFindFirst.mockResolvedValue(membershipRow(permissions));
  };

  describe('the guard chain', () => {
    it('refuses an unauthenticated request', async () => {
      const response = await api().get('/api/v1/admin/roles').expect(401);

      expect((response.body as Envelope).error?.code).toBe(ErrorCode.UNAUTHENTICATED);
    });

    it('refuses a customer token before permissions are ever consulted', async () => {
      sessionFindFirst.mockResolvedValue({
        id: SESSION_ID,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86_400_000),
        user: {
          id: OTHER_ID,
          tenantId: TENANT_ID,
          type: UserType.CUSTOMER,
          status: UserStatus.ACTIVE,
          deletedAt: null,
        },
      });

      const response = await api()
        .get('/api/v1/admin/roles')
        .set('Authorization', `Bearer ${await tokenFor(UserType.CUSTOMER, OTHER_ID)}`)
        .expect(403);

      // The coarse population check, not the fine-grained one — a customer must
      // never reach the RBAC layer at all.
      expect((response.body as Envelope).error?.code).toBe(ErrorCode.FORBIDDEN);
      expect(membershipFindFirst).not.toHaveBeenCalled();
    });

    it('refuses an admin lacking the required permission', async () => {
      grant(Permission.ConversationsRead);

      const response = await api()
        .get('/api/v1/admin/roles')
        .set('Authorization', `Bearer ${await tokenFor()}`)
        .expect(403);

      const body = response.body as Envelope;
      expect(body.error?.code).toBe(ErrorCode.INSUFFICIENT_PERMISSIONS);
      // Echoed so the UI can name the permission to request.
      expect(body.error?.details).toMatchObject({ required: [Permission.RolesRead] });
    });

    it('admits an admin holding the required permission', async () => {
      grant(Permission.RolesRead);

      await api()
        .get('/api/v1/admin/roles')
        .set('Authorization', `Bearer ${await tokenFor()}`)
        .expect(200);
    });

    it('admits an owner through the wildcard', async () => {
      grant('*');

      await api()
        .get('/api/v1/admin/roles')
        .set('Authorization', `Bearer ${await tokenFor()}`)
        .expect(200);
    });

    it('refuses an authenticated admin with no membership in the workspace', async () => {
      membershipFindFirst.mockResolvedValue(null);

      const response = await api()
        .get('/api/v1/admin/roles')
        .set('Authorization', `Bearer ${await tokenFor()}`)
        .expect(403);

      expect((response.body as Envelope).error?.code).toBe(ErrorCode.ROLE_REQUIRED);
    });

    it('lets a denial beat the wildcard on a real route', async () => {
      membershipFindFirst.mockResolvedValue(
        membershipRow(['*'], { deniedPermissions: [Permission.RolesRead] }),
      );

      const response = await api()
        .get('/api/v1/admin/roles')
        .set('Authorization', `Bearer ${await tokenFor()}`)
        .expect(403);

      expect((response.body as Envelope).error?.code).toBe(ErrorCode.INSUFFICIENT_PERMISSIONS);
    });
  });

  describe('member self-service', () => {
    it('serves /me with no permission requirement', async () => {
      // Every member must be able to discover their own access, including one
      // whose role grants nothing — otherwise the panel cannot render at all.
      grant();

      const response = await api()
        .get('/api/v1/admin/members/me')
        .set('Authorization', `Bearer ${await tokenFor()}`)
        .expect(200);

      expect((response.body as Envelope<{ userId: string }>).data?.userId).toBe(ADMIN_ID);
    });

    it('expands wildcards into literal slugs for the UI', async () => {
      grant('*');

      const response = await api()
        .get('/api/v1/admin/members/me')
        .set('Authorization', `Bearer ${await tokenFor()}`)
        .expect(200);

      const permissions = (response.body as Envelope<{ permissions: string[] }>).data?.permissions;

      expect(permissions).toContain(Permission.WalletsAdjust);
      expect(permissions).not.toContain('*');
    });

    it('routes /me ahead of the :userId parameter', async () => {
      grant();

      // Registration order decides this; a regression turns /me into a 422 from
      // the UUID pipe rather than anything obviously wrong.
      await api()
        .get('/api/v1/admin/members/me')
        .set('Authorization', `Bearer ${await tokenFor()}`)
        .expect(200);
    });
  });

  describe('the permission catalogue', () => {
    it('serves the grouped catalogue the role editor renders', async () => {
      grant(Permission.RolesRead);

      const response = await api()
        .get('/api/v1/admin/roles/permissions')
        .set('Authorization', `Bearer ${await tokenFor()}`)
        .expect(200);

      const body = response.body as Envelope<{
        groups: { key: string; permissions: string[] }[];
        permissions: string[];
      }>;

      expect(body.data?.groups.length).toBeGreaterThan(0);
      expect(body.data?.permissions).toContain(Permission.MembersRead);
    });
  });

  describe('multi-permission routes', () => {
    it('admits the dashboard on any one of its permissions', async () => {
      grant(Permission.CustomersRead);

      await api()
        .get('/api/v1/admin/dashboard')
        .set('Authorization', `Bearer ${await tokenFor()}`)
        .expect(200);
    });

    it('refuses the dashboard when none of them is held', async () => {
      grant(Permission.ApiKeysRead);

      await api()
        .get('/api/v1/admin/dashboard')
        .set('Authorization', `Bearer ${await tokenFor()}`)
        .expect(403);
    });
  });

  describe('public surface', () => {
    it('leaves invitation acceptance unauthenticated', async () => {
      // The invitee has no account and no token; the invitation token is the
      // only credential. A 401 here would make invitations unusable.
      const response = await api()
        .post('/api/v1/admin/invitations/accept')
        .send({ token: 'not-a-real-token', password: 'correct horse battery' })
        .expect(401);

      expect((response.body as Envelope).error?.code).toBe(ErrorCode.TOKEN_INVALID);
    });
  });
});

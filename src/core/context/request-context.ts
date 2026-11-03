import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { ErrorCode } from '../errors/error-code.enum';
import { AppException } from '../errors/app.exception';

/** What kind of principal is driving the current unit of work. */
export enum ActorType {
  /** A human user holding a JWT access token. */
  User = 'user',
  /** A machine client authenticating with an API key. */
  ApiKey = 'api_key',
  /** A background worker processing a queue job. */
  System = 'system',
  /** An inbound Meta webhook — authenticated by signature, not by principal. */
  Webhook = 'webhook',
  /** Unauthenticated public traffic (login, health, docs). */
  Anonymous = 'anonymous',
}

/**
 * Ambient state for one unit of work — an HTTP request, a queue job, a socket event.
 *
 * Mutable by design: middleware seeds transport facts, then guards enrich it with the
 * resolved principal. Everything downstream reads it without touching function signatures.
 */
export interface RequestContextData {
  /** Unique per request. Echoed as the `x-request-id` response header. */
  requestId: string;
  /** Stable across a whole causal chain (HTTP → queue job → outbound call). */
  correlationId: string;
  /** `process.hrtime.bigint()`-free monotonic-ish start marker, ms since epoch. */
  startedAt: number;
  actorType: ActorType;

  tenantId?: string;
  userId?: string;
  apiKeyId?: string;
  sessionId?: string;
  /** Flattened permission slugs for the current principal, e.g. `contacts:write`. */
  permissions?: ReadonlySet<string>;
  roles?: readonly string[];

  ip?: string;
  userAgent?: string;
  method?: string;
  path?: string;
  /** Client-supplied `Idempotency-Key`, if any. */
  idempotencyKey?: string;

  /**
   * Disables automatic tenant scoping in the Prisma extension.
   *
   * Only platform-level work (migrations, cross-tenant reports, the admin console)
   * may set this, and only via {@link RequestContext.runAsSystem}. It is never
   * settable from anything that parses user input.
   */
  readonly bypassTenantScope?: boolean;

  /** Free-form structured fields merged into every log line for this request. */
  logFields?: Record<string, unknown>;
}

const storage = new AsyncLocalStorage<RequestContextData>();

/**
 * Request-scoped ambient context backed by `AsyncLocalStorage`.
 *
 * Why ALS rather than Nest's `Scope.REQUEST` providers: request-scoped DI forces
 * Nest to rebuild the injector subtree for *every* request, which measurably hurts
 * throughput and quietly infects every provider that touches a scoped one. ALS keeps
 * all providers singletons while still giving us per-request state — and, critically,
 * it also works inside BullMQ workers and Socket.IO handlers where there is no
 * Nest request at all.
 */
export const RequestContext = {
  /** Runs `fn` with a fresh context. Returns whatever `fn` returns. */
  run<T>(seed: Partial<RequestContextData>, fn: () => T): T {
    return storage.run(createContext(seed), fn);
  },

  /**
   * Runs `fn` as the platform itself, with tenant scoping disabled.
   * Use for migrations, schedulers and cross-tenant maintenance only.
   */
  runAsSystem<T>(seed: Partial<RequestContextData>, fn: () => T): T {
    const context: RequestContextData = {
      ...createContext(seed),
      actorType: ActorType.System,
      bypassTenantScope: true,
    };
    return storage.run(context, fn);
  },

  /** The active context, or `undefined` outside any run(). */
  get(): RequestContextData | undefined {
    return storage.getStore();
  },

  /** @throws AppException if called outside a context — signals a wiring bug. */
  getOrThrow(): RequestContextData {
    const context = storage.getStore();
    if (!context) {
      throw AppException.internal('No request context is active for the current execution');
    }
    return context;
  },

  get tenantId(): string | undefined {
    return storage.getStore()?.tenantId;
  },

  /**
   * The active tenant.
   * @throws AppException(TENANT_NOT_RESOLVED) when tenancy could not be established —
   *         a hard stop, because proceeding would risk unscoped data access.
   */
  requireTenantId(): string {
    const tenantId = storage.getStore()?.tenantId;
    if (!tenantId) {
      throw new AppException(ErrorCode.TENANT_NOT_RESOLVED, {
        message: 'No tenant is associated with this request',
      });
    }
    return tenantId;
  },

  get userId(): string | undefined {
    return storage.getStore()?.userId;
  },

  get requestId(): string | undefined {
    return storage.getStore()?.requestId;
  },

  get correlationId(): string | undefined {
    return storage.getStore()?.correlationId;
  },

  get isSystem(): boolean {
    return storage.getStore()?.bypassTenantScope === true;
  },

  /** Shallow-merges fields into the active context. No-op outside a context. */
  patch(fields: Partial<Omit<RequestContextData, 'bypassTenantScope'>>): void {
    const context = storage.getStore();
    if (!context) return;
    Object.assign(context, fields);
  },

  /** Adds fields that the logger will attach to every subsequent log line. */
  addLogFields(fields: Record<string, unknown>): void {
    const context = storage.getStore();
    if (!context) return;
    context.logFields = { ...context.logFields, ...fields };
  },

  hasPermission(permission: string): boolean {
    return storage.getStore()?.permissions?.has(permission) ?? false;
  },
} as const;

function createContext(seed: Partial<RequestContextData>): RequestContextData {
  const requestId = seed.requestId ?? randomUUID();
  return {
    ...seed,
    requestId,
    correlationId: seed.correlationId ?? requestId,
    startedAt: seed.startedAt ?? Date.now(),
    actorType: seed.actorType ?? ActorType.Anonymous,
  };
}

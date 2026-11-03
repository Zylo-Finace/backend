import { Prisma } from '@prisma/client';

import { RequestContext } from '../../../core/context/request-context';
import { AppException } from '../../../core/errors/app.exception';
import { ErrorCode } from '../../../core/errors/error-code.enum';

const TENANT_FIELD = 'tenantId';
const SOFT_DELETE_FIELD = 'deletedAt';

/**
 * Models carrying a `tenantId` scalar, derived from the DMMF at import time.
 *
 * Deriving this from the schema rather than hand-maintaining a list is the whole
 * point: a model added in a later phase is protected the moment it declares
 * `tenantId`, with no chance of someone forgetting to register it here.
 */
export const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set(
  Prisma.dmmf.datamodel.models
    .filter((model) => model.fields.some((field) => field.name === TENANT_FIELD))
    .map((model) => model.name),
);

/** Models supporting soft delete (`deletedAt` nullable timestamp). */
export const SOFT_DELETABLE_MODELS: ReadonlySet<string> = new Set(
  Prisma.dmmf.datamodel.models
    .filter((model) => model.fields.some((field) => field.name === SOFT_DELETE_FIELD))
    .map((model) => model.name),
);

/** Operations whose `args.where` must be narrowed to the active tenant. */
const WHERE_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
  'upsert',
]);

/** Operations whose `args.data` must carry the active tenant. */
const DATA_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn', 'upsert']);

interface QueryArgs {
  where?: Record<string, unknown>;
  data?: Record<string, unknown> | Record<string, unknown>[];
  create?: Record<string, unknown>;
  update?: Record<string, unknown>;
}

/**
 * Enforces tenant isolation at the data-access layer.
 *
 * ## Why here and not in the services
 *
 * "Always remember to add `where: { tenantId }`" is a rule that holds until the
 * first tired Friday commit, and the failure mode is one tenant reading another's
 * conversations — the single worst bug this product can ship. Pushing the filter
 * into the client means isolation is the *default* and forgetting it is impossible:
 * there is no code path from a service to Postgres that skips this hook.
 *
 * ## What it does
 *
 * - Injects `tenantId = <active tenant>` into the `where` of every read and write.
 * - Injects `tenantId` into `create`/`createMany` payloads.
 * - Rejects any query that explicitly names a *different* tenant
 *   (`CROSS_TENANT_ACCESS_DENIED`) instead of silently rewriting it — an explicit
 *   mismatch is a bug or an attack, never something to paper over.
 * - Refuses to run tenant-scoped queries with no tenant in context, unless the
 *   caller is explicitly running as the platform via `RequestContext.runAsSystem`.
 *
 * ## Known limits (documented, not hidden)
 *
 * 1. **`$queryRaw` bypasses this entirely.** Raw SQL must filter by tenant by
 *    hand; `BaseRepository.rawTenantScoped` exists to make that the easy path.
 * 1a. **Creates still pass `tenantId` explicitly.** Prisma's generated types make
 *    `tenantId` a required field on `create`, so callers supply it and this
 *    extension *verifies* rather than injects it. That is the better outcome: the
 *    tenant is visible at the call site and a mismatch is still rejected. Reads
 *    and updates need no such ceremony, because `where` clauses are fully
 *    optional in Prisma's types and injection is invisible there.
 * 2. **Nested writes are not rewritten.** `create({ data: { user: { create: {…} } } })`
 *    does not get `tenantId` injected into the nested payload. Nested creates of
 *    tenant-scoped models must pass `tenantId` explicitly — Prisma's nested-write
 *    args are recursive and rewriting them safely is not worth the blast radius.
 * 3. Postgres RLS is the intended second layer for defence in depth; this
 *    extension is the first.
 */
/** Shape of the hook Prisma hands to `$allOperations`. */
export interface OperationContext<TArgs = unknown, TResult = unknown> {
  model: string;
  operation: string;
  args: TArgs;
  query: (args: TArgs) => Promise<TResult>;
}

/**
 * The interceptor body, exported separately from the extension wrapper so it can
 * be unit-tested directly with a stub `query` — testing through
 * `Prisma.defineExtension` would require a live database to prove anything.
 *
 * `async` so that a scoping violation surfaces as a rejected promise rather than
 * a synchronous throw: callers await this, and a mixed sync/async failure mode is
 * exactly how an error escapes a `.catch()` and becomes an unhandled rejection.
 */

export async function applyTenantScope<TArgs, TResult>({
  model,
  operation,
  args,
  query,
}: OperationContext<TArgs, TResult>): Promise<TResult> {
  if (!TENANT_SCOPED_MODELS.has(model)) {
    return query(args);
  }

  // Platform-level work (migrations, cross-tenant reporting, the tenant
  // provisioning flow itself) opts out explicitly and auditably.
  if (RequestContext.isSystem) {
    return query(args);
  }

  const tenantId = RequestContext.tenantId;
  if (!tenantId) {
    throw new AppException(ErrorCode.TENANT_NOT_RESOLVED, {
      message: 'Tenant-scoped query attempted without an active tenant',
      details: { model, operation },
    });
  }

  const typedArgs = { ...((args ?? {}) as QueryArgs) };

  if (WHERE_OPERATIONS.has(operation)) {
    typedArgs.where = applyTenantToWhere(typedArgs.where, tenantId, model, operation);
  }

  if (DATA_OPERATIONS.has(operation)) {
    applyTenantToData(typedArgs, tenantId, model, operation);
  }

  return query(typedArgs as TArgs);
}

export const tenantScopeExtension = Prisma.defineExtension({
  name: 'tenantScope',
  query: {
    $allModels: {
      $allOperations: (context) =>
        applyTenantScope(context as unknown as OperationContext<unknown, unknown>),
    },
  },
});

function applyTenantToWhere(
  where: Record<string, unknown> | undefined,
  tenantId: string,
  model: string,
  operation: string,
): Record<string, unknown> {
  const next = { ...(where ?? {}) };
  const existing = next[TENANT_FIELD];

  if (existing !== undefined && existing !== tenantId) {
    throw new AppException(ErrorCode.CROSS_TENANT_ACCESS_DENIED, {
      message: 'Query targeted a tenant other than the active one',
      details: { model, operation },
    });
  }

  next[TENANT_FIELD] = tenantId;
  return next;
}

function applyTenantToData(
  args: QueryArgs,
  tenantId: string,
  model: string,
  operation: string,
): void {
  const assign = (payload: Record<string, unknown>): Record<string, unknown> => {
    const existing = payload[TENANT_FIELD];
    if (existing !== undefined && existing !== tenantId) {
      throw new AppException(ErrorCode.CROSS_TENANT_ACCESS_DENIED, {
        message: 'Write targeted a tenant other than the active one',
        details: { model, operation },
      });
    }
    return { ...payload, [TENANT_FIELD]: tenantId };
  };

  if (Array.isArray(args.data)) {
    args.data = args.data.map(assign);
  } else if (args.data) {
    args.data = assign(args.data);
  }

  // `upsert` carries its insert payload under `create`.
  if (args.create) {
    args.create = assign(args.create);
  }
}

import { Prisma } from '@prisma/client';

import { type OperationContext, SOFT_DELETABLE_MODELS } from './tenant-scope.extension';

const SOFT_DELETE_FIELD = 'deletedAt';

/** Read operations that must exclude soft-deleted rows by default. */
const READ_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

interface QueryArgs {
  where?: Record<string, unknown>;
}

/**
 * Hides soft-deleted rows from every read.
 *
 * ## Design notes
 *
 * **Reads are filtered; `delete` is still a real delete.** A common variant of this
 * pattern silently rewrites `delete` into `update { deletedAt: now }`. That makes
 * `delete()` a lie — it returns a row that still exists, breaks `onDelete: Cascade`
 * (the database never sees a deletion, so children survive as orphans), and leaves
 * unique constraints occupied by invisible rows. Instead: reads are filtered
 * automatically, and callers soft-delete *explicitly* via
 * `BaseRepository.softDelete()`. Explicit beats magic when the magic can orphan data.
 *
 * **Opting out.** Pass `deletedAt` yourself — including `deletedAt: { not: null }`
 * for a "recently deleted" view, or `deletedAt: undefined` to include everything —
 * and this extension leaves the query alone.
 *
 * **Unique constraints.** `@@unique([tenantId, email])` still counts soft-deleted
 * rows, so a deleted user's email cannot be reused. Where reuse must be allowed,
 * the migration replaces the constraint with a partial unique index
 * (`... WHERE deleted_at IS NULL`), which Prisma cannot express natively.
 *
 * Exported as a plain function (rather than only as the extension) for direct
 * unit testing; see the note on `applyTenantScope`.
 */
export async function applySoftDeleteFilter<TArgs, TResult>({
  model,
  operation,
  args,
  query,
}: OperationContext<TArgs, TResult>): Promise<TResult> {
  if (!SOFT_DELETABLE_MODELS.has(model) || !READ_OPERATIONS.has(operation)) {
    return query(args);
  }

  const typedArgs = { ...((args ?? {}) as QueryArgs) };
  const where = typedArgs.where ?? {};

  // Caller stated an intent about deleted rows — respect it.
  if (SOFT_DELETE_FIELD in where) {
    return query(args);
  }

  typedArgs.where = { ...where, [SOFT_DELETE_FIELD]: null };
  return query(typedArgs as TArgs);
}

export const softDeleteExtension = Prisma.defineExtension({
  name: 'softDelete',
  query: {
    $allModels: {
      $allOperations: (context) =>
        applySoftDeleteFilter(context as unknown as OperationContext<unknown, unknown>),
    },
  },
});

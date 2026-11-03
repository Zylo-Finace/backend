import { applySoftDeleteFilter } from './soft-delete.extension';

function stubQuery() {
  return jest.fn().mockResolvedValue([]);
}

describe('softDeleteExtension', () => {
  it.each(['findUnique', 'findFirst', 'findMany', 'count', 'aggregate', 'groupBy'])(
    'excludes soft-deleted rows from %s',
    async (operation) => {
      const query = stubQuery();

      await applySoftDeleteFilter({
        model: 'User',
        operation,
        args: { where: { id: 'u1' } },
        query,
      });

      expect(query).toHaveBeenCalledWith({ where: { id: 'u1', deletedAt: null } });
    },
  );

  it('adds the filter when no where clause was supplied', async () => {
    const query = stubQuery();

    await applySoftDeleteFilter({ model: 'User', operation: 'findMany', args: {}, query });

    expect(query).toHaveBeenCalledWith({ where: { deletedAt: null } });
  });

  it('respects an explicit deletedAt filter', async () => {
    const query = stubQuery();
    const args = { where: { deletedAt: { not: null } } };

    // A "recently deleted" view must be able to see deleted rows.
    await applySoftDeleteFilter({ model: 'User', operation: 'findMany', args, query });

    expect(query).toHaveBeenCalledWith(args);
  });

  it('treats an explicit `deletedAt: undefined` as "include everything"', async () => {
    const query = stubQuery();
    const args = { where: { deletedAt: undefined } };

    await applySoftDeleteFilter({ model: 'User', operation: 'findMany', args, query });

    expect(query).toHaveBeenCalledWith(args);
  });

  it('leaves write operations alone', async () => {
    const query = stubQuery();
    const args = { where: { id: 'u1' }, data: { firstName: 'A' } };

    // Filtering an update's where clause is the tenant extension's job; adding
    // `deletedAt: null` here would silently make "restore a deleted user" impossible.
    await applySoftDeleteFilter({ model: 'User', operation: 'update', args, query });

    expect(query).toHaveBeenCalledWith(args);
  });

  it('leaves models without a deletedAt column alone', async () => {
    const query = stubQuery();
    const args = { where: { tenantId: 't1' } };

    await applySoftDeleteFilter({ model: 'AuditLog', operation: 'findMany', args, query });

    expect(query).toHaveBeenCalledWith(args);
  });

  it('does not mutate the caller-supplied args', async () => {
    const query = stubQuery();
    const args = { where: { id: 'u1' } };

    await applySoftDeleteFilter({ model: 'User', operation: 'findFirst', args, query });

    expect(args).toEqual({ where: { id: 'u1' } });
  });
});

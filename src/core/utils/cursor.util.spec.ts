import { ErrorCode } from '../errors/error-code.enum';
import { buildCursorPage } from '../dto/pagination.dto';
import { Cursor } from './cursor.util';

describe('Cursor', () => {
  it('round-trips a payload', () => {
    const encoded = Cursor.encode({ k: '2026-01-01T00:00:00.000Z', i: 'abc' });
    expect(Cursor.decode(encoded)).toEqual({ k: '2026-01-01T00:00:00.000Z', i: 'abc' });
  });

  it('produces URL-safe output that survives a query string unescaped', () => {
    const encoded = Cursor.encode({ k: '2026-01-01T00:00:00.000Z', i: 'a/b+c=d' });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('round-trips the (createdAt, id) keyset', () => {
    const date = new Date('2026-03-15T12:30:00.000Z');
    const { date: decoded, id } = Cursor.toDate(Cursor.fromDate(date, 'row-1'));

    expect(decoded.toISOString()).toBe(date.toISOString());
    expect(id).toBe('row-1');
  });

  it.each([
    ['not base64', '!!!not-base64!!!'],
    ['valid base64, wrong shape', Buffer.from('{"x":1}').toString('base64url')],
    ['valid base64, not JSON', Buffer.from('hello').toString('base64url')],
    ['empty', ''],
  ])('rejects a malformed cursor (%s) as a validation error', (_label, value) => {
    // Clients must get a 422, not a 500, when they mangle a cursor.
    expect(() => Cursor.decode(value)).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION_FAILED }) as Error,
    );
  });

  it('rejects a cursor carrying an unparseable date', () => {
    const encoded = Cursor.encode({ k: 'not-a-date', i: 'abc' });
    expect(() => Cursor.toDate(encoded)).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION_FAILED }) as Error,
    );
  });
});

describe('buildCursorPage', () => {
  const toCursor = (item: { id: string }) => item.id;

  it('detects a next page from the over-fetched row and trims it', () => {
    // Fetched with take: limit + 1 — the extra row is the "is there more?" signal.
    const rows = [{ id: '1' }, { id: '2' }, { id: '3' }];

    const page = buildCursorPage(rows, 2, toCursor);

    expect(page.items).toEqual([{ id: '1' }, { id: '2' }]);
    expect(page.meta.hasNextPage).toBe(true);
    expect(page.meta.nextCursor).toBe('2');
  });

  it('reports the final page when fewer rows than the limit come back', () => {
    const page = buildCursorPage([{ id: '1' }], 2, toCursor);

    expect(page.meta.hasNextPage).toBe(false);
    expect(page.meta.nextCursor).toBeUndefined();
  });

  it('handles an exactly-full page as the last page', () => {
    const page = buildCursorPage([{ id: '1' }, { id: '2' }], 2, toCursor);

    expect(page.items).toHaveLength(2);
    expect(page.meta.hasNextPage).toBe(false);
  });

  it('handles an empty result set', () => {
    const page = buildCursorPage([], 10, toCursor);

    expect(page.items).toEqual([]);
    expect(page.meta.hasNextPage).toBe(false);
    expect(page.meta.nextCursor).toBeUndefined();
  });
});

import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { OutcomeUnknownError, RampPortalIdempotency } from './ramp-portal.idempotency';

type Row = {
  id: string;
  key: string;
  endpoint: string;
  requestHash: string;
  status: string;
  responseBody: unknown;
  expiresAt: Date;
};

/** Minimal in-memory stand-in for the idempotency_records table. */
function fakeDb() {
  const rows: Row[] = [];
  let seq = 0;
  return {
    rows,
    idempotencyRecord: {
      findFirst: jest.fn(({ where }: { where: { key: string; endpoint: string } }) =>
        Promise.resolve(
          rows.find((r) => r.key === where.key && r.endpoint === where.endpoint) ?? null,
        ),
      ),
      create: jest.fn(({ data }: { data: Omit<Row, 'id' | 'responseBody'> }) => {
        const row = { ...data, id: String(++seq), responseBody: null } as Row;
        rows.push(row);
        return Promise.resolve({ id: row.id });
      }),
      update: jest.fn(({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return Promise.resolve(row);
      }),
      delete: jest.fn(({ where }: { where: { id: string } }) => {
        rows.splice(
          rows.findIndex((r) => r.id === where.id),
          1,
        );
        return Promise.resolve();
      }),
    },
  };
}

const params = {
  key: 'review-key-1',
  endpoint: 'bank-send',
  userId: 'u1',
  request: { amount: '5000' },
};

async function codeOf(p: Promise<unknown>) {
  try {
    await p;
    return 'RESOLVED';
  } catch (e) {
    return e instanceof AppException ? e.code : (e as Error).name;
  }
}

describe('RampPortalIdempotency', () => {
  it('requires a key', async () => {
    const svc = new RampPortalIdempotency(fakeDb() as never);
    expect(
      await codeOf(svc.run({ ...params, key: undefined }, () => Promise.resolve({ ok: true }))),
    ).toBe(ErrorCode.IDEMPOTENCY_KEY_REQUIRED);
  });

  it('runs once and replays the stored response', async () => {
    const svc = new RampPortalIdempotency(fakeDb() as never);
    const action = jest.fn().mockResolvedValue({ ref: 'BS-1' });
    expect(await svc.run(params, action)).toEqual({ ref: 'BS-1' });
    expect(await svc.run(params, action)).toEqual({ ref: 'BS-1' });
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('refuses the same key for a different request', async () => {
    const svc = new RampPortalIdempotency(fakeDb() as never);
    await svc.run(params, () => Promise.resolve({ ref: 'BS-1' }));
    expect(
      await codeOf(
        svc.run({ ...params, request: { amount: '9000' } }, () => Promise.resolve({ ref: 'BS-2' })),
      ),
    ).toBe(ErrorCode.IDEMPOTENCY_KEY_CONFLICT);
  });

  it('reports a request still in progress', async () => {
    const db = fakeDb();
    const svc = new RampPortalIdempotency(db as never);
    let release!: () => void;
    const first = svc.run(
      params,
      () => new Promise<{ ref: string }>((r) => (release = () => r({ ref: 'BS-1' }))),
    );
    await new Promise((r) => setImmediate(r));
    expect(await codeOf(svc.run(params, () => Promise.resolve({ ref: 'BS-2' })))).toBe(
      ErrorCode.IDEMPOTENT_REQUEST_IN_PROGRESS,
    );
    release();
    await first;
  });

  it('releases the key after a failure that moved nothing', async () => {
    const svc = new RampPortalIdempotency(fakeDb() as never);
    const wrongPin = new AppException(ErrorCode.INVALID_CREDENTIALS);
    expect(await codeOf(svc.run(params, () => Promise.reject(wrongPin)))).toBe(
      ErrorCode.INVALID_CREDENTIALS,
    );
    expect(await svc.run(params, () => Promise.resolve({ ref: 'BS-1' }))).toEqual({ ref: 'BS-1' });
  });

  it('keeps the key burned when the outcome is unknown', async () => {
    const svc = new RampPortalIdempotency(fakeDb() as never);
    expect(
      await codeOf(svc.run(params, () => Promise.reject(new OutcomeUnknownError('slow')))),
    ).toBe('OutcomeUnknownError');
    const retry = jest.fn().mockResolvedValue({ ref: 'BS-2' });
    expect(await codeOf(svc.run(params, retry))).toBe(ErrorCode.PAYOUT_UNKNOWN_OUTCOME);
    expect(retry).not.toHaveBeenCalled();
  });

  it('scopes keys per customer', async () => {
    const svc = new RampPortalIdempotency(fakeDb() as never);
    await svc.run(params, () => Promise.resolve({ ref: 'mine' }));
    expect(
      await svc.run({ ...params, userId: 'u2' }, () => Promise.resolve({ ref: 'theirs' })),
    ).toEqual({
      ref: 'theirs',
    });
  });
});

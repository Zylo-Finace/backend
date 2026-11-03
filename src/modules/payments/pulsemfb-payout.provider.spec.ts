import type { PinoLogger } from 'nestjs-pino';

import type { AppConfig } from '../../config/app.config';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { Money } from '../../core/money/money';
import type { MetricsService } from '../../infrastructure/observability/metrics.service';
import { PayoutEventStatus, type PayoutRequest } from './payout-provider.interface';
import { PulseMfbPayoutProvider, namesMatch } from './pulsemfb-payout.provider';
import { PulseMfbClient } from './pulsemfb.client';
import { PulseMfbProvider } from './pulsemfb.provider';

const FLOAT_ACCOUNT = '9990000001';

const buildConfig = (overrides: Partial<AppConfig['pulsemfb']> = {}) =>
  ({
    pulsemfb: {
      baseUrl: 'https://test-api.pulsemfb.example',
      publicKey: 'pk_test_abc',
      privateKey: 'stripe_dummy_test_xyz',
      apiKey: '',
      webhookSecret: 'whsec_dummy_test_abc',
      httpTimeoutMs: 10_000,
      signatureTtlSeconds: 300,
      bankCode: '090713',
      bankName: 'Pulse MFB',
      debitAccountNumber: FLOAT_ACCOUNT,
      debitAccountId: 'acct_float_1',
      ...overrides,
    },
  }) as AppConfig;

const logger = {
  setContext: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as PinoLogger;

const metrics = {
  whatsappApiCallsTotal: { inc: jest.fn() },
  whatsappApiDuration: { observe: jest.fn() },
} as unknown as MetricsService;

const request: PayoutRequest = {
  reference: 'PAY-20260815-abc',
  amount: Money.fromNaira('5000'),
  bankCode: '058',
  accountNumber: '0234057048',
  accountName: 'DAYO OJO',
  narration: 'Withdrawal',
};

const build = (config = buildConfig()) => {
  const client = new PulseMfbClient(config, logger, metrics);
  return new PulseMfbPayoutProvider(
    config,
    client,
    new PulseMfbProvider(config, client, logger),
    logger,
  );
};

/**
 * Asserts a synchronous throw carries a given `ErrorCode`.
 *
 * `toThrow(expect.objectContaining(...))` types its argument as `any`, so the
 * code being asserted on goes unchecked. Catching explicitly keeps it typed.
 */
function expectThrowsCode(fn: () => unknown, code: ErrorCode): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({ code });
}

/** Queues one JSON reply per call, in order. */
const respondInOrder = (...replies: { body: unknown; status?: number }[]) => {
  const queue = [...replies];
  return jest.fn().mockImplementation(() => {
    const next = queue.shift() ?? { body: {}, status: 200 };
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
};

const nameEnquiryOk = (accountName: string) => ({
  body: { data: { responseCode: '00', accountName, responseMessage: 'Successful' } },
});

describe('PulseMfbPayoutProvider', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  // ===========================================================================
  //  The destination re-verification gate
  // ===========================================================================

  describe('initiateTransfer', () => {
    it('re-runs name enquiry and sends when both providers agree', async () => {
      const fetchMock = respondInOrder(nameEnquiryOk('DAYO OJO'), {
        body: { data: { internal_reference: 'FT123', status: 'completed' } },
      });
      global.fetch = fetchMock;

      const acceptance = await build().initiateTransfer(request);

      expect(acceptance.providerReference).toBe('FT123');
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toMatchObject({
        debit_account_number: FLOAT_ACCOUNT,
        beneficiary_account_number: '0234057048',
        beneficiary_bank_code: '058',
        amount: 5000,
        reference: 'PAY-20260815-abc',
      });
    });

    it('refuses when the fallback resolves a different account holder', async () => {
      // The scenario this whole gate exists for: the two providers disagree on
      // what bank code `058` means, so the same digits name somebody else.
      global.fetch = respondInOrder(nameEnquiryOk('SOMEBODY ELSE'));

      await expect(build().initiateTransfer(request)).rejects.toMatchObject({
        code: ErrorCode.PAYOUT_REJECTED,
      });

      // Critically: the transfer call was never made.
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('does not send when name enquiry is unavailable', async () => {
      // Skipping the check on failure would bypass it at exactly the moment it
      // is most needed.
      global.fetch = respondInOrder({ body: { message: 'boom' }, status: 500 });

      await expect(build().initiateTransfer(request)).rejects.toThrow();
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('treats a synchronous "completed" as acceptance, not settlement', async () => {
      global.fetch = respondInOrder(nameEnquiryOk('DAYO OJO'), {
        body: { data: { status: 'completed', internal_reference: 'FT1' } },
      });

      const acceptance = await build().initiateTransfer(request);

      // A `PayoutAcceptance` has no notion of success — that is the point.
      expect(acceptance).not.toHaveProperty('status');
      expect(acceptance.raw).toMatchObject({ status: 'completed' });
    });

    it('refuses a fractional naira amount rather than shorting the customer', async () => {
      global.fetch = respondInOrder(nameEnquiryOk('DAYO OJO'));

      await expect(
        build().initiateTransfer({ ...request, amount: Money.fromKobo(500_050n) }),
      ).rejects.toMatchObject({ code: ErrorCode.PAYOUT_AMOUNT_NOT_ALLOWED });
    });

    it('fails clearly when no debit account is configured', async () => {
      global.fetch = jest.fn();

      await expect(
        build(buildConfig({ debitAccountNumber: '' })).initiateTransfer(request),
      ).rejects.toMatchObject({ code: ErrorCode.SERVICE_UNAVAILABLE });

      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  //  Error mapping — what the router keys its failover decision on
  // ===========================================================================

  describe('error mapping', () => {
    it('reports a lost write as an unknown outcome, never as a failure', async () => {
      global.fetch = jest
        .fn()
        .mockImplementationOnce(
          () =>
            new Response(JSON.stringify(nameEnquiryOk('DAYO OJO').body), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
        )
        .mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));

      await expect(build().initiateTransfer(request)).rejects.toMatchObject({
        code: ErrorCode.PAYOUT_UNKNOWN_OUTCOME,
        retryable: false,
      });
    });

    it('separates an exhausted float from a rejected request', async () => {
      global.fetch = respondInOrder(nameEnquiryOk('DAYO OJO'), {
        body: { message: 'Insufficient balance. Required: ₦5,100.00, Available: ₦3,000.00' },
        status: 400,
      });

      // SERVICE_UNAVAILABLE, not PAYOUT_REJECTED: our float is empty, which says
      // nothing about the customer's request.
      await expect(build().initiateTransfer(request)).rejects.toMatchObject({
        code: ErrorCode.SERVICE_UNAVAILABLE,
      });
    });

    it('recognises a duplicate reference', async () => {
      global.fetch = respondInOrder(nameEnquiryOk('DAYO OJO'), {
        body: { message: 'Transfer with this reference already exists' },
        status: 409,
      });

      await expect(build().initiateTransfer(request)).rejects.toMatchObject({
        code: ErrorCode.PAYOUT_DUPLICATE_REFERENCE,
      });
    });
  });

  // ===========================================================================
  //  Name enquiry
  // ===========================================================================

  describe('resolveAccount', () => {
    it('returns the name the bank holds', async () => {
      global.fetch = respondInOrder(nameEnquiryOk('DAYO OJO'));

      await expect(build().resolveAccount('0234057048', '058')).resolves.toMatchObject({
        accountName: 'DAYO OJO',
        // Their response echoes the *enquiring* account; ours is authoritative.
        accountNumber: '0234057048',
      });
    });

    it.each([
      ['an empty name', { responseCode: '00', accountName: '' }],
      ['a non-success response code', { responseCode: '07', accountName: 'DAYO OJO' }],
    ])('rejects %s', async (_label, data) => {
      global.fetch = respondInOrder({ body: { data } });

      await expect(build().resolveAccount('0234057048', '058')).rejects.toMatchObject({
        code: ErrorCode.RESOURCE_NOT_FOUND,
      });
    });
  });

  it('refuses to list banks, since Pulse publishes none', () => {
    expectThrowsCode(() => build().listBanks(), ErrorCode.NOT_IMPLEMENTED);
  });

  // ===========================================================================
  //  Webhook events
  // ===========================================================================

  describe('parseEvent', () => {
    it.each([
      ['transfer.completed', PayoutEventStatus.Completed],
      ['transfer.failed', PayoutEventStatus.Failed],
    ])('lets the event name %s outrank a stale body status', (eventName, expected) => {
      const event = build().parseEvent({
        event: eventName,
        // Still carrying the value from acceptance time.
        data: { reference: 'PAY-1', status: 'pending' },
      });

      expect(event.status).toBe(expected);
      expect(event.reference).toBe('PAY-1');
    });

    it('ignores an unrecognised status rather than guessing', () => {
      const event = build().parseEvent({
        event: 'transfer.something',
        data: { reference: 'PAY-1', status: 'quantum' },
      });

      expect(event.status).toBe(PayoutEventStatus.Ignored);
    });

    it('refuses an event with no reference to attribute it to', () => {
      expectThrowsCode(
        () => build().parseEvent({ event: 'transfer.completed', data: {} }),
        ErrorCode.VALIDATION_FAILED,
      );
    });
  });
});

// =============================================================================
//  The name comparison the transfer gate depends on
// =============================================================================

describe('namesMatch', () => {
  it.each([
    ['DAYO OJO', 'Dayo Ojo'],
    ['OJO, DAYO', 'DAYO OJO'],
    ['DAYO OJO', 'DAYO SAMUEL OJO'],
    ["CAL'/'Dayo Ojo", 'Dayo Ojo'],
  ])('accepts %s against %s', (a, b) => {
    expect(namesMatch(a, b)).toBe(true);
  });

  it.each([
    ['DAYO OJO', 'JOHN SMITH'],
    ['DAYO OJO', 'DAYO ADEBAYO'],
    ['DAYO OJO', ''],
  ])('rejects %s against %s', (a, b) => {
    expect(namesMatch(a, b)).toBe(false);
  });
});

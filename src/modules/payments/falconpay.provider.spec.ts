import { createHmac } from 'node:crypto';

import type { PinoLogger } from 'nestjs-pino';

import type { AppConfig } from '../../config/app.config';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { Money } from '../../core/money/money';
import type { MetricsService } from '../../infrastructure/observability/metrics.service';
import { FalconPayProvider } from './falconpay.provider';
import { PayoutEventStatus } from './payout-provider.interface';

const API_KEY = 'stripe_dummy_test_deadbeefdeadbeefdeadbeef';
const WEBHOOK_SECRET = 'whsec_dummy_test_0123456789abcdef0123456789abcdef';
const BASE_URL = 'https://sandbox.falconpay.ng/v1';

const buildConfig = (overrides: Partial<AppConfig['payouts']['falconpay']> = {}) =>
  ({
    payments: { httpTimeoutMs: 10_000 },
    payouts: {
      provider: 'falconpay',
      minAmountNaira: 100,
      maxAmountNaira: 1_000_000,
      falconpay: {
        baseUrl: BASE_URL,
        secretKey: API_KEY,
        publicKey: '',
        webhookSecret: WEBHOOK_SECRET,
        webhookUrl: '',
        senderName: 'Acme Ltd',
        ...overrides,
      },
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

const sign = (body: string, secret = WEBHOOK_SECRET) =>
  createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex');

/** A `fetch` stand-in returning one canned response. */
const respondWith = (
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) =>
  jest.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json', ...init.headers },
    }),
  );

describe('FalconPayProvider', () => {
  const provider = new FalconPayProvider(buildConfig(), logger, metrics);
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  // ===========================================================================
  //  Signature verification — the only authentication on the webhook route
  // ===========================================================================

  describe('signature verification', () => {
    const body = JSON.stringify({ reference: 'PAY-20260806-abc', status: 'completed' });

    it('accepts a correctly signed body', () => {
      expect(provider.verifySignature(Buffer.from(body), sign(body))).toBe(true);
    });

    it('rejects a body that was modified after signing', () => {
      // The whole point: an attacker who intercepts a real webhook cannot flip a
      // failed payout to completed and keep the signature valid.
      const tampered = body.replace('failed', 'completed').replace('"completed"', '"failed"');
      expect(provider.verifySignature(Buffer.from(tampered), sign(body))).toBe(false);
    });

    it('rejects a signature made with the API key instead of the webhook secret', () => {
      // These are two different credentials and confusing them is an easy
      // integration mistake — it must fail closed, not coincidentally pass.
      expect(provider.verifySignature(Buffer.from(body), sign(body, API_KEY))).toBe(false);
    });

    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['garbage', 'not-a-signature'],
      ['truncated', sign(body).slice(0, 40)],
    ])('rejects a %s signature', (_label, signature) => {
      expect(provider.verifySignature(Buffer.from(body), signature)).toBe(false);
    });

    it('accepts an uppercase signature, which some clients send', () => {
      expect(provider.verifySignature(Buffer.from(body), sign(body).toUpperCase())).toBe(true);
    });

    it('is sensitive to byte-level formatting, proving raw bytes are required', () => {
      // Re-serialising parsed JSON changes key order and whitespace. This test
      // documents *why* the controller must use `req.rawBody` and never
      // `JSON.stringify(req.body)`.
      const reserialised = JSON.stringify(JSON.parse(body), null, 2);
      expect(provider.verifySignature(Buffer.from(reserialised), sign(body))).toBe(false);
    });

    it('accepts a signature over `{timestamp}.{rawBody}`, the documented scheme', () => {
      const ts = '1789028677';
      const signature = sign(`${ts}.${body}`);
      expect(provider.verifySignature(Buffer.from(body), signature, ts)).toBe(true);
    });

    it('rejects a timestamped signature presented with a different timestamp', () => {
      // Otherwise the timestamp would be decoration: a captured webhook could be
      // replayed under any header value.
      const signature = sign(`1789028677.${body}`);
      expect(provider.verifySignature(Buffer.from(body), signature, '1789028678')).toBe(false);
    });

    it('rejects a timestamped signature when the timestamp header is missing', () => {
      const signature = sign(`1789028677.${body}`);
      expect(provider.verifySignature(Buffer.from(body), signature)).toBe(false);
    });

    it('fails closed when no webhook secret is configured', () => {
      const unconfigured = new FalconPayProvider(
        buildConfig({ webhookSecret: '' }),
        logger,
        metrics,
      );

      // An unconfigured secret must never mean "accept everything" — an accepted
      // forgery here settles a payout that never happened.
      expect(unconfigured.verifySignature(Buffer.from(body), sign(body))).toBe(false);
    });
  });

  // ===========================================================================
  //  Event parsing
  // ===========================================================================

  describe('event parsing', () => {
    const completed = {
      reference: 'PAY-20260806-a3f9c1',
      transaction_reference: 'FalconPay-NMB3K9XZ1A8QWERTY2',
      success: true,
      status: 'completed',
      session_id: '090405250416143700000000000000',
    };

    it('maps a completed payout', () => {
      const event = provider.parseEvent(completed);

      expect(event.status).toBe(PayoutEventStatus.Completed);
      expect(event.reference).toBe('PAY-20260806-a3f9c1');
      expect(event.providerReference).toBe('FalconPay-NMB3K9XZ1A8QWERTY2');
      expect(event.sessionId).toBe('090405250416143700000000000000');
      expect(event.rawEventType).toBe('payout.completed');
    });

    it.each([
      ['failed', PayoutEventStatus.Failed],
      ['processing', PayoutEventStatus.Processing],
    ])('maps status "%s"', (status, expected) => {
      expect(provider.parseEvent({ ...completed, status }).status).toBe(expected);
    });

    it('prefers the status field over the success boolean', () => {
      // A payload whose boolean disagrees with its status is exactly the case
      // where guessing wrong costs real money.
      const event = provider.parseEvent({ ...completed, status: 'failed', success: true });
      expect(event.status).toBe(PayoutEventStatus.Failed);
    });

    it('ignores an unrecognised status rather than guessing', () => {
      // Inventing "failed" from a status we do not understand would release a
      // hold on a transfer that may well have succeeded.
      const event = provider.parseEvent({ ...completed, status: 'quantum-superposition' });
      expect(event.status).toBe(PayoutEventStatus.Ignored);
    });

    it('falls back to the success boolean only when there is no status', () => {
      expect(provider.parseEvent({ reference: 'r', success: true }).status).toBe(
        PayoutEventStatus.Completed,
      );
      expect(provider.parseEvent({ reference: 'r', success: false }).status).toBe(
        PayoutEventStatus.Failed,
      );
      expect(provider.parseEvent({ reference: 'r' }).status).toBe(PayoutEventStatus.Ignored);
    });

    it('rejects a payload with no reference', () => {
      // Without our reference the event cannot be attributed to a payout, and
      // guessing from the amount is not a thing we will do with money.
      expect(() => provider.parseEvent({ status: 'completed' })).toThrow(AppException);
    });
  });

  // ===========================================================================
  //  Amount conversion — kobo in, whole naira out
  // ===========================================================================

  describe('transfer amounts', () => {
    const request = {
      reference: 'PAY-20260806-a3f9c1',
      amount: Money.fromNaira('5000'),
      bankCode: '058',
      accountNumber: '0123456789',
      accountName: 'John Doe',
      narration: 'Wallet withdrawal',
    };

    it('sends whole naira, not the kobo the wallet stores', async () => {
      const fetchMock = respondWith({
        success: true,
        message: 'Successful',
        data: { transaction_reference: 'FalconPay-XYZ', session_id: '0904' },
      });
      global.fetch = fetchMock;

      const acceptance = await provider.initiateTransfer(request);

      const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body)) as Record<string, unknown>;
      // ₦5,000 is 500000 kobo internally but must go out as 5000.
      expect(request.amount.kobo).toBe(500_000n);
      expect(body.amount).toBe(5000);
      expect(body.reference).toBe('PAY-20260806-a3f9c1');
      expect(body.sender_name).toBe('Acme Ltd');
      expect(acceptance.providerReference).toBe('FalconPay-XYZ');
      expect(acceptance.sessionId).toBe('0904');
      expect(acceptance.raw).toMatchObject({
        transaction_reference: 'FalconPay-XYZ',
        success: true,
        status: 'completed',
      });
    });

    it('authenticates with the API key, never the webhook secret', async () => {
      const fetchMock = respondWith({ success: true, data: {} });
      global.fetch = fetchMock;

      await provider.initiateTransfer(request);

      const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
      expect(headers['x-api-key']).toBe(API_KEY);
      expect(JSON.stringify(headers)).not.toContain(WEBHOOK_SECRET);
    });

    it('refuses a fractional-naira amount instead of silently truncating', async () => {
      global.fetch = respondWith({ success: true, data: {} });

      // Truncating would short the customer by 50 kobo and leave the ledger
      // disagreeing with the bank. Better to fail loudly.
      await expect(
        provider.initiateTransfer({ ...request, amount: Money.fromNaira('5000.50') }),
      ).rejects.toMatchObject({ code: ErrorCode.PAYOUT_AMOUNT_NOT_ALLOWED });
    });
  });

  // ===========================================================================
  //  Error translation — the distinctions that decide what happens to the hold
  // ===========================================================================

  describe('error translation', () => {
    const request = {
      reference: 'PAY-20260806-a3f9c1',
      amount: Money.fromNaira('5000'),
      bankCode: '058',
      accountNumber: '0123456789',
      accountName: 'John Doe',
      narration: 'Wallet withdrawal',
    };

    it('maps 409 to a duplicate reference, so the caller leaves the transfer alone', async () => {
      global.fetch = respondWith(
        {
          success: false,
          message: 'Duplicate reference for this business',
          error: 'DUPLICATE_REFERENCE',
        },
        { status: 409 },
      );

      await expect(provider.initiateTransfer(request)).rejects.toMatchObject({
        code: ErrorCode.PAYOUT_DUPLICATE_REFERENCE,
      });
    });

    it('maps 422 to a definite rejection, which is safe to refund', async () => {
      global.fetch = respondWith(
        { success: false, message: 'Business not onboarded', error: 'UNPROCESSABLE' },
        { status: 422 },
      );

      await expect(provider.initiateTransfer(request)).rejects.toMatchObject({
        code: ErrorCode.PAYOUT_REJECTED,
      });
    });

    it('surfaces Retry-After on a 429', async () => {
      global.fetch = respondWith(
        { success: false, message: 'Too many requests', error: 'RATE_LIMITED' },
        { status: 429, headers: { 'retry-after': '30' } },
      );

      await expect(provider.initiateTransfer(request)).rejects.toMatchObject({
        code: ErrorCode.RATE_LIMIT_EXCEEDED,
        details: { retryAfter: '30' },
      });
    });

    it('treats a 200 body with success:false as a failure', async () => {
      // The HTTP status alone is not the contract — the envelope is.
      global.fetch = respondWith({ success: false, message: 'Nope' });

      await expect(provider.initiateTransfer(request)).rejects.toBeInstanceOf(AppException);
    });

    it('reports a transfer timeout as an unknown outcome, never as a failure', async () => {
      const timeout = Object.assign(new Error('The operation was aborted'), {
        name: 'TimeoutError',
      });
      global.fetch = jest.fn().mockRejectedValue(timeout);

      // The instruction may have been queued even though the response was lost.
      // Calling this "failed" and releasing the hold is how money gets sent twice.
      await expect(provider.initiateTransfer(request)).rejects.toMatchObject({
        code: ErrorCode.PAYOUT_UNKNOWN_OUTCOME,
        retryable: false,
      });
    });

    it('reports a read timeout as a plain retryable upstream timeout', async () => {
      const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
      global.fetch = jest.fn().mockRejectedValue(timeout);

      // A GET moved no money, so it carries none of the ambiguity above.
      await expect(provider.listBanks()).rejects.toMatchObject({
        code: ErrorCode.UPSTREAM_TIMEOUT,
        retryable: true,
      });
    });
  });

  // ===========================================================================
  //  Reference data
  // ===========================================================================

  describe('bank list and name enquiry', () => {
    it('returns the bank list and drops unusable entries', async () => {
      global.fetch = respondWith({
        success: true,
        message: 'Successful',
        data: [
          { name: 'GTBank', code: '058' },
          { name: 'Access Bank', code: '044' },
          // A bank with no code could only ever produce a failed transfer.
          { name: 'Broken Bank' },
        ],
      });

      await expect(provider.listBanks()).resolves.toEqual([
        { name: 'GTBank', code: '058' },
        { name: 'Access Bank', code: '044' },
      ]);
    });

    it('accepts a bare JSON array from live FalconPay (no success envelope)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve([
            { name: 'Opay', code: '100004' },
            { name: 'GTBank', code: '058' },
            { name: 'No Code Bank' },
          ]),
      });

      await expect(provider.listBanks()).resolves.toEqual([
        { name: 'Opay', code: '100004' },
        { name: 'GTBank', code: '058' },
      ]);
    });

    it('resolves an account name and passes the enquiry as query parameters', async () => {
      const fetchMock = respondWith({
        success: true,
        message: 'Successful',
        data: { account_name: 'JOHN DOE', account_number: '0123456789', bank_code: '058' },
      });
      global.fetch = fetchMock;

      const resolved = await provider.resolveAccount('0123456789', '058');

      expect(resolved.accountName).toBe('JOHN DOE');
      expect(String(fetchMock.mock.calls[0]![0])).toBe(
        `${BASE_URL}/api/verify-bank?account_number=0123456789&bank_code=058`,
      );
    });

    it('treats a resolved-but-nameless account as not found', async () => {
      global.fetch = respondWith({ success: true, data: {} });

      // An empty name must never be sent as the recipient on a transfer.
      await expect(provider.resolveAccount('0123456789', '058')).rejects.toMatchObject({
        code: ErrorCode.RESOURCE_NOT_FOUND,
      });
    });

    it('does not put the full account number in the error details', async () => {
      global.fetch = respondWith({ success: true, data: {} });

      await expect(provider.resolveAccount('0123456789', '058')).rejects.toMatchObject({
        details: { accountNumber: '******6789' },
      });
    });
  });
});

import { createHmac } from 'node:crypto';

import type { PinoLogger } from 'nestjs-pino';

import type { AppConfig } from '../../config/app.config';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import type { MetricsService } from '../../infrastructure/observability/metrics.service';
import { WebhookEventKind } from './payment-provider.interface';
import { PayVesselClient } from './payvessel.client';
import { PayVesselProvider } from './payvessel.provider';

const API_KEY = 'PVKEY-0123456789abcdef';
const API_SECRET = 'PVSECRET-0123456789abcdef';
const BUSINESS_ID = '061C074E2F91F944B93993B4';

const buildConfig = (overrides: Partial<AppConfig['payments']['payvessel']> = {}) =>
  ({
    payments: {
      provider: 'payvessel',
      httpTimeoutMs: 10_000,
      webhookMaxAgeSeconds: 300,
      payvessel: {
        baseUrl: 'https://api.payvessel.com',
        kycBaseUrl: 'https://api.payvessel.com/kyc',
        apiKey: API_KEY,
        apiSecret: API_SECRET,
        businessId: BUSINESS_ID,
        staticBankCodes: ['999991', '120001'],
        dynamicBankCode: '120001',
        dynamicAccountTtlMinutes: 30,
        webhookIps: ['3.255.23.38', '162.246.254.36'],
        enforceWebhookIps: true,
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

const sign = (body: string, secret = API_SECRET) =>
  createHmac('sha512', secret).update(Buffer.from(body, 'utf8')).digest('hex');

/** A `fetch` stand-in returning one canned response. */
const respondWith = (body: unknown, status = 200) =>
  jest.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );

/** The JSON body of a captured `fetch` call. `RequestInit['body']` is a union that
 *  includes streams, so it is narrowed here once rather than cast at each use. */
const sentBody = (init: RequestInit): Record<string, unknown> =>
  JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<string, unknown>;

const build = (overrides: Partial<AppConfig['payments']['payvessel']> = {}) => {
  const config = buildConfig(overrides);
  return new PayVesselProvider(config, new PayVesselClient(config, logger, metrics), logger);
};

describe('PayVesselProvider', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  describe('createVirtualAccount', () => {
    const staticResponse = {
      status: true,
      service: 'CREATE_VIRTUAL_ACCOUNT',
      business: BUSINESS_ID,
      banks: [
        {
          bankName: '9Payment Service Bank',
          bankCode: '120001',
          accountNumber: '5030200545',
          accountName: 'JOHN DOE',
          account_type: 'STATIC',
          trackingReference: '40HTTGT96CDF360C3DRVGV3J',
        },
        {
          bankName: 'PalmPay',
          bankCode: '999991',
          accountNumber: '6030200545',
          accountName: 'JOHN DOE',
          account_type: 'STATIC',
          trackingReference: '50HTTGT96CDF360C3DRVGV3J',
        },
      ],
    };

    it('sends the BVN and every configured partner bank', async () => {
      const fetchMock = respondWith(staticResponse, 201);
      global.fetch = fetchMock;

      const account = await build().createVirtualAccount({
        userId: 'user-1',
        fullName: 'JOHN DOE',
        email: 'john@example.com',
        phoneE164: '+2348012345678',
        bvn: '22345678901',
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = sentBody(init);

      expect(body.account_type).toBe('STATIC');
      expect(body.bvn).toBe('22345678901');
      expect(body.bankcode).toEqual(['999991', '120001']);
      expect(body.businessid).toBe(BUSINESS_ID);
      expect((init.headers as Record<string, string>)['api-secret']).toBe(API_SECRET);

      // The first bank is the funding account; the rest stay in `raw`.
      expect(account.accountNumber).toBe('5030200545');
      expect(account.reference).toBe('40HTTGT96CDF360C3DRVGV3J');
    });

    it('strips formatting from an identifier before sending it', async () => {
      const fetchMock = respondWith(staticResponse, 201);
      global.fetch = fetchMock;

      await build().createVirtualAccount({
        userId: 'user-1',
        fullName: 'JOHN DOE',
        email: 'john@example.com',
        phoneE164: '+2348012345678',
        bvn: '223-4567 8901',
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(sentBody(init).bvn).toBe('22345678901');
    });

    it('refuses without a BVN or NIN, before spending a provider call', async () => {
      const fetchMock = respondWith(staticResponse, 201);
      global.fetch = fetchMock;

      await expect(
        build().createVirtualAccount({
          userId: 'user-1',
          fullName: 'JOHN DOE',
          email: 'john@example.com',
          phoneE164: '+2348012345678',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.PRECONDITION_FAILED });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a 200 that carries no account rather than storing an empty NUBAN', async () => {
      global.fetch = respondWith({ status: true, banks: [] }, 200);

      await expect(
        build().createVirtualAccount({
          userId: 'user-1',
          fullName: 'JOHN DOE',
          email: 'john@example.com',
          phoneE164: '+2348012345678',
          nin: '12345678901',
        }),
      ).rejects.toBeInstanceOf(AppException);
    });

    it('surfaces the provider’s field errors without leaking the credential', async () => {
      global.fetch = respondWith(
        {
          status: false,
          service: 'CREATE_VIRTUAL_ACCOUNT',
          message: 'Invalid payload',
          errors: { bvn: ['BVN is mandatory for STATIC accounts'] },
        },
        400,
      );

      await expect(
        build().createVirtualAccount({
          userId: 'user-1',
          fullName: 'JOHN DOE',
          email: 'john@example.com',
          phoneE164: '+2348012345678',
          bvn: '22345678901',
        }),
      ).rejects.toMatchObject({
        code: ErrorCode.UPSTREAM_ERROR,
        details: { providerMessage: expect.stringContaining('BVN is mandatory') },
      });
    });
  });

  describe('createDynamicAccount', () => {
    it('asks for one bank, sends no identity, and returns the expiry', async () => {
      const fetchMock = respondWith(
        {
          status: true,
          service: 'CREATE_VIRTUAL_ACCOUNT',
          business: BUSINESS_ID,
          // Dynamic responses carry a bare object where static carries an array.
          banks: {
            bankCode: '120001',
            bankName: '9Payment Service Bank',
            accountNumber: '5030200545',
            accountName: 'Demo User',
            account_type: 'DYNAMIC',
            expire_date: '2026-05-15T11:49:36.117753+01:00',
            trackingReference: 'YOINFKVRO90311273BD8DZZ9',
          },
        },
        201,
      );
      global.fetch = fetchMock;

      const account = await build().createDynamicAccount({
        orderRef: 'ord_123',
        fullName: 'Demo User',
        email: 'demo@example.com',
        phoneE164: '+2348012345678',
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = sentBody(init);

      expect(body.account_type).toBe('DYNAMIC');
      expect(body.bankcode).toEqual(['120001']);
      expect(body).not.toHaveProperty('bvn');
      expect(body).not.toHaveProperty('nin');

      expect(account.accountNumber).toBe('5030200545');
      expect(account.expiresAt?.toISOString()).toBe('2026-05-15T10:49:36.117Z');
    });
  });

  describe('verifySignature', () => {
    const body = JSON.stringify({ event: 'transaction.success' });

    it('accepts an HMAC-SHA512 digest of the exact bytes received', () => {
      expect(build().verifySignature(Buffer.from(body, 'utf8'), sign(body))).toBe(true);
    });

    it('rejects a digest computed with a different secret', () => {
      expect(build().verifySignature(Buffer.from(body, 'utf8'), sign(body, 'other'))).toBe(false);
    });

    it('rejects a body whose whitespace changed after signing', () => {
      const resigned = sign(JSON.stringify(JSON.parse(body), null, 2));
      expect(build().verifySignature(Buffer.from(body, 'utf8'), resigned)).toBe(false);
    });

    it('rejects a missing signature', () => {
      expect(build().verifySignature(Buffer.from(body, 'utf8'), undefined)).toBe(false);
    });

    it('fails closed when no secret is configured', () => {
      const provider = build({ apiSecret: '' });
      expect(provider.verifySignature(Buffer.from(body, 'utf8'), sign(body))).toBe(false);
    });
  });

  describe('isTrustedSource', () => {
    it('accepts a listed address', () => {
      expect(build().isTrustedSource('3.255.23.38')).toBe(true);
    });

    it('accepts an IPv4-mapped IPv6 form of a listed address', () => {
      expect(build().isTrustedSource('::ffff:162.246.254.36')).toBe(true);
    });

    it('rejects anything else', () => {
      expect(build().isTrustedSource('203.0.113.7')).toBe(false);
      expect(build().isTrustedSource(undefined)).toBe(false);
    });

    it('accepts everything when the allowlist is explicitly disabled', () => {
      expect(build({ enforceWebhookIps: false }).isTrustedSource('203.0.113.7')).toBe(true);
    });
  });

  describe('parseEvent', () => {
    const credit = {
      event: 'transaction.success',
      order: {
        amount: '50000.00',
        settlement_amount: '48500.00',
        fee: '1500.00',
        currency: 'NGN',
        status: 'completed',
      },
      transaction: {
        reference: 'TXN_2024_001',
        status: 'success',
        account_number: '5030200545',
        trackingReference: '40HTTGT96CDF360C3DRVGV3J',
        paid_at: '2024-02-14T10:36:42Z',
        sender: { name: 'ADA OKAFOR', bank: 'GTBank' },
      },
    };

    it('normalises a reserved-account credit', () => {
      const event = build().parseEvent(credit);

      expect(event.kind).toBe(WebhookEventKind.FundingReceived);
      expect(event.providerEventId).toBe('transaction.success:TXN_2024_001');
      expect(event.transfer?.reference).toBe('TXN_2024_001');
      expect(event.transfer?.destinationAccountNumber).toBe('5030200545');
      expect(event.transfer?.destinationAccountReference).toBe('40HTTGT96CDF360C3DRVGV3J');
      expect(event.transfer?.senderName).toBe('ADA OKAFOR');
    });

    it('credits the gross amount, not the settlement amount', () => {
      // The customer is credited what they sent; the provider fee is the
      // business's cost and is reconciled from the ledger metadata.
      const event = build().parseEvent(credit);
      expect(event.transfer?.amount.toDecimalString()).toBe('50000.00');
    });

    it('parses naira decimals without float rounding', () => {
      const event = build().parseEvent({
        ...credit,
        order: { ...credit.order, amount: '0.10' },
      });
      expect(event.transfer?.amount.kobo).toBe(10n);
    });

    it('ignores a success-named event whose transaction did not succeed', () => {
      const event = build().parseEvent({
        ...credit,
        transaction: { ...credit.transaction, status: 'failed' },
      });
      expect(event.kind).toBe(WebhookEventKind.Ignored);
    });

    it('ignores event types we do not act on, but records their names', () => {
      const event = build().parseEvent({ ...credit, event: 'reserved_account.debit' });
      expect(event.kind).toBe(WebhookEventKind.Ignored);
      expect(event.rawEventType).toBe('reserved_account.debit');
    });

    it('refuses a credit with no reference — there would be no idempotency key', () => {
      expect(() => build().parseEvent({ ...credit, transaction: { status: 'success' } })).toThrow(
        AppException,
      );
    });

    it('refuses a credit with no amount', () => {
      expect(() => build().parseEvent({ ...credit, order: { currency: 'NGN' } })).toThrow(
        AppException,
      );
    });
  });
});

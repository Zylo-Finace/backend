import { createHmac } from 'node:crypto';

import type { PinoLogger } from 'nestjs-pino';

import type { AppConfig } from '../../config/app.config';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { Money } from '../../core/money/money';
import type { MetricsService } from '../../infrastructure/observability/metrics.service';
import { WebhookEventKind } from './payment-provider.interface';
import { PulseMfbClient, PULSE_API_PREFIX } from './pulsemfb.client';
import {
  PulseMfbProvider,
  PulseTransferDirection,
  accountReference,
  classifyTransferEvent,
  parseNairaAmount,
  toLocalMsisdn,
} from './pulsemfb.provider';

const PUBLIC_KEY = 'pk_test_abc123';
const PRIVATE_KEY = 'stripe_dummy_test_xyz789';
const WEBHOOK_SECRET = 'whsec_dummy_test_0123456789abcdef';
const BASE_URL = 'https://test-api.pulsemfb.example';
const FLOAT_ACCOUNT = '9990000001';

const buildConfig = (overrides: Partial<AppConfig['pulsemfb']> = {}) =>
  ({
    pulsemfb: {
      baseUrl: BASE_URL,
      publicKey: PUBLIC_KEY,
      privateKey: PRIVATE_KEY,
      apiKey: '',
      webhookSecret: WEBHOOK_SECRET,
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

/**
 * A `fetch` stand-in returning one canned response.
 *
 * A fresh `Response` per call, not a shared one: a body stream can only be read
 * once, so reusing the object makes every call after the first look like a
 * malformed reply.
 */
const respondWith = (body: unknown, status = 200) =>
  jest.fn().mockImplementation(
    () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );

const build = (config = buildConfig()) =>
  new PulseMfbProvider(config, new PulseMfbClient(config, logger, metrics), logger);

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

describe('PulseMfbProvider', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  // ===========================================================================
  //  Request signing — a drift here fails every call as a blanket 401
  // ===========================================================================

  describe('request signing', () => {
    it('signs timestamp + method + path + the exact body it sends', async () => {
      const fetchMock = respondWith({
        statusCode: 201,
        data: { account_number: '9995734440', account_name: "CAL'/'Dayo Ojo", reference: 'x' },
      });
      global.fetch = fetchMock;

      await build().createVirtualAccount({
        userId: 'user-1',
        fullName: 'Dayo Ojo',
        email: 'dayo@example.com',
        phoneE164: '+2348055940326',
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      const sentBody = init.body as string;

      const expected = createHmac('sha256', PRIVATE_KEY)
        .update(`${headers['x-timestamp']}POST${PULSE_API_PREFIX}/accounts/prefix${sentBody}`)
        .digest('hex');

      expect(headers['x-signature']).toBe(expected);
      expect(headers['x-public-key']).toBe(PUBLIC_KEY);
    });

    it('omits x-api-key unless one is configured', async () => {
      global.fetch = respondWith({ data: { account_number: '9995734440' } });

      await build().createVirtualAccount({
        userId: 'u',
        fullName: 'A B',
        email: 'a@b.c',
        phoneE164: '+2348055940326',
      });

      const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
      expect(init.headers).not.toHaveProperty('x-api-key');
    });

    it('fails before the round trip when no key pair is configured', async () => {
      global.fetch = jest.fn();
      const provider = build(buildConfig({ privateKey: '' }));

      await expect(
        provider.createVirtualAccount({
          userId: 'u',
          fullName: 'A B',
          email: 'a@b.c',
          phoneE164: '+2348055940326',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.UPSTREAM_ERROR });

      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  //  Account issuance
  // ===========================================================================

  describe('createVirtualAccount', () => {
    it('supplies the bank identity from config, since Pulse names none', async () => {
      global.fetch = respondWith({
        data: {
          account_number: '9995734440',
          account_name: "CAL'/'Dayo Ojo",
          reference: 'ACC-user-1',
        },
      });

      const account = await build().createVirtualAccount({
        userId: 'user-1',
        fullName: 'Dayo Ojo',
        email: 'dayo@example.com',
        phoneE164: '+2348055940326',
      });

      expect(account).toMatchObject({
        accountNumber: '9995734440',
        // Stored prefixed, exactly as the sender's bank will display it.
        accountName: "CAL'/'Dayo Ojo",
        bankCode: '090713',
        bankName: 'Pulse MFB',
        currency: 'NGN',
      });
    });

    it('sends a stable reference derived from the user id', async () => {
      const fetchMock = respondWith({ data: { account_number: '9995734440' } });
      global.fetch = fetchMock;

      await build().createVirtualAccount({
        userId: 'user-42',
        fullName: 'Dayo Ojo',
        email: 'dayo@example.com',
        phoneE164: '+2348055940326',
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toMatchObject({
        reference: accountReference('user-42'),
        customer_phone: '08055940326',
      });
    });

    it('forwards a BVN when we hold one, and omits it otherwise', async () => {
      const fetchMock = respondWith({ data: { account_number: '9995734440' } });
      global.fetch = fetchMock;

      const provider = build();
      const base = {
        userId: 'u',
        fullName: 'A B',
        email: 'a@b.c',
        phoneE164: '+2348055940326',
      };

      await provider.createVirtualAccount({ ...base, bvn: '12345678901' });
      await provider.createVirtualAccount(base);

      const [first, second] = fetchMock.mock.calls.map(
        ([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>,
      );
      expect(first).toMatchObject({ bvn: '12345678901' });
      expect(second).not.toHaveProperty('bvn');
    });

    it('rejects a malformed account number rather than showing it to a customer', async () => {
      global.fetch = respondWith({ data: { account_number: '123' } });

      await expect(
        build().createVirtualAccount({
          userId: 'u',
          fullName: 'A B',
          email: 'a@b.c',
          phoneE164: '+2348055940326',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.UPSTREAM_ERROR });
    });

    it('marks a 4xx as non-retryable and a 5xx as retryable', async () => {
      global.fetch = respondWith({ message: 'Validation failed' }, 400);
      await expect(
        build().createVirtualAccount({
          userId: 'u',
          fullName: 'A B',
          email: 'a@b.c',
          phoneE164: '+2348055940326',
        }),
      ).rejects.toMatchObject({ retryable: false });

      global.fetch = respondWith({ message: 'boom' }, 500);
      await expect(
        build().createVirtualAccount({
          userId: 'u',
          fullName: 'A B',
          email: 'a@b.c',
          phoneE164: '+2348055940326',
        }),
      ).rejects.toMatchObject({ retryable: true });
    });
  });

  // ===========================================================================
  //  Webhook signature — the only authentication on that route
  // ===========================================================================

  describe('verifySignature', () => {
    const body = JSON.stringify({ event: 'account.created', data: { reference: 'ACC-1' } });
    const sign = (payload: string, secret = WEBHOOK_SECRET) =>
      createHmac('sha256', secret).update(Buffer.from(payload, 'utf8')).digest('hex');

    it('accepts a correctly signed body', () => {
      expect(build().verifySignature(Buffer.from(body), sign(body))).toBe(true);
    });

    it('rejects a body signed with the wrong secret', () => {
      expect(build().verifySignature(Buffer.from(body), sign(body, 'other'))).toBe(false);
    });

    it('rejects a tampered body', () => {
      const signature = sign(body);
      const tampered = body.replace('ACC-1', 'ACC-2');
      expect(build().verifySignature(Buffer.from(tampered), signature)).toBe(false);
    });

    it('rejects a missing signature', () => {
      expect(build().verifySignature(Buffer.from(body), undefined)).toBe(false);
    });

    it('fails closed when no secret is configured', () => {
      const provider = build(buildConfig({ webhookSecret: '' }));
      expect(provider.verifySignature(Buffer.from(body), sign(body))).toBe(false);
    });

    it('verifies the raw bytes, not a re-serialisation', () => {
      // The same JSON document, pretty-printed as a provider might well send it.
      // Re-serialising drops the whitespace and changes the digest, which is
      // exactly how a "verify `JSON.stringify(req.body)`" implementation rejects
      // every legitimate webhook.
      const raw = '{\n  "a": 1,\n  "b": 2\n}';
      const signature = sign(raw);
      const reserialised = JSON.stringify(JSON.parse(raw) as unknown);

      expect(raw).not.toBe(reserialised);
      expect(build().verifySignature(Buffer.from(raw), signature)).toBe(true);
      expect(build().verifySignature(Buffer.from(reserialised), signature)).toBe(false);
    });
  });

  // ===========================================================================
  //  Event parsing
  // ===========================================================================

  describe('parseEvent', () => {
    it('maps account.created to an assignment and recovers the user id', () => {
      const event = build().parseEvent({
        event: 'account.created',
        data: { account_number: '9995734440', account_name: 'X', reference: 'ACC-user-7' },
      });

      expect(event.kind).toBe(WebhookEventKind.AccountAssigned);
      expect(event.accountAssignment?.userId).toBe('user-7');
    });

    it('reports assignment failure when the account number is unusable', () => {
      const event = build().parseEvent({
        event: 'account.created',
        data: { account_number: 'nope', reference: 'ACC-user-7' },
      });

      expect(event.kind).toBe(WebhookEventKind.AccountAssignmentFailed);
    });

    it('maps an inbound credit to funding, in kobo', () => {
      const event = build().parseEvent({
        event: 'transfer.completed',
        timestamp: '2026-08-15T10:00:00Z',
        data: {
          reference: 'FT123',
          amount: 5000,
          debit_account: '0111111111',
          credit_account: '9995734440',
          narration: 'From JOHN DOE',
        },
      });

      expect(event.kind).toBe(WebhookEventKind.FundingReceived);
      expect(event.transfer?.amount.kobo).toBe(500_000n);
      expect(event.transfer?.destinationAccountNumber).toBe('9995734440');
    });

    it('refuses a credit missing the fields it would have to guess', () => {
      expectThrowsCode(
        () =>
          build().parseEvent({
            event: 'transfer.completed',
            data: { credit_account: '9995734440' },
          }),
        ErrorCode.VALIDATION_FAILED,
      );
    });

    it.each(['vas.completed', 'vas.failed', 'transfer.failed', 'something.new'])(
      'ignores %s on the inbound leg',
      (eventName) => {
        expect(build().parseEvent({ event: eventName, data: {} }).kind).toBe(
          WebhookEventKind.Ignored,
        );
      },
    );
  });

  // ===========================================================================
  //  Direction classification — one event type, two directions
  // ===========================================================================

  describe('classifyTransferEvent', () => {
    it('reads a debit of our float as one of our payouts', () => {
      expect(
        classifyTransferEvent(
          { data: { debit_account: FLOAT_ACCOUNT, credit_account: '0111111111' } },
          FLOAT_ACCOUNT,
        ),
      ).toBe(PulseTransferDirection.Outbound);
    });

    it('reads a credit to any other account as customer funding', () => {
      expect(
        classifyTransferEvent(
          { data: { debit_account: '0111111111', credit_account: '9995734440' } },
          FLOAT_ACCOUNT,
        ),
      ).toBe(PulseTransferDirection.Inbound);
    });

    it('refuses to classify when neither side is ours', () => {
      expect(classifyTransferEvent({ data: { debit_account: '0111111111' } }, FLOAT_ACCOUNT)).toBe(
        PulseTransferDirection.Unrelated,
      );
    });

    it('does not read a credit to our own float as customer funding', () => {
      expect(
        classifyTransferEvent({ data: { credit_account: FLOAT_ACCOUNT } }, FLOAT_ACCOUNT),
      ).toBe(PulseTransferDirection.Unrelated);
    });
  });

  // ===========================================================================
  //  Helpers
  // ===========================================================================

  describe('parseNairaAmount', () => {
    it('reads whole and fractional naira without float drift', () => {
      expect(parseNairaAmount(5000)?.kobo).toBe(500_000n);
      expect(parseNairaAmount('50000.00')?.kobo).toBe(5_000_000n);
      // The case a naive `* 100` gets wrong: 5000.07 * 100 === 500006.9999…
      expect(parseNairaAmount(5000.07)?.kobo).toBe(500_007n);
    });

    it('returns undefined for anything unparseable', () => {
      expect(parseNairaAmount('N5,000')).toBeUndefined();
      expect(parseNairaAmount(null)).toBeUndefined();
      expect(parseNairaAmount({})).toBeUndefined();
    });
  });

  describe('toLocalMsisdn', () => {
    it.each([
      ['+2348055940326', '08055940326'],
      ['2348055940326', '08055940326'],
      ['08055940326', '08055940326'],
      ['8055940326', '08055940326'],
    ])('converts %s to %s', (input, expected) => {
      expect(toLocalMsisdn(input)).toBe(expected);
    });
  });

  it('reports Money in kobo throughout, never naira', () => {
    // Guards the one conversion mistake that would silently multiply or divide
    // every funding credit by 100.
    expect(Money.fromNaira('1').kobo).toBe(100n);
  });
});

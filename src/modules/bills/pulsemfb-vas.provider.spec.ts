import type { PinoLogger } from 'nestjs-pino';

import type { AppConfig } from '../../config/app.config';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { Money } from '../../core/money/money';
import type { MetricsService } from '../../infrastructure/observability/metrics.service';
import { PulseMfbClient } from '../payments/pulsemfb.client';
import { BillOrderStatus, MobileNetwork } from './bills-provider.interface';
import {
  PulseMfbVasProvider,
  decodePlanCode,
  encodePlanCode,
  isPulseMfbPlanCode,
} from './pulsemfb-vas.provider';

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
      debitAccountNumber: '9990000001',
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

const respondWith = (body: unknown, status = 200) =>
  jest.fn().mockImplementation(
    () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );

const build = (config = buildConfig()) =>
  new PulseMfbVasProvider(config, new PulseMfbClient(config, logger, metrics), logger);

describe('PulseMfbVasProvider', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  // ===========================================================================
  //  Plan codes — the guard against delivering another provider's bundle
  // ===========================================================================

  describe('plan codes', () => {
    it('round-trips through the namespaced form', () => {
      const code = encodePlanCode('mtn', '1GB-30days');
      expect(code).toBe('pm:mtn:1GB-30days');
      expect(decodePlanCode(code)).toEqual({ networkSlug: 'mtn', planId: '1GB-30days' });
    });

    it.each(['sp:1:3', '3', '', 'pm:mtn', 'pm::x', 'ck:1GB'])('does not claim %s', (code) => {
      expect(isPulseMfbPlanCode(code)).toBe(false);
    });

    it('refuses to buy against another provider’s code', async () => {
      global.fetch = jest.fn();

      await expect(
        build().buyData({
          reference: 'r1',
          network: MobileNetwork.Mtn,
          planCode: 'sp:1:3',
          phoneNumber: '08055940326',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.BILL_PRODUCT_NOT_FOUND });

      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  //  Orders — acceptance is not delivery
  // ===========================================================================

  describe('orders', () => {
    it('maps a pending purchase to Processing, never to Completed', async () => {
      global.fetch = respondWith({
        data: { reference: 'AIR123', status: 'pending', amount: 1000 },
      });

      const order = await build().buyAirtime({
        reference: 'r1',
        network: MobileNetwork.Mtn,
        amount: Money.fromNaira('1000'),
        phoneNumber: '08055940326',
      });

      // Reporting delivery here would tell a customer their airtime landed while
      // the network was still deciding — and would leave nothing to refund when
      // it later failed.
      expect(order.status).toBe(BillOrderStatus.Processing);
      expect(order.providerOrderId).toBe('AIR123');
    });

    it('sends the network slug, naira amount and float account', async () => {
      const fetchMock = respondWith({ data: { reference: 'AIR1', status: 'pending' } });
      global.fetch = fetchMock;

      await build().buyAirtime({
        reference: 'r1',
        network: MobileNetwork.NineMobile,
        amount: Money.fromNaira('500'),
        phoneNumber: '08055940326',
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toMatchObject({
        provider: '9mobile',
        amount: 500,
        phone_number: '08055940326',
        debit_account_id: 'acct_float_1',
      });
    });

    it('sends the decoded plan id for data', async () => {
      const fetchMock = respondWith({ data: { reference: 'DATA1', status: 'pending' } });
      global.fetch = fetchMock;

      await build().buyData({
        reference: 'r1',
        network: MobileNetwork.Mtn,
        planCode: 'pm:mtn:1GB-30days',
        phoneNumber: '08055940326',
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toMatchObject({
        provider: 'mtn',
        data_plan: '1GB-30days',
      });
    });

    it('refuses a fractional naira airtime amount', async () => {
      global.fetch = jest.fn();

      await expect(
        build().buyAirtime({
          reference: 'r1',
          network: MobileNetwork.Mtn,
          amount: Money.fromKobo(100_050n),
          phoneNumber: '08055940326',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.BILL_AMOUNT_NOT_ALLOWED });
    });

    it('reports a lost order as unknown, never as failed', async () => {
      global.fetch = jest
        .fn()
        .mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));

      // A refund on a bundle that was actually delivered is unrecoverable.
      await expect(
        build().buyAirtime({
          reference: 'r1',
          network: MobileNetwork.Mtn,
          amount: Money.fromNaira('1000'),
          phoneNumber: '08055940326',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.BILL_ORDER_UNKNOWN_OUTCOME });
    });

    it('maps an exhausted float to a retryable float error', async () => {
      global.fetch = respondWith({ message: 'Insufficient balance. Required: ₦1,000.00' }, 400);

      await expect(
        build().buyAirtime({
          reference: 'r1',
          network: MobileNetwork.Mtn,
          amount: Money.fromNaira('1000'),
          phoneNumber: '08055940326',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.BILL_PROVIDER_FLOAT_EXHAUSTED });
    });
  });

  // ===========================================================================
  //  Catalogue — shape is undocumented, so parsing is defensive
  // ===========================================================================

  describe('fetchDataPlans', () => {
    const bundle = {
      data_plan: '1GB-30days',
      name: '1GB - 30 days',
      amount: 300,
      provider: 'mtn',
    };

    it.each([
      ['a bare array', [bundle]],
      ['a bundles wrapper', { bundles: [bundle] }],
      ['a plans wrapper', { plans: [bundle] }],
      ['a per-network map', { mtn: [{ ...bundle, provider: undefined }] }],
    ])('reads %s', async (_label, payload) => {
      global.fetch = respondWith({ data: payload });

      const plans = await build().fetchDataPlans();

      expect(plans).toHaveLength(1);
      expect(plans[0]).toMatchObject({
        network: MobileNetwork.Mtn,
        networkName: 'MTN',
        code: 'pm:mtn:1GB-30days',
      });
      expect(plans[0]!.price.kobo).toBe(30_000n);
    });

    it('skips entries missing anything a customer is charged on', async () => {
      global.fetch = respondWith({
        data: [
          bundle,
          { ...bundle, amount: undefined },
          { ...bundle, provider: 'starlink' },
          { ...bundle, data_plan: undefined, code: undefined, id: undefined },
        ],
      });

      await expect(build().fetchDataPlans()).resolves.toHaveLength(1);
    });

    it('fails rather than presenting an empty catalogue as real', async () => {
      global.fetch = respondWith({ data: [] });

      await expect(build().fetchDataPlans()).rejects.toMatchObject({
        code: ErrorCode.UPSTREAM_ERROR,
      });
    });
  });

  // ===========================================================================
  //  Float
  // ===========================================================================

  describe('getFloatBalance', () => {
    it('reads the available balance, not the ledger one', async () => {
      global.fetch = respondWith({
        data: { available_balance: 50_000.0, ledger_balance: 75_000.0, currency: 'NGN' },
      });

      const balance = await build().getFloatBalance();
      expect(balance.kobo).toBe(5_000_000n);
    });

    it('abstains when only the account id is configured', async () => {
      global.fetch = jest.fn();

      await expect(
        build(buildConfig({ debitAccountNumber: '' })).getFloatBalance(),
      ).rejects.toMatchObject({ code: ErrorCode.SERVICE_UNAVAILABLE });
    });
  });

  // ===========================================================================
  //  Callbacks
  // ===========================================================================

  describe('parseCallback', () => {
    it.each([
      ['vas.completed', BillOrderStatus.Completed],
      ['vas.failed', BillOrderStatus.Failed],
    ])('lets %s outrank a stale body status', (event, expected) => {
      const callback = build().parseCallback({
        event,
        data: { reference: 'AIR123', status: 'pending' },
      });

      expect(callback.status).toBe(expected);
      expect(callback.reference).toBe('AIR123');
    });

    it('reports an unrecognised status as Unknown, which is not refundable', () => {
      const callback = build().parseCallback({
        event: 'vas.something',
        data: { reference: 'AIR123', status: 'quantum' },
      });

      expect(callback.status).toBe(BillOrderStatus.Unknown);
    });
  });
});

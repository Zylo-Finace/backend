import type { PinoLogger } from 'nestjs-pino';

import type { AppConfig } from '../../config/app.config';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { Money } from '../../core/money/money';
import type { MetricsService } from '../../infrastructure/observability/metrics.service';
import { BillOrderStatus, MobileNetwork } from './bills-provider.interface';
import { SmePlugClient } from './smeplug.client';
import { decodePlanCode, SmePlugProvider } from './smeplug.provider';

const SECRET_KEY = 'sk_smeplug_0123456789abcdef';

const buildConfig = (overrides: Partial<AppConfig['bills']['smeplug']> = {}) =>
  ({
    bills: {
      provider: 'smeplug',
      fallbackProvider: 'clubkonnect',
      httpTimeoutMs: 10_000,
      floatReserveNaira: 1_000,
      balanceCacheSeconds: 15,
      catalogueCacheSeconds: 3_600,
      smeplug: {
        baseUrl: 'https://smeplug.ng/api/v1',
        secretKey: SECRET_KEY,
        webhookSecret: 'w'.repeat(32),
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

/** A `fetch` stand-in returning one canned response (fresh body each call). */
const respondWith = (body: unknown, status = 200) =>
  jest.fn().mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );

/** The JSON body of a captured `fetch` call, narrowed once rather than per use. */
const sentBody = (init: RequestInit): Record<string, unknown> =>
  JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<string, unknown>;

const build = (overrides: Partial<AppConfig['bills']['smeplug']> = {}) => {
  const config = buildConfig(overrides);
  return new SmePlugProvider(new SmePlugClient(config, logger, metrics), logger);
};

/** The catalogue shape: plans keyed by SMEPlug's numeric network id. */
const PLANS_RESPONSE = {
  status: true,
  data: {
    '1': [
      { id: '1', name: '500MB [SME]', price: '220', telco_price: '0' },
      { id: '2', name: '1GB [SME]', price: '410', telco_price: '0' },
    ],
    '4': [{ id: '9', name: '2GB [SME]', price: '800', telco_price: '0' }],
  },
};

describe('SmePlugProvider', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  describe('getFloatBalance', () => {
    it('reads the top-level balance, which uses no envelope', async () => {
      global.fetch = respondWith({ balance: 3229.12 });

      const balance = await build().getFloatBalance();

      expect(balance.toDecimalString()).toBe('3229.12');
    });

    it('sends the secret key as a bearer token', async () => {
      const fetchMock = respondWith({ balance: 100 });
      global.fetch = fetchMock;

      await build().getFloatBalance();

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://smeplug.ng/api/v1/account/balance');
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET_KEY}`);
    });

    it('converts through a decimal string so no float reaches a balance', async () => {
      global.fetch = respondWith({ balance: 0.1 });

      expect((await build().getFloatBalance()).kobo).toBe(10n);
    });

    it('fails when no balance is reported rather than assuming zero', async () => {
      // Assuming zero would stop every sale; assuming anything else would let
      // orders through against a float we cannot see.
      global.fetch = respondWith({});

      await expect(build().getFloatBalance()).rejects.toBeInstanceOf(AppException);
    });

    it('fails closed when no secret key is configured', async () => {
      const fetchMock = respondWith({ balance: 100 });
      global.fetch = fetchMock;

      await expect(build({ secretKey: '' }).getFloatBalance()).rejects.toMatchObject({
        code: ErrorCode.SERVICE_UNAVAILABLE,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('fetchDataPlans', () => {
    it('flattens the per-network map and maps network ids to our enum', async () => {
      global.fetch = respondWith(PLANS_RESPONSE);

      const plans = await build().fetchDataPlans();

      expect(plans).toHaveLength(3);
      expect(plans[0]).toMatchObject({
        network: MobileNetwork.Mtn,
        networkName: 'MTN',
        name: '500MB [SME]',
      });
      expect(plans[0]!.price.toDecimalString()).toBe('220.00');
      // SMEPlug's `4` is Glo, not our `04` (Airtel) — the mapping is not identity.
      expect(plans[2]!.network).toBe(MobileNetwork.Glo);
    });

    it('namespaces plan codes so the two catalogues cannot collide', async () => {
      global.fetch = respondWith(PLANS_RESPONSE);

      const plans = await build().fetchDataPlans();

      expect(plans[0]!.code).toBe('sp:1:1');
      expect(decodePlanCode(plans[0]!.code)).toEqual({ networkId: '1', planId: '1' });
      // A bare ClubKonnect code must not decode as one of ours.
      expect(decodePlanCode('1')).toBeNull();
    });

    it('skips a network id it does not recognise rather than guessing', async () => {
      // An unknown id means SMEPlug added a network; inventing a mapping would
      // route real orders to the wrong one.
      global.fetch = respondWith({
        status: true,
        data: { '9': [{ id: '1', name: '1GB', price: '400' }], ...PLANS_RESPONSE.data },
      });

      const plans = await build().fetchDataPlans();

      expect(plans).toHaveLength(3);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('refuses an empty catalogue rather than showing a customer no plans', async () => {
      global.fetch = respondWith({ status: true, data: {} });

      await expect(build().fetchDataPlans()).rejects.toBeInstanceOf(AppException);
    });

    it('refuses a 200 that carries status:false', async () => {
      global.fetch = respondWith({ status: false, msg: 'Unauthorised' });

      await expect(build().fetchDataPlans()).rejects.toMatchObject({
        details: { providerMessage: 'Unauthorised' },
      });
    });
  });

  describe('buyAirtime', () => {
    it('sends whole naira, the mapped network id and our reference', async () => {
      const fetchMock = respondWith({
        status: true,
        data: { reference: '53d202a6f23740ed2828', msg: '20 airtime purchase for 09061668519' },
      });
      global.fetch = fetchMock;

      const order = await build().buyAirtime({
        reference: 'ord_1',
        network: MobileNetwork.Airtel,
        amount: Money.fromNaira('500'),
        phoneNumber: '09061668519',
      });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = sentBody(init);

      // Prefer Share & Sell VTU before Wallet /airtime/purchase.
      expect(url).toBe('https://smeplug.ng/api/v1/vtu');
      // Naira, not kobo. Sending kobo here bills the customer a hundredfold.
      expect(body.amount).toBe(500);
      expect(body.network_id).toBe(2);
      expect(body.phone_number).toBe('09061668519');

      expect(order.status).toBe(BillOrderStatus.Completed);
      expect(order.providerOrderId).toBe('53d202a6f23740ed2828');
    });

    it('treats a 200 with status:false as a terminal decline, not an exception', async () => {
      // VTU then Wallet both decline — Failed order so the router can fall back.
      global.fetch = respondWith({ status: false, msg: 'Insufficient balance' });

      const order = await build().buyAirtime({
        reference: 'ord_2',
        network: MobileNetwork.Mtn,
        amount: Money.fromNaira('100'),
        phoneNumber: '08012345678',
      });

      expect(order.status).toBe(BillOrderStatus.Failed);
      expect(order.remark).toBe('Insufficient balance');
      expect(order.reference).toBe('ord_2');
      // VTU attempt + Wallet fallback.
      expect((global.fetch as jest.Mock).mock.calls).toHaveLength(2);
      expect((global.fetch as jest.Mock).mock.calls[0]![0]).toBe('https://smeplug.ng/api/v1/vtu');
      expect((global.fetch as jest.Mock).mock.calls[1]![0]).toBe(
        'https://smeplug.ng/api/v1/airtime/purchase',
      );
    });
  });

  describe('buyData', () => {
    it('decodes our namespaced plan code back into network and plan ids', async () => {
      const fetchMock = respondWith({
        status: true,
        data: { reference: '49e2e6ea701054ff164c', msg: 'You have successfully transferred 500MB' },
      });
      global.fetch = fetchMock;

      await build().buyData({
        reference: 'ord_3',
        network: MobileNetwork.Mtn,
        planCode: 'sp:1:7',
        phoneNumber: '08012345678',
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = sentBody(init);

      expect(body.network_id).toBe(1);
      expect(body.plan_id).toBe(7);
      expect(body.phone).toBe('08012345678');
    });

    it('refuses a plan code belonging to the other provider', async () => {
      // Reaching here means the router misrouted. Delivering *some* bundle would
      // be worse than delivering none.
      const fetchMock = respondWith({ status: true, data: {} });
      global.fetch = fetchMock;

      await expect(
        build().buyData({
          reference: 'ord_4',
          network: MobileNetwork.Mtn,
          planCode: '312',
          phoneNumber: '08012345678',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.BILL_PRODUCT_NOT_FOUND });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('honours current_status when the response carries one', async () => {
      global.fetch = respondWith({
        status: true,
        data: { current_status: 'pending', reference: 'abc', msg: 'queued' },
      });

      const order = await build().buyData({
        reference: 'ord_5',
        network: MobileNetwork.Mtn,
        planCode: 'sp:1:1',
        phoneNumber: '08012345678',
      });

      expect(order.status).toBe(BillOrderStatus.Processing);
    });
  });

  describe('parseCallback', () => {
    const notification = {
      transaction: {
        status: 'success',
        reference: '46634e8384c7c68f5baa',
        customer_reference: 'ord_9',
        type: 'Data purchase',
        beneficiary: '09061668519',
        memo: '500MB (SME) - Monthly data purchase',
        response: '500MB (SME) - Monthly data purchase',
        price: '200',
      },
    };

    it('matches on our customer_reference, not the provider’s', () => {
      const callback = build().parseCallback(notification);

      expect(callback.reference).toBe('ord_9');
      expect(callback.providerOrderId).toBe('46634e8384c7c68f5baa');
      expect(callback.status).toBe(BillOrderStatus.Completed);
      expect(callback.remark).toContain('500MB');
    });

    it.each([
      ['failed', BillOrderStatus.Failed],
      ['refunded', BillOrderStatus.Cancelled],
      ['pending', BillOrderStatus.Processing],
    ])('maps a %s notification', (status, expected) => {
      const callback = build().parseCallback({
        transaction: { ...notification.transaction, status },
      });
      expect(callback.status).toBe(expected);
    });

    it('maps an unrecognised status to Unknown, never to Failed', () => {
      // Refunding on a word we have not seen is how a customer keeps both the
      // data and the money.
      const callback = build().parseCallback({
        transaction: { ...notification.transaction, status: 'quarantined' },
      });

      expect(callback.status).toBe(BillOrderStatus.Unknown);
    });

    it('survives a payload with no transaction at all', () => {
      const callback = build().parseCallback({});

      expect(callback.reference).toBeUndefined();
      expect(callback.status).toBe(BillOrderStatus.Unknown);
    });
  });
});

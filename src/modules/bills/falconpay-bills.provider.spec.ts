import type { PinoLogger } from 'nestjs-pino';

import type { AppConfig } from '../../config/app.config';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { Money } from '../../core/money/money';
import {
  BillOrderStatus,
  CableProvider,
  MeterType,
  MobileNetwork,
} from './bills-provider.interface';
import {
  FalconPayBillsProvider,
  decodeFalconPayCode,
  encodeFalconPayCode,
  isFalconPayBillEvent,
  parseAmountRangeFromName,
  parseFalconPayBillCallback,
} from './falconpay-bills.provider';

const BASE_URL = 'https://payment.falconpay.ng/v1';

const config = {
  payouts: { falconpay: { baseUrl: BASE_URL, secretKey: 'stripe_dummy_live_abc' } },
  bills: { httpTimeoutMs: 10_000, catalogueCacheSeconds: 3600 },
} as unknown as AppConfig;

const logger = {
  setContext: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as PinoLogger;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const QUOTE = {
  success: true,
  data: {
    face_amount: 1000,
    your_discount: 15,
    amount_to_be_debited: 985,
    quote_token: 'cf23bd69',
    quote_exp: 1789028677,
  },
};

const AIRTIME_SERVICES = {
  success: true,
  data: [
    { service_id: 'mtn', name: 'MTN Airtime VTU', min: '50', max: '50000' },
    { service_id: 'etisalat', name: '9mobile Airtime VTU', min: '50', max: '50000' },
  ],
};

type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** Routes `fetch` by path, recording every call. */
function mockFetch(routes: Record<string, Route>) {
  const fn = jest.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const path = url.pathname.replace('/v1', '');
    const route = routes[`${init.method ?? 'GET'} ${path}`];
    if (!route) throw new Error(`unrouted ${init.method} ${path}`);
    return route(url, init);
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const bodyOf = (fn: jest.Mock, path: string): Record<string, unknown> => {
  const call = fn.mock.calls.find(([url]) => String(url).includes(path));
  return JSON.parse((call?.[1] as RequestInit).body as string) as Record<string, unknown>;
};

describe('FalconPayBillsProvider', () => {
  const originalFetch = global.fetch;
  let provider: FalconPayBillsProvider;

  beforeEach(() => {
    provider = new FalconPayBillsProvider(config, logger);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  describe('plan codes', () => {
    it('round-trips a service id and a variation code containing hyphens', () => {
      const code = encodeFalconPayCode('mtn-data', 'mtn-10mb-100');
      expect(code).toBe('fp:mtn-data:mtn-10mb-100');
      expect(decodeFalconPayCode(code)).toEqual({
        serviceId: 'mtn-data',
        variationCode: 'mtn-10mb-100',
      });
    });

    it.each(['sp:1:3', 'mtn-10mb-100', 'fp::x', 'fp:mtn-data:'])('rejects %s', (code) => {
      expect(decodeFalconPayCode(code)).toBeNull();
    });
  });

  describe('purchase', () => {
    it('quotes, then pays with the quote passed through verbatim', async () => {
      const fetchMock = mockFetch({
        'GET /api/bills/services': () => json(AIRTIME_SERVICES),
        'GET /api/bills/quote': () => json(QUOTE),
        'POST /api/bills/pay': () =>
          json({
            success: true,
            data: {
              reference: 'ref-000001',
              transaction_reference: 'FalconPay-BILL7K2M9XQ4Z1WER8',
              status: 'completed',
              amount_debited: 985,
            },
          }),
      });

      const order = await provider.buyAirtime({
        reference: 'ref-000001',
        network: MobileNetwork.NineMobile,
        amount: Money.fromNaira(1000),
        phoneNumber: '08030000000',
      });

      expect(order.status).toBe(BillOrderStatus.Completed);
      expect(order.providerOrderId).toBe('FalconPay-BILL7K2M9XQ4Z1WER8');
      expect(order.amountCharged?.toDecimalString()).toBe('985.00');

      expect(bodyOf(fetchMock, '/bills/pay')).toEqual({
        reference: 'ref-000001',
        product: 'airtime',
        service_id: 'etisalat',
        amount: 1000,
        customer_id: '08030000000',
        phone: '08030000000',
        face_amount: 1000,
        net_amount: 985,
        quote_exp: 1789028677,
        quote_token: 'cf23bd69',
      });
    });

    it('sends the decoded service and variation for a data bundle', async () => {
      const fetchMock = mockFetch({
        'GET /api/bills/quote': (url) => {
          expect(url.searchParams.get('service_id')).toBe('mtn-data');
          expect(url.searchParams.get('variation_code')).toBe('mtn-10mb-100');
          return json({
            ...QUOTE,
            data: { ...QUOTE.data, face_amount: 100, amount_to_be_debited: 98 },
          });
        },
        'POST /api/bills/pay': () => json({ success: true, data: { status: 'completed' } }),
      });

      await provider.buyData({
        reference: 'ref-000002',
        network: MobileNetwork.Mtn,
        planCode: 'fp:mtn-data:mtn-10mb-100',
        phoneNumber: '08030000000',
      });

      const body = bodyOf(fetchMock, '/bills/pay');
      expect(body).toMatchObject({ product: 'data', variation_code: 'mtn-10mb-100', amount: 100 });
    });

    it('refuses another provider’s plan code instead of guessing', async () => {
      mockFetch({});
      await expect(
        provider.buyData({
          reference: 'ref-000003',
          network: MobileNetwork.Mtn,
          planCode: 'sp:1:3',
          phoneNumber: '08030000000',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.BILL_PRODUCT_NOT_FOUND });
    });

    it('treats a 202 as in flight, never as failure', async () => {
      mockFetch({
        'GET /api/bills/quote': () => json(QUOTE),
        'POST /api/bills/pay': () => json({ success: true, data: {} }, 202),
      });

      const order = await provider.payElectricity({
        reference: 'ref-000004',
        discoCode: 'ikeja-electric',
        meterType: MeterType.Prepaid,
        meterNumber: '0102030405',
        amount: Money.fromNaira(1000),
        phoneNumber: '08030000000',
      });

      expect(order.status).toBe(BillOrderStatus.Processing);
    });

    it('reports a 422 as a refundable failure', async () => {
      mockFetch({
        'GET /api/bills/quote': () => json(QUOTE),
        'POST /api/bills/pay': () => json({ success: false, message: 'Declined by biller' }, 422),
      });

      const order = await provider.fundBetting({
        reference: 'ref-000005',
        companyCode: 'bet9ja',
        customerId: '123456',
        amount: Money.fromNaira(1000),
      });

      expect(order.status).toBe(BillOrderStatus.Failed);
      expect(order.remark).toBe('Declined by biller');
    });

    it('throws on a 503, where nothing was debited', async () => {
      mockFetch({
        'GET /api/bills/quote': () => json(QUOTE),
        'POST /api/bills/pay': () => json({ success: false, message: 'Biller down' }, 503),
      });

      await expect(
        provider.fundBetting({
          reference: 'ref-000006',
          companyCode: 'bet9ja',
          customerId: '123456',
          amount: Money.fromNaira(1000),
        }),
      ).rejects.toMatchObject({ code: ErrorCode.SERVICE_UNAVAILABLE });
    });

    it('asks /bills/status when the pay call gets no response', async () => {
      mockFetch({
        'GET /api/bills/quote': () => json(QUOTE),
        'POST /api/bills/pay': () => {
          const error = new Error('timed out');
          error.name = 'TimeoutError';
          throw error;
        },
        'GET /api/bills/status': () =>
          json({
            success: true,
            data: {
              reference: 'ref-000007',
              product: 'airtime',
              status: 'completed',
              settled: true,
            },
          }),
      });

      const order = await provider.buyAirtime({
        reference: 'ref-000007',
        network: MobileNetwork.Mtn,
        amount: Money.fromNaira(1000),
        phoneNumber: '08030000000',
      });

      expect(order.status).toBe(BillOrderStatus.Completed);
    });

    it('returns Unknown — not Failed, not a throw — when the outcome cannot be confirmed', async () => {
      // A throw here makes the caller refund the customer for a purchase that
      // may well have been delivered.
      mockFetch({
        'GET /api/bills/quote': () => json(QUOTE),
        'POST /api/bills/pay': () => json({ success: false, message: 'oops' }, 500),
        'GET /api/bills/status': () => json({ success: false }, 500),
      });

      const order = await provider.buyAirtime({
        reference: 'ref-000008',
        network: MobileNetwork.Mtn,
        amount: Money.fromNaira(1000),
        phoneNumber: '08030000000',
      });

      expect(order.status).toBe(BillOrderStatus.Unknown);
    });

    it('refuses a quote whose face value differs from the request', async () => {
      mockFetch({
        'GET /api/bills/quote': () => json(QUOTE),
        'POST /api/bills/pay': () => {
          throw new Error('must not pay');
        },
      });

      await expect(
        provider.buyAirtime({
          reference: 'ref-000009',
          network: MobileNetwork.Mtn,
          amount: Money.fromNaira(500),
          phoneNumber: '08030000000',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.BILL_AMOUNT_NOT_ALLOWED });
    });

    it('treats settled:false on a status read as still processing', async () => {
      mockFetch({
        'GET /api/bills/status': () =>
          json({ success: true, data: { reference: 'r', product: 'tv', settled: false } }),
      });
      const order = await provider.queryOrder({ reference: 'ref-000010' });
      expect(order.status).toBe(BillOrderStatus.Processing);
    });
  });

  describe('verification', () => {
    it('returns the biller’s customer name', async () => {
      mockFetch({
        'GET /api/bills/services': () =>
          json({ success: true, data: [{ service_id: 'dstv', name: 'DSTV' }] }),
        'POST /api/bills/verify': () =>
          json({ success: true, data: { Customer_Name: 'JOHN DOE' } }),
      });

      await expect(provider.verifySmartCard(CableProvider.Dstv, '1234567890')).resolves.toEqual({
        identifier: '1234567890',
        name: 'JOHN DOE',
      });
    });

    it('reads FalconPay camelCase customerName (betting MSISDN)', async () => {
      mockFetch({
        'POST /api/bills/verify': () =>
          json({ success: true, data: { customerName: '2348060332714' }, message: 'Successful' }),
      });

      await expect(
        provider.verifyBettingCustomer('KUD-BET-SPTY-001', '08060332714'),
      ).resolves.toEqual({
        identifier: '08060332714',
        name: '2348060332714',
      });
    });

    it('maps a 404 to an invalid customer', async () => {
      mockFetch({
        'POST /api/bills/verify': () =>
          json({ success: false, message: 'Customer could not be verified', data: null }, 404),
      });

      await expect(
        provider.verifyMeter('ikeja-electric', '0102030405', MeterType.Postpaid),
      ).rejects.toMatchObject({ code: ErrorCode.BILL_CUSTOMER_INVALID });
    });
  });

  describe('catalogue', () => {
    it('namespaces bundle codes and skips SME variants', async () => {
      mockFetch({
        'GET /api/bills/services': (url) => {
          switch (url.searchParams.get('product')) {
            case 'data':
              return json({
                success: true,
                data: [{ service_id: 'mtn-data' }, { service_id: 'glo-sme-data' }],
              });
            case 'tv':
              return json({ success: true, data: [{ service_id: 'gotv' }] });
            case 'electricity':
              return json({
                success: true,
                data: [{ service_id: 'ikeja-electric', name: 'IKEDC', min: '1000', max: '500000' }],
              });
            default:
              return json({ success: true, data: [{ service_id: 'bet9ja', name: 'Bet9ja' }] });
          }
        },
        'GET /api/bills/variations': (url) =>
          json({
            success: true,
            data: {
              service_id: url.searchParams.get('service_id'),
              variations: [{ variation_code: 'v-1', name: 'Plan 1', amount: '100.00' }],
            },
          }),
      });

      const catalogue = await provider.fetchCatalogue();

      expect(catalogue.dataPlans).toEqual([
        expect.objectContaining({ network: MobileNetwork.Mtn, code: 'fp:mtn-data:v-1' }),
      ]);
      expect(catalogue.cablePackages[0]).toMatchObject({
        provider: CableProvider.Gotv,
        code: 'fp:gotv:v-1',
      });
      expect(catalogue.discos[0]?.bounds.min.toDecimalString()).toBe('1000.00');
      expect(catalogue.bettingCompanies[0]?.code).toBe('bet9ja');
      expect(catalogue.bettingCompanies[0]?.bounds.min.toDecimalString()).toBe('100.00');
      expect(catalogue.bettingCompanies[0]?.bounds.max.toDecimalString()).toBe('50000.00');
    });

    it('parses betting bounds from FalconPay service names', async () => {
      mockFetch({
        'GET /api/bills/services': (url) => {
          if (url.searchParams.get('product') !== 'betting') {
            return json({ success: true, data: [] });
          }
          return json({
            success: true,
            data: [
              { service_id: 'KUD-BET-SPTY-001', name: 'Sportybet Fund Wallet' },
              { service_id: 'KUD-BET-BETK-001', name: '100 - 50000NGN BETKING DEPOSIT' },
              { service_id: 'KUD-BET-BETW-001', name: 'NGN100 to 50000NGN BetWay' },
            ],
          });
        },
        'GET /api/bills/variations': () => json({ success: true, data: { variations: [] } }),
      });

      const { bettingCompanies } = await provider.fetchCatalogue();
      const sporty = bettingCompanies.find((c) => c.code === 'KUD-BET-SPTY-001');
      expect(sporty?.bounds.min.toDecimalString()).toBe('100.00');
      expect(sporty?.bounds.max.toDecimalString()).toBe('50000.00');
      expect(
        bettingCompanies.find((c) => c.code === 'KUD-BET-BETK-001')?.bounds.max.toDecimalString(),
      ).toBe('50000.00');
      expect(
        bettingCompanies.find((c) => c.code === 'KUD-BET-BETW-001')?.bounds.min.toDecimalString(),
      ).toBe('100.00');
    });

    it('reads amount ranges embedded in biller names', () => {
      expect(parseAmountRangeFromName('100 - 50000NGN BETKING DEPOSIT')).toEqual({
        min: 100,
        max: 50_000,
      });
      expect(parseAmountRangeFromName('NGN100 to 50000NGN BetWay')).toEqual({
        min: 100,
        max: 50_000,
      });
      expect(parseAmountRangeFromName('NGN100 - NGN 50000 NAIRABET CREDIT')).toEqual({
        min: 100,
        max: 50_000,
      });
      expect(parseAmountRangeFromName('Sportybet Fund Wallet')).toBeNull();
    });

    it('reads the wallet balance as the float', async () => {
      mockFetch({
        'GET /api/wallet/balance': () =>
          json({ success: true, data: { balance: 150000.0 }, message: 'Successful' }),
      });
      expect((await provider.getFloatBalance()).toDecimalString()).toBe('150000.00');
    });

    it('fails when the balance cannot be read', async () => {
      mockFetch({
        'GET /api/wallet/balance': () =>
          json({ success: false, data: null, message: 'Wallet not found' }, 400),
      });
      await expect(provider.getFloatBalance()).rejects.toBeInstanceOf(AppException);
    });
  });

  describe('webhooks', () => {
    const billEvent = {
      reference: 'your-ref-001',
      transaction_reference: 'FalconPay-BILL7K2M9XQ4Z1WER8',
      success: true,
      status: 'completed',
      product: 'electricity',
      token: '1234-5678',
    };

    it('tells a bill event from a transfer event', () => {
      expect(isFalconPayBillEvent(billEvent)).toBe(true);
      expect(isFalconPayBillEvent({ event: 'bill.failed', data: { reference: 'x' } })).toBe(true);
      expect(
        isFalconPayBillEvent({
          reference: 'TXN-1',
          transaction_reference: 'FalconPay-NMB3K9XZ1A8QWERTY2',
          status: 'completed',
        }),
      ).toBe(false);
    });

    it('parses bill.completed', () => {
      expect(parseFalconPayBillCallback(billEvent)).toMatchObject({
        reference: 'your-ref-001',
        providerOrderId: 'FalconPay-BILL7K2M9XQ4Z1WER8',
        status: BillOrderStatus.Completed,
      });
    });
  });
});

import type { PinoLogger } from 'nestjs-pino';

import type { AppConfig } from '../../config/app.config';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { Money } from '../../core/money/money';
import {
  BillOrderStatus,
  BillVertical,
  CableProvider,
  MeterType,
  MobileNetwork,
} from './bills-provider.interface';
import {
  CK_ENDPOINT,
  type CkParams,
  type CkRequestOptions,
  type ClubKonnectClient,
} from './clubkonnect.client';
import { ClubKonnectProvider } from './clubkonnect.provider';

const config = {
  bills: {
    provider: 'clubkonnect',
    httpTimeoutMs: 30_000,
    floatReserveNaira: 0,
    balanceCacheSeconds: 15,
    catalogueCacheSeconds: 3600,
    clubkonnect: {
      baseUrl: 'https://www.nellobytesystems.com',
      userId: 'CK123',
      apiKey: 'secret-key',
      callbackUrl: 'https://api.example.com/webhooks/bills',
    },
  },
} as AppConfig;

const logger = {
  setContext: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as PinoLogger;

/** Responds per endpoint, and records what was sent. */
function makeClient(responses: Record<string, unknown>) {
  // The full three-parameter signature, so assertions can inspect the params and
  // options a call was made with.
  const get = jest.fn(
    (endpoint: string, _params?: CkParams, _options?: CkRequestOptions): Promise<unknown> => {
      if (!(endpoint in responses)) {
        return Promise.reject(new Error(`unexpected endpoint ${endpoint}`));
      }
      return Promise.resolve(responses[endpoint]);
    },
  );

  return { client: { get } as unknown as ClubKonnectClient, get };
}

describe('ClubKonnectProvider', () => {
  beforeEach(() => jest.clearAllMocks());

  // ===========================================================================
  //  Float
  // ===========================================================================

  describe('float balance', () => {
    it('parses a naira balance string exactly, without float arithmetic', async () => {
      const { client } = makeClient({
        [CK_ENDPOINT.walletBalance]: { balance: '863210.10', id: 'CK123' },
      });
      const provider = new ClubKonnectProvider(client, config, logger);

      const balance = await provider.getFloatBalance();

      expect(balance.kobo).toBe(86_321_010n);
      expect(balance.toDecimalString()).toBe('863210.10');
    });

    it('strips thousands separators the provider sometimes includes', async () => {
      const { client } = makeClient({
        [CK_ENDPOINT.walletBalance]: { balance: '1,234,567.89' },
      });
      const provider = new ClubKonnectProvider(client, config, logger);

      expect((await provider.getFloatBalance()).toDecimalString()).toBe('1234567.89');
    });

    it('fails rather than reporting zero when no balance is returned', async () => {
      // Reporting ₦0 here would silently stop every sale; reporting a fabricated
      // number would let orders through. Neither is acceptable.
      const { client } = makeClient({ [CK_ENDPOINT.walletBalance]: { id: 'CK123' } });
      const provider = new ClubKonnectProvider(client, config, logger);

      await expect(provider.getFloatBalance()).rejects.toThrow(
        expect.objectContaining({ code: ErrorCode.UPSTREAM_ERROR }) as Error,
      );
    });
  });

  // ===========================================================================
  //  Catalogue — shapes taken verbatim from the live endpoints
  // ===========================================================================

  describe('catalogue parsing', () => {
    const catalogueResponses = {
      [CK_ENDPOINT.dataPlans]: {
        MOBILE_NETWORK: {
          MTN: [
            {
              ID: '01',
              PRODUCT: [
                {
                  PRODUCT_SNO: '1',
                  PRODUCT_CODE: '2',
                  PRODUCT_ID: '500',
                  PRODUCT_NAME: '500 MB - Weekly (SME)',
                  PRODUCT_AMOUNT: '307',
                },
                {
                  PRODUCT_SNO: '2',
                  PRODUCT_CODE: '9',
                  PRODUCT_ID: '500.00',
                  PRODUCT_NAME: '500 MB - Monthly (SME)',
                  PRODUCT_AMOUNT: '307',
                },
              ],
            },
          ],
        },
      },
      [CK_ENDPOINT.cablePackages]: {
        TV_ID: {
          DStv: [
            {
              ID: 'dstv',
              PRODUCT: [
                {
                  PACKAGE_ID: 'dstv-padi',
                  PACKAGE_NAME: 'DStv Padi N4,400',
                  PACKAGE_AMOUNT: '4400.00',
                  PRODUCT_DISCOUNT_AMOUNT: '4356',
                  MINAMOUNT: 100,
                  MAXAMOUNT: 200000,
                },
              ],
            },
          ],
        },
      },
      [CK_ENDPOINT.discos]: {
        ELECTRIC_COMPANY: {
          IKEJA_ELECTRIC: [
            {
              ID: '02',
              NAME: 'Ikeja Electric - IKEDC (PHCN)',
              PRODUCT: [
                { PRODUCT_ID: '01', PRODUCT_TYPE: 'prepaid', MINAMOUNT: 1000, MAXAMOUNT: 200000 },
                { PRODUCT_ID: '02', PRODUCT_TYPE: 'postpaid', MINAMOUNT: 1000, MAXAMOUNT: 200000 },
              ],
            },
          ],
        },
      },
      [CK_ENDPOINT.bettingCompanies]: {
        BETTING_COMPANY: [
          {
            PRODUCT_CODE: 'product-bet-king',
            PRODUCT_NAME: 'BetKing',
            MINAMOUNT: 100,
            MAXAMOUNT: 50000,
          },
        ],
      },
    };

    it('uses PRODUCT_ID as the data plan code, not PRODUCT_CODE', async () => {
      // The distinction matters: PRODUCT_CODE is "2", but the purchase endpoint
      // expects PRODUCT_ID ("500"). Sending the wrong one buys the wrong bundle.
      const { client } = makeClient(catalogueResponses);
      const provider = new ClubKonnectProvider(client, config, logger);

      const { dataPlans } = await provider.fetchCatalogue();

      expect(dataPlans.map((plan) => plan.code)).toEqual(['500', '500.00']);
      expect(dataPlans[0]).toMatchObject({
        network: MobileNetwork.Mtn,
        networkName: 'MTN',
        name: '500 MB - Weekly (SME)',
      });
      expect(dataPlans[0]?.price.toDecimalString()).toBe('307.00');
    });

    it('reads the discounted figure as the cable cost price', async () => {
      const { client } = makeClient(catalogueResponses);
      const provider = new ClubKonnectProvider(client, config, logger);

      const [bouquet] = (await provider.fetchCatalogue()).cablePackages;

      expect(bouquet?.provider).toBe(CableProvider.Dstv);
      expect(bouquet?.code).toBe('dstv-padi');
      // List price is what the customer sees; cost price is what our float pays.
      expect(bouquet?.price.toDecimalString()).toBe('4400.00');
      expect(bouquet?.costPrice.toDecimalString()).toBe('4356.00');
    });

    it('falls back to list price when no discount is quoted', async () => {
      // Overstating cost only makes the float check stricter — the safe direction.
      const { client } = makeClient({
        ...catalogueResponses,
        [CK_ENDPOINT.cablePackages]: {
          TV_ID: {
            GOtv: [
              {
                ID: 'gotv',
                PRODUCT: [{ PACKAGE_ID: 'gotv-jinja', PACKAGE_AMOUNT: '3900.00' }],
              },
            ],
          },
        },
      });
      const provider = new ClubKonnectProvider(client, config, logger);

      const [bouquet] = (await provider.fetchCatalogue()).cablePackages;
      expect(bouquet?.costPrice.toDecimalString()).toBe('3900.00');
    });

    it('collects the meter types a disco supports', async () => {
      const { client } = makeClient(catalogueResponses);
      const provider = new ClubKonnectProvider(client, config, logger);

      const [disco] = (await provider.fetchCatalogue()).discos;

      expect(disco?.code).toBe('02');
      expect(disco?.meterTypes).toEqual([MeterType.Prepaid, MeterType.Postpaid]);
      expect(disco?.bounds.min.toDecimalString()).toBe('1000.00');
    });

    it('reads numeric JSON bounds as exact money', async () => {
      const { client } = makeClient(catalogueResponses);
      const provider = new ClubKonnectProvider(client, config, logger);

      const [company] = (await provider.fetchCatalogue()).bettingCompanies;

      expect(company?.code).toBe('product-bet-king');
      expect(company?.bounds.max.toDecimalString()).toBe('50000.00');
    });

    it('requests catalogues without an API key, which those endpoints reject', async () => {
      const { client, get } = makeClient(catalogueResponses);
      const provider = new ClubKonnectProvider(client, config, logger);

      await provider.fetchCatalogue();

      for (const call of get.mock.calls) {
        expect(call[2]).toEqual({ withApiKey: false });
      }
    });

    it('skips malformed entries rather than failing the whole catalogue', async () => {
      const { client } = makeClient({
        ...catalogueResponses,
        [CK_ENDPOINT.dataPlans]: {
          MOBILE_NETWORK: {
            MTN: [
              {
                ID: '01',
                PRODUCT: [
                  { PRODUCT_ID: '', PRODUCT_AMOUNT: '100' },
                  { PRODUCT_ID: '1000', PRODUCT_NAME: '1 GB', PRODUCT_AMOUNT: '410' },
                  { PRODUCT_NAME: 'no id or price' },
                ],
              },
            ],
          },
        },
      });
      const provider = new ClubKonnectProvider(client, config, logger);

      const { dataPlans } = await provider.fetchCatalogue();
      expect(dataPlans).toHaveLength(1);
      expect(dataPlans[0]?.code).toBe('1000');
    });
  });

  // ===========================================================================
  //  Verification
  // ===========================================================================

  describe('verification', () => {
    it('returns the name a valid meter resolves to', async () => {
      const { client, get } = makeClient({
        [CK_ENDPOINT.verifyElectricity]: { customer_name: 'BALOGUN SUNDAY' },
      });
      const provider = new ClubKonnectProvider(client, config, logger);

      const customer = await provider.verifyMeter('02', '1234567890', MeterType.Prepaid);

      expect(customer).toEqual({ identifier: '1234567890', name: 'BALOGUN SUNDAY' });
      expect(get).toHaveBeenCalledWith(CK_ENDPOINT.verifyElectricity, {
        ElectricCompany: '02',
        MeterNo: '1234567890',
        MeterType: '01',
      });
    });

    it('rejects a sentinel failure that arrives in the name field', async () => {
      // The whole point: this is an HTTP 200 with a success-shaped body. Passing
      // it through would show the customer a "name" of INVALID_METERNO and let
      // the payment proceed against a meter that does not exist.
      const { client } = makeClient({
        [CK_ENDPOINT.verifyElectricity]: { customer_name: 'INVALID_METERNO' },
      });
      const provider = new ClubKonnectProvider(client, config, logger);

      await expect(provider.verifyMeter('02', '9999999999', MeterType.Prepaid)).rejects.toThrow(
        expect.objectContaining({ code: ErrorCode.BILL_CUSTOMER_INVALID }) as Error,
      );
    });

    it('rejects the betting variant, which words its failure differently', async () => {
      const { client } = makeClient({
        [CK_ENDPOINT.verifyBetting]: { customer_name: 'Error, Invalid Customer ID' },
      });
      const provider = new ClubKonnectProvider(client, config, logger);

      await expect(
        provider.verifyBettingCustomer('product-bet-king', '1234567890'),
      ).rejects.toThrow(
        expect.objectContaining({ code: ErrorCode.BILL_CUSTOMER_INVALID }) as Error,
      );
    });

    it('rejects an empty name rather than accepting a blank customer', async () => {
      const { client } = makeClient({ [CK_ENDPOINT.verifyCableTv]: { customer_name: '  ' } });
      const provider = new ClubKonnectProvider(client, config, logger);

      await expect(provider.verifySmartCard(CableProvider.Dstv, '1234567890')).rejects.toThrow(
        expect.objectContaining({ code: ErrorCode.BILL_CUSTOMER_INVALID }) as Error,
      );
    });
  });

  // ===========================================================================
  //  Orders
  // ===========================================================================

  describe('placing orders', () => {
    const accepted = { orderid: '789', statuscode: '100', status: 'ORDER_RECEIVED' };

    it('sends our reference as RequestID and includes the callback URL', async () => {
      const { client, get } = makeClient({ [CK_ENDPOINT.airtime]: accepted });
      const provider = new ClubKonnectProvider(client, config, logger);

      await provider.buyAirtime({
        network: MobileNetwork.Mtn,
        amount: Money.fromNaira('500'),
        phoneNumber: '08149659347',
        reference: 'REF-ABC-123',
      });

      expect(get).toHaveBeenCalledWith(CK_ENDPOINT.airtime, {
        MobileNetwork: '01',
        Amount: '500',
        MobileNumber: '08149659347',
        RequestID: 'REF-ABC-123',
        CallBackURL: 'https://api.example.com/webhooks/bills',
      });
    });

    it('sends whole naira, never kobo', async () => {
      const { client, get } = makeClient({ [CK_ENDPOINT.electricity]: accepted });
      const provider = new ClubKonnectProvider(client, config, logger);

      await provider.payElectricity({
        discoCode: '02',
        meterType: MeterType.Prepaid,
        meterNumber: '1234567890',
        amount: Money.fromNaira('2000'),
        phoneNumber: '08149659347',
        reference: 'REF-ABC-123',
      });

      // ₦2,000 must go out as "2000" — sending 200000 would bill 100x.
      expect(get.mock.calls[0]?.[1]).toMatchObject({ Amount: '2000' });
    });

    it('refuses a fractional amount instead of letting it be truncated upstream', async () => {
      const { client } = makeClient({ [CK_ENDPOINT.airtime]: accepted });
      const provider = new ClubKonnectProvider(client, config, logger);

      await expect(
        provider.buyAirtime({
          network: MobileNetwork.Mtn,
          amount: Money.fromNaira('500.50'),
          phoneNumber: '08149659347',
          reference: 'REF-ABC-123',
        }),
      ).rejects.toThrow(
        expect.objectContaining({ code: ErrorCode.BILL_AMOUNT_NOT_ALLOWED }) as Error,
      );
    });

    it('maps an acceptance to Pending, not Completed', async () => {
      // ORDER_RECEIVED means queued. Treating it as delivered is how a customer
      // gets told their airtime arrived before it has.
      const { client } = makeClient({ [CK_ENDPOINT.data]: accepted });
      const provider = new ClubKonnectProvider(client, config, logger);

      const order = await provider.buyData({
        network: MobileNetwork.Mtn,
        planCode: '1000',
        phoneNumber: '08149659347',
        reference: 'REF-ABC-123',
      });

      expect(order).toMatchObject({
        reference: 'REF-ABC-123',
        providerOrderId: '789',
        vertical: BillVertical.Data,
        status: BillOrderStatus.Pending,
        statusCode: '100',
      });
    });

    it('surfaces the prepaid electricity token when one is issued', async () => {
      const { client } = makeClient({
        [CK_ENDPOINT.electricity]: {
          orderid: '789',
          statuscode: '200',
          status: 'ORDER_COMPLETED',
          meterno: '1234567890',
          metertoken: '0001-2345-6789',
          amountcharged: '1990',
        },
      });
      const provider = new ClubKonnectProvider(client, config, logger);

      const order = await provider.payElectricity({
        discoCode: '02',
        meterType: MeterType.Prepaid,
        meterNumber: '1234567890',
        amount: Money.fromNaira('2000'),
        phoneNumber: '08149659347',
        reference: 'REF-ABC-123',
      });

      expect(order.status).toBe(BillOrderStatus.Completed);
      expect(order.meterToken).toBe('0001-2345-6789');
      // The discounted figure our float was actually charged.
      expect(order.amountCharged?.toDecimalString()).toBe('1990.00');
    });

    it('flags an unclassifiable status code for a human', async () => {
      const { client } = makeClient({
        [CK_ENDPOINT.betting]: { orderid: '789', statuscode: '777' },
      });
      const provider = new ClubKonnectProvider(client, config, logger);

      const order = await provider.fundBetting({
        companyCode: 'product-bet-king',
        customerId: '1234567890',
        amount: Money.fromNaira('1000'),
        reference: 'REF-ABC-123',
      });

      expect(order.status).toBe(BillOrderStatus.Unknown);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  //  Reconciliation
  // ===========================================================================

  describe('querying an order', () => {
    it('queries by provider order id when one is known', async () => {
      const { client, get } = makeClient({
        [CK_ENDPOINT.query]: { orderid: '789', statuscode: '200', ordertype: 'MTN Data' },
      });
      const provider = new ClubKonnectProvider(client, config, logger);

      const order = await provider.queryOrder({ providerOrderId: '789' });

      expect(get.mock.calls[0]?.[1]).toEqual({ OrderID: '789', RequestID: undefined });
      expect(order.status).toBe(BillOrderStatus.Completed);
      expect(order.vertical).toBe(BillVertical.Data);
    });

    it('falls back to our reference when there is no provider order id', async () => {
      const { client, get } = makeClient({
        [CK_ENDPOINT.query]: { requestid: 'REF-ABC-123', statuscode: '300' },
      });
      const provider = new ClubKonnectProvider(client, config, logger);

      await provider.queryOrder({ reference: 'REF-ABC-123' });

      expect(get.mock.calls[0]?.[1]).toEqual({ OrderID: undefined, RequestID: 'REF-ABC-123' });
    });

    it('refuses a query with neither identifier', async () => {
      const { client } = makeClient({});
      const provider = new ClubKonnectProvider(client, config, logger);

      await expect(provider.queryOrder({})).rejects.toThrow(
        expect.objectContaining({ code: ErrorCode.VALIDATION_FAILED }) as Error,
      );
    });
  });

  // ===========================================================================
  //  Callbacks
  // ===========================================================================

  describe('parsing callbacks', () => {
    it('normalises a completion callback', () => {
      const { client } = makeClient({});
      const provider = new ClubKonnectProvider(client, config, logger);

      const event = provider.parseCallback({
        orderdate: '22th-Jul-2023',
        orderid: '6501321715',
        requestid: 'REF-ABC-123',
        statuscode: '200',
        orderstatus: 'ORDER_COMPLETED',
        orderremark: 'Dear Customer, You have successfully shared 50MB Data to 08149659347',
      });

      expect(event).toMatchObject({
        reference: 'REF-ABC-123',
        providerOrderId: '6501321715',
        status: BillOrderStatus.Completed,
        statusCode: '200',
      });
    });

    it('handles the empty requestid the provider sends on some callbacks', () => {
      const { client } = makeClient({});
      const provider = new ClubKonnectProvider(client, config, logger);

      const event = provider.parseCallback({ orderid: '650', requestid: '', statuscode: '200' });

      // Undefined rather than an empty string, so a caller cannot accidentally
      // look up an order by "".
      expect(event.reference).toBeUndefined();
      expect(event.providerOrderId).toBe('650');
    });

    it.each([[null], [undefined], ['a string'], [42]])('rejects a %p payload', (payload) => {
      const { client } = makeClient({});
      const provider = new ClubKonnectProvider(client, config, logger);

      expect(() => provider.parseCallback(payload)).toThrow(
        expect.objectContaining({ code: ErrorCode.VALIDATION_FAILED }) as Error,
      );
    });
  });
});

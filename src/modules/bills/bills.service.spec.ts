import type { PinoLogger } from 'nestjs-pino';

import type { AppConfig } from '../../config/app.config';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { Money } from '../../core/money/money';
import type { CacheService } from '../../infrastructure/cache/cache.service';
import {
  BillOrderStatus,
  type BillsProvider,
  BillVertical,
  CableProvider,
  MeterType,
  MobileNetwork,
} from './bills-provider.interface';
import type { BillsCatalogueService } from './bills.catalogue';
import { BillsService } from './bills.service';

const logger = {
  setContext: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as PinoLogger;

function makeConfig(overrides: Partial<AppConfig['bills']> = {}): AppConfig {
  return {
    bills: {
      provider: 'clubkonnect',
      httpTimeoutMs: 30_000,
      floatReserveNaira: 0,
      // Caching off by default in tests so each case controls its own balance.
      balanceCacheSeconds: 0,
      catalogueCacheSeconds: 3600,
      clubkonnect: {
        baseUrl: 'https://www.nellobytesystems.com',
        userId: 'CK123',
        apiKey: 'secret',
        callbackUrl: 'https://api.example.com/webhooks/bills',
      },
      ...overrides,
    },
  } as AppConfig;
}

const acceptedOrder = {
  reference: 'REF-ABC-123',
  providerOrderId: '789',
  vertical: BillVertical.Airtime,
  status: BillOrderStatus.Pending,
  statusCode: '100',
  raw: {},
};

function makeProvider(balance = '100000') {
  return {
    name: 'clubkonnect',
    getFloatBalance: jest.fn().mockResolvedValue(Money.fromNaira(balance)),
    fetchCatalogue: jest.fn(),
    verifyMeter: jest.fn().mockResolvedValue({ identifier: '1234567890', name: 'BALOGUN SUNDAY' }),
    verifySmartCard: jest
      .fn()
      .mockResolvedValue({ identifier: '1234567890', name: 'ADAEZE OKONKWO' }),
    verifyBettingCustomer: jest
      .fn()
      .mockResolvedValue({ identifier: '1234567890', name: 'BALOGUN SUNDAY (BKwise)' }),
    buyAirtime: jest.fn().mockResolvedValue(acceptedOrder),
    buyData: jest.fn().mockResolvedValue({ ...acceptedOrder, vertical: BillVertical.Data }),
    payElectricity: jest
      .fn()
      .mockResolvedValue({ ...acceptedOrder, vertical: BillVertical.Electricity }),
    subscribeCableTv: jest
      .fn()
      .mockResolvedValue({ ...acceptedOrder, vertical: BillVertical.CableTv }),
    fundBetting: jest.fn().mockResolvedValue({ ...acceptedOrder, vertical: BillVertical.Betting }),
    queryOrder: jest.fn(),
    parseCallback: jest.fn(),
  } satisfies Record<keyof BillsProvider, unknown> as unknown as jest.Mocked<BillsProvider>;
}

function makeCatalogue() {
  return {
    requireDataPlan: jest.fn().mockResolvedValue({
      network: MobileNetwork.Mtn,
      networkName: 'MTN',
      code: '1000',
      name: '1 GB - Weekly (SME)',
      price: Money.fromNaira('410'),
    }),
    requireCablePackage: jest.fn().mockResolvedValue({
      provider: CableProvider.Dstv,
      code: 'dstv-padi',
      name: 'DStv Padi',
      price: Money.fromNaira('4400'),
      costPrice: Money.fromNaira('4356'),
      bounds: { min: Money.fromNaira('100'), max: Money.fromNaira('200000') },
    }),
    requireDisco: jest.fn().mockResolvedValue({
      code: '02',
      name: 'Ikeja Electric',
      meterTypes: [MeterType.Prepaid, MeterType.Postpaid],
      bounds: { min: Money.fromNaira('1000'), max: Money.fromNaira('200000') },
    }),
    requireBettingCompany: jest.fn().mockResolvedValue({
      code: 'product-bet-king',
      name: 'BetKing',
      bounds: { min: Money.fromNaira('100'), max: Money.fromNaira('50000') },
    }),
    assertWithinBounds: jest.fn(),
  } as unknown as jest.Mocked<BillsCatalogueService>;
}

function makeCache() {
  return {
    keys: { global: (...parts: (string | number)[]) => parts.join(':') },
    get: jest.fn().mockResolvedValue(undefined),
    set: jest.fn().mockResolvedValue(true),
    delete: jest.fn().mockResolvedValue(1),
  } as unknown as jest.Mocked<CacheService>;
}

describe('BillsService', () => {
  beforeEach(() => jest.clearAllMocks());

  // ===========================================================================
  //  The float check
  // ===========================================================================

  describe('float check before processing', () => {
    it('places the order when the float covers it', async () => {
      const provider = makeProvider('100000');
      const service = new BillsService(
        provider,
        makeConfig(),
        makeCatalogue(),
        makeCache(),
        logger,
      );

      const result = await service.buyAirtime({
        network: MobileNetwork.Mtn,
        phoneNumber: '08149659347',
        amount: Money.fromNaira('500'),
      });

      expect(provider.getFloatBalance).toHaveBeenCalled();
      expect(provider.buyAirtime).toHaveBeenCalled();
      expect(result.cost.toDecimalString()).toBe('500.00');
    });

    it('refuses the order — and never calls the provider — when the float is short', async () => {
      // The point of the whole guard: no upstream call, so no half-placed order
      // to reconcile and no customer charged for something that cannot happen.
      const provider = makeProvider('100');
      const service = new BillsService(
        provider,
        makeConfig(),
        makeCatalogue(),
        makeCache(),
        logger,
      );

      await expect(
        service.buyAirtime({
          network: MobileNetwork.Mtn,
          phoneNumber: '08149659347',
          amount: Money.fromNaira('500'),
        }),
      ).rejects.toThrow(
        expect.objectContaining({ code: ErrorCode.BILL_PROVIDER_FLOAT_EXHAUSTED }) as Error,
      );

      expect(provider.buyAirtime).not.toHaveBeenCalled();
    });

    it('holds back the configured reserve', async () => {
      // ₦5,000 balance, ₦4,000 reserve — only ₦1,000 is actually spendable.
      const provider = makeProvider('5000');
      const service = new BillsService(
        provider,
        makeConfig({ floatReserveNaira: 4000 }),
        makeCatalogue(),
        makeCache(),
        logger,
      );

      await expect(
        service.buyAirtime({
          network: MobileNetwork.Mtn,
          phoneNumber: '08149659347',
          amount: Money.fromNaira('2000'),
        }),
      ).rejects.toThrow(
        expect.objectContaining({ code: ErrorCode.BILL_PROVIDER_FLOAT_EXHAUSTED }) as Error,
      );

      await expect(
        service.buyAirtime({
          network: MobileNetwork.Mtn,
          phoneNumber: '08149659347',
          amount: Money.fromNaira('1000'),
        }),
      ).resolves.toBeDefined();
    });

    it('allows an order exactly equal to the available float', async () => {
      const provider = makeProvider('500');
      const service = new BillsService(
        provider,
        makeConfig(),
        makeCatalogue(),
        makeCache(),
        logger,
      );

      await expect(
        service.buyAirtime({
          network: MobileNetwork.Mtn,
          phoneNumber: '08149659347',
          amount: Money.fromNaira('500'),
        }),
      ).resolves.toBeDefined();
    });

    it('fails closed when the balance cannot be read', async () => {
      // Failing open here would defeat the entire guard.
      const provider = makeProvider();
      provider.getFloatBalance.mockRejectedValue(new Error('upstream down'));
      const service = new BillsService(
        provider,
        makeConfig(),
        makeCatalogue(),
        makeCache(),
        logger,
      );

      await expect(
        service.buyAirtime({
          network: MobileNetwork.Mtn,
          phoneNumber: '08149659347',
          amount: Money.fromNaira('500'),
        }),
      ).rejects.toThrow();

      expect(provider.buyAirtime).not.toHaveBeenCalled();
    });

    it('checks the float against the plan price for data, not the request', async () => {
      // A data request carries no amount at all — the cost comes from the
      // catalogue, and that is what must be checked.
      const provider = makeProvider('400');
      const catalogue = makeCatalogue();
      const service = new BillsService(provider, makeConfig(), catalogue, makeCache(), logger);

      await expect(
        service.buyData({
          network: MobileNetwork.Mtn,
          phoneNumber: '08149659347',
          planCode: '1000',
        }),
      ).rejects.toThrow(
        expect.objectContaining({ code: ErrorCode.BILL_PROVIDER_FLOAT_EXHAUSTED }) as Error,
      );

      expect(catalogue.requireDataPlan).toHaveBeenCalledWith(MobileNetwork.Mtn, '1000');
      expect(provider.buyData).not.toHaveBeenCalled();
    });

    it('checks cable against the discounted cost price, which is what we pay', async () => {
      // Balance sits between cost price (4356) and list price (4400): checking
      // the wrong one would refuse an order we can comfortably afford.
      const provider = makeProvider('4380');
      const service = new BillsService(
        provider,
        makeConfig(),
        makeCatalogue(),
        makeCache(),
        logger,
      );

      const result = await service.subscribeCableTv({
        provider: CableProvider.Dstv,
        packageCode: 'dstv-padi',
        smartCardNumber: '1234567890',
        phoneNumber: '08149659347',
      });

      expect(result.cost.toDecimalString()).toBe('4356.00');
      expect(provider.subscribeCableTv).toHaveBeenCalled();
    });

    it('reuses a cached balance when caching is enabled', async () => {
      const provider = makeProvider();
      const cache = makeCache();
      cache.get.mockResolvedValue('100000');

      const service = new BillsService(
        provider,
        makeConfig({ balanceCacheSeconds: 15 }),
        makeCatalogue(),
        cache,
        logger,
      );

      await service.buyAirtime({
        network: MobileNetwork.Mtn,
        phoneNumber: '08149659347',
        amount: Money.fromNaira('500'),
      });

      expect(provider.getFloatBalance).not.toHaveBeenCalled();
    });

    it('drops the cached balance after an order, since the float has moved', async () => {
      const provider = makeProvider();
      const cache = makeCache();
      const service = new BillsService(
        provider,
        makeConfig({ balanceCacheSeconds: 15 }),
        makeCatalogue(),
        cache,
        logger,
      );

      await service.buyAirtime({
        network: MobileNetwork.Mtn,
        phoneNumber: '08149659347',
        amount: Money.fromNaira('500'),
      });

      expect(cache.delete).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  //  Verification ordering
  // ===========================================================================

  describe('recipient verification', () => {
    it('verifies the meter before placing an electricity order', async () => {
      const provider = makeProvider();
      const service = new BillsService(
        provider,
        makeConfig(),
        makeCatalogue(),
        makeCache(),
        logger,
      );

      const result = await service.payElectricity({
        discoCode: '02',
        meterType: MeterType.Prepaid,
        meterNumber: '1234567890',
        amount: Money.fromNaira('2000'),
        phoneNumber: '08149659347',
      });

      expect(provider.verifyMeter).toHaveBeenCalledWith('02', '1234567890', MeterType.Prepaid);
      expect(result.customerName).toBe('BALOGUN SUNDAY');
    });

    it('abandons the order when verification fails, before touching the float', async () => {
      const provider = makeProvider();
      provider.verifySmartCard.mockRejectedValue(new Error('invalid smartcard'));
      const service = new BillsService(
        provider,
        makeConfig(),
        makeCatalogue(),
        makeCache(),
        logger,
      );

      await expect(
        service.subscribeCableTv({
          provider: CableProvider.Dstv,
          packageCode: 'dstv-padi',
          smartCardNumber: '1234567890',
          phoneNumber: '08149659347',
        }),
      ).rejects.toThrow();

      expect(provider.subscribeCableTv).not.toHaveBeenCalled();
    });

    it('reports a bad meter as the customer error it is, even when the float is short', async () => {
      // Ordering matters for the message the customer gets: "check your meter
      // number" is actionable, "try again later" is not.
      const provider = makeProvider('1');
      provider.verifyMeter.mockRejectedValue(
        Object.assign(new Error('bad meter'), { code: ErrorCode.BILL_CUSTOMER_INVALID }),
      );
      const service = new BillsService(
        provider,
        makeConfig(),
        makeCatalogue(),
        makeCache(),
        logger,
      );

      await expect(
        service.payElectricity({
          discoCode: '02',
          meterType: MeterType.Prepaid,
          meterNumber: '9999999999',
          amount: Money.fromNaira('2000'),
          phoneNumber: '08149659347',
        }),
      ).rejects.toThrow(
        expect.objectContaining({ code: ErrorCode.BILL_CUSTOMER_INVALID }) as Error,
      );
    });

    it('verifies the betting account before funding it', async () => {
      const provider = makeProvider();
      const service = new BillsService(
        provider,
        makeConfig(),
        makeCatalogue(),
        makeCache(),
        logger,
      );

      const result = await service.fundBetting({
        companyCode: 'product-bet-king',
        customerId: '1234567890',
        amount: Money.fromNaira('1000'),
      });

      expect(provider.verifyBettingCustomer).toHaveBeenCalledWith('product-bet-king', '1234567890');
      expect(result.customerName).toBe('BALOGUN SUNDAY (BKwise)');
    });
  });

  // ===========================================================================
  //  Input normalisation
  // ===========================================================================

  describe('input handling', () => {
    it.each([
      ['08149659347', '08149659347'],
      ['+2348149659347', '08149659347'],
      ['2348149659347', '08149659347'],
      ['+234 814 965 9347', '08149659347'],
    ])('normalises %p to the local form %p', async (input, expected) => {
      const provider = makeProvider();
      const service = new BillsService(
        provider,
        makeConfig(),
        makeCatalogue(),
        makeCache(),
        logger,
      );

      await service.buyAirtime({
        network: MobileNetwork.Mtn,
        phoneNumber: input,
        amount: Money.fromNaira('500'),
      });

      expect(provider.buyAirtime).toHaveBeenCalledWith(
        expect.objectContaining({ phoneNumber: expected }),
      );
    });

    it.each([['not-a-number'], ['0812345'], ['']])(
      'rejects %p as a phone number',
      async (input) => {
        const provider = makeProvider();
        const service = new BillsService(
          provider,
          makeConfig(),
          makeCatalogue(),
          makeCache(),
          logger,
        );

        await expect(
          service.buyAirtime({
            network: MobileNetwork.Mtn,
            phoneNumber: input,
            amount: Money.fromNaira('500'),
          }),
        ).rejects.toThrow();
        expect(provider.buyAirtime).not.toHaveBeenCalled();
      },
    );

    it('rejects a non-Nigerian number', async () => {
      const provider = makeProvider();
      const service = new BillsService(
        provider,
        makeConfig(),
        makeCatalogue(),
        makeCache(),
        logger,
      );

      await expect(
        service.buyAirtime({
          network: MobileNetwork.Mtn,
          phoneNumber: '+14155552671',
          amount: Money.fromNaira('500'),
        }),
      ).rejects.toThrow(expect.objectContaining({ code: ErrorCode.VALIDATION_FAILED }) as Error);
    });

    it('rejects a fractional amount', async () => {
      const provider = makeProvider();
      const service = new BillsService(
        provider,
        makeConfig(),
        makeCatalogue(),
        makeCache(),
        logger,
      );

      await expect(
        service.buyAirtime({
          network: MobileNetwork.Mtn,
          phoneNumber: '08149659347',
          amount: Money.fromNaira('500.50'),
        }),
      ).rejects.toThrow(
        expect.objectContaining({ code: ErrorCode.BILL_AMOUNT_NOT_ALLOWED }) as Error,
      );
    });

    it('mints a unique reference when the caller supplies none', async () => {
      const provider = makeProvider();
      const service = new BillsService(
        provider,
        makeConfig(),
        makeCatalogue(),
        makeCache(),
        logger,
      );

      const order = {
        network: MobileNetwork.Mtn,
        phoneNumber: '08149659347',
        amount: Money.fromNaira('500'),
      };
      await service.buyAirtime(order);
      await service.buyAirtime(order);

      const [first, second] = provider.buyAirtime.mock.calls.map((call) => call[0]?.reference);

      expect(first).not.toBe(second);
      // Timestamp-led, matching ClubKonnect's own RequestID convention.
      expect(first).toMatch(/^\d{14}[0-9a-f]{10}$/);
    });

    it('passes a caller reference through unchanged, so retries stay idempotent', async () => {
      const provider = makeProvider();
      const service = new BillsService(
        provider,
        makeConfig(),
        makeCatalogue(),
        makeCache(),
        logger,
      );

      await service.buyAirtime({
        network: MobileNetwork.Mtn,
        phoneNumber: '08149659347',
        amount: Money.fromNaira('500'),
        reference: 'wallet-txn-8891',
      });

      expect(provider.buyAirtime).toHaveBeenCalledWith(
        expect.objectContaining({ reference: 'wallet-txn-8891' }),
      );
    });

    it.each([['short'], ['has spaces here'], ['bad/chars']])(
      'rejects the malformed reference %p',
      async (reference) => {
        const provider = makeProvider();
        const service = new BillsService(
          provider,
          makeConfig(),
          makeCatalogue(),
          makeCache(),
          logger,
        );

        await expect(
          service.buyAirtime({
            network: MobileNetwork.Mtn,
            phoneNumber: '08149659347',
            amount: Money.fromNaira('500'),
            reference,
          }),
        ).rejects.toThrow(expect.objectContaining({ code: ErrorCode.VALIDATION_FAILED }) as Error);
      },
    );

    it.each([['12'], ['meter number!'], ['']])(
      'rejects the malformed identifier %p',
      async (meterNumber) => {
        const provider = makeProvider();
        const service = new BillsService(
          provider,
          makeConfig(),
          makeCatalogue(),
          makeCache(),
          logger,
        );

        await expect(
          service.payElectricity({
            discoCode: '02',
            meterType: MeterType.Prepaid,
            meterNumber,
            amount: Money.fromNaira('2000'),
            phoneNumber: '08149659347',
          }),
        ).rejects.toThrow(expect.objectContaining({ code: ErrorCode.VALIDATION_FAILED }) as Error);
      },
    );
  });
});

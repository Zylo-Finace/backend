import type { PinoLogger } from 'nestjs-pino';

import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { Money } from '../../core/money/money';
import {
  type AirtimeDataProvider,
  type BillOrder,
  BillOrderStatus,
  type BillsProvider,
  BillVertical,
  type DataPlan,
  MobileNetwork,
} from './bills-provider.interface';
import {
  mergeDataPlans,
  parseValidityDays,
  parseVolumeMb,
  RoutedBillsProvider,
} from './routed-bills.provider';

const logger = {
  setContext: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as PinoLogger;

const plan = (overrides: Partial<DataPlan> & Pick<DataPlan, 'code' | 'name'>): DataPlan => ({
  network: MobileNetwork.Mtn,
  networkName: 'MTN',
  price: Money.fromNaira('400'),
  ...overrides,
});

const order = (overrides: Partial<BillOrder> = {}): BillOrder => ({
  reference: 'ord_1',
  vertical: BillVertical.Airtime,
  status: BillOrderStatus.Completed,
  statusCode: 'success',
  raw: {},
  ...overrides,
});

const buildPrimary = (overrides: Partial<AirtimeDataProvider> = {}): AirtimeDataProvider => ({
  name: 'smeplug',
  getFloatBalance: jest.fn(() => Promise.resolve(Money.fromNaira('5000'))),
  fetchDataPlans: jest.fn(() => Promise.resolve([])),
  buyAirtime: jest.fn(() => Promise.resolve(order())),
  buyData: jest.fn(() => Promise.resolve(order({ vertical: BillVertical.Data }))),
  parseCallback: jest.fn(),
  ...overrides,
});

const buildFull = (overrides: Partial<BillsProvider> = {}): BillsProvider => ({
  name: 'clubkonnect',
  getFloatBalance: jest.fn(() => Promise.resolve(Money.fromNaira('9000'))),
  fetchCatalogue: jest.fn(() =>
    Promise.resolve({ dataPlans: [], cablePackages: [], discos: [], bettingCompanies: [] }),
  ),
  buyAirtime: jest.fn(() => Promise.resolve(order({ statusCode: 'ck' }))),
  buyData: jest.fn(() => Promise.resolve(order({ vertical: BillVertical.Data, statusCode: 'ck' }))),
  payElectricity: jest.fn(),
  subscribeCableTv: jest.fn(),
  fundBetting: jest.fn(),
  verifyMeter: jest.fn(),
  verifySmartCard: jest.fn(),
  verifyBettingCustomer: jest.fn(),
  queryOrder: jest.fn(),
  parseCallback: jest.fn(),
  ...overrides,
});

const airtimeRequest = {
  reference: 'ord_1',
  network: MobileNetwork.Mtn,
  amount: Money.fromNaira('500'),
  phoneNumber: '08012345678',
};

describe('plan name parsing', () => {
  describe('parseVolumeMb', () => {
    it.each([
      ['500MB [SME]', 500],
      ['1GB [SME]', 1024],
      ['1.5GB - 30 days', 1536],
      ['40 GB Monthly', 40960],
      ['1TB Annual', 1048576],
    ])('reads %s as %i MB', (name, expected) => {
      expect(parseVolumeMb(name)).toBe(expected);
    });

    it('returns null for a name with no volume', () => {
      expect(parseVolumeMb('Weekend Bundle')).toBeNull();
    });
  });

  describe('parseValidityDays', () => {
    it.each([
      ['1GB - 30 days', 30],
      ['500MB 7day', 7],
      ['2GB Monthly', 30],
      ['1GB Weekly', 7],
      ['100MB Daily', 1],
      ['20GB 3 months', 90],
    ])('reads %s as %i days', (name, expected) => {
      expect(parseValidityDays(name)).toBe(expected);
    });

    it('returns null when the name states no validity', () => {
      // Null is a real value here — most SMEPlug names carry no validity — and it
      // participates in the pairing key so a bare plan pairs only with a bare one.
      expect(parseValidityDays('500MB [SME]')).toBeNull();
    });
  });
});

describe('mergeDataPlans', () => {
  it('pairs plans that agree on network, volume and validity', () => {
    const { equivalents } = mergeDataPlans(
      [plan({ code: 'sp:1:2', name: '1GB [SME] - 30 days' })],
      [plan({ code: '312', name: '1GB - 30 days' })],
    );

    expect(equivalents.get('sp:1:2')).toBe('312');
  });

  it('refuses to pair when the match is ambiguous', () => {
    // A bare "1GB" could be either the 7-day or the 30-day bundle. Guessing here
    // delivers the wrong thing at a price the customer was not quoted.
    const { equivalents } = mergeDataPlans(
      [plan({ code: 'sp:1:2', name: '1GB [SME]' })],
      [plan({ code: '312', name: '1GB' }), plan({ code: '313', name: '1GB' })],
    );

    expect(equivalents.size).toBe(0);
  });

  it('does not pair a bare plan with a dated one', () => {
    const { equivalents } = mergeDataPlans(
      [plan({ code: 'sp:1:2', name: '1GB [SME]' })],
      [plan({ code: '312', name: '1GB - 30 days' })],
    );

    expect(equivalents.size).toBe(0);
  });

  it('does not pair across networks', () => {
    const { equivalents } = mergeDataPlans(
      [plan({ code: 'sp:1:2', name: '1GB [SME]', network: MobileNetwork.Mtn })],
      [plan({ code: '312', name: '1GB', network: MobileNetwork.Glo })],
    );

    expect(equivalents.size).toBe(0);
  });

  it('puts the leading provider’s plans first', () => {
    const { plans } = mergeDataPlans(
      [plan({ code: 'sp:1:2', name: '1GB [SME]' })],
      [plan({ code: '999', name: '9GB - 30 days' })],
    );

    expect(plans[0]!.code).toBe('sp:1:2');
  });

  it('keeps fallback plans that have no equivalent', () => {
    // Losing a bundle a customer could previously buy is a worse regression than
    // showing one that costs a little more.
    const { plans } = mergeDataPlans(
      [plan({ code: 'sp:1:2', name: '1GB [SME]' })],
      [plan({ code: '999', name: '9GB - 30 days' })],
    );

    expect(plans.map((entry) => entry.code)).toEqual(['sp:1:2', '999']);
  });

  it('drops the fallback copy of a paired plan, so it is not listed twice', () => {
    const { plans } = mergeDataPlans(
      [plan({ code: 'sp:1:2', name: '1GB - 30 days' })],
      [plan({ code: '312', name: '1GB - 30 days' })],
    );

    expect(plans.map((entry) => entry.code)).toEqual(['sp:1:2']);
  });
});

describe('RoutedBillsProvider', () => {
  afterEach(() => jest.clearAllMocks());

  describe('getFloatBalance', () => {
    it('reports the larger of the two floats', async () => {
      // With a fallback in place, the honest answer to "can this be funded?" is
      // yes when either provider can fund it.
      const router = new RoutedBillsProvider(buildPrimary(), buildFull(), logger);

      expect((await router.getFloatBalance()).toDecimalString()).toBe('9000.00');
    });

    it('uses whichever provider answered when the other fails', async () => {
      const router = new RoutedBillsProvider(
        buildPrimary({ getFloatBalance: jest.fn(() => Promise.reject(new Error('down'))) }),
        buildFull(),
        logger,
      );

      expect((await router.getFloatBalance()).toDecimalString()).toBe('9000.00');
    });

    it('fails when neither will answer, rather than failing open', async () => {
      const router = new RoutedBillsProvider(
        buildPrimary({ getFloatBalance: jest.fn(() => Promise.reject(new Error('down'))) }),
        buildFull({ getFloatBalance: jest.fn(() => Promise.reject(new Error('down'))) }),
        logger,
      );

      await expect(router.getFloatBalance()).rejects.toBeInstanceOf(AppException);
    });
  });

  describe('buyAirtime', () => {
    it('goes to the leading provider first', async () => {
      const primary = buildPrimary();
      const full = buildFull();
      const router = new RoutedBillsProvider(primary, full, logger);

      await router.buyAirtime(airtimeRequest);

      expect(primary.buyAirtime).toHaveBeenCalledTimes(1);
      expect(full.buyAirtime).not.toHaveBeenCalled();
    });

    it('falls back when the leader times out', async () => {
      const full = buildFull();
      const router = new RoutedBillsProvider(
        buildPrimary({
          buyAirtime: jest.fn(() =>
            Promise.reject(new AppException(ErrorCode.UPSTREAM_TIMEOUT, { message: 'slow' })),
          ),
        }),
        full,
        logger,
      );

      const result = await router.buyAirtime(airtimeRequest);

      expect(full.buyAirtime).toHaveBeenCalledWith(airtimeRequest);
      expect(result.statusCode).toBe('ck');
    });

    it('falls back when the leader declines without throwing', async () => {
      // A declined order is a `BillOrder`, not an exception — the leader
      // answered, it simply refused, and nothing was delivered.
      const full = buildFull();
      const router = new RoutedBillsProvider(
        buildPrimary({
          buyAirtime: jest.fn(() => Promise.resolve(order({ status: BillOrderStatus.Failed }))),
        }),
        full,
        logger,
      );

      const result = await router.buyAirtime(airtimeRequest);

      expect(full.buyAirtime).toHaveBeenCalled();
      expect(result.statusCode).toBe('ck');
    });

    it('does not fall back on a validation error', async () => {
      // A rejected phone number will be rejected identically downstream; a second
      // provider call just makes the customer wait for the same answer.
      const full = buildFull();
      const router = new RoutedBillsProvider(
        buildPrimary({
          buyAirtime: jest.fn(() =>
            Promise.reject(
              new AppException(ErrorCode.VALIDATION_FAILED, { message: 'bad number' }),
            ),
          ),
        }),
        full,
        logger,
      );

      await expect(router.buyAirtime(airtimeRequest)).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_FAILED,
      });
      expect(full.buyAirtime).not.toHaveBeenCalled();
    });

    it('does not fall back on an indeterminate result', async () => {
      // `Unknown` may mean the airtime *was* delivered. Re-placing the order
      // downstream would deliver it twice and charge our float twice.
      const full = buildFull();
      const router = new RoutedBillsProvider(
        buildPrimary({
          buyAirtime: jest.fn(() => Promise.resolve(order({ status: BillOrderStatus.Unknown }))),
        }),
        full,
        logger,
      );

      const result = await router.buyAirtime(airtimeRequest);

      expect(result.status).toBe(BillOrderStatus.Unknown);
      expect(full.buyAirtime).not.toHaveBeenCalled();
    });

    it('returns the leader’s refusal when the fallback also fails', async () => {
      const router = new RoutedBillsProvider(
        buildPrimary({
          buyAirtime: jest.fn(() =>
            Promise.resolve(order({ status: BillOrderStatus.Failed, remark: 'no float' })),
          ),
        }),
        buildFull({ buyAirtime: jest.fn(() => Promise.reject(new Error('also down'))) }),
        logger,
      );

      const result = await router.buyAirtime(airtimeRequest);

      expect(result.status).toBe(BillOrderStatus.Failed);
      expect(result.remark).toBe('no float');
    });
  });

  describe('buyData', () => {
    const dataRequest = {
      reference: 'ord_2',
      network: MobileNetwork.Mtn,
      planCode: 'sp:1:2',
      phoneNumber: '08012345678',
    };

    /** A router whose catalogue has been loaded, so pairings are known. */
    const loaded = async (primaryPlans: DataPlan[], fallbackPlans: DataPlan[]) => {
      const primary = buildPrimary({
        fetchDataPlans: jest.fn(() => Promise.resolve(primaryPlans)),
      });
      const full = buildFull({
        fetchCatalogue: jest.fn(() =>
          Promise.resolve({
            dataPlans: fallbackPlans,
            cablePackages: [],
            discos: [],
            bettingCompanies: [],
          }),
        ),
      });
      const router = new RoutedBillsProvider(primary, full, logger);
      await router.fetchCatalogue();
      return { router, primary, full };
    };

    it('sends a fallback-owned plan code straight downstream', async () => {
      const primary = buildPrimary();
      const full = buildFull();
      const router = new RoutedBillsProvider(primary, full, logger);

      await router.buyData({ ...dataRequest, planCode: '312' });

      expect(primary.buyData).not.toHaveBeenCalled();
      expect(full.buyData).toHaveBeenCalled();
    });

    it('falls back with the paired plan code, never the original', async () => {
      const { router, full } = await loaded(
        [plan({ code: 'sp:1:2', name: '1GB [SME] - 30 days' })],
        [plan({ code: '312', name: '1GB - 30 days' })],
      );

      (router as unknown as { primary: AirtimeDataProvider }).primary.buyData = jest.fn(() =>
        Promise.reject(new AppException(ErrorCode.UPSTREAM_TIMEOUT, { message: 'slow' })),
      );

      await router.buyData(dataRequest);

      expect(full.buyData).toHaveBeenCalledWith(
        expect.objectContaining({ planCode: '312', reference: 'ord_2' }),
      );
    });

    it('does not fall back when no confident equivalent exists', async () => {
      // Better a clean failure than a different bundle at a price the customer
      // was never quoted.
      const { router, full } = await loaded(
        [plan({ code: 'sp:1:2', name: '1GB [SME]' })],
        [plan({ code: '312', name: '9GB - 30 days' })],
      );

      (router as unknown as { primary: AirtimeDataProvider }).primary.buyData = jest.fn(() =>
        Promise.reject(new AppException(ErrorCode.UPSTREAM_TIMEOUT, { message: 'slow' })),
      );

      await expect(router.buyData(dataRequest)).rejects.toMatchObject({
        code: ErrorCode.UPSTREAM_TIMEOUT,
      });
      expect(full.buyData).not.toHaveBeenCalled();
    });
  });

  describe('fetchCatalogue', () => {
    it('serves the fallback catalogue alone when the leader has no plans', async () => {
      const router = new RoutedBillsProvider(
        buildPrimary({ fetchDataPlans: jest.fn(() => Promise.reject(new Error('down'))) }),
        buildFull({
          fetchCatalogue: jest.fn(() =>
            Promise.resolve({
              dataPlans: [plan({ code: '312', name: '1GB' })],
              cablePackages: [],
              discos: [],
              bettingCompanies: [],
            }),
          ),
        }),
        logger,
      );

      const catalogue = await router.fetchCatalogue();

      expect(catalogue.dataPlans.map((entry) => entry.code)).toEqual(['312']);
    });

    it('fails when the full catalogue cannot be loaded', async () => {
      // Electricity, cable and betting have no second source.
      const router = new RoutedBillsProvider(
        buildPrimary(),
        buildFull({ fetchCatalogue: jest.fn(() => Promise.reject(new Error('down'))) }),
        logger,
      );

      await expect(router.fetchCatalogue()).rejects.toThrow('down');
    });
  });

  describe('verticals the leader does not sell', () => {
    it.each([
      ['payElectricity', { reference: 'r' }],
      ['subscribeCableTv', { reference: 'r' }],
      ['fundBetting', { reference: 'r' }],
    ])('routes %s straight to the full provider', async (method, request) => {
      const full = buildFull();
      const router = new RoutedBillsProvider(buildPrimary(), full, logger);

      await (router as unknown as Record<string, (arg: unknown) => Promise<unknown>>)[method]!(
        request,
      );

      expect(full[method as keyof BillsProvider]).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  //  The trailing airtime/data tier
  // ===========================================================================

  describe('with a trailing VAS tier', () => {
    const buildVas = (overrides: Partial<AirtimeDataProvider> = {}): AirtimeDataProvider => ({
      name: 'pulsemfb',
      getFloatBalance: jest.fn(() => Promise.resolve(Money.fromNaira('1000'))),
      fetchDataPlans: jest.fn(() => Promise.resolve([])),
      buyAirtime: jest.fn(() => Promise.resolve(order())),
      buyData: jest.fn(() => Promise.resolve(order({ vertical: BillVertical.Data }))),
      parseCallback: jest.fn(),
      ...overrides,
    });

    const unreachable = () =>
      Promise.reject(new AppException(ErrorCode.UPSTREAM_TIMEOUT, { message: 'timeout' }));

    it('names every tier it will use', () => {
      const router = new RoutedBillsProvider(buildPrimary(), buildFull(), logger, buildVas());
      expect(router.name).toBe('smeplug+clubkonnect+pulsemfb');
    });

    it('falls through to the third tier for airtime when both above fail', async () => {
      const vas = buildVas();
      const router = new RoutedBillsProvider(
        buildPrimary({ buyAirtime: jest.fn(unreachable) }),
        buildFull({ buyAirtime: jest.fn(unreachable) }),
        logger,
        vas,
      );

      await expect(
        router.buyAirtime({
          reference: 'r',
          network: MobileNetwork.Mtn,
          amount: Money.fromNaira('500'),
          phoneNumber: '08055940326',
        }),
      ).resolves.toMatchObject({ status: BillOrderStatus.Completed });

      expect(vas.buyAirtime).toHaveBeenCalled();
    });

    it('does not reach the third tier when a higher one succeeds', async () => {
      const vas = buildVas();
      const router = new RoutedBillsProvider(buildPrimary(), buildFull(), logger, vas);

      await router.buyAirtime({
        reference: 'r',
        network: MobileNetwork.Mtn,
        amount: Money.fromNaira('500'),
        phoneNumber: '08055940326',
      });

      expect(vas.buyAirtime).not.toHaveBeenCalled();
    });

    it('stops at a failure that says something about the request', async () => {
      const vas = buildVas();
      const router = new RoutedBillsProvider(
        buildPrimary({
          buyAirtime: jest.fn(() =>
            Promise.reject(
              new AppException(ErrorCode.VALIDATION_FAILED, { message: 'bad number' }),
            ),
          ),
        }),
        buildFull(),
        logger,
        vas,
      );

      await expect(
        router.buyAirtime({
          reference: 'r',
          network: MobileNetwork.Mtn,
          amount: Money.fromNaira('500'),
          phoneNumber: '08055940326',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });

      expect(vas.buyAirtime).not.toHaveBeenCalled();
    });

    it('sends data to the third tier only under a code that tier sells', async () => {
      const vas = buildVas({
        fetchDataPlans: jest.fn(() =>
          Promise.resolve([plan({ code: 'pm:mtn:1GB-30days', name: '1GB 30 days' })]),
        ),
      });
      const router = new RoutedBillsProvider(
        buildPrimary({
          fetchDataPlans: jest.fn(() =>
            Promise.resolve([plan({ code: 'sp:1:3', name: '1GB 30 days' })]),
          ),
          buyData: jest.fn(unreachable),
        }),
        buildFull({ buyData: jest.fn(unreachable) }),
        logger,
        vas,
      );

      await router.fetchCatalogue();
      await router.buyData({
        reference: 'r',
        network: MobileNetwork.Mtn,
        planCode: 'sp:1:3',
        phoneNumber: '08055940326',
      });

      // Re-placed under the third tier's own code, never under SMEPlug's.
      expect(vas.buyData).toHaveBeenCalledWith(
        expect.objectContaining({ planCode: 'pm:mtn:1GB-30days' }),
      );
    });

    it('skips the third tier for data when no confident equivalent exists', async () => {
      const vas = buildVas({
        fetchDataPlans: jest.fn(() =>
          Promise.resolve([plan({ code: 'pm:mtn:2GB', name: '2GB 30 days' })]),
        ),
      });
      const router = new RoutedBillsProvider(
        buildPrimary({
          fetchDataPlans: jest.fn(() =>
            Promise.resolve([plan({ code: 'sp:1:3', name: '1GB 30 days' })]),
          ),
          buyData: jest.fn(unreachable),
        }),
        buildFull({ buyData: jest.fn(unreachable) }),
        logger,
        vas,
      );

      await router.fetchCatalogue();

      // Better a clean failure than a 2GB bundle at the 1GB price.
      await expect(
        router.buyData({
          reference: 'r',
          network: MobileNetwork.Mtn,
          planCode: 'sp:1:3',
          phoneNumber: '08055940326',
        }),
      ).rejects.toBeDefined();

      expect(vas.buyData).not.toHaveBeenCalled();
    });

    it('routes a third-tier plan code straight to that tier', async () => {
      const vas = buildVas();
      const full = buildFull();
      const router = new RoutedBillsProvider(buildPrimary(), full, logger, vas);

      await router.buyData({
        reference: 'r',
        network: MobileNetwork.Mtn,
        planCode: 'pm:mtn:1GB-30days',
        phoneNumber: '08055940326',
      });

      expect(vas.buyData).toHaveBeenCalled();
      expect(full.buyData).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  //  No leading provider — `BILLS_PROVIDER=clubkonnect` with a trailing tier
  // ===========================================================================

  describe('without a leading provider', () => {
    const buildVas = (overrides: Partial<AirtimeDataProvider> = {}): AirtimeDataProvider => ({
      name: 'pulsemfb',
      getFloatBalance: jest.fn(() => Promise.resolve(Money.fromNaira('1000'))),
      fetchDataPlans: jest.fn(() => Promise.resolve([])),
      buyAirtime: jest.fn(() => Promise.resolve(order())),
      buyData: jest.fn(() => Promise.resolve(order({ vertical: BillVertical.Data }))),
      parseCallback: jest.fn(),
      ...overrides,
    });

    it('names only the tiers present', () => {
      const router = new RoutedBillsProvider(undefined, buildFull(), logger, buildVas());
      expect(router.name).toBe('clubkonnect+pulsemfb');
    });

    it('serves airtime from the full provider, then the trailing tier', async () => {
      const vas = buildVas();
      const router = new RoutedBillsProvider(
        undefined,
        buildFull({
          buyAirtime: jest.fn(() =>
            Promise.reject(new AppException(ErrorCode.UPSTREAM_TIMEOUT, { message: 'timeout' })),
          ),
        }),
        logger,
        vas,
      );

      await router.buyAirtime({
        reference: 'r',
        network: MobileNetwork.Mtn,
        amount: Money.fromNaira('500'),
        phoneNumber: '08055940326',
      });

      expect(vas.buyAirtime).toHaveBeenCalled();
    });

    it('keeps the full provider’s catalogue under its own codes', async () => {
      const router = new RoutedBillsProvider(
        undefined,
        buildFull({
          fetchCatalogue: jest.fn(() =>
            Promise.resolve({
              dataPlans: [plan({ code: 'ck:1', name: '1GB 30 days' })],
              cablePackages: [],
              discos: [],
              bettingCompanies: [],
            }),
          ),
        }),
        logger,
        buildVas(),
      );

      const catalogue = await router.fetchCatalogue();
      expect(catalogue.dataPlans).toEqual([expect.objectContaining({ code: 'ck:1' })]);
    });
  });
});

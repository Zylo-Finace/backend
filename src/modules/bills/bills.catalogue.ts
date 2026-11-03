import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { Money } from '../../core/money/money';
import { CacheNamespace } from '../../infrastructure/cache/cache-key';
import { CacheService } from '../../infrastructure/cache/cache.service';
import {
  type AmountBounds,
  type BettingCompany,
  type BillCatalogue,
  BILLS_PROVIDER,
  type BillsProvider,
  type CablePackage,
  type CableProvider,
  type DataPlan,
  type ElectricityDisco,
  type MeterType,
  type MobileNetwork,
} from './bills-provider.interface';

/** Cached form. `Money` does not survive a JSON round trip, so amounts are stored as strings. */
interface SerialisedCatalogue {
  dataPlans: (Omit<DataPlan, 'price'> & { price: string })[];
  cablePackages: (Omit<CablePackage, 'price' | 'costPrice' | 'bounds'> & {
    price: string;
    costPrice: string;
    bounds: { min: string; max: string };
  })[];
  discos: (Omit<ElectricityDisco, 'bounds'> & { bounds: { min: string; max: string } })[];
  bettingCompanies: (Omit<BettingCompany, 'bounds'> & {
    bounds: { min: string; max: string };
  })[];
}

/**
 * The sellable catalogue, cached and queryable.
 *
 * ## Why the catalogue is authoritative rather than advisory
 *
 * Every product code a customer can choose is validated against this before an
 * order is placed. Passing an unrecognised `DataPlan` straight through to
 * ClubKonnect gets a generic error back *after* the round trip, with no way to
 * tell "you typed a bad code" apart from "the provider is having a bad day" —
 * and the two need opposite responses.
 *
 * It is also where prices come from. The float check upstream of every order
 * needs to know what an order will cost *before* placing it, and for data and
 * cable that figure exists only in the catalogue.
 */
@Injectable()
export class BillsCatalogueService {
  constructor(
    @Inject(BILLS_PROVIDER) private readonly provider: BillsProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly cache: CacheService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(BillsCatalogueService.name);
  }

  private get cacheKey(): string {
    return this.cache.keys.global(CacheNamespace.Bill, 'catalogue', this.provider.name);
  }

  /**
   * The catalogue, from cache when warm.
   *
   * Cached platform-wide rather than per tenant: it is the provider's price list,
   * identical for everyone, and fetching it is four slow upstream calls.
   */
  async get(): Promise<BillCatalogue> {
    const ttl = this.config.bills.catalogueCacheSeconds;
    if (ttl <= 0) return this.provider.fetchCatalogue();

    const cached = await this.cache.get<SerialisedCatalogue>(this.cacheKey);
    if (cached) return deserialise(cached);

    const catalogue = await this.provider.fetchCatalogue();
    await this.cache.set(this.cacheKey, serialise(catalogue), { ttlSeconds: ttl });

    this.logger.info(
      {
        dataPlans: catalogue.dataPlans.length,
        cablePackages: catalogue.cablePackages.length,
        discos: catalogue.discos.length,
        bettingCompanies: catalogue.bettingCompanies.length,
      },
      'Bill payment catalogue refreshed',
    );

    return catalogue;
  }

  /** Drops the cached copy so the next read goes upstream. */
  async invalidate(): Promise<void> {
    await this.cache.delete(this.cacheKey);
  }

  // ===========================================================================
  //  Lookups
  // ===========================================================================

  async dataPlansFor(network: MobileNetwork): Promise<DataPlan[]> {
    const { dataPlans } = await this.get();
    return dataPlans.filter((plan) => plan.network === network);
  }

  async cablePackagesFor(provider: CableProvider): Promise<CablePackage[]> {
    const { cablePackages } = await this.get();
    return cablePackages.filter((item) => item.provider === provider);
  }

  async discos(): Promise<ElectricityDisco[]> {
    return (await this.get()).discos;
  }

  async bettingCompanies(): Promise<BettingCompany[]> {
    return (await this.get()).bettingCompanies;
  }

  /** @throws AppException `BILL_PRODUCT_NOT_FOUND` when the plan is not in the catalogue. */
  async requireDataPlan(network: MobileNetwork, code: string): Promise<DataPlan> {
    const { dataPlans } = await this.get();
    const plan = dataPlans.find((item) => item.network === network && item.code === code);

    if (!plan) {
      throw new AppException(ErrorCode.BILL_PRODUCT_NOT_FOUND, {
        message: 'That data plan is not available',
        details: { network, planCode: code },
      });
    }
    return plan;
  }

  /** @throws AppException `BILL_PRODUCT_NOT_FOUND` when the package is not in the catalogue. */
  async requireCablePackage(provider: CableProvider, code: string): Promise<CablePackage> {
    const { cablePackages } = await this.get();
    const item = cablePackages.find(
      (candidate) => candidate.provider === provider && candidate.code === code,
    );

    if (!item) {
      throw new AppException(ErrorCode.BILL_PRODUCT_NOT_FOUND, {
        message: 'That cable TV package is not available',
        details: { provider, packageCode: code },
      });
    }
    return item;
  }

  /**
   * @throws AppException `BILL_PRODUCT_NOT_FOUND` when the disco is unknown, or
   *   when it does not support the requested meter type.
   */
  async requireDisco(code: string, meterType: MeterType): Promise<ElectricityDisco> {
    const { discos } = await this.get();
    const disco = discos.find((item) => item.code === code);

    if (!disco) {
      throw new AppException(ErrorCode.BILL_PRODUCT_NOT_FOUND, {
        message: 'That electricity provider is not available',
        details: { discoCode: code },
      });
    }

    // An empty list means the catalogue did not describe the meter types, not
    // that none are supported — refusing on that would break every disco.
    if (disco.meterTypes.length > 0 && !disco.meterTypes.includes(meterType)) {
      throw new AppException(ErrorCode.BILL_PRODUCT_NOT_FOUND, {
        message: 'That meter type is not supported by this electricity provider',
        details: { discoCode: code, meterType },
      });
    }

    return disco;
  }

  /** @throws AppException `BILL_PRODUCT_NOT_FOUND` when the company is not in the catalogue. */
  async requireBettingCompany(code: string): Promise<BettingCompany> {
    const { bettingCompanies } = await this.get();
    const company = bettingCompanies.find((item) => item.code === code);

    if (!company) {
      throw new AppException(ErrorCode.BILL_PRODUCT_NOT_FOUND, {
        message: 'That betting platform is not available',
        details: { companyCode: code },
      });
    }
    return company;
  }

  /**
   * Enforces the provider's own per-product limits before the round trip.
   *
   * Bounds of zero mean the catalogue did not state one, and are ignored rather
   * than treated as "nothing is allowed".
   */
  assertWithinBounds(amount: Money, bounds: AmountBounds, context: Record<string, unknown>): void {
    if (!amount.isPositive()) {
      throw new AppException(ErrorCode.BILL_AMOUNT_NOT_ALLOWED, {
        message: 'Amount must be greater than zero',
        details: { ...context, amount: amount.toDecimalString() },
      });
    }

    if (bounds.min.isPositive() && amount.lessThan(bounds.min)) {
      throw new AppException(ErrorCode.BILL_AMOUNT_NOT_ALLOWED, {
        message: `The minimum for this product is ${bounds.min.format()}`,
        details: {
          ...context,
          amount: amount.toDecimalString(),
          min: bounds.min.toDecimalString(),
        },
      });
    }

    if (bounds.max.isPositive() && amount.greaterThan(bounds.max)) {
      throw new AppException(ErrorCode.BILL_AMOUNT_NOT_ALLOWED, {
        message: `The maximum for this product is ${bounds.max.format()}`,
        details: {
          ...context,
          amount: amount.toDecimalString(),
          max: bounds.max.toDecimalString(),
        },
      });
    }
  }
}

// =============================================================================
//  Cache serialisation
// =============================================================================

function serialise(catalogue: BillCatalogue): SerialisedCatalogue {
  return {
    dataPlans: catalogue.dataPlans.map((plan) => ({
      ...plan,
      price: plan.price.toDecimalString(),
    })),
    cablePackages: catalogue.cablePackages.map((item) => ({
      ...item,
      price: item.price.toDecimalString(),
      costPrice: item.costPrice.toDecimalString(),
      bounds: { min: item.bounds.min.toDecimalString(), max: item.bounds.max.toDecimalString() },
    })),
    discos: catalogue.discos.map((disco) => ({
      ...disco,
      bounds: { min: disco.bounds.min.toDecimalString(), max: disco.bounds.max.toDecimalString() },
    })),
    bettingCompanies: catalogue.bettingCompanies.map((company) => ({
      ...company,
      bounds: {
        min: company.bounds.min.toDecimalString(),
        max: company.bounds.max.toDecimalString(),
      },
    })),
  };
}

function deserialise(cached: SerialisedCatalogue): BillCatalogue {
  return {
    dataPlans: cached.dataPlans.map((plan) => ({ ...plan, price: Money.fromNaira(plan.price) })),
    cablePackages: cached.cablePackages.map((item) => ({
      ...item,
      price: Money.fromNaira(item.price),
      costPrice: Money.fromNaira(item.costPrice),
      bounds: { min: Money.fromNaira(item.bounds.min), max: Money.fromNaira(item.bounds.max) },
    })),
    discos: cached.discos.map((disco) => ({
      ...disco,
      bounds: { min: Money.fromNaira(disco.bounds.min), max: Money.fromNaira(disco.bounds.max) },
    })),
    bettingCompanies: cached.bettingCompanies.map((company) => ({
      ...company,
      bounds: {
        min: Money.fromNaira(company.bounds.min),
        max: Money.fromNaira(company.bounds.max),
      },
    })),
  };
}

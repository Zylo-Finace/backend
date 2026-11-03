import { Injectable, OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { AppException } from '../../core/errors/app.exception';
import { InjectPrisma } from '../../infrastructure/database/prisma.module';
import type { ExtendedPrismaClient } from '../../infrastructure/database/prisma.service';
import { applyRampRateOverrides, getRampConfig, getRampRateOverrides } from './ramp.config';

export type RampRatesSnapshot = {
  sellRateNgn: number;
  buyRateNgn: number;
  maxOrderUsdc: number;
  minBankSendNgn: number;
  maxBankSendNgn: number;
  sellFeeNgn: number;
  timestamp: string;
  source: 'database' | 'env';
};

export type UpdateRampRatesInput = {
  sellRateNgn?: number;
  buyRateNgn?: number;
  maxOrderUsdc?: number;
  minBankSendNgn?: number;
  maxBankSendNgn?: number;
  sellFeeNgn?: number;
  updatedByUserId?: string;
};

/**
 * Loads admin-editable rates from `zylo_ramp_settings` into process memory so
 * sync `getRampConfig()` (used all over WhatsApp flows) stays fast.
 */
@Injectable()
export class RampRatesService implements OnModuleInit {
  constructor(
    @InjectPrisma() private readonly db: ExtendedPrismaClient,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RampRatesService.name);
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.reloadFromDb();
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '[ramp-rates] Failed to load DB overrides; using env defaults',
      );
    }
  }

  async reloadFromDb(): Promise<void> {
    const row = await this.db.zyRampSettings.findUnique({ where: { id: 1 } });
    if (!row) return;
    applyRampRateOverrides({
      sellNgn: row.sellRateNgn,
      buyNgn: row.buyRateNgn,
      maxOrderUsdc: Number(row.maxOrderUsdc),
      minBankSendNgn: row.minBankSendNgn,
      maxBankSendNgn: row.maxBankSendNgn,
      sellFeeNgn: row.sellFeeNgn,
      updatedAt: row.updatedAt.toISOString(),
    });
    this.logger.info(
      { sell: row.sellRateNgn, buy: row.buyRateNgn },
      '[ramp-rates] Loaded overrides from DB',
    );
  }

  getSnapshot(): RampRatesSnapshot {
    const config = getRampConfig();
    const overrides = getRampRateOverrides();
    return {
      sellRateNgn: config.rates.sellNgn,
      buyRateNgn: config.rates.buyNgn,
      maxOrderUsdc: config.maxOrderUsdc,
      minBankSendNgn: config.minBankSendNgn,
      maxBankSendNgn: config.maxBankSendNgn,
      sellFeeNgn: config.sellFeeNgn,
      timestamp: overrides.updatedAt ?? new Date().toISOString(),
      source: overrides.sellNgn != null || overrides.buyNgn != null ? 'database' : 'env',
    };
  }

  async update(input: UpdateRampRatesInput): Promise<RampRatesSnapshot> {
    const current = this.getSnapshot();
    const sell = input.sellRateNgn ?? current.sellRateNgn;
    const buy = input.buyRateNgn ?? current.buyRateNgn;
    const maxOrder = input.maxOrderUsdc ?? current.maxOrderUsdc;
    const minBank = input.minBankSendNgn ?? current.minBankSendNgn;
    const maxBank = input.maxBankSendNgn ?? current.maxBankSendNgn;
    const sellFee = input.sellFeeNgn ?? current.sellFeeNgn;

    this.assertValid({ sell, buy, maxOrder, minBank, maxBank, sellFee });

    const row = await this.db.zyRampSettings.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        sellRateNgn: sell,
        buyRateNgn: buy,
        maxOrderUsdc: maxOrder,
        minBankSendNgn: minBank,
        maxBankSendNgn: maxBank,
        sellFeeNgn: sellFee,
        updatedByUserId: input.updatedByUserId ?? null,
      },
      update: {
        sellRateNgn: sell,
        buyRateNgn: buy,
        maxOrderUsdc: maxOrder,
        minBankSendNgn: minBank,
        maxBankSendNgn: maxBank,
        sellFeeNgn: sellFee,
        updatedByUserId: input.updatedByUserId ?? null,
      },
    });

    applyRampRateOverrides({
      sellNgn: row.sellRateNgn,
      buyNgn: row.buyRateNgn,
      maxOrderUsdc: Number(row.maxOrderUsdc),
      minBankSendNgn: row.minBankSendNgn,
      maxBankSendNgn: row.maxBankSendNgn,
      sellFeeNgn: row.sellFeeNgn,
      updatedAt: row.updatedAt.toISOString(),
    });

    this.logger.info(
      {
        sell: row.sellRateNgn,
        buy: row.buyRateNgn,
        by: input.updatedByUserId,
      },
      '[ramp-rates] Updated by admin',
    );

    return this.getSnapshot();
  }

  private assertValid(v: {
    sell: number;
    buy: number;
    maxOrder: number;
    minBank: number;
    maxBank: number;
    sellFee: number;
  }): void {
    if (!Number.isFinite(v.sell) || v.sell < 100 || v.sell > 50_000) {
      throw AppException.validation('Sell rate must be between ₦100 and ₦50,000 per USDC');
    }
    if (!Number.isFinite(v.buy) || v.buy < 100 || v.buy > 50_000) {
      throw AppException.validation('Buy rate must be between ₦100 and ₦50,000 per USDC');
    }
    if (v.buy < v.sell) {
      throw AppException.validation('Buy rate must be ≥ sell rate (spread)');
    }
    if (!Number.isFinite(v.maxOrder) || v.maxOrder <= 0 || v.maxOrder > 1_000_000) {
      throw AppException.validation('Max order USDC is invalid');
    }
    if (!Number.isInteger(v.minBank) || v.minBank < 50) {
      throw AppException.validation('Min bank send must be at least ₦50');
    }
    if (!Number.isInteger(v.maxBank) || v.maxBank < v.minBank) {
      throw AppException.validation('Max bank send must be ≥ min bank send');
    }
    if (!Number.isInteger(v.sellFee) || v.sellFee < 0 || v.sellFee > 100_000) {
      throw AppException.validation('Sell fee NGN is invalid');
    }
  }
}

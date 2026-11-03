import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { isRampEnabled } from './ramp.config';
import { RampNairaService } from './ramp.naira';
import { RampStoreService } from './ramp.store';

const POLL_MS = 45_000;
/** Give FalconPay webhooks time to arrive before we poll. */
const MIN_AGE_MS = 25_000;

/**
 * Polls FalconPay for terminal payout status when webhooks are missing or late,
 * then sends the green WhatsApp receipt via {@link RampNairaService}.
 */
@Injectable()
export class RampBankSendWatcher implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;

  constructor(
    private readonly store: RampStoreService,
    private readonly naira: RampNairaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RampBankSendWatcher.name);
  }

  onModuleInit(): void {
    this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  private start(): void {
    if (!isRampEnabled()) {
      this.logger.info('[zylo-ramp] disabled — bank-send watcher not started');
      return;
    }
    this.logger.info('[zylo-ramp] watching processing bank sends for FalconPay completion');
    void this.scanOnce();
    this.timer = setInterval(() => void this.scanOnce(), POLL_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async scanOnce(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const pending = await this.store.listProcessingBankSends(40);
      const cutoff = Date.now() - MIN_AGE_MS;
      for (const row of pending) {
        if (row.createdAt.getTime() > cutoff) continue;
        try {
          await this.naira.reconcileBankSendNotification(row.ref);
        } catch (e) {
          this.logger.warn(
            { err: e instanceof Error ? e.message : String(e), ref: row.ref },
            '[zylo-ramp] bank-send reconcile failed',
          );
        }
      }
    } finally {
      this.scanning = false;
    }
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { VirtualAccountType } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';

import { RequestContext } from '../../core/context/request-context';
import { InjectPrisma } from '../../infrastructure/database/prisma.module';
import type { ExtendedPrismaClient } from '../../infrastructure/database/prisma.service';
import { CacheNamespace } from '../../infrastructure/cache/cache-key';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { KycService } from '../kyc/kyc.service';
import { PAYMENT_PROVIDER, type PaymentProvider } from './payment-provider.interface';

/**
 * Issues each customer their dedicated funding account.
 *
 * ## Never on the registration path
 *
 * Provisioning is a round trip to the provider, and sometimes onward to a bank.
 * It is slow, it fails, and it is entirely outside our control. Blocking
 * registration on it would mean a provider outage stops customer sign-ups
 * altogether — so registration completes with a wallet but no funding account,
 * and this service fills the gap afterwards.
 *
 * The customer-visible consequence is honest and small: `GET /wallet/funding-account`
 * returns 404 until the account exists, and the UI shows "your account is being
 * set up". That is a far better failure than "registration is down".
 *
 * ## Idempotency
 *
 * A distributed lock keyed on the user prevents two concurrent calls issuing two
 * accounts, and the `@@unique([userId])` constraint on `bank_accounts` is the
 * backstop if the lock is unavailable. Provisioning twice would leave a customer
 * with an orphaned NUBAN that receives money nobody credits.
 */
@Injectable()
export class AccountProvisioningService {
  constructor(
    @InjectPrisma() private readonly db: ExtendedPrismaClient,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly kyc: KycService,
    private readonly cache: CacheService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AccountProvisioningService.name);
  }

  /**
   * Ensures a customer has a funding account, creating one if needed.
   *
   * @returns `true` when an account exists afterwards, `false` when provisioning
   *          failed and should be retried later. Deliberately does not throw:
   *          callers are background paths where a failure is expected and
   *          recoverable, not an exception to propagate.
   */
  async ensureAccount(userId: string): Promise<boolean> {
    const tenantId = RequestContext.requireTenantId();

    const existing = await this.db.bankAccount.findFirst({
      where: { userId },
      select: { id: true },
    });
    if (existing) return true;

    const lockKey = this.cache.keys.tenant(tenantId, CacheNamespace.Lock, 'provision', userId);

    const result = await this.cache.withLock(lockKey, 60, async () => {
      // Re-check inside the lock: the holder we queued behind may have just
      // finished creating it.
      const raced = await this.db.bankAccount.findFirst({
        where: { userId },
        select: { id: true },
      });
      if (raced) return true;

      const user = await this.db.user.findFirst({
        where: { id: userId },
        select: { id: true, fullName: true, email: true, phoneE164: true },
      });

      if (!user?.phoneE164) {
        this.logger.warn({ userId }, 'Cannot provision an account without a phone number');
        return false;
      }

      // A permanent NUBAN is a durable claim on a bank, and the partner bank
      // requires verified identity before it will issue one. Checked here rather
      // than left to the provider's 400 so the reason is ours to explain, and so
      // a provider that stops enforcing it does not quietly open the gate.
      if (!(await this.kyc.canIssuePermanentAccount(userId))) {
        this.logger.info(
          { userId },
          'Customer is not verified to the required tier; deferring account provisioning',
        );
        return false;
      }

      const identity = await this.kyc.getVerifiedIdentifiers(userId);

      try {
        const account = await this.provider.createVirtualAccount({
          userId: user.id,
          // The registry's spelling, when we have it. The partner bank matches
          // the account name against the BVN record, not against our profile, so
          // sending the customer's own spelling is how issuance silently fails.
          fullName: identity.verifiedName ?? user.fullName ?? 'Customer',
          // Providers require an email. A deterministic placeholder derived from
          // the phone keeps provisioning possible for customers who gave none,
          // and stays stable so a retry maps to the same provider customer.
          email: user.email ?? `${user.phoneE164.replace(/\D/g, '')}@customers.invalid`,
          phoneE164: user.phoneE164,
          bvn: identity.bvn,
          nin: identity.nin,
        });

        await this.db.bankAccount.create({
          data: {
            tenantId,
            userId: user.id,
            provider: account.provider,
            accountType: VirtualAccountType.STATIC,
            reference: account.reference,
            bankName: account.bankName,
            bankCode: account.bankCode,
            accountName: account.accountName,
            accountNumber: account.accountNumber,
            currency: account.currency,
            metadata: account.raw as never,
          },
        });

        this.logger.info(
          { userId, bank: account.bankName, provider: account.provider },
          'Dedicated funding account provisioned',
        );
        return true;
      } catch (error) {
        // Logged, not thrown: the caller is a background path and the customer's
        // account is still usable without funding until this succeeds.
        this.logger.error({ err: error, userId }, 'Failed to provision a funding account');
        return false;
      }
    });

    // `withLock` returns undefined when another worker holds the lock — that
    // worker is provisioning right now, so this is not a failure.
    return result ?? false;
  }
}

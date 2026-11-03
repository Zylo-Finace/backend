import { Injectable } from '@nestjs/common';
import { Prisma, UserStatus, UserType } from '@prisma/client';

import { buildOffsetPage, type OffsetPage } from '../../../core/dto/pagination.dto';
import { AppException } from '../../../core/errors/app.exception';
import { ErrorCode } from '../../../core/errors/error-code.enum';
import { Money } from '../../../core/money/money';
import { Phone } from '../../../core/utils/phone.util';
import { InjectPrisma } from '../../../infrastructure/database/prisma.module';
import type { ExtendedPrismaClient } from '../../../infrastructure/database/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { CustomerQueryDto, SuspendCustomerDto } from './customers.controller';

export interface CustomerListItem {
  id: string;
  phoneE164: string | null;
  fullName: string | null;
  username: string | null;
  status: UserStatus;
  balance: ReturnType<Money['toJSON']> | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface CustomerDetail extends CustomerListItem {
  email: string | null;
  locale: string;
  timezone: string | null;
  phoneVerifiedAt: string | null;
  pinResetRequired: boolean;
  lockedUntil: string | null;
  failedPinAttempts: number;
  wallet: {
    id: string;
    balance: ReturnType<Money['toJSON']>;
    locked: ReturnType<Money['toJSON']>;
    currency: string;
    status: string;
  } | null;
  fundingAccount: {
    bankName: string;
    accountNumber: string;
    accountName: string;
    isActive: boolean;
  } | null;
}

/**
 * Customers — the end users reached over WhatsApp.
 *
 * Read and moderate only. There is no create endpoint: customers arrive by
 * registering through WhatsApp, and a back-office-created account would have no
 * verified phone number, which is the identity the entire wallet and messaging
 * model keys on.
 */
@Injectable()
export class CustomersService {
  constructor(
    @InjectPrisma() private readonly db: ExtendedPrismaClient,
    private readonly audit: AuditService,
  ) {}

  async list(query: CustomerQueryDto): Promise<OffsetPage<CustomerListItem>> {
    const where: Prisma.UserWhereInput = {
      type: UserType.CUSTOMER,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.search ? { OR: searchPredicate(query.search) } : {}),
    };

    const [rows, total] = await Promise.all([
      this.db.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
        select: {
          id: true,
          phoneE164: true,
          fullName: true,
          username: true,
          status: true,
          lastLoginAt: true,
          createdAt: true,
          wallet: { select: { balance: true, currency: true } },
        },
      }),
      this.db.user.count({ where }),
    ]);

    const items = rows.map((row) => ({
      id: row.id,
      phoneE164: row.phoneE164,
      fullName: row.fullName,
      username: row.username,
      status: row.status,
      balance: row.wallet ? Money.fromKobo(row.wallet.balance, row.wallet.currency).toJSON() : null,
      lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));

    return buildOffsetPage(items, total, query);
  }

  async get(id: string): Promise<CustomerDetail> {
    const user = await this.db.user.findFirst({
      where: { id, type: UserType.CUSTOMER, deletedAt: null },
      select: {
        id: true,
        phoneE164: true,
        fullName: true,
        username: true,
        email: true,
        status: true,
        locale: true,
        timezone: true,
        phoneVerifiedAt: true,
        pinResetRequired: true,
        lockedUntil: true,
        failedPinAttempts: true,
        lastLoginAt: true,
        createdAt: true,
        wallet: {
          select: {
            id: true,
            balance: true,
            lockedBalance: true,
            currency: true,
            status: true,
          },
        },
        bankAccount: {
          select: {
            bankName: true,
            accountNumber: true,
            accountName: true,
            isActive: true,
          },
        },
      },
    });

    if (!user) throw AppException.notFound('Customer', id);

    return {
      id: user.id,
      phoneE164: user.phoneE164,
      fullName: user.fullName,
      username: user.username,
      email: user.email,
      status: user.status,
      locale: user.locale,
      timezone: user.timezone,
      phoneVerifiedAt: user.phoneVerifiedAt?.toISOString() ?? null,
      pinResetRequired: user.pinResetRequired,
      lockedUntil: user.lockedUntil?.toISOString() ?? null,
      failedPinAttempts: user.failedPinAttempts,
      balance: user.wallet
        ? Money.fromKobo(user.wallet.balance, user.wallet.currency).toJSON()
        : null,
      wallet: user.wallet
        ? {
            id: user.wallet.id,
            balance: Money.fromKobo(user.wallet.balance, user.wallet.currency).toJSON(),
            locked: Money.fromKobo(user.wallet.lockedBalance, user.wallet.currency).toJSON(),
            currency: user.wallet.currency,
            status: user.wallet.status,
          }
        : null,
      fundingAccount: user.bankAccount,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
    };
  }

  async suspend(id: string, dto: SuspendCustomerDto): Promise<CustomerDetail> {
    const customer = await this.get(id);

    if (customer.status === UserStatus.SUSPENDED) {
      throw new AppException(ErrorCode.INVALID_STATE_TRANSITION, {
        message: 'This customer is already suspended',
      });
    }

    await this.db.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { status: UserStatus.SUSPENDED } });
      await tx.session.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'customer suspended' },
      });
    });

    await this.audit.record({
      action: 'customer.suspended',
      resourceType: 'user',
      resourceId: id,
      metadata: { reason: dto.reason },
    });

    return this.get(id);
  }

  async reinstate(id: string): Promise<CustomerDetail> {
    await this.get(id);

    await this.db.user.update({
      where: { id },
      data: { status: UserStatus.ACTIVE, failedPinAttempts: 0, lockedUntil: null },
    });

    await this.audit.record({
      action: 'customer.reinstated',
      resourceType: 'user',
      resourceId: id,
    });

    return this.get(id);
  }

  /**
   * Clears a PIN lockout without changing the PIN.
   *
   * The common support case is a customer who fat-fingered their PIN five times,
   * not a compromised account. Resetting the counter is the minimum intervention
   * — and notably it does *not* let staff set a PIN, which would make every
   * support agent capable of draining a wallet.
   */
  async unlock(id: string): Promise<CustomerDetail> {
    await this.get(id);

    await this.db.user.update({
      where: { id },
      data: { failedPinAttempts: 0, lockedUntil: null },
    });

    await this.audit.record({
      action: 'customer.unlocked',
      resourceType: 'user',
      resourceId: id,
    });

    return this.get(id);
  }

  /**
   * Forces the customer to choose a new PIN on next use.
   *
   * Sets a flag rather than issuing a PIN: a PIN staff can see is a PIN staff
   * can use, and the wallet treats the PIN as the transaction credential.
   */
  async requirePinReset(id: string): Promise<CustomerDetail> {
    await this.get(id);

    await this.db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: { pinResetRequired: true, failedPinAttempts: 0, lockedUntil: null },
      });
      await tx.session.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'pin reset required' },
      });
    });

    await this.audit.record({
      action: 'customer.pin_reset_required',
      resourceType: 'user',
      resourceId: id,
    });

    return this.get(id);
  }
}

/**
 * Builds the search predicate.
 *
 * A search that looks like a phone number is normalised to E.164 first, so
 * `08012345678`, `2348012345678` and `+234 801 234 5678` all find the same
 * customer — the same convergence the registration path performs. Without it,
 * staff searching the number a customer read out over the phone find nothing.
 */
function searchPredicate(search: string): Prisma.UserWhereInput[] {
  const predicates: Prisma.UserWhereInput[] = [
    { fullName: { contains: search, mode: 'insensitive' } },
    { username: { contains: search.toLowerCase() } },
    { phoneE164: { contains: search } },
  ];

  const normalised = Phone.normalize(search);
  if (normalised) predicates.push({ phoneE164: normalised });

  return predicates;
}

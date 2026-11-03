import { Injectable } from '@nestjs/common';
import {
  PayoutStatus,
  Prisma,
  ReferralStatus,
  RewardReason,
  UserStatus,
  type RewardProfile,
} from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';

import { RequestContext } from '../../core/context/request-context';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { Phone } from '../../core/utils/phone.util';
import { InjectPrisma } from '../../infrastructure/database/prisma.module';
import type { ExtendedPrismaClient } from '../../infrastructure/database/prisma.service';
import {
  DAILY_CHECK_IN_POINTS,
  LATE_REFERRAL_WINDOW_DAYS,
  QUALIFYING_TRANSACTION_NGN,
  REFEREE_POINTS,
  REFERRAL_CAP,
  REFERRAL_SAME_IP_DAILY_LIMIT,
  REFERRER_POINTS,
  SIGNUP_POINTS,
  STREAK_BONUSES,
  TRANSACTION_MILESTONES,
  applyCheckIn,
  generateReferralCode,
  isWellFormedReferralCode,
  lagosDay,
  milestonesReached,
  nextMilestone,
  nextStreakBonus,
  normalizeReferralCode,
} from './rewards.rules';

/** Anything with a `$transaction`-style model surface: the client or a tx. */
type Db = Pick<ExtendedPrismaClient, 'rewardProfile' | 'rewardLedgerEntry' | 'referral' | 'user'>;

interface Award {
  tenantId: string;
  userId: string;
  reason: RewardReason;
  points: number;
  dedupeKey: string;
  label: string;
  metadata?: Prisma.InputJsonValue;
}

export interface RewardsSummary {
  balance: number;
  lifetimePoints: number;
  streak: {
    current: number;
    longest: number;
    checkedInToday: boolean;
    dailyPoints: number;
    nextBonus: { days: number; points: number } | null;
    bonuses: ReadonlyArray<{ days: number; points: number }>;
  };
  transactions: {
    completed: number;
    qualifyingAmountNgn: number;
    nextMilestone: { count: number; points: number } | null;
    milestones: Array<{ count: number; points: number; achieved: boolean }>;
  };
  referral: {
    code: string;
    referrerPoints: number;
    refereePoints: number;
    pending: number;
    rewarded: number;
    pointsEarned: number;
    /** Whether this customer can still enter a friend's code. */
    canApplyCode: boolean;
    referredBy: string | null;
  };
  signupPoints: number;
}

export interface RewardHistoryItem {
  id: string;
  reason: RewardReason;
  points: number;
  label: string;
  createdAt: string;
}

export interface ReferralView {
  id: string;
  name: string;
  status: ReferralStatus;
  rejectionReason: string | null;
  createdAt: string;
  rewardedAt: string | null;
}

/**
 * BANJEE Points and referrals.
 *
 * ## Money-like, so built like money
 *
 * Every award is a row in an append-only ledger with a per-customer
 * `dedupeKey`, inserted with `ON CONFLICT DO NOTHING`. The cached balance is
 * incremented only when that insert actually wrote a row, in the same
 * transaction. That makes each rule idempotent by construction: a retried
 * request, a double tap or two tabs racing each other all converge on one
 * award, and nothing needs a lock.
 *
 * ## Referral fraud
 *
 * A referral pays only once the invited customer completes a real transaction
 * (≥ {@link QUALIFYING_TRANSACTION_NGN}), never at signup — signups are free to
 * fake, transactions are not. On top of that: one referrer per customer ever,
 * no self-referral (also a database CHECK), a rolling cap per referrer, and a
 * same-IP burst limit. Blocked referrals are kept as REJECTED with a reason,
 * so support can see what happened.
 */
@Injectable()
export class RewardsService {
  constructor(
    @InjectPrisma() private readonly db: ExtendedPrismaClient,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RewardsService.name);
  }

  // ===========================================================================
  //  Lifecycle hooks (called from auth / portal actions)
  // ===========================================================================

  /**
   * Looks up the customer a code belongs to, before an account is created.
   * @throws VALIDATION_FAILED when the code does not exist, so registration can
   *         say so instead of silently dropping it.
   */
  async resolveReferrer(rawCode: string): Promise<string> {
    const code = normalizeReferralCode(rawCode);
    const profile = isWellFormedReferralCode(code)
      ? await this.db.rewardProfile.findFirst({
          where: { referralCode: code },
          select: { userId: true, user: { select: { status: true } } },
        })
      : null;

    if (!profile || profile.user.status !== UserStatus.ACTIVE) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: "That referral code isn't valid. Check it, or leave it blank.",
        details: { field: 'referralCode' },
      });
    }
    return profile.userId;
  }

  /** Signup bonus, referral code and (optionally) the referral link. Never throws. */
  async onSignup(args: {
    userId: string;
    username: string | null;
    referrerId?: string;
    ip?: string;
  }): Promise<void> {
    try {
      const tenantId = RequestContext.requireTenantId();
      await this.ensureProfile(args.userId, args.username);
      await this.db.$transaction((tx) =>
        this.award(tx, {
          tenantId,
          userId: args.userId,
          reason: RewardReason.SIGNUP,
          points: SIGNUP_POINTS,
          dedupeKey: 'signup',
          label: 'Welcome to BANJEE',
        }),
      );
      if (args.referrerId) await this.attachReferral(args.userId, args.referrerId, args.ip);
    } catch (err) {
      // Rewards must never be the reason an account could not be opened.
      this.logger.error({ err, userId: args.userId }, 'Signup rewards failed');
    }
  }

  /** Daily check-in and transaction sync after a login. Never throws. */
  async onLogin(userId: string): Promise<void> {
    try {
      await this.checkIn(userId);
      await this.syncTransactions(userId);
    } catch (err) {
      this.logger.error({ err, userId }, 'Login rewards failed');
    }
  }

  /** Re-evaluates milestones and referral qualification after a transaction. Never throws. */
  async onTransaction(userId: string): Promise<void> {
    try {
      await this.syncTransactions(userId);
    } catch (err) {
      this.logger.error({ err, userId }, 'Transaction rewards failed');
    }
  }

  // ===========================================================================
  //  Customer API
  // ===========================================================================

  async getSummary(userId: string): Promise<RewardsSummary> {
    await this.checkIn(userId);
    const completed = await this.syncTransactions(userId);

    const profile = await this.ensureProfile(userId);
    const [referralCounts, referralPoints, referredBy, canApplyCode] = await Promise.all([
      this.db.referral.groupBy({
        by: ['status'],
        where: { referrerId: userId },
        _count: { _all: true },
      }),
      this.db.rewardLedgerEntry.aggregate({
        where: { userId, reason: RewardReason.REFERRAL_REFERRER },
        _sum: { points: true },
      }),
      this.db.referral.findFirst({
        where: { refereeId: userId },
        select: { referrer: { select: { username: true, fullName: true } } },
      }),
      this.canApplyCode(userId),
    ]);

    const countFor = (status: ReferralStatus) =>
      referralCounts.find((r) => r.status === status)?._count._all ?? 0;

    return {
      balance: profile.pointsBalance,
      lifetimePoints: profile.lifetimePoints,
      streak: {
        current: profile.currentStreak,
        longest: profile.longestStreak,
        checkedInToday: profile.lastCheckInDate
          ? profile.lastCheckInDate.toISOString().slice(0, 10) === lagosDay()
          : false,
        dailyPoints: DAILY_CHECK_IN_POINTS,
        nextBonus: nextStreakBonus(profile.currentStreak),
        bonuses: STREAK_BONUSES,
      },
      transactions: {
        completed,
        qualifyingAmountNgn: QUALIFYING_TRANSACTION_NGN,
        nextMilestone: nextMilestone(completed),
        milestones: TRANSACTION_MILESTONES.map((m) => ({ ...m, achieved: completed >= m.count })),
      },
      referral: {
        code: profile.referralCode,
        referrerPoints: REFERRER_POINTS,
        refereePoints: REFEREE_POINTS,
        pending: countFor(ReferralStatus.PENDING),
        rewarded: countFor(ReferralStatus.REWARDED),
        pointsEarned: referralPoints._sum.points ?? 0,
        canApplyCode,
        referredBy: referredBy ? displayName(referredBy.referrer) : null,
      },
      signupPoints: SIGNUP_POINTS,
    };
  }

  async getHistory(userId: string, limit = 50): Promise<RewardHistoryItem[]> {
    const rows = await this.db.rewardLedgerEntry.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    return rows.map((r) => ({
      id: r.id,
      reason: r.reason,
      points: r.points,
      label: r.label,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async getReferrals(userId: string): Promise<ReferralView[]> {
    const rows = await this.db.referral.findMany({
      where: { referrerId: userId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { referee: { select: { username: true, fullName: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      name: displayName(r.referee),
      status: r.status,
      rejectionReason: r.rejectionReason,
      createdAt: r.createdAt.toISOString(),
      rewardedAt: r.rewardedAt?.toISOString() ?? null,
    }));
  }

  /** Enter a friend's code after signing up, within the late window. */
  async applyCode(userId: string, rawCode: string, ip?: string): Promise<RewardsSummary> {
    if (!(await this.canApplyCode(userId))) {
      throw new AppException(ErrorCode.PRECONDITION_FAILED, {
        message: `Referral codes can only be added within ${LATE_REFERRAL_WINDOW_DAYS} days of signing up, once.`,
      });
    }
    const referrerId = await this.resolveReferrer(rawCode);
    if (referrerId === userId) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: "You can't use your own referral code.",
        details: { field: 'referralCode' },
      });
    }
    await this.attachReferral(userId, referrerId, ip);
    await this.syncTransactions(userId);
    return this.getSummary(userId);
  }

  // ===========================================================================
  //  Rules
  // ===========================================================================

  private async canApplyCode(userId: string): Promise<boolean> {
    const [user, existing] = await Promise.all([
      this.db.user.findFirst({ where: { id: userId }, select: { createdAt: true } }),
      this.db.referral.findFirst({ where: { refereeId: userId }, select: { id: true } }),
    ]);
    if (!user || existing) return false;
    const ageDays = (Date.now() - user.createdAt.getTime()) / 86_400_000;
    return ageDays <= LATE_REFERRAL_WINDOW_DAYS;
  }

  private async attachReferral(refereeId: string, referrerId: string, ip?: string): Promise<void> {
    const tenantId = RequestContext.requireTenantId();
    if (refereeId === referrerId) return;

    const since = new Date(Date.now() - 86_400_000);
    const sameIpToday = ip
      ? await this.db.referral.count({
          where: { referrerId, signupIp: ip, createdAt: { gte: since } },
        })
      : 0;

    const blocked = sameIpToday >= REFERRAL_SAME_IP_DAILY_LIMIT;

    try {
      await this.db.referral.create({
        data: {
          tenantId,
          referrerId,
          refereeId,
          signupIp: ip?.slice(0, 45),
          status: blocked ? ReferralStatus.REJECTED : ReferralStatus.PENDING,
          rejectionReason: blocked ? 'Too many sign-ups from the same device' : null,
        },
      });
    } catch (err) {
      // Unique on refereeId: already referred. First code wins, silently.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return;
      throw err;
    }

    if (blocked) {
      this.logger.warn({ referrerId, refereeId }, 'Referral rejected: same-IP burst');
    }
  }

  /** Once per Lagos day. Returns the profile after the check-in. */
  private async checkIn(userId: string): Promise<RewardProfile> {
    const tenantId = RequestContext.requireTenantId();
    const profile = await this.ensureProfile(userId);
    const today = lagosDay();
    const lastDay = profile.lastCheckInDate?.toISOString().slice(0, 10) ?? null;
    const outcome = applyCheckIn(lastDay, profile.currentStreak, today);
    if (!outcome.counted) return profile;

    const todayDate = new Date(`${today}T00:00:00Z`);

    return this.db.$transaction(async (tx) => {
      // Compare-and-set on the last check-in day: two concurrent requests read
      // the same row, but only one of them moves the date and pays.
      const moved = await tx.rewardProfile.updateMany({
        where: {
          id: profile.id,
          OR: [{ lastCheckInDate: null }, { lastCheckInDate: { not: todayDate } }],
        },
        data: {
          currentStreak: outcome.streak,
          longestStreak: Math.max(profile.longestStreak, outcome.streak),
          lastCheckInDate: todayDate,
        },
      });

      if (moved.count === 1) {
        await this.award(tx, {
          tenantId,
          userId,
          reason: RewardReason.DAILY_CHECK_IN,
          points: DAILY_CHECK_IN_POINTS,
          dedupeKey: `checkin:${today}`,
          label: outcome.streak > 1 ? `Daily check-in · day ${outcome.streak}` : 'Daily check-in',
        });
        if (outcome.bonus) {
          await this.award(tx, {
            tenantId,
            userId,
            reason: RewardReason.STREAK_BONUS,
            points: outcome.bonus.points,
            // Keyed by day as well: a streak can legitimately reach 7 again later.
            dedupeKey: `streak:${outcome.bonus.days}:${today}`,
            label: `${outcome.bonus.days}-day streak bonus`,
          });
        }
      }

      return tx.rewardProfile.findFirstOrThrow({ where: { id: profile.id } });
    });
  }

  /**
   * Counts the customer's completed, qualifying transactions across web and
   * WhatsApp, pays any milestones reached and qualifies a pending referral.
   * Returns the count.
   */
  private async syncTransactions(userId: string): Promise<number> {
    const tenantId = RequestContext.requireTenantId();
    const completed = await this.countQualifyingTransactions(userId);
    const reached = milestonesReached(completed);

    if (reached.length) {
      await this.ensureProfile(userId);
      await this.db.$transaction(async (tx) => {
        for (const m of reached) {
          await this.award(tx, {
            tenantId,
            userId,
            reason: RewardReason.TRANSACTION_MILESTONE,
            points: m.points,
            dedupeKey: `milestone:${m.count}`,
            label: m.count === 1 ? 'First transaction' : `${m.count} transactions milestone`,
            metadata: { count: m.count },
          });
        }
      });
    }

    if (completed >= 1) await this.qualifyReferral(userId);
    return completed;
  }

  private async qualifyReferral(refereeId: string): Promise<void> {
    const tenantId = RequestContext.requireTenantId();
    const referral = await this.db.referral.findFirst({
      where: { refereeId, status: ReferralStatus.PENDING },
      include: {
        referrer: { select: { status: true } },
        referee: { select: { username: true, fullName: true } },
      },
    });
    if (!referral) return;

    const reject = async (reason: string) => {
      await this.db.referral.updateMany({
        where: { id: referral.id, status: ReferralStatus.PENDING },
        data: { status: ReferralStatus.REJECTED, rejectionReason: reason },
      });
      this.logger.warn({ referralId: referral.id, reason }, 'Referral rejected');
    };

    if (referral.referrer.status !== UserStatus.ACTIVE) {
      return reject('The inviting account is not active');
    }

    const windowStart = new Date(Date.now() - REFERRAL_CAP.windowDays * 86_400_000);
    const recent = await this.db.referral.count({
      where: {
        referrerId: referral.referrerId,
        status: ReferralStatus.REWARDED,
        rewardedAt: { gte: windowStart },
      },
    });
    if (recent >= REFERRAL_CAP.count) {
      return reject(
        `Referral limit of ${REFERRAL_CAP.count} per ${REFERRAL_CAP.windowDays} days reached`,
      );
    }

    // The same verified identity on both sides is one person with two phones.
    const [referrerKyc, refereeKyc] = await Promise.all([
      this.db.kycProfile.findFirst({
        where: { userId: referral.referrerId },
        select: { bvnHash: true, ninHash: true },
      }),
      this.db.kycProfile.findFirst({
        where: { userId: refereeId },
        select: { bvnHash: true, ninHash: true },
      }),
    ]);
    const sameIdentity =
      (referrerKyc?.bvnHash && referrerKyc.bvnHash === refereeKyc?.bvnHash) ||
      (referrerKyc?.ninHash && referrerKyc.ninHash === refereeKyc?.ninHash);
    if (sameIdentity) return reject('Both accounts belong to the same person');

    await this.ensureProfile(referral.referrerId);
    await this.ensureProfile(refereeId);

    await this.db.$transaction(async (tx) => {
      const claimed = await tx.referral.updateMany({
        where: { id: referral.id, status: ReferralStatus.PENDING },
        data: { status: ReferralStatus.REWARDED, rewardedAt: new Date() },
      });
      if (claimed.count !== 1) return;

      await this.award(tx, {
        tenantId,
        userId: referral.referrerId,
        reason: RewardReason.REFERRAL_REFERRER,
        points: REFERRER_POINTS,
        dedupeKey: `referral:${refereeId}`,
        label: `${displayName(referral.referee)} joined with your code`,
        metadata: { referralId: referral.id },
      });
      await this.award(tx, {
        tenantId,
        userId: refereeId,
        reason: RewardReason.REFERRAL_REFEREE,
        points: REFEREE_POINTS,
        dedupeKey: 'referred-bonus',
        label: 'Referral bonus',
        metadata: { referralId: referral.id },
      });
    });

    this.logger.info({ referralId: referral.id }, 'Referral rewarded');
  }

  private async countQualifyingTransactions(userId: string): Promise<number> {
    const user = await this.db.user.findFirst({
      where: { id: userId },
      select: { phoneE164: true },
    });
    const phones = user?.phoneE164 ? rampPhoneCandidates(user.phoneE164) : [];
    const minNgn = QUALIFYING_TRANSACTION_NGN;

    const [bankSends, bills, orders, payouts] = await Promise.all([
      phones.length
        ? this.db.zyRampBankSend.count({
            where: { phone: { in: phones }, status: 'completed', amountNgn: { gte: minNgn } },
          })
        : 0,
      phones.length
        ? this.db.zyRampBillPurchase.count({
            where: { phone: { in: phones }, status: 'completed', amountNgn: { gte: minNgn } },
          })
        : 0,
      phones.length
        ? this.db.zyRampOrder.count({
            where: { phone: { in: phones }, status: 'completed', amountNgn: { gte: minNgn } },
          })
        : 0,
      this.db.payout.count({
        where: {
          userId,
          status: PayoutStatus.COMPLETED,
          amount: { gte: BigInt(minNgn * 100) },
        },
      }),
    ]);

    return bankSends + bills + orders + payouts;
  }

  // ===========================================================================
  //  Primitives
  // ===========================================================================

  /** Creates the rewards profile (and its referral code) on first use. */
  private async ensureProfile(userId: string, username?: string | null): Promise<RewardProfile> {
    const existing = await this.db.rewardProfile.findFirst({ where: { userId } });
    if (existing) return existing;

    const tenantId = RequestContext.requireTenantId();
    const handle =
      username !== undefined
        ? username
        : ((await this.db.user.findFirst({ where: { id: userId }, select: { username: true } }))
            ?.username ?? null);

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.db.rewardProfile.create({
          data: { tenantId, userId, referralCode: generateReferralCode(handle) },
        });
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
          throw err;
        }
        // Either a concurrent request created the profile, or the code clashed.
        const raced = await this.db.rewardProfile.findFirst({ where: { userId } });
        if (raced) return raced;
      }
    }
    throw AppException.internal('Could not allocate a referral code');
  }

  /**
   * Writes one ledger row and moves the balance — only if the row is new.
   * Must run inside a transaction.
   */
  private async award(tx: Db, award: Award): Promise<boolean> {
    const inserted = await tx.rewardLedgerEntry.createMany({
      data: [
        {
          tenantId: award.tenantId,
          userId: award.userId,
          reason: award.reason,
          points: award.points,
          dedupeKey: award.dedupeKey,
          label: award.label.slice(0, 160),
          metadata: award.metadata,
        },
      ],
      skipDuplicates: true,
    });
    if (inserted.count === 0) return false;

    await tx.rewardProfile.updateMany({
      where: { userId: award.userId },
      data: {
        pointsBalance: { increment: award.points },
        ...(award.points > 0 ? { lifetimePoints: { increment: award.points } } : {}),
      },
    });
    return true;
  }
}

/** "Ada L." — enough for a customer to recognise a friend, no more. */
function displayName(user: { username: string | null; fullName: string | null }): string {
  const parts = user.fullName?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (parts.length >= 2) return `${parts[0]} ${parts[parts.length - 1]![0]!.toUpperCase()}.`;
  if (parts.length === 1) return parts[0]!;
  return user.username ? `@${user.username}` : 'A friend';
}

/** Every form a WhatsApp ramp row may key this phone by. */
function rampPhoneCandidates(phoneE164: string): string[] {
  const wa = Phone.toWhatsAppId(phoneE164);
  const local =
    phoneE164.startsWith('+234') && phoneE164.length >= 14 ? `0${phoneE164.slice(4)}` : undefined;
  return [...new Set([wa, phoneE164, `+${wa}`, local].filter(Boolean) as string[])];
}

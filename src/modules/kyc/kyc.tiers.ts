import { KycLevel } from '@prisma/client';

import { KycTier } from '../../config/env.validation';

/**
 * The ladder, in order. Everything that compares two levels goes through
 * {@link rank} rather than comparing enum members, because enum ordering is an
 * implementation detail of code generation and a reordered Prisma schema must
 * not silently change who is allowed to open a bank account.
 */
const ORDER: readonly KycLevel[] = [
  KycLevel.TIER_0,
  KycLevel.TIER_1,
  KycLevel.TIER_2,
  KycLevel.TIER_3,
];

/** Position on the ladder. Higher is more evidence. */
export function rank(level: KycLevel): number {
  return ORDER.indexOf(level);
}

export function atLeast(level: KycLevel, required: KycLevel): boolean {
  return rank(level) >= rank(required);
}

/** Translates the configured tier string into the database enum. */
export function tierToLevel(tier: KycTier): KycLevel {
  switch (tier) {
    case KycTier.Tier1:
      return KycLevel.TIER_1;
    case KycTier.Tier2:
      return KycLevel.TIER_2;
    case KycTier.Tier3:
      return KycLevel.TIER_3;
    case KycTier.Tier0:
    default:
      return KycLevel.TIER_0;
  }
}

/**
 * The level implied by the evidence on file.
 *
 * Derived rather than stored so the two can never disagree.
 *
 * The ladder is strictly sequential, and that is the point: a NIN alone does not
 * reach TIER_1, because tier 2 is defined as *agreement between two registries*
 * and there is nothing to agree with until a BVN record exists. A customer who
 * somehow held a verified NIN and no BVN would sit at TIER_0 — which is the
 * honest reading, not an oversight.
 *
 * TIER_3 is not derivable at all: it requires a human decision, so callers keep
 * the higher of this result and the profile's current level.
 */
export function levelFor(evidence: { bvnVerified: boolean; ninVerified: boolean }): KycLevel {
  if (!evidence.bvnVerified) return KycLevel.TIER_0;
  return evidence.ninVerified ? KycLevel.TIER_2 : KycLevel.TIER_1;
}

/**
 * Transaction limits per level, in whole naira.
 *
 * Modelled on the CBN three-tier framework rather than invented: an unverified
 * customer is capped tightly, one verified identifier lifts them to a working
 * limit, and both plus a permanent account removes the daily ceiling. `null`
 * means no platform-imposed limit — the wallet balance and the payout bounds
 * still apply.
 *
 * Kept in code, not configuration: these are a compliance position, and a
 * position that can be widened by an environment variable is a position that
 * will be widened at 2am by somebody debugging a failed transfer.
 */
export interface TierLimits {
  /** Largest single inbound funding, naira. */
  singleFundingNaira: number | null;
  /** Total inbound funding per rolling day, naira. */
  dailyFundingNaira: number | null;
  /** Whether a permanent (STATIC) NUBAN may be issued at this level. */
  permanentAccount: boolean;
}

export const TIER_LIMITS: Readonly<Record<KycLevel, TierLimits>> = Object.freeze({
  // Registered only. Enough to try the product through a single-use on-ramp
  // account, not enough to hold a bank account.
  [KycLevel.TIER_0]: Object.freeze({
    singleFundingNaira: 50_000,
    dailyFundingNaira: 50_000,
    permanentAccount: false,
  }),
  [KycLevel.TIER_1]: Object.freeze({
    singleFundingNaira: 200_000,
    dailyFundingNaira: 500_000,
    permanentAccount: false,
  }),
  [KycLevel.TIER_2]: Object.freeze({
    singleFundingNaira: 1_000_000,
    dailyFundingNaira: 5_000_000,
    permanentAccount: true,
  }),
  [KycLevel.TIER_3]: Object.freeze({
    singleFundingNaira: null,
    dailyFundingNaira: null,
    permanentAccount: true,
  }),
});

export function limitsFor(level: KycLevel): TierLimits {
  return TIER_LIMITS[level];
}

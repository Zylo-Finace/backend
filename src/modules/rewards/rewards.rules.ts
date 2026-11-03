import { randomInt } from 'node:crypto';

/**
 * BANJEE Points — the rules, as pure functions.
 *
 * Kept free of I/O so every number a customer can see is covered by a unit test,
 * and so changing a reward is a one-line diff reviewed as policy rather than a
 * hunt through service code.
 */

export const SIGNUP_POINTS = 100;

/** Paid once per calendar day the customer opens the app. */
export const DAILY_CHECK_IN_POINTS = 5;

/** One-off bonuses when a streak reaches these lengths (days → points). */
export const STREAK_BONUSES: ReadonlyArray<{ days: number; points: number }> = [
  { days: 3, points: 15 },
  { days: 7, points: 50 },
  { days: 14, points: 120 },
  { days: 30, points: 300 },
];

/** Completed-transaction counts that earn a bonus (count → points). */
export const TRANSACTION_MILESTONES: ReadonlyArray<{ count: number; points: number }> = [
  { count: 1, points: 50 },
  { count: 5, points: 100 },
  { count: 10, points: 200 },
  { count: 25, points: 500 },
  { count: 50, points: 1_000 },
  { count: 100, points: 2_500 },
];

/**
 * Smallest transaction, in naira, that counts towards milestones and referral
 * qualification. Without a floor, ten ₦50 airtime top-ups farm a milestone.
 */
export const QUALIFYING_TRANSACTION_NGN = 500;

export const REFERRER_POINTS = 500;
export const REFEREE_POINTS = 200;

/** Referrals a single customer can be paid for in a rolling window. */
export const REFERRAL_CAP = { count: 30, windowDays: 30 } as const;
/** Referred signups from one IP, for one referrer, per day, before we stop paying. */
export const REFERRAL_SAME_IP_DAILY_LIMIT = 3;
/** How long after signup a customer may still enter a friend's code. */
export const LATE_REFERRAL_WINDOW_DAYS = 7;

/** Streaks and check-ins follow the customer's day, not UTC's. */
const TIME_ZONE = 'Africa/Lagos';

/** `YYYY-MM-DD` for `at` in Lagos. */
export function lagosDay(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export interface CheckInOutcome {
  /** False when the customer already checked in today. */
  counted: boolean;
  streak: number;
  /** Bonus unlocked by this check-in, if the new streak hits a threshold. */
  bonus: { days: number; points: number } | null;
}

/**
 * What a check-in on `today` does to a streak last extended on `lastDay`.
 *
 * Yesterday extends it; today is a no-op; anything older restarts at 1.
 */
export function applyCheckIn(
  lastDay: string | null,
  currentStreak: number,
  today: string,
): CheckInOutcome {
  if (lastDay === today) return { counted: false, streak: currentStreak, bonus: null };

  const streak = lastDay && daysBetween(lastDay, today) === 1 ? currentStreak + 1 : 1;
  const bonus = STREAK_BONUSES.find((b) => b.days === streak) ?? null;
  return { counted: true, streak, bonus };
}

/** Milestones reached at `count` completed transactions, lowest first. */
export function milestonesReached(count: number): Array<{ count: number; points: number }> {
  return TRANSACTION_MILESTONES.filter((m) => count >= m.count);
}

/** The next milestone above `count`, or null once they are all earned. */
export function nextMilestone(count: number): { count: number; points: number } | null {
  return TRANSACTION_MILESTONES.find((m) => count < m.count) ?? null;
}

/** The next streak bonus above `streak`, or null past the last one. */
export function nextStreakBonus(streak: number): { days: number; points: number } | null {
  return STREAK_BONUSES.find((b) => streak < b.days) ?? null;
}

/** No 0/O, 1/I/L: codes are read aloud and typed from screenshots. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * A shareable referral code: up to four letters of the username, then random
 * characters, eight in total. `ADA7K2QF` is friendlier than a UUID and still
 * leaves 31^4+ combinations per prefix, with the unique index resolving clashes.
 */
export function generateReferralCode(username: string | null): string {
  const prefix = (username ?? '')
    .toUpperCase()
    .split('')
    .filter((c) => CODE_ALPHABET.includes(c))
    .join('')
    .slice(0, 4);
  let code = prefix;
  while (code.length < 8) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** Normalises what a customer typed: case, spaces and dashes. */
export function normalizeReferralCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '');
}

export function isWellFormedReferralCode(code: string): boolean {
  return /^[A-Z0-9]{4,16}$/.test(code);
}

import {
  applyCheckIn,
  daysBetween,
  generateReferralCode,
  isWellFormedReferralCode,
  lagosDay,
  milestonesReached,
  nextMilestone,
  nextStreakBonus,
  normalizeReferralCode,
} from './rewards.rules';

describe('lagosDay', () => {
  it('uses the Lagos calendar day, not UTC', () => {
    // 23:30 UTC is 00:30 the next day in Lagos (UTC+1).
    expect(lagosDay(new Date('2026-09-16T23:30:00Z'))).toBe('2026-09-17');
  });
});

describe('daysBetween', () => {
  it('counts across a month boundary', () => {
    expect(daysBetween('2026-08-31', '2026-09-01')).toBe(1);
  });
});

describe('applyCheckIn', () => {
  it('starts a streak on the first check-in', () => {
    expect(applyCheckIn(null, 0, '2026-09-16')).toEqual({ counted: true, streak: 1, bonus: null });
  });

  it('does nothing on a second check-in the same day', () => {
    expect(applyCheckIn('2026-09-16', 4, '2026-09-16')).toEqual({
      counted: false,
      streak: 4,
      bonus: null,
    });
  });

  it('extends a streak checked in yesterday', () => {
    expect(applyCheckIn('2026-09-15', 4, '2026-09-16').streak).toBe(5);
  });

  it('restarts after a missed day', () => {
    expect(applyCheckIn('2026-09-14', 9, '2026-09-16').streak).toBe(1);
  });

  it('pays the bonus exactly when a threshold is reached', () => {
    expect(applyCheckIn('2026-09-15', 6, '2026-09-16').bonus).toEqual({ days: 7, points: 50 });
    expect(applyCheckIn('2026-09-15', 7, '2026-09-16').bonus).toBeNull();
  });
});

describe('milestones', () => {
  it('lists every milestone at or below the count', () => {
    expect(milestonesReached(0)).toEqual([]);
    expect(milestonesReached(12).map((m) => m.count)).toEqual([1, 5, 10]);
  });

  it('finds the next one to aim for', () => {
    expect(nextMilestone(0)?.count).toBe(1);
    expect(nextMilestone(10)?.count).toBe(25);
    expect(nextMilestone(500)).toBeNull();
  });

  it('finds the next streak bonus', () => {
    expect(nextStreakBonus(3)?.days).toBe(7);
    expect(nextStreakBonus(30)).toBeNull();
  });
});

describe('referral codes', () => {
  it('are eight unambiguous characters led by the username', () => {
    const code = generateReferralCode('ada_lovelace');
    expect(code).toHaveLength(8);
    expect(code.startsWith('ADA')).toBe(true);
    expect(code).not.toMatch(/[01OIL_]/);
  });

  it('work without a username', () => {
    expect(generateReferralCode(null)).toMatch(/^[A-Z2-9]{8}$/);
  });

  it('normalise what people type', () => {
    expect(normalizeReferralCode(' ada7-k2qf ')).toBe('ADA7K2QF');
    expect(isWellFormedReferralCode('ADA7K2QF')).toBe(true);
    expect(isWellFormedReferralCode('AD')).toBe(false);
  });
});

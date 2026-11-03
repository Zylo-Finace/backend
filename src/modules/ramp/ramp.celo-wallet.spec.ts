import { celoUserIndex, pickPreferredStable, sumDigitalDollars } from './ramp.celo-wallet';

describe('celoUserIndex', () => {
  it('is stable for the same phone digits', () => {
    expect(celoUserIndex('2348168882530')).toBe(celoUserIndex('+234 816 888 2530'));
    expect(celoUserIndex('2348168882530')).toBe(celoUserIndex('234-816-888-2530'));
  });

  it('never returns 0 (reserved for gas sponsor)', () => {
    for (const phone of ['2348012345678', '2348099999999', '1', '999']) {
      expect(celoUserIndex(phone)).toBeGreaterThan(0);
    }
  });

  it('differs across phones', () => {
    expect(celoUserIndex('2348111111111')).not.toBe(celoUserIndex('2348222222222'));
  });
});

describe('sumDigitalDollars', () => {
  it('sums USDC+USDT+cUSD at 1:1 with 6dp rounding', () => {
    expect(sumDigitalDollars(1, 2, 0.5)).toBe(3.5);
    expect(sumDigitalDollars(0.1, 0.2, 0.3)).toBe(0.6);
    expect(sumDigitalDollars(1.0000004, 0, 0)).toBe(1);
  });
});

describe('pickPreferredStable', () => {
  it('picks the highest balance that covers the need', () => {
    expect(pickPreferredStable({ usdc: 5, usdt: 12, cusd: 3 }, 10)).toBe('USDT');
  });

  it('falls through when the top balance is short', () => {
    expect(pickPreferredStable({ usdc: 8, usdt: 20, cusd: 1 }, 9)).toBe('USDT');
    expect(pickPreferredStable({ usdc: 8, usdt: 3, cusd: 1 }, 7)).toBe('USDC');
  });

  it('returns null when nothing covers', () => {
    expect(pickPreferredStable({ usdc: 1, usdt: 2, cusd: 0.5 }, 5)).toBeNull();
  });

  it('treats exact cover as enough', () => {
    expect(pickPreferredStable({ usdc: 0, usdt: 0, cusd: 2.5 }, 2.5)).toBe('cUSD');
  });
});

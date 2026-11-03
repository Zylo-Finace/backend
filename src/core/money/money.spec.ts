import { ErrorCode } from '../errors/error-code.enum';
import { Money } from './money';

describe('Money', () => {
  describe('construction from kobo', () => {
    it('accepts bigint, number and string', () => {
      expect(Money.fromKobo(150050n).kobo).toBe(150050n);
      expect(Money.fromKobo(150050).kobo).toBe(150050n);
      expect(Money.fromKobo('150050').kobo).toBe(150050n);
    });

    it('rejects a non-integer', () => {
      expect(() => Money.fromKobo(150.5)).toThrow(
        expect.objectContaining({ code: ErrorCode.VALIDATION_FAILED }) as Error,
      );
    });
  });

  describe('construction from naira', () => {
    it.each([
      ['1500.50', 150050n],
      ['1500.5', 150050n], // "…5" is 50 kobo, not 5 — padded, not truncated
      ['1500', 150000n],
      ['0.01', 1n],
      ['0', 0n],
      ['-250.75', -25075n],
    ])('parses %s to %s kobo', (input, expected) => {
      expect(Money.fromNaira(input).kobo).toBe(expected);
    });

    it('rejects a float, which is the whole point of this type', () => {
      // 0.1 + 0.2 === 0.30000000000000004. Allowing it would silently produce
      // 30 kobo here and a different answer somewhere else.
      expect(() => Money.fromNaira(0.1 + 0.2)).toThrow(
        expect.objectContaining({ code: ErrorCode.VALIDATION_FAILED }) as Error,
      );
    });

    it('accepts an integer number', () => {
      expect(Money.fromNaira(1500).kobo).toBe(150000n);
    });

    it.each(['1500.555', 'abc', '1,500.50', '', '1500.', '₦1500'])(
      'rejects malformed input %s',
      (input) => {
        expect(() => Money.fromNaira(input)).toThrow(
          expect.objectContaining({ code: ErrorCode.VALIDATION_FAILED }) as Error,
        );
      },
    );
  });

  describe('arithmetic', () => {
    it('adds and subtracts exactly', () => {
      const a = Money.fromNaira('1500.50');
      const b = Money.fromNaira('249.50');

      expect(a.add(b).toDecimalString()).toBe('1750.00');
      expect(a.subtract(b).toDecimalString()).toBe('1251.00');
    });

    it('stays exact across many operations, where floats would drift', () => {
      // A tenth of a naira added 10,000 times is exactly ₦1,000.
      let total = Money.fromKobo(0n);
      for (let index = 0; index < 10_000; index += 1) {
        total = total.add(Money.fromNaira('0.10'));
      }
      expect(total.toDecimalString()).toBe('1000.00');
    });

    it('is immutable — operations return new instances', () => {
      const original = Money.fromNaira('100.00');
      original.add(Money.fromNaira('50.00'));

      expect(original.toDecimalString()).toBe('100.00');
    });

    it('multiplies by an integer factor', () => {
      expect(Money.fromNaira('19.99').multiply(3).toDecimalString()).toBe('59.97');
    });

    it('refuses a fractional multiplier, which would hide a rounding policy', () => {
      expect(() => Money.fromNaira('100.00').multiply(0.075)).toThrow(
        expect.objectContaining({ code: ErrorCode.VALIDATION_FAILED }) as Error,
      );
    });

    it('refuses to mix currencies', () => {
      const naira = Money.fromKobo(100n, 'NGN');
      const cedi = Money.fromKobo(100n, 'GHS');

      expect(() => naira.add(cedi)).toThrow(
        expect.objectContaining({ code: ErrorCode.VALIDATION_FAILED }) as Error,
      );
    });
  });

  describe('comparison', () => {
    it('compares amounts', () => {
      const balance = Money.fromNaira('1000.00');

      expect(balance.greaterThan(Money.fromNaira('999.99'))).toBe(true);
      expect(balance.greaterThanOrEqual(Money.fromNaira('1000.00'))).toBe(true);
      expect(balance.lessThan(Money.fromNaira('1000.01'))).toBe(true);
      expect(balance.equals(Money.fromNaira('1000.00'))).toBe(true);
    });

    it('distinguishes zero, positive and negative', () => {
      expect(Money.fromKobo(0n).isZero()).toBe(true);
      expect(Money.fromKobo(1n).isPositive()).toBe(true);
      expect(Money.fromKobo(-1n).isNegative()).toBe(true);
    });

    it('treats different currencies as unequal rather than throwing', () => {
      expect(Money.fromKobo(100n, 'NGN').equals(Money.fromKobo(100n, 'GHS'))).toBe(false);
    });
  });

  describe('presentation', () => {
    it('always renders two decimal places', () => {
      expect(Money.fromKobo(150000n).toDecimalString()).toBe('1500.00');
      expect(Money.fromKobo(5n).toDecimalString()).toBe('0.05');
      expect(Money.fromKobo(0n).toDecimalString()).toBe('0.00');
    });

    it('formats with a currency symbol and grouping', () => {
      expect(Money.fromNaira('1500.50').format()).toBe('₦1,500.50');
      expect(Money.fromNaira('-250.00').format()).toBe('-₦250.00');
    });

    it('serialises money as a string, never a JS number', () => {
      const json = Money.fromNaira('1500.50').toJSON();

      expect(json).toEqual({
        amount: '1500.50',
        currency: 'NGN',
        formatted: '₦1,500.50',
      });
      expect(typeof json.amount).toBe('string');
    });

    it('survives JSON.stringify, which throws on a bare BigInt', () => {
      expect(() => JSON.stringify({ balance: Money.fromNaira('1500.50') })).not.toThrow();
    });

    it('keeps full precision beyond Number.MAX_SAFE_INTEGER', () => {
      // ₦10 trillion in kobo exceeds 2^53; a JS number would round it.
      const huge = Money.fromKobo('1000000000000000');
      expect(huge.toDecimalString()).toBe('10000000000000.00');
    });
  });
});

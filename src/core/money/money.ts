import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-code.enum';

/** Minor units per major unit. NGN, like most currencies, is 100. */
const MINOR_UNITS_PER_MAJOR = 100n;

/** Guard rail against a runaway loop or a bad provider payload. ~₦92 trillion. */
const MAX_MINOR_UNITS = 9_223_372_036_854_775_807n;

/**
 * An exact monetary amount, stored as integer minor units (kobo).
 *
 * ## The problem this type exists to prevent
 *
 * In a codebase where money is a bare `number`/`bigint`, nothing stops
 * `wallet.balance - price` where one is kobo and the other is naira. That bug
 * type-checks, passes review, and quietly overcharges customers by 100×. Wrapping
 * the amount makes the unit part of the type: a `Money` can only be combined with
 * another `Money`, and the only ways in are explicitly named
 * ({@link Money.fromKobo} / {@link Money.fromNaira}).
 *
 * Immutable — every operation returns a new instance, so an amount cannot be
 * mutated out from under a caller holding a reference to it.
 */
export class Money {
  private constructor(
    /** Amount in minor units (kobo). Always an integer, may be negative. */
    readonly kobo: bigint,
    readonly currency: string,
  ) {}

  static readonly ZERO = new Money(0n, 'NGN');

  /** From minor units — the database representation. */
  static fromKobo(kobo: bigint | number | string, currency = 'NGN'): Money {
    let value: bigint;
    try {
      value = typeof kobo === 'bigint' ? kobo : BigInt(kobo);
    } catch {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: 'Amount must be a whole number of kobo',
        details: { received: String(kobo) },
      });
    }

    if (value > MAX_MINOR_UNITS || value < -MAX_MINOR_UNITS) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: 'Amount exceeds the maximum supported value',
      });
    }
    return new Money(value, currency);
  }

  /**
   * From major units, as a decimal *string* — never a float.
   *
   * `Money.fromNaira(0.1 + 0.2)` would be 30 kobo, not 30. Accepting only strings
   * (or integers) at this boundary means a float can never silently become a
   * balance. Provider payloads carrying `"1500.50"` go through here.
   */
  static fromNaira(naira: string | number | bigint, currency = 'NGN'): Money {
    if (typeof naira === 'bigint') {
      return new Money(naira * MINOR_UNITS_PER_MAJOR, currency);
    }

    if (typeof naira === 'number') {
      if (!Number.isInteger(naira)) {
        throw new AppException(ErrorCode.VALIDATION_FAILED, {
          message: 'Fractional amounts must be provided as a string to avoid float rounding',
          details: { received: naira },
        });
      }
      return new Money(BigInt(naira) * MINOR_UNITS_PER_MAJOR, currency);
    }

    const trimmed = naira.trim();
    const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
    if (!match) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: 'Amount must be a decimal with at most 2 places, e.g. "1500.50"',
        details: { received: trimmed },
      });
    }

    const [, sign, whole, fraction = ''] = match;
    // "1500.5" means 50 kobo, not 5 — pad rather than truncate.
    const minor = BigInt(whole!) * MINOR_UNITS_PER_MAJOR + BigInt(fraction.padEnd(2, '0'));
    return new Money(sign ? -minor : minor, currency);
  }

  // -- Arithmetic -------------------------------------------------------------

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.kobo + other.kobo, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.kobo - other.kobo, this.currency);
  }

  /**
   * Multiplies by an integer factor (quantity of items, number of months).
   *
   * There is intentionally no `multiply(0.075)` for percentages: rounding a
   * percentage is a policy decision (round half up? banker's? in whose favour?)
   * that belongs in the fee calculator, not hidden in a generic helper.
   */
  multiply(factor: bigint | number): Money {
    if (typeof factor === 'number' && !Number.isInteger(factor)) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: 'Money can only be multiplied by an integer factor',
      });
    }
    return new Money(this.kobo * BigInt(factor), this.currency);
  }

  negate(): Money {
    return new Money(-this.kobo, this.currency);
  }

  abs(): Money {
    return this.kobo < 0n ? this.negate() : this;
  }

  // -- Comparison -------------------------------------------------------------

  isZero(): boolean {
    return this.kobo === 0n;
  }

  isPositive(): boolean {
    return this.kobo > 0n;
  }

  isNegative(): boolean {
    return this.kobo < 0n;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.kobo === other.kobo;
  }

  greaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.kobo > other.kobo;
  }

  greaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.kobo >= other.kobo;
  }

  lessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.kobo < other.kobo;
  }

  // -- Presentation -----------------------------------------------------------

  /** Decimal string, always 2 places: `"1500.50"`. Safe for JSON. */
  toDecimalString(): string {
    const negative = this.kobo < 0n;
    const absolute = negative ? -this.kobo : this.kobo;
    const whole = absolute / MINOR_UNITS_PER_MAJOR;
    const fraction = absolute % MINOR_UNITS_PER_MAJOR;
    return `${negative ? '-' : ''}${whole}.${fraction.toString().padStart(2, '0')}`;
  }

  /** Human-facing, grouped: `"₦1,500.50"`. */
  format(locale = 'en-NG'): string {
    const [whole = '0', fraction = '00'] = this.toDecimalString().replace('-', '').split('.');
    const grouped = new Intl.NumberFormat(locale).format(BigInt(whole));
    const symbol = this.currency === 'NGN' ? '₦' : `${this.currency} `;
    return `${this.kobo < 0n ? '-' : ''}${symbol}${grouped}.${fraction}`;
  }

  /**
   * The API representation.
   *
   * JSON has no BigInt and `JSON.stringify` throws on one, so money crosses the
   * wire as strings. A JS `number` would silently lose precision above 2^53 and
   * invites clients to do float arithmetic on a balance.
   */
  toJSON(): { amount: string; currency: string; formatted: string } {
    return {
      amount: this.toDecimalString(),
      currency: this.currency,
      formatted: this.format(),
    };
  }

  toString(): string {
    return this.format();
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: 'Cannot combine amounts in different currencies',
        details: { left: this.currency, right: other.currency },
      });
    }
  }
}

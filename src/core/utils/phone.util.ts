import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-code.enum';

/** Default region for bare local numbers. This is a Nigeria-first product. */
export const DEFAULT_REGION: CountryCode = 'NG';

/**
 * Phone number normalisation.
 *
 * ## Why this is load-bearing
 *
 * On a WhatsApp product the phone number *is* the primary key of a human being.
 * The same Nigerian customer may present as `08012345678`, `2348012345678`,
 * `+234 801 234 5678`, or `+234-801-234-5678`. Store those verbatim and one
 * person becomes four accounts, four wallets and four virtual bank accounts —
 * and the balance they topped up is in whichever one they used last.
 *
 * Everything therefore converges on E.164 (`+2348012345678`) at the boundary,
 * before any lookup or insert. `libphonenumber-js` is used rather than a regex
 * because numbering plans are genuinely irregular: Nigerian mobile numbers dropped
 * a digit in 2006, and knowing that `0810` is valid while `0210` is not requires
 * the real metadata.
 */
/**
 * Strict E.164: `+`, a non-zero country digit, then 6–14 more digits (15 total max).
 *
 * This duplicates the `users_phone_is_e164` CHECK constraint **on purpose**.
 * `libphonenumber-js` is lenient in places — it reports a 17-digit Nigerian
 * number as valid — and without this guard such a number would pass application
 * validation and then be rejected by the database, turning a clean 422 into a
 * 500. The two rules must agree, so they are written to agree.
 */
const E164_STRICT = /^\+[1-9]\d{6,14}$/;

export const Phone = {
  /**
   * Normalises to E.164.
   *
   * @param input  User-supplied number in any common format.
   * @param region Region for bare local numbers (defaults to Nigeria).
   * @returns E.164 (`+2348012345678`), or `undefined` if not a valid number.
   */
  normalize(input: string, region: CountryCode = DEFAULT_REGION): string | undefined {
    const trimmed = input?.trim();
    if (!trimmed) return undefined;

    const parsed = parsePhoneNumberFromString(trimmed, region);
    // `isValid()` checks the number against the region's numbering plan, not just
    // its length — `+2340000000000` parses but is not a real number. The strict
    // E.164 check then catches the lengths its metadata lets through.
    if (!parsed?.isValid()) return undefined;

    return E164_STRICT.test(parsed.number) ? parsed.number : undefined;
  },

  /**
   * Normalises, or rejects the request.
   *
   * @throws AppException(VALIDATION_FAILED) with no hint about whether the number
   *         is registered — that distinction is an enumeration oracle.
   */
  normalizeOrThrow(input: string, region: CountryCode = DEFAULT_REGION): string {
    const normalized = Phone.normalize(input, region);
    if (!normalized) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: 'Enter a valid phone number',
        details: { field: 'phone' },
      });
    }
    return normalized;
  },

  isValid(input: string, region: CountryCode = DEFAULT_REGION): boolean {
    return Phone.normalize(input, region) !== undefined;
  },

  /**
   * The digits-only form Meta's Cloud API uses (`2348012345678` — no `+`).
   * Kept as a deliberate conversion so nobody hand-slices the string.
   */
  toWhatsAppId(e164: string): string {
    return e164.replace(/^\+/, '');
  },

  /** Inverse of {@link toWhatsAppId}, for numbers arriving on a webhook. */
  fromWhatsAppId(waId: string): string | undefined {
    return Phone.normalize(waId.startsWith('+') ? waId : `+${waId}`);
  },

  /**
   * Masks for display and logs: `+234801****678`.
   *
   * A full phone number in a log line is customer PII and, on this product, also
   * an account identifier. Support views and audit trails use this form.
   */
  mask(e164: string): string {
    if (e164.length < 8) return '****';
    return `${e164.slice(0, 7)}****${e164.slice(-3)}`;
  },
} as const;

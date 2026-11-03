import { ErrorCode } from '../errors/error-code.enum';
import { Phone } from './phone.util';

describe('Phone', () => {
  describe('normalisation', () => {
    it.each([
      '08012345678',
      '2348012345678',
      '+2348012345678',
      '+234 801 234 5678',
      '+234-801-234-5678',
      '  08012345678  ',
    ])('converges %s on one E.164 value', (input) => {
      // This is the property that stops one human becoming several accounts,
      // several wallets and several virtual bank accounts.
      expect(Phone.normalize(input)).toBe('+2348012345678');
    });

    it.each([
      ['empty', ''],
      ['letters', 'not-a-number'],
      ['too short', '0801234'],
      ['invalid NG prefix', '+2340000000000'],
      ['too long', '+23480123456789012'],
    ])('rejects %s', (_label, input) => {
      expect(Phone.normalize(input)).toBeUndefined();
    });

    it('honours an explicit region for local formats', () => {
      expect(Phone.normalize('07911123456', 'GB')).toBe('+447911123456');
    });

    it('accepts an international number regardless of default region', () => {
      expect(Phone.normalize('+14155552671')).toBe('+14155552671');
    });
  });

  describe('normalizeOrThrow', () => {
    it('returns the E.164 value for a valid number', () => {
      expect(Phone.normalizeOrThrow('08012345678')).toBe('+2348012345678');
    });

    it('throws a validation error that reveals nothing about registration', () => {
      // The message must not differ between "invalid" and "not registered" —
      // that difference is an enumeration oracle on a product where the phone
      // number is the identity.
      expect(() => Phone.normalizeOrThrow('garbage')).toThrow(
        expect.objectContaining({ code: ErrorCode.VALIDATION_FAILED }) as Error,
      );
    });
  });

  describe('WhatsApp identifiers', () => {
    it('strips the plus for Meta’s wa_id format', () => {
      expect(Phone.toWhatsAppId('+2348012345678')).toBe('2348012345678');
    });

    it('round-trips an inbound wa_id', () => {
      expect(Phone.fromWhatsAppId('2348012345678')).toBe('+2348012345678');
    });

    it('tolerates a wa_id that already carries a plus', () => {
      expect(Phone.fromWhatsAppId('+2348012345678')).toBe('+2348012345678');
    });
  });

  describe('masking', () => {
    it('hides the subscriber digits for logs and support views', () => {
      expect(Phone.mask('+2348012345678')).toBe('+234801****678');
    });

    it('does not leak anything for an implausibly short value', () => {
      expect(Phone.mask('+234')).toBe('****');
    });
  });
});

import { createHmac } from 'node:crypto';

import { BankAccountProvider } from '@prisma/client';
import type { PinoLogger } from 'nestjs-pino';

import type { AppConfig } from '../../config/app.config';
import { ErrorCode } from '../../core/errors/error-code.enum';
import type { MetricsService } from '../../infrastructure/observability/metrics.service';
import { WebhookEventKind } from './payment-provider.interface';
import { PaystackProvider } from './paystack.provider';

const SECRET = 'stripe_dummy_test_deadbeefdeadbeefdeadbeef';

const config = {
  payments: {
    provider: 'paystack',
    httpTimeoutMs: 10_000,
    webhookMaxAgeSeconds: 300,
    paystack: {
      secretKey: SECRET,
      baseUrl: 'https://api.paystack.co',
      preferredBank: 'wema-bank',
    },
  },
} as AppConfig;

const logger = {
  setContext: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as PinoLogger;

const metrics = {
  whatsappApiCallsTotal: { inc: jest.fn() },
  whatsappApiDuration: { observe: jest.fn() },
} as unknown as MetricsService;

const sign = (body: string, secret = SECRET) =>
  createHmac('sha512', secret).update(Buffer.from(body, 'utf8')).digest('hex');

describe('PaystackProvider', () => {
  const provider = new PaystackProvider(config, logger, metrics);

  describe('signature verification', () => {
    const body = JSON.stringify({ event: 'charge.success', data: { id: 1 } });

    it('accepts a correctly signed body', () => {
      expect(provider.verifySignature(Buffer.from(body), sign(body))).toBe(true);
    });

    it('rejects a body that was modified after signing', () => {
      // The whole point: an attacker who intercepts a real webhook cannot change
      // the amount and keep the signature valid.
      const tampered = body.replace('"id":1', '"id":999');
      expect(provider.verifySignature(Buffer.from(tampered), sign(body))).toBe(false);
    });

    it('rejects a signature made with a different secret', () => {
      expect(provider.verifySignature(Buffer.from(body), sign(body, 'sk_other'))).toBe(false);
    });

    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['garbage', 'not-a-signature'],
      ['truncated', sign(body).slice(0, 40)],
    ])('rejects a %s signature', (_label, signature) => {
      expect(provider.verifySignature(Buffer.from(body), signature)).toBe(false);
    });

    it('accepts an uppercase signature, which some clients send', () => {
      expect(provider.verifySignature(Buffer.from(body), sign(body).toUpperCase())).toBe(true);
    });

    it('is sensitive to byte-level formatting, proving raw bytes are required', () => {
      // Re-serialising parsed JSON changes key order and whitespace. This test
      // documents *why* the controller must use `req.rawBody` and never
      // `JSON.stringify(req.body)`.
      const reserialised = JSON.stringify(JSON.parse(body), null, 2);
      expect(provider.verifySignature(Buffer.from(reserialised), sign(body))).toBe(false);
    });

    it('fails closed when no secret is configured', () => {
      const unconfigured = new PaystackProvider(
        {
          payments: {
            ...config.payments,
            paystack: { ...config.payments.paystack, secretKey: '' },
          },
        } as AppConfig,
        logger,
        metrics,
      );

      // An unconfigured secret must never mean "accept everything".
      expect(unconfigured.verifySignature(Buffer.from(body), sign(body))).toBe(false);
    });
  });

  describe('event parsing', () => {
    const chargeEvent = {
      event: 'charge.success',
      data: {
        id: 302961,
        reference: 'TRF_9f8g7h6j',
        amount: 150050,
        currency: 'NGN',
        channel: 'dedicated_nuban',
        paid_at: '2026-08-06T10:15:00.000Z',
        authorization: {
          receiver_bank_account_number: '9912345678',
          sender_name: 'ADAEZE OKONKWO',
          sender_bank: 'GTBank',
        },
      },
    };

    it('maps a dedicated-account transfer to a funding event', () => {
      const event = provider.parseEvent(chargeEvent);

      expect(event.kind).toBe(WebhookEventKind.FundingReceived);
      expect(event.rawEventType).toBe('charge.success');
      expect(event.transfer?.reference).toBe('TRF_9f8g7h6j');
      expect(event.transfer?.destinationAccountNumber).toBe('9912345678');
      expect(event.transfer?.senderName).toBe('ADAEZE OKONKWO');
    });

    it('reads the amount as kobo without float arithmetic', () => {
      const event = provider.parseEvent(chargeEvent);

      // Paystack sends kobo; ₦1,500.50 is 150050 and must round-trip exactly.
      expect(event.transfer?.amount.kobo).toBe(150050n);
      expect(event.transfer?.amount.toDecimalString()).toBe('1500.50');
    });

    it('derives a stable deduplication key from the transaction id', () => {
      // Redelivery of the same transaction must produce the same key, or the
      // webhook table cannot deduplicate.
      expect(provider.parseEvent(chargeEvent).providerEventId).toBe('charge.success:302961');
      expect(provider.parseEvent(chargeEvent).providerEventId).toBe(
        provider.parseEvent(chargeEvent).providerEventId,
      );
    });

    it('ignores card charges, which do not fund a wallet', () => {
      const card = { ...chargeEvent, data: { ...chargeEvent.data, channel: 'card' } };
      expect(provider.parseEvent(card).kind).toBe(WebhookEventKind.Ignored);
    });

    it('ignores event types we do not handle, rather than failing', () => {
      // An unhandled event must not return a non-2xx, or Paystack will retry it
      // forever and eventually disable the subscription.
      const event = provider.parseEvent({ event: 'transfer.failed', data: { id: 5 } });

      expect(event.kind).toBe(WebhookEventKind.Ignored);
      expect(event.rawEventType).toBe('transfer.failed');
    });

    it('maps an account assignment, carrying our user id back', () => {
      const event = provider.parseEvent({
        event: 'dedicatedaccount.assign.success',
        data: {
          id: 77,
          customer: { metadata: { userId: 'user-123' } },
          dedicated_account: {
            id: 4455,
            account_name: 'WABOT / ADAEZE OKONKWO',
            account_number: '9912345678',
            currency: 'NGN',
            bank: { name: 'Wema Bank', slug: 'wema-bank' },
          },
        },
      });

      expect(event.kind).toBe(WebhookEventKind.AccountAssigned);
      expect(event.accountAssignment?.userId).toBe('user-123');
      expect(event.accountAssignment?.account.accountNumber).toBe('9912345678');
      expect(event.accountAssignment?.account.provider).toBe(BankAccountProvider.PAYSTACK);
    });

    it('rejects a funding event with no reference, since it cannot be idempotent', () => {
      const noReference = {
        event: 'charge.success',
        data: { ...chargeEvent.data, reference: undefined },
      };

      expect(() => provider.parseEvent(noReference)).toThrow(
        expect.objectContaining({ code: ErrorCode.VALIDATION_FAILED }) as Error,
      );
    });

    it.each([[null], [undefined], [{}], [{ event: 'x' }], ['a string']])(
      'rejects a structurally invalid payload (%p)',
      (payload) => {
        expect(() => provider.parseEvent(payload)).toThrow(
          expect.objectContaining({ code: ErrorCode.VALIDATION_FAILED }) as Error,
        );
      },
    );
  });
});

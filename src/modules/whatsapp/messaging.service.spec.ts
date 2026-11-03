import { MessageStatus, TemplateStatus } from '@prisma/client';
import type { PinoLogger } from 'nestjs-pino';

import type { AppConfig } from '../../config/app.config';
import { RequestContext } from '../../core/context/request-context';
import { ErrorCode } from '../../core/errors/error-code.enum';
import type { ExtendedPrismaClient } from '../../infrastructure/database/prisma.service';
import type { CryptoService } from '../../infrastructure/security/crypto.service';
import type { MetricsService } from '../../infrastructure/observability/metrics.service';
import type { CloudApiClient } from './cloud-api.client';
import { MessagingService } from './messaging.service';

const TENANT_ID = '0195f2a0-0000-7000-8000-000000000001';
const HOUR = 60 * 60 * 1000;

const config = {
  whatsapp: {
    appSecret: 's',
    webhookVerifyToken: 't',
    graphBaseUrl: 'https://graph.facebook.com',
    graphVersion: 'v21.0',
    httpTimeoutMs: 15_000,
    serviceWindowHours: 24,
  },
} as AppConfig;

const logger = {
  setContext: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as PinoLogger;

const metrics = { messagesTotal: { inc: jest.fn() } } as unknown as MetricsService;
const crypto = { decrypt: jest.fn().mockReturnValue('plain-token') } as unknown as CryptoService;

function build(
  options: {
    lastInboundAt?: Date | null;
    numberStatus?: string;
    template?: { status: TemplateStatus; bodyVariableCount: number } | null;
    existingMessage?: { id: string; wamid: string; status: MessageStatus } | null;
  } = {},
) {
  const sendMessage = jest.fn().mockResolvedValue({ messages: [{ id: 'wamid.SENT' }] });
  const client = { sendMessage } as unknown as CloudApiClient;

  const db = {
    whatsAppPhoneNumber: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'number-1',
        phoneNumberId: 'META_PN',
        accessToken: 'encrypted',
        status: options.numberStatus ?? 'CONNECTED',
      }),
    },
    conversation: {
      upsert: jest.fn().mockResolvedValue({
        id: 'conv-1',
        lastInboundAt: options.lastInboundAt ?? null,
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    messageTemplate: {
      findFirst: jest.fn().mockResolvedValue(options.template ?? null),
    },
    message: {
      findFirst: jest.fn().mockResolvedValue(options.existingMessage ?? null),
      create: jest.fn().mockResolvedValue({ id: 'msg-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn().mockResolvedValue([]),
  } as unknown as ExtendedPrismaClient;

  return {
    service: new MessagingService(db, client, crypto, config, logger, metrics),
    db,
    sendMessage,
  };
}

const inTenant = <T>(fn: () => Promise<T>) => RequestContext.run({ tenantId: TENANT_ID }, fn);

describe('MessagingService', () => {
  describe('service window', () => {
    it('allows a free-form message inside 24 hours', async () => {
      const { service, sendMessage } = build({ lastInboundAt: new Date(Date.now() - 2 * HOUR) });

      const result = await inTenant(() =>
        service.sendText({ to: '08012345678', text: 'Your balance is ₦1,500.50' }),
      );

      expect(result.status).toBe(MessageStatus.SENT);
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it('refuses a free-form message outside the window', async () => {
      const { service, sendMessage } = build({ lastInboundAt: new Date(Date.now() - 25 * HOUR) });

      await expect(
        inTenant(() => service.sendText({ to: '08012345678', text: 'hello' })),
      ).rejects.toMatchObject({ code: ErrorCode.WHATSAPP_OUTSIDE_SERVICE_WINDOW });

      // Enforced before the call: a rejected send still costs a round trip,
      // counts against rate limits, and damages the number's quality rating.
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('refuses when the customer has never messaged us', async () => {
      const { service } = build({ lastInboundAt: null });

      await expect(
        inTenant(() => service.sendText({ to: '08012345678', text: 'hello' })),
      ).rejects.toMatchObject({ code: ErrorCode.WHATSAPP_OUTSIDE_SERVICE_WINDOW });
    });

    it('treats the boundary correctly', () => {
      const { service } = build();

      expect(service.isWindowOpen(new Date(Date.now() - 23.9 * HOUR))).toBe(true);
      expect(service.isWindowOpen(new Date(Date.now() - 24.1 * HOUR))).toBe(false);
      expect(service.isWindowOpen(null)).toBe(false);
    });

    it('sends a template regardless of the window', async () => {
      // Templates are the *only* way to re-engage a lapsed customer, so the
      // window must not gate them.
      const { service, sendMessage } = build({
        lastInboundAt: new Date(Date.now() - 100 * HOUR),
        template: { status: TemplateStatus.APPROVED, bodyVariableCount: 1 },
      });

      const result = await inTenant(() =>
        service.sendTemplate({
          to: '08012345678',
          templateName: 'funds_received',
          variables: ['1500.50'],
        }),
      );

      expect(result.status).toBe(MessageStatus.SENT);
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('template validation', () => {
    it('refuses an unapproved template without calling Meta', async () => {
      const { service, sendMessage } = build({
        template: { status: TemplateStatus.PENDING, bodyVariableCount: 0 },
      });

      await expect(
        inTenant(() => service.sendTemplate({ to: '08012345678', templateName: 'promo' })),
      ).rejects.toMatchObject({ code: ErrorCode.WHATSAPP_TEMPLATE_NOT_APPROVED });

      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('refuses a template that does not exist locally', async () => {
      const { service } = build({ template: null });

      await expect(
        inTenant(() => service.sendTemplate({ to: '08012345678', templateName: 'ghost' })),
      ).rejects.toMatchObject({ code: ErrorCode.RESOURCE_NOT_FOUND });
    });

    it.each([
      [2, ['only-one']],
      [1, ['a', 'b']],
      [1, []],
    ])('rejects a variable count mismatch (expects %i)', async (expected, variables) => {
      // Caught locally so the caller gets a clear 422 instead of an opaque Meta
      // error after a wasted round trip.
      const { service, sendMessage } = build({
        template: { status: TemplateStatus.APPROVED, bodyVariableCount: expected },
      });

      await expect(
        inTenant(() =>
          service.sendTemplate({ to: '08012345678', templateName: 'alert', variables }),
        ),
      ).rejects.toMatchObject({ code: ErrorCode.WHATSAPP_TEMPLATE_PARAM_MISMATCH });

      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('builds Meta’s positional body parameters', async () => {
      const { service, sendMessage } = build({
        template: { status: TemplateStatus.APPROVED, bodyVariableCount: 2 },
      });

      await inTenant(() =>
        service.sendTemplate({
          to: '08012345678',
          templateName: 'funds_received',
          variables: ['1500.50', 'GTBank'],
        }),
      );

      const body = sendMessage.mock.calls[0]?.[2] as Record<string, unknown>;
      expect(body.template).toMatchObject({
        name: 'funds_received',
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: '1500.50' },
              { type: 'text', text: 'GTBank' },
            ],
          },
        ],
      });
    });
  });

  describe('recipient and number handling', () => {
    it('normalises the recipient to Meta’s digits-only format', async () => {
      const { service, sendMessage } = build({ lastInboundAt: new Date() });

      await inTenant(() => service.sendText({ to: '08012345678', text: 'hi' }));

      const body = sendMessage.mock.calls[0]?.[2] as { to: string };
      // Meta rejects a leading `+`.
      expect(body.to).toBe('2348012345678');
    });

    it('rejects an unparseable recipient before doing any work', async () => {
      const { service, sendMessage } = build({ lastInboundAt: new Date() });

      await expect(
        inTenant(() => service.sendText({ to: 'not-a-number', text: 'hi' })),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });

      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('refuses to send from a number that is not connected', async () => {
      const { service } = build({ lastInboundAt: new Date(), numberStatus: 'DISCONNECTED' });

      await expect(
        inTenant(() => service.sendText({ to: '08012345678', text: 'hi' })),
      ).rejects.toMatchObject({ code: ErrorCode.WHATSAPP_NUMBER_NOT_REGISTERED });
    });

    it('decrypts the stored access token before use', async () => {
      const { service, sendMessage } = build({ lastInboundAt: new Date() });

      await inTenant(() => service.sendText({ to: '08012345678', text: 'hi' }));

      // The token is stored AES-256-GCM encrypted; sending the ciphertext would
      // fail every call.
      expect(crypto.decrypt).toHaveBeenCalledWith('encrypted');
      expect(sendMessage.mock.calls[0]?.[1]).toBe('plain-token');
    });
  });

  describe('idempotency and persistence', () => {
    it('returns the existing message when a client reference repeats', async () => {
      const { service, sendMessage } = build({
        lastInboundAt: new Date(),
        existingMessage: { id: 'msg-original', wamid: 'wamid.OLD', status: MessageStatus.SENT },
      });

      const result = await inTenant(() =>
        service.sendText({ to: '08012345678', text: 'hi', clientReference: 'ref-1' }),
      );

      // A retried API call must not send the customer a second message.
      expect(result.duplicate).toBe(true);
      expect(result.messageId).toBe('msg-original');
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('records the message before calling Meta', async () => {
      const { service, db, sendMessage } = build({ lastInboundAt: new Date() });

      await inTenant(() => service.sendText({ to: '08012345678', text: 'hi' }));

      // A crash mid-flight must leave a PENDING row to reconcile, not a message
      // that may or may not have been sent with no trace of it.
      const createOrder = (db.message.create as jest.Mock).mock.invocationCallOrder[0]!;
      const sendOrder = sendMessage.mock.invocationCallOrder[0]!;
      expect(createOrder).toBeLessThan(sendOrder);
    });

    it('marks the message failed when Meta rejects it', async () => {
      const { service, db, sendMessage } = build({ lastInboundAt: new Date() });
      sendMessage.mockRejectedValue(new Error('rejected'));

      await expect(
        inTenant(() => service.sendText({ to: '08012345678', text: 'hi' })),
      ).rejects.toThrow();

      expect(db.message.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: MessageStatus.FAILED }) as unknown,
        }),
      );
    });

    it('refuses to send without a tenant in context', async () => {
      const { service } = build({ lastInboundAt: new Date() });

      await expect(service.sendText({ to: '08012345678', text: 'hi' })).rejects.toMatchObject({
        code: ErrorCode.TENANT_NOT_RESOLVED,
      });
    });
  });
});

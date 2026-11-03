import type { PinoLogger } from 'nestjs-pino';

import type { AppConfig } from '../../config/app.config';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import type { MetricsService } from '../../infrastructure/observability/metrics.service';
import { CloudApiClient } from './cloud-api.client';

const config = {
  whatsapp: {
    appSecret: 'secret',
    webhookVerifyToken: 'token',
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

const metrics = {
  whatsappApiCallsTotal: { inc: jest.fn() },
  whatsappApiDuration: { observe: jest.fn() },
} as unknown as MetricsService;

/** Stubs `fetch` with a Meta-shaped response. */
function stubFetch(status: number, body: unknown) {
  const mock = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
  global.fetch = mock;
  return mock;
}

const metaError = (code: number, message = 'error') => ({
  error: { message, code, type: 'OAuthException', fbtrace_id: 'trace-1' },
});

describe('CloudApiClient', () => {
  const client = new CloudApiClient(config, logger, metrics);
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  describe('sending', () => {
    it('posts to the versioned messages endpoint with the number id', async () => {
      const fetchMock = stubFetch(200, {
        messaging_product: 'whatsapp',
        contacts: [{ input: '2348012345678', wa_id: '2348012345678' }],
        messages: [{ id: 'wamid.NEW' }],
      });

      const result = await client.sendMessage('PHONE_ID', 'token-123', {
        to: '2348012345678',
        type: 'text',
        text: { body: 'hello' },
      });

      expect(result.messages[0]?.id).toBe('wamid.NEW');

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      // The Graph version is pinned; an unpinned call silently follows Meta's
      // default forward into breaking changes.
      expect(url).toBe('https://graph.facebook.com/v21.0/PHONE_ID/messages');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-123');
    });

    it('always includes the messaging_product field Meta requires', async () => {
      const fetchMock = stubFetch(200, { messages: [{ id: 'wamid.X' }] });

      await client.sendMessage('PHONE_ID', 'token', { to: '234', type: 'text' });

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.messaging_product).toBe('whatsapp');
    });

    it('applies a request deadline', async () => {
      const fetchMock = stubFetch(200, { messages: [{ id: 'wamid.X' }] });

      await client.sendMessage('PHONE_ID', 'token', { to: '234' });

      // Without a deadline, a degraded Meta holds our workers open indefinitely.
      const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
      expect(init.signal).toBeDefined();
    });
  });

  describe('error mapping', () => {
    it.each([
      [131047, ErrorCode.WHATSAPP_OUTSIDE_SERVICE_WINDOW],
      [131051, ErrorCode.WHATSAPP_OUTSIDE_SERVICE_WINDOW],
      [131026, ErrorCode.WHATSAPP_RECIPIENT_INVALID],
      [132000, ErrorCode.WHATSAPP_TEMPLATE_PARAM_MISMATCH],
      [132001, ErrorCode.WHATSAPP_TEMPLATE_NOT_APPROVED],
      [131031, ErrorCode.WHATSAPP_NUMBER_NOT_REGISTERED],
      [190, ErrorCode.WHATSAPP_TOKEN_INVALID],
      [0, ErrorCode.WHATSAPP_TOKEN_INVALID],
    ])('maps Meta code %i to %s', async (code, expected) => {
      stubFetch(400, metaError(code));

      await expect(client.sendMessage('PN', 'token', {})).rejects.toMatchObject({ code: expected });
    });

    it.each([4, 80007, 130429, 131056])('marks throttling code %i as retryable', async (code) => {
      stubFetch(400, metaError(code));

      const error = await client.sendMessage('PN', 'token', {}).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).retryable).toBe(true);
      expect((error as AppException).retryAfterSeconds).toBe(30);
    });

    it('does not retry a permanent rejection', async () => {
      // Retrying an unapproved template forever burns rate limit and never
      // succeeds.
      stubFetch(400, metaError(132001));

      const error = await client.sendMessage('PN', 'token', {}).catch((e: unknown) => e);
      expect((error as AppException).retryable).toBe(false);
    });

    it('does not retry an invalid token, which needs a human', async () => {
      stubFetch(401, metaError(190));

      const error = await client.sendMessage('PN', 'token', {}).catch((e: unknown) => e);
      expect((error as AppException).retryable).toBe(false);
    });

    it('treats a 5xx as retryable even with an unknown code', async () => {
      // Meta's HTTP status is unreliable for 4xx, but a 500 is genuinely theirs.
      stubFetch(503, metaError(99999));

      const error = await client.sendMessage('PN', 'token', {}).catch((e: unknown) => e);
      expect((error as AppException).retryable).toBe(true);
    });

    it('falls back to a generic error for an unmapped 4xx code', async () => {
      stubFetch(400, metaError(123456, 'Something specific'));

      await expect(client.sendMessage('PN', 'token', {})).rejects.toMatchObject({
        code: ErrorCode.WHATSAPP_API_ERROR,
      });
    });

    it('never leaks the access token into an error', async () => {
      stubFetch(400, metaError(132001));

      const error = (await client
        .sendMessage('PN', 'super-secret-token', {})
        .catch((e: unknown) => e)) as AppException;

      expect(JSON.stringify(error.details ?? {})).not.toContain('super-secret-token');
      expect(error.message).not.toContain('super-secret-token');
    });

    it('maps a network failure to a retryable upstream error', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'));

      const error = await client.sendMessage('PN', 'token', {}).catch((e: unknown) => e);

      expect((error as AppException).code).toBe(ErrorCode.UPSTREAM_ERROR);
      expect((error as AppException).retryable).toBe(true);
    });

    it('distinguishes a timeout from a generic network failure', async () => {
      const timeout = new Error('The operation was aborted');
      timeout.name = 'TimeoutError';
      global.fetch = jest.fn().mockRejectedValue(timeout);

      const error = await client.sendMessage('PN', 'token', {}).catch((e: unknown) => e);
      expect((error as AppException).code).toBe(ErrorCode.UPSTREAM_TIMEOUT);
    });
  });
});

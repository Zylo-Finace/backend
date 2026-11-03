import type { PinoLogger } from 'nestjs-pino';

import type { AppConfig } from '../../config/app.config';
import { ErrorCode } from '../../core/errors/error-code.enum';
import type { MetricsService } from '../../infrastructure/observability/metrics.service';
import { CK_ENDPOINT, ClubKonnectClient } from './clubkonnect.client';

function makeConfig(overrides: Partial<AppConfig['bills']['clubkonnect']> = {}): AppConfig {
  return {
    bills: {
      provider: 'clubkonnect',
      httpTimeoutMs: 30_000,
      floatReserveNaira: 0,
      balanceCacheSeconds: 15,
      catalogueCacheSeconds: 3600,
      clubkonnect: {
        baseUrl: 'https://www.nellobytesystems.com',
        userId: 'CK123',
        apiKey: 'super-secret-key',
        callbackUrl: 'https://api.example.com/webhooks/bills',
        ...overrides,
      },
    },
  } as AppConfig;
}

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

/** Stubs `fetch` with a text body. */
function stubFetch(body: string, init: { ok?: boolean; status?: number } = {}) {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: () => Promise.resolve(body),
  });
  global.fetch = fetchMock;
  return fetchMock;
}

describe('ClubKonnectClient', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => {
    delete (global as { fetch?: unknown }).fetch;
  });

  describe('request construction', () => {
    it('sends credentials as query parameters, which is how this API authenticates', async () => {
      const fetchMock = stubFetch('{"balance":"3500"}');
      const client = new ClubKonnectClient(makeConfig(), logger, metrics);

      await client.get(CK_ENDPOINT.walletBalance, {});

      const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(url.origin + url.pathname).toBe(
        'https://www.nellobytesystems.com/APIWalletBalanceV1.asp',
      );
      expect(url.searchParams.get('UserID')).toBe('CK123');
      expect(url.searchParams.get('APIKey')).toBe('super-secret-key');
    });

    it('omits the API key on catalogue endpoints, which reject it', async () => {
      const fetchMock = stubFetch('{"BETTING_COMPANY":[]}');
      const client = new ClubKonnectClient(makeConfig(), logger, metrics);

      await client.get(CK_ENDPOINT.bettingCompanies, {}, { withApiKey: false });

      const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(url.searchParams.get('UserID')).toBe('CK123');
      expect(url.searchParams.has('APIKey')).toBe(false);
    });

    it('drops undefined and empty parameters instead of sending blanks', async () => {
      const fetchMock = stubFetch('{"orderid":"1"}');
      const client = new ClubKonnectClient(makeConfig(), logger, metrics);

      await client.get(CK_ENDPOINT.airtime, {
        MobileNetwork: '01',
        CallBackURL: undefined,
        RequestID: '',
      });

      const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(url.searchParams.has('CallBackURL')).toBe(false);
      expect(url.searchParams.has('RequestID')).toBe(false);
      expect(url.searchParams.get('MobileNetwork')).toBe('01');
    });

    it('url-encodes parameters rather than concatenating them', async () => {
      const fetchMock = stubFetch('{"orderid":"1"}');
      const client = new ClubKonnectClient(makeConfig(), logger, metrics);

      await client.get(CK_ENDPOINT.airtime, { RequestID: 'a b&c=d' });

      const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(url.searchParams.get('RequestID')).toBe('a b&c=d');
    });

    it('fails closed when credentials are not configured', async () => {
      const client = new ClubKonnectClient(makeConfig({ apiKey: '' }), logger, metrics);

      await expect(client.get(CK_ENDPOINT.airtime, {})).rejects.toThrow(
        expect.objectContaining({ code: ErrorCode.SERVICE_UNAVAILABLE }) as Error,
      );
    });
  });

  describe('never leaking the API key', () => {
    // The key lives in the query string, so the URL is itself a secret. Every
    // log path below must carry the endpoint, never the URL.
    it('keeps the key out of logs when the provider returns an error page', async () => {
      stubFetch('<html>Service Unavailable</html>', { ok: false, status: 503 });
      const client = new ClubKonnectClient(makeConfig(), logger, metrics);

      await expect(client.get(CK_ENDPOINT.airtime, {})).rejects.toThrow();

      const logged = JSON.stringify((logger.error as jest.Mock).mock.calls);
      expect(logged).not.toContain('super-secret-key');
    });

    it('keeps the key out of logs when the body is unparseable', async () => {
      stubFetch('<html>nope</html>');
      const client = new ClubKonnectClient(makeConfig(), logger, metrics);

      await expect(client.get(CK_ENDPOINT.airtime, {})).rejects.toThrow();

      const logged = JSON.stringify((logger.error as jest.Mock).mock.calls);
      expect(logged).not.toContain('super-secret-key');
    });

    it('keeps the key out of the error surfaced to callers', async () => {
      stubFetch('<html>nope</html>');
      const client = new ClubKonnectClient(makeConfig(), logger, metrics);

      const error = await client.get(CK_ENDPOINT.airtime, {}).catch((caught: unknown) => caught);

      expect(JSON.stringify(error)).not.toContain('super-secret-key');
    });
  });

  describe('response handling', () => {
    it('parses a JSON body served as text/html', async () => {
      stubFetch('\n\t{"balance":"3500"}\n');
      const client = new ClubKonnectClient(makeConfig(), logger, metrics);

      await expect(client.get(CK_ENDPOINT.walletBalance, {})).resolves.toEqual({
        balance: '3500',
      });
    });

    it.each([
      ['INVALID_CREDENTIALS'],
      ['MISSING_CREDENTIALS'],
      ['MISSING_USERID'],
      ['MISSING_APIKEY'],
      ['"INVALID_CREDENTIALS"'],
      ['  invalid_credentials  '],
    ])('recognises the bare error body %p', async (body) => {
      // These arrive as HTTP 200 with no JSON at all.
      stubFetch(body);
      const client = new ClubKonnectClient(makeConfig(), logger, metrics);

      await expect(client.get(CK_ENDPOINT.walletBalance, {})).rejects.toThrow(
        expect.objectContaining({ code: ErrorCode.SERVICE_UNAVAILABLE }) as Error,
      );
    });

    it('rejects an empty body as retryable rather than as an empty result', async () => {
      stubFetch('   ');
      const client = new ClubKonnectClient(makeConfig(), logger, metrics);

      await expect(client.get(CK_ENDPOINT.walletBalance, {})).rejects.toThrow(
        expect.objectContaining({ code: ErrorCode.UPSTREAM_ERROR, retryable: true }) as Error,
      );
    });

    it('treats a timeout as UPSTREAM_TIMEOUT, which callers must not read as failure', async () => {
      // An order that timed out may still have been accepted upstream.
      const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      global.fetch = jest.fn().mockRejectedValue(timeout);
      const client = new ClubKonnectClient(makeConfig(), logger, metrics);

      await expect(client.get(CK_ENDPOINT.airtime, {})).rejects.toThrow(
        expect.objectContaining({ code: ErrorCode.UPSTREAM_TIMEOUT }) as Error,
      );
    });

    it('marks a 5xx retryable and a 4xx not', async () => {
      const client = new ClubKonnectClient(makeConfig(), logger, metrics);

      stubFetch('server error', { ok: false, status: 502 });
      await expect(client.get(CK_ENDPOINT.airtime, {})).rejects.toThrow(
        expect.objectContaining({ retryable: true }) as Error,
      );

      stubFetch('bad request', { ok: false, status: 400 });
      await expect(client.get(CK_ENDPOINT.airtime, {})).rejects.toThrow(
        expect.objectContaining({ retryable: false }) as Error,
      );
    });
  });
});

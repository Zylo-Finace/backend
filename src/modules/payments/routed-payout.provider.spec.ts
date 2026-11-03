import { PayoutProviderName } from '@prisma/client';
import type { PinoLogger } from 'nestjs-pino';

import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { Money } from '../../core/money/money';
import {
  type PayoutAcceptance,
  type PayoutProvider,
  type PayoutRequest,
} from './payout-provider.interface';
import { RoutedPayoutProvider } from './routed-payout.provider';

const logger = {
  setContext: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as PinoLogger;

const request: PayoutRequest = {
  reference: 'PAY-20260815-abc',
  amount: Money.fromNaira('5000'),
  bankCode: '058',
  accountNumber: '0234057048',
  accountName: 'DAYO OJO',
  narration: 'Withdrawal',
};

const acceptance = (providerReference: string): PayoutAcceptance => ({
  providerReference,
  raw: {},
});

/** A `PayoutProvider` stand-in whose every method is a spy. */
function stubProvider(name: PayoutProviderName): jest.Mocked<PayoutProvider> {
  return {
    name,
    listBanks: jest.fn(),
    resolveAccount: jest.fn(),
    initiateTransfer: jest.fn(),
    verifySignature: jest.fn(),
    parseEvent: jest.fn(),
  };
}

describe('RoutedPayoutProvider', () => {
  let primary: jest.Mocked<PayoutProvider>;
  let fallback: jest.Mocked<PayoutProvider>;
  let router: RoutedPayoutProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    primary = stubProvider(PayoutProviderName.FALCONPAY);
    fallback = stubProvider(PayoutProviderName.PULSEMFB);
    router = new RoutedPayoutProvider(primary, fallback, logger);
  });

  // ===========================================================================
  //  The failover rule — the whole reason this class exists
  // ===========================================================================

  describe('when the primary definitely did not queue the transfer', () => {
    it.each([
      ['a refusal', ErrorCode.PAYOUT_REJECTED],
      ['an unconfigured or float-exhausted provider', ErrorCode.SERVICE_UNAVAILABLE],
      ['an open circuit', ErrorCode.CIRCUIT_OPEN],
    ])('re-places the transfer after %s', async (_label, code) => {
      primary.initiateTransfer.mockRejectedValue(new AppException(code, { message: 'no' }));
      fallback.initiateTransfer.mockResolvedValue(acceptance('PULSE-1'));

      await expect(router.initiateTransfer(request)).resolves.toEqual(acceptance('PULSE-1'));

      // The fallback must receive the request *unchanged* — same reference, same
      // amount, same destination. Anything else and the two providers would be
      // sending different transfers.
      expect(fallback.initiateTransfer).toHaveBeenCalledWith(request);
    });
  });

  describe('when the primary may have queued the transfer', () => {
    it.each([
      ['an explicitly unknown outcome', ErrorCode.PAYOUT_UNKNOWN_OUTCOME],
      ['a timeout', ErrorCode.UPSTREAM_TIMEOUT],
      ['an upstream 5xx', ErrorCode.UPSTREAM_ERROR],
      ['a duplicate reference', ErrorCode.PAYOUT_DUPLICATE_REFERENCE],
      ['a validation failure', ErrorCode.VALIDATION_FAILED],
      ['a rate limit', ErrorCode.RATE_LIMIT_EXCEEDED],
    ])('never re-places after %s', async (_label, code) => {
      primary.initiateTransfer.mockRejectedValue(new AppException(code, { message: 'no' }));

      await expect(router.initiateTransfer(request)).rejects.toMatchObject({ code });

      // The assertion that matters: a second NIP transfer was never sent.
      expect(fallback.initiateTransfer).not.toHaveBeenCalled();
    });

    it('does not re-place after a non-AppException, which carries no outcome information', async () => {
      primary.initiateTransfer.mockRejectedValue(new Error('socket hang up'));

      await expect(router.initiateTransfer(request)).rejects.toThrow('socket hang up');
      expect(fallback.initiateTransfer).not.toHaveBeenCalled();
    });
  });

  it('does not call the fallback when the primary succeeds', async () => {
    primary.initiateTransfer.mockResolvedValue(acceptance('FALCON-1'));

    await expect(router.initiateTransfer(request)).resolves.toEqual(acceptance('FALCON-1'));
    expect(fallback.initiateTransfer).not.toHaveBeenCalled();
  });

  it("surfaces the primary's reason when both refuse", async () => {
    primary.initiateTransfer.mockRejectedValue(
      new AppException(ErrorCode.PAYOUT_REJECTED, { message: 'primary said no' }),
    );
    fallback.initiateTransfer.mockRejectedValue(
      new AppException(ErrorCode.SERVICE_UNAVAILABLE, { message: 'fallback said no' }),
    );

    // The customer has no model of a "fallback provider", so the primary's
    // refusal is the explicable one.
    await expect(router.initiateTransfer(request)).rejects.toMatchObject({
      code: ErrorCode.PAYOUT_REJECTED,
    });
  });

  // ===========================================================================
  //  Reference data
  // ===========================================================================

  describe('reference data', () => {
    it('serves the bank list from the primary only', async () => {
      primary.listBanks.mockResolvedValue([{ name: 'GTBank', code: '058' }]);

      await expect(router.listBanks()).resolves.toEqual([{ name: 'GTBank', code: '058' }]);
      expect(fallback.listBanks).not.toHaveBeenCalled();
    });

    it('does not fall back on a bank-list failure', async () => {
      primary.listBanks.mockRejectedValue(new Error('down'));

      await expect(router.listBanks()).rejects.toThrow('down');
      expect(fallback.listBanks).not.toHaveBeenCalled();
    });

    it('resolves accounts through the primary only', async () => {
      // Routing a name enquiry to a provider that numbers banks differently
      // would resolve a different institution and show the customer a plausible
      // but wrong name.
      primary.resolveAccount.mockRejectedValue(new Error('down'));

      await expect(router.resolveAccount('0234057048', '058')).rejects.toThrow('down');
      expect(fallback.resolveAccount).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  //  Identity and webhooks
  // ===========================================================================

  it("reports the primary's name, so ledger rows name a real provider", () => {
    expect(router.name).toBe(PayoutProviderName.FALCONPAY);
  });

  it('refuses to verify or parse webhooks, which belong to the concrete adapters', () => {
    expect(() => router.verifySignature()).toThrow(AppException);
    expect(() => router.parseEvent()).toThrow(AppException);
  });
});

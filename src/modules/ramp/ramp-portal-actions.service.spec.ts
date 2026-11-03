jest.mock('./ramp.commands', () => ({ RampCommandsService: class {} }));
jest.mock('./ramp.bills', () => ({ RampBillsService: class {} }));
jest.mock('./ramp.naira', () => ({ RampNairaService: class {} }));
jest.mock('./ramp.stellar-wallet', () => ({ RampStellarWalletService: class {} }));
jest.mock('./ramp.celo-wallet', () => ({ RampCeloWalletService: class {} }));
jest.mock('./ramp.store', () => ({ RampStoreService: class {} }));
jest.mock('./ramp.whatsapp', () => ({ RampWhatsAppService: class {} }));
jest.mock('../auth/auth.service', () => ({ AuthService: class {} }));
jest.mock('../rewards/rewards.service', () => ({ RewardsService: class {} }));
jest.mock('./ramp.receipt', () => ({
  renderBankSendReceiptPng: jest.fn().mockResolvedValue(Buffer.from('png')),
  renderBillReceiptPng: jest.fn().mockResolvedValue(Buffer.from('png')),
  renderTransferReceiptPng: jest.fn().mockResolvedValue(Buffer.from('png')),
}));

import type { PinoLogger } from 'nestjs-pino';

import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { BillOrderStatus, MobileNetwork } from '../bills/bills-provider.interface';
import { RampPortalActionsService } from './ramp-portal-actions.service';
import { OutcomeUnknownError, type RampPortalIdempotency } from './ramp-portal.idempotency';

const device = { ip: '127.0.0.1', userAgent: 'jest' };
const STELLAR = `G${'A'.repeat(55)}`;
const PEER = `G${'B'.repeat(55)}`;

async function waitFor(assert: () => void, attempts = 20): Promise<void> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      assert();
      return;
    } catch (e) {
      last = e;
      await new Promise((r) => setImmediate(r));
    }
  }
  throw last;
}

function codeOf(e: unknown): string | undefined {
  return e instanceof AppException ? e.code : undefined;
}

async function rejectionCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return 'RESOLVED';
  } catch (e) {
    return codeOf(e);
  }
}

function setup() {
  process.env.WA_RAMP_RATE_SELL_NGN = '1500';
  process.env.WA_RAMP_MAX_ORDER_USDC = '500';
  process.env.WA_RAMP_MIN_BANK_SEND_NGN = '100';
  process.env.WA_RAMP_MAX_BANK_SEND_NGN = '500000';
  process.env.WA_RAMP_SELL_FEE_NGN = '100';

  const db = {
    user: { findFirst: jest.fn().mockResolvedValue({ phoneE164: '+2348030000001' }) },
    zyRampUser: { findFirst: jest.fn().mockResolvedValue({ phone: '2348030000001' }) },
  };
  const auth = { verifyTransactionPin: jest.fn().mockResolvedValue(undefined) };
  // Pass-through idempotency: exercised separately in its own spec.
  const idempotency = {
    run: jest.fn((_p: unknown, action: () => Promise<unknown>) => action()),
  } as unknown as RampPortalIdempotency;
  const commands = {
    resolveTransferDestination: jest.fn().mockResolvedValue({
      matches: [
        { to: PEER, toLabel: '@chidi', displayName: 'Chidi', kind: 'username', knownUser: true },
      ],
    }),
    resolveCeloTransferDestination: jest.fn(),
    ensureZyloWallet: jest.fn().mockResolvedValue(STELLAR),
    ensureCeloWallet: jest.fn().mockResolvedValue(`0x${'c'.repeat(40)}`),
    notifyRecipientTransfer: jest.fn().mockResolvedValue(undefined),
  };
  const naira = {
    quoteUsdcForNgn: jest.fn((ngn: number) => ({
      amountNgn: ngn,
      amountUsdc: ngn / 1500,
      rate: 1500,
    })),
    resolveAccount: jest
      .fn()
      .mockResolvedValue({ accountNumber: '0123456789', accountName: 'AMAKA EZE' }),
    resolveSupportedBank: jest.fn().mockResolvedValue({ code: '058', name: 'GTBank' }),
    executeBankSend: jest.fn().mockResolvedValue({
      ref: 'BS-1',
      completed: false,
      amountNgn: 5000,
      amountUsdc: 3.333333,
      chain: 'stellar',
    }),
  };
  const bills = {
    listDataPlansForNetwork: jest
      .fn()
      .mockResolvedValue([{ code: 'MTN1GB', name: '1GB 30 days', amountNgn: 1200 }]),
    executeAirtime: jest.fn(),
    executeData: jest.fn().mockResolvedValue({
      ref: 'D-1',
      status: BillOrderStatus.Completed,
      amountNgn: 1200,
      amountUsdc: 0.8,
      chain: 'stellar',
    }),
    listDiscos: jest.fn().mockResolvedValue([
      {
        code: 'ikeja-electric',
        name: 'Ikeja Electric',
        minNgn: 1000,
        maxNgn: 100000,
        meterTypes: [],
      },
    ]),
    verifyMeterName: jest.fn().mockResolvedValue('ADA OBI'),
    executeElectricity: jest.fn().mockResolvedValue({
      ref: 'el_1',
      status: BillOrderStatus.Completed,
      amountNgn: 5000,
      amountUsdc: 3.33,
      chain: 'stellar',
      meterToken: '1234-5678-9012',
    }),
    listCablePackages: jest
      .fn()
      .mockResolvedValue([{ code: 'dstv-compact', name: 'Compact', amountNgn: 15700 }]),
    verifySmartCardName: jest.fn().mockResolvedValue('ADA OBI'),
    executeCable: jest.fn().mockResolvedValue({
      ref: 'tv_1',
      status: BillOrderStatus.Pending,
      amountNgn: 15700,
      amountUsdc: 10.47,
      chain: 'stellar',
    }),
    listBettingCompanies: jest
      .fn()
      .mockResolvedValue([{ code: 'bet9ja', name: 'Bet9ja', minNgn: 0, maxNgn: 0 }]),
    verifyBettingName: jest.fn().mockResolvedValue('ADA OBI'),
    executeBetting: jest.fn(),
  };
  const stellar = { transferUsdc: jest.fn().mockResolvedValue('a'.repeat(64)) };
  const celo = { transferStable: jest.fn() };
  const store = {
    getUser: jest.fn().mockResolvedValue({ username: 'tolu', whatsappName: 'Tolu' }),
    listPayoutAccounts: jest.fn().mockResolvedValue([
      {
        id: 7,
        phone: '2348030000001',
        bankName: 'GTBank',
        bankCode: '058',
        accountNumber: '0123456789',
        accountName: 'TOLU ADE',
        isDefault: true,
        createdAt: new Date(),
      },
    ]),
    upsertPayoutAccount: jest.fn().mockResolvedValue(undefined),
    findBankSendByRef: jest.fn(),
  };
  const whatsapp = {
    sendText: jest.fn().mockResolvedValue(undefined),
    sendImage: jest.fn().mockResolvedValue(undefined),
  };
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  } as unknown as PinoLogger;

  const service = new RampPortalActionsService(
    db as never,
    auth as never,
    idempotency,
    commands as never,
    naira as never,
    bills as never,
    stellar as never,
    celo as never,
    store as never,
    { onTransaction: jest.fn().mockResolvedValue(undefined) } as never,
    whatsapp as never,
    logger,
  );
  return { service, db, auth, commands, naira, bills, stellar, store, whatsapp };
}

describe('RampPortalActionsService', () => {
  describe('sendUsdc', () => {
    const dto = { recipient: '@chidi', amount: '10', network: 'stellar' as const, pin: '4829' };

    it('sends from the customer wallet with the same call the chat uses', async () => {
      const { service, stellar, commands, auth, whatsapp } = setup();
      const res = await service.sendUsdc('u1', dto, 'key-12345', device);

      expect(auth.verifyTransactionPin).toHaveBeenCalledWith('u1', '4829', device);
      expect(stellar.transferUsdc).toHaveBeenCalledWith(STELLAR, PEER, 10, '2348030000001');
      expect(commands.notifyRecipientTransfer).toHaveBeenCalled();
      expect(whatsapp.sendText).toHaveBeenCalledWith(
        '2348030000001',
        expect.stringContaining('Sent 10 USDC from the web app'),
      );
      await waitFor(() =>
        expect(whatsapp.sendImage).toHaveBeenCalledWith(
          '2348030000001',
          expect.objectContaining({ filename: 'banjee-receipt.png' }),
        ),
      );
      expect(res).toMatchObject({
        status: 'completed',
        amountUsdc: 10,
        recipient: { label: '@chidi' },
      });
    });

    it('moves nothing when the PIN is wrong', async () => {
      const { service, stellar, auth } = setup();
      auth.verifyTransactionPin.mockRejectedValue(new AppException(ErrorCode.INVALID_CREDENTIALS));
      expect(await rejectionCode(service.sendUsdc('u1', dto, 'key-12345', device))).toBe(
        ErrorCode.INVALID_CREDENTIALS,
      );
      expect(stellar.transferUsdc).not.toHaveBeenCalled();
    });

    it('refuses an ambiguous recipient', async () => {
      const { service, commands, stellar } = setup();
      commands.resolveTransferDestination.mockResolvedValue({
        matches: [
          { to: PEER, toLabel: 'chidi', kind: 'contact', knownUser: true },
          { to: `G${'C'.repeat(55)}`, toLabel: '@chidi2', kind: 'username', knownUser: true },
        ],
      });
      expect(await rejectionCode(service.sendUsdc('u1', dto, 'key-12345', device))).toBe(
        ErrorCode.VALIDATION_FAILED,
      );
      expect(stellar.transferUsdc).not.toHaveBeenCalled();
    });

    it('refuses sending to your own wallet', async () => {
      const { service, commands, stellar } = setup();
      commands.resolveTransferDestination.mockResolvedValue({
        matches: [{ to: STELLAR, toLabel: '@me', kind: 'username', knownUser: true }],
      });
      expect(await rejectionCode(service.sendUsdc('u1', dto, 'key-12345', device))).toBe(
        ErrorCode.VALIDATION_FAILED,
      );
      expect(stellar.transferUsdc).not.toHaveBeenCalled();
    });

    it('turns an unconfirmed chain submit into an unknown outcome', async () => {
      const { service, stellar } = setup();
      stellar.transferUsdc.mockRejectedValue(new Error('Transaction not confirmed after 30s'));
      expect(await rejectionCode(service.sendUsdc('u1', dto, 'key-12345', device))).toBe(
        ErrorCode.PAYOUT_UNKNOWN_OUTCOME,
      );
    });

    it('maps insufficient balance without leaking internals', async () => {
      const { service, stellar } = setup();
      stellar.transferUsdc.mockRejectedValue(new Error('Insufficient USDC balance on contract C…'));
      expect(await rejectionCode(service.sendUsdc('u1', dto, 'key-12345', device))).toBe(
        ErrorCode.INSUFFICIENT_BALANCE,
      );
    });

    it('explains when no WhatsApp wallet is linked', async () => {
      const { service, db } = setup();
      db.zyRampUser.findFirst.mockResolvedValue(null);
      expect(await rejectionCode(service.sendUsdc('u1', dto, 'key-12345', device))).toBe(
        ErrorCode.PRECONDITION_FAILED,
      );
    });
  });

  describe('bankSend', () => {
    it('uses the account name resolved on the server, not from the client', async () => {
      const { service, naira, store, whatsapp } = setup();
      const res = await service.bankSend(
        'u1',
        {
          bankCode: '058',
          accountNumber: '0123456789',
          amountNgn: '5000',
          network: 'stellar',
          pin: '4829',
        },
        'key-12345',
        device,
      );
      expect(naira.executeBankSend).toHaveBeenCalledWith(
        expect.objectContaining({
          accountName: 'AMAKA EZE',
          bankName: 'GTBank',
          amountNgn: 5000,
          deferSettlement: true,
        }),
      );
      expect(store.upsertPayoutAccount).toHaveBeenCalled();
      expect(whatsapp.sendText).toHaveBeenCalledWith(
        '2348030000001',
        expect.stringContaining('Bank transfer submitted from the web app'),
      );
      expect(res).toMatchObject({ ref: 'BS-1', status: 'processing', accountName: 'AMAKA EZE' });
    });

    it('rejects amounts outside the limits before asking for the PIN', async () => {
      const { service, auth } = setup();
      expect(
        await rejectionCode(
          service.bankSend(
            'u1',
            {
              bankCode: '058',
              accountNumber: '0123456789',
              amountNgn: '50',
              network: 'stellar',
              pin: '4829',
            },
            'key-12345',
            device,
          ),
        ),
      ).toBe(ErrorCode.PAYOUT_AMOUNT_NOT_ALLOWED);
      expect(auth.verifyTransactionPin).not.toHaveBeenCalled();
    });
  });

  describe('sellUsdc', () => {
    const dto = { amountUsdc: '25', network: 'stellar' as const, pin: '4829', quotedRateNgn: 1500 };

    it('locks the chat quote: gross minus the flat fee, at the reviewed rate', async () => {
      const { service, naira, whatsapp } = setup();
      const res = await service.sellUsdc('u1', dto, 'key-12345', device);
      expect(naira.executeBankSend).toHaveBeenCalledWith(
        expect.objectContaining({
          amountUsdc: 25,
          rate: 1500,
          amountNgn: 25 * 1500 - 100,
          accountName: 'TOLU ADE',
        }),
      );
      expect(whatsapp.sendText).toHaveBeenCalledWith(
        '2348030000001',
        expect.stringContaining('Sale submitted from the web app'),
      );
      expect(res).toMatchObject({ ref: 'BS-1', rateNgn: 1500, feeNgn: 100 });
    });

    it('refuses when the rate changed since review, without touching the PIN', async () => {
      const { service, auth, naira } = setup();
      expect(
        await rejectionCode(
          service.sellUsdc('u1', { ...dto, quotedRateNgn: 1400 }, 'key-12345', device),
        ),
      ).toBe(ErrorCode.PRECONDITION_FAILED);
      expect(auth.verifyTransactionPin).not.toHaveBeenCalled();
      expect(naira.executeBankSend).not.toHaveBeenCalled();
    });

    it('needs a saved payout account', async () => {
      const { service, store } = setup();
      store.listPayoutAccounts.mockResolvedValue([]);
      expect(await rejectionCode(service.sellUsdc('u1', dto, 'key-12345', device))).toBe(
        ErrorCode.PRECONDITION_FAILED,
      );
    });
  });

  describe('buyData', () => {
    it('charges the catalogue price for the plan', async () => {
      const { service, bills } = setup();
      await service.buyData(
        'u1',
        {
          mobileNetwork: 'mtn',
          phone: '08031234567',
          planCode: 'MTN1GB',
          network: 'stellar',
          pin: '4829',
        },
        'key-12345',
        device,
      );
      expect(bills.executeData).toHaveBeenCalledWith(
        expect.objectContaining({
          network: MobileNetwork.Mtn,
          planCode: 'MTN1GB',
          amountNgn: 1200,
        }),
      );
    });

    it('rejects an unknown plan', async () => {
      const { service, bills } = setup();
      expect(
        await rejectionCode(
          service.buyData(
            'u1',
            {
              mobileNetwork: 'mtn',
              phone: '08031234567',
              planCode: 'NOPE',
              network: 'stellar',
              pin: '4829',
            },
            'key-12345',
            device,
          ),
        ),
      ).toBe(ErrorCode.BILL_PRODUCT_NOT_FOUND);
      expect(bills.executeData).not.toHaveBeenCalled();
    });
  });

  describe('payElectricity', () => {
    const dto = {
      discoCode: 'ikeja-electric',
      meterType: 'prepaid' as const,
      meterNumber: '45012345678',
      amountNgn: '5000',
      network: 'stellar' as const,
      pin: '4829',
    };

    it('uses the provider-verified name and returns the token', async () => {
      const { service, bills, whatsapp } = setup();
      const res = await service.payElectricity('u1', dto, 'key-12345', device);
      expect(bills.executeElectricity).toHaveBeenCalledWith(
        expect.objectContaining({ meterType: '01', customerName: 'ADA OBI', amountNgn: 5000 }),
      );
      expect(res).toMatchObject({ status: 'completed', meterToken: '1234-5678-9012' });
      await waitFor(() => {
        expect(whatsapp.sendText).toHaveBeenCalled();
        expect(whatsapp.sendImage).toHaveBeenCalledWith(
          '2348030000001',
          expect.objectContaining({ filename: 'banjee-electricity-receipt.png' }),
        );
      });
    });

    it('refuses an amount outside the disco limits before asking for the PIN', async () => {
      const { service, auth, bills } = setup();
      expect(
        await rejectionCode(
          service.payElectricity('u1', { ...dto, amountNgn: '500' }, 'key-12345', device),
        ),
      ).toBe(ErrorCode.BILL_AMOUNT_NOT_ALLOWED);
      expect(auth.verifyTransactionPin).not.toHaveBeenCalled();
      expect(bills.executeElectricity).not.toHaveBeenCalled();
    });

    it('does not pay a meter the provider cannot find', async () => {
      const { service, bills } = setup();
      bills.verifyMeterName.mockRejectedValue(new Error('Invalid meter number'));
      expect(await rejectionCode(service.payElectricity('u1', dto, 'key-12345', device))).toBe(
        ErrorCode.BILL_CUSTOMER_INVALID,
      );
      expect(bills.executeElectricity).not.toHaveBeenCalled();
    });
  });

  describe('payCable', () => {
    it('charges the catalogue price for the package', async () => {
      const { service, bills } = setup();
      const res = await service.payCable(
        'u1',
        {
          provider: 'dstv',
          packageCode: 'dstv-compact',
          smartCardNumber: '7023456789',
          network: 'stellar',
          pin: '4829',
        },
        'key-12345',
        device,
      );
      expect(bills.executeCable).toHaveBeenCalledWith(
        expect.objectContaining({ amountNgn: 15700, providerLabel: 'DStv' }),
      );
      expect(res.status).toBe('processing');
    });
  });

  describe('fundBetting', () => {
    it('falls back to default limits when the catalogue has none', async () => {
      const { service } = setup();
      expect(
        await rejectionCode(
          service.fundBetting(
            'u1',
            {
              companyCode: 'bet9ja',
              customerId: '1234567',
              amountNgn: '60000',
              network: 'stellar',
              pin: '4829',
            },
            'key-12345',
            device,
          ),
        ),
      ).toBe(ErrorCode.BILL_AMOUNT_NOT_ALLOWED);
    });
  });

  describe('getBankSend', () => {
    it("never shows another customer's transfer", async () => {
      const { service, store } = setup();
      store.findBankSendByRef.mockResolvedValue({
        ref: 'BS-9',
        phone: '2348099999999',
        status: 'completed',
      });
      expect(await rejectionCode(service.getBankSend('u1', 'BS-9'))).toBe(
        ErrorCode.RESOURCE_NOT_FOUND,
      );
    });
  });

  it('exports OutcomeUnknownError for callers', () => {
    expect(new OutcomeUnknownError('x')).toBeInstanceOf(Error);
  });
});

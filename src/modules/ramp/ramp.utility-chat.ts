import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { CableProvider, MeterType } from '../bills/bills-provider.interface';
import { RampBillsService } from './ramp.bills';
import { formatCeloStable, RampCeloWalletService } from './ramp.celo-wallet';
import { getRampConfig, pinFlowEnabled, usableWhatsAppFlowId } from './ramp.config';
import { RampNairaService, type SpendChain } from './ramp.naira';
import { RampOnboardingService } from './ramp.onboarding';
import { formatSacAmount, RampStellarWalletService } from './ramp.stellar-wallet';
import { RampStoreService } from './ramp.store';
import type { RampReply } from './ramp.whatsapp';

const CABLE_PROVIDERS: Array<{ id: CableProvider; label: string }> = [
  { id: CableProvider.Dstv, label: 'DStv' },
  { id: CableProvider.Gotv, label: 'GOtv' },
  { id: CableProvider.Startimes, label: 'StarTimes' },
];

type PendingElectricity = {
  step: 'disco' | 'meter_type' | 'meter' | 'amount' | 'pay_from' | 'pin';
  discoCode?: string;
  discoName?: string;
  meterType?: MeterType;
  meterNumber?: string;
  customerName?: string;
  minNgn?: number;
  maxNgn?: number;
  amountNgn?: number;
  amountUsdc?: number;
  rate?: number;
  payChain?: SpendChain;
  discoOptions?: Array<{ code: string; name: string; minNgn: number; maxNgn: number }>;
};

type PendingCable = {
  step: 'provider' | 'package' | 'smartcard' | 'pay_from' | 'pin';
  provider?: CableProvider;
  providerLabel?: string;
  packageCode?: string;
  packageName?: string;
  smartCardNumber?: string;
  customerName?: string;
  amountNgn?: number;
  amountUsdc?: number;
  rate?: number;
  payChain?: SpendChain;
  packageOptions?: Array<{ code: string; name: string; amountNgn: number }>;
};

type PendingBetting = {
  step: 'company' | 'customer' | 'amount' | 'pay_from' | 'pin';
  companyCode?: string;
  companyName?: string;
  customerId?: string;
  customerName?: string;
  minNgn?: number;
  maxNgn?: number;
  amountNgn?: number;
  amountUsdc?: number;
  rate?: number;
  payChain?: SpendChain;
  companyOptions?: Array<{ code: string; name: string; minNgn: number; maxNgn: number }>;
};

function asText(text: string): RampReply {
  return { type: 'text', text };
}

function waListTitle(s: string, max = 24): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * WhatsApp multi-step flows for electricity, cable TV and betting.
 * Kept separate from airtime/data so `ramp.commands` stays navigable.
 */
@Injectable()
export class RampUtilityChatService {
  private readonly pendingElectricity = new Map<string, PendingElectricity>();
  private readonly pendingCable = new Map<string, PendingCable>();
  private readonly pendingBetting = new Map<string, PendingBetting>();

  constructor(
    private readonly bills: RampBillsService,
    private readonly naira: RampNairaService,
    private readonly onboarding: RampOnboardingService,
    private readonly store: RampStoreService,
    private readonly stellar: RampStellarWalletService,
    private readonly celo: RampCeloWalletService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RampUtilityChatService.name);
  }

  clearAll(phone: string): void {
    this.pendingElectricity.delete(phone);
    this.pendingCable.delete(phone);
    this.pendingBetting.delete(phone);
  }

  hasActive(phone: string): boolean {
    return (
      this.pendingElectricity.has(phone) ||
      this.pendingCable.has(phone) ||
      this.pendingBetting.has(phone)
    );
  }

  billsMenu(): RampReply {
    return {
      type: 'list',
      header: this.onboarding.brandName(),
      body: 'Bills & top-up — what do you need?',
      footer: 'Paid with Stellar or Celo USDC',
      button: 'Choose',
      sections: [
        {
          title: 'Mobile',
          rows: [
            { id: 'menu_airtime', title: 'Buy airtime', description: 'MTN, Airtel, Glo, 9mobile' },
            { id: 'menu_data', title: 'Buy data', description: 'Mobile data bundles' },
          ],
        },
        {
          title: 'Utilities',
          rows: [
            {
              id: 'menu_electricity',
              title: 'Electricity',
              description: 'Prepaid token / postpaid',
            },
            { id: 'menu_cable', title: 'Cable TV', description: 'DStv, GOtv, StarTimes' },
            { id: 'menu_betting', title: 'Betting top-up', description: 'Fund betting wallets' },
          ],
        },
      ],
    };
  }

  /** Electricity / cable / betting only (Actions hub shortcut). */
  utilitiesMenu(): RampReply {
    return {
      type: 'list',
      header: this.onboarding.brandName(),
      body: 'Utilities — pick one:',
      footer: 'Paid with Stellar or Celo USDC',
      button: 'Choose',
      sections: [
        {
          title: 'Utilities',
          rows: [
            {
              id: 'menu_electricity',
              title: 'Electricity',
              description: 'Prepaid token / postpaid',
            },
            { id: 'menu_cable', title: 'Cable TV', description: 'DStv, GOtv, StarTimes' },
            { id: 'menu_betting', title: 'Betting top-up', description: 'Fund betting wallets' },
          ],
        },
      ],
    };
  }

  async startElectricity(phone: string): Promise<RampReply | RampReply[]> {
    this.clearAll(phone);
    let discos: PendingElectricity['discoOptions'] = [];
    try {
      discos = await this.bills.listDiscos();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn({ err: msg, phone }, '[zylo-ramp] electricity catalogue failed');
      return asText('Electricity providers are unavailable right now. Try again later.');
    }
    if (!discos.length) {
      return asText('No electricity companies available right now. Try again later.');
    }
    this.pendingElectricity.set(phone, { step: 'disco', discoOptions: discos });
    return {
      type: 'list',
      header: this.onboarding.brandName(),
      body: 'Electricity — pick your DISCO',
      footer: 'Then meter + amount',
      button: 'DISCOs',
      sections: [
        {
          title: 'Company',
          rows: discos.map((d, i) => ({
            id: `elec_disco_${i}`,
            title: waListTitle(d.name),
            description: `₦${d.minNgn.toLocaleString('en-NG')}–₦${d.maxNgn.toLocaleString('en-NG')}`,
          })),
        },
      ],
    };
  }

  startCable(phone: string): RampReply {
    this.clearAll(phone);
    this.pendingCable.set(phone, { step: 'provider' });
    return {
      type: 'list',
      header: this.onboarding.brandName(),
      body: 'Cable TV — pick a provider',
      footer: 'DStv · GOtv · StarTimes',
      button: 'Providers',
      sections: [
        {
          title: 'TV',
          rows: CABLE_PROVIDERS.map((p) => ({
            id: `cable_prov_${p.id}`,
            title: p.label,
            description: `Renew ${p.label}`,
          })),
        },
      ],
    };
  }

  async startBetting(phone: string): Promise<RampReply | RampReply[]> {
    this.clearAll(phone);
    let companies: PendingBetting['companyOptions'] = [];
    try {
      companies = await this.bills.listBettingCompanies();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn({ err: msg, phone }, '[zylo-ramp] betting catalogue failed');
      return asText('Betting companies are unavailable right now. Try again later.');
    }
    if (!companies.length) {
      return asText('No betting companies available right now. Try again later.');
    }
    this.pendingBetting.set(phone, { step: 'company', companyOptions: companies });
    return {
      type: 'list',
      header: this.onboarding.brandName(),
      body: 'Betting top-up — pick a platform',
      footer: 'Then customer ID + amount',
      button: 'Platforms',
      sections: [
        {
          title: 'Betting',
          rows: companies.map((c, i) => ({
            id: `bet_co_${i}`,
            title: waListTitle(c.name),
            description: `From ₦${c.minNgn.toLocaleString('en-NG')}`,
          })),
        },
      ],
    };
  }

  /**
   * Handle Flow PIN for utility bills. Returns null if this PIN is not for us.
   */
  async handleFlowPin(phone: string, pin: string): Promise<RampReply | RampReply[] | null> {
    const elec = this.pendingElectricity.get(phone);
    if (elec?.step === 'pin') {
      if (!/^\d{4}$/.test(pin)) return asText('PIN must be exactly 4 digits.');
      const ok = await this.onboarding.verifyUserPin(phone, pin);
      if (!ok) return asText('Wrong PIN. Try again, or cancel.');
      return this.executeElectricity(phone);
    }
    const cable = this.pendingCable.get(phone);
    if (cable?.step === 'pin') {
      if (!/^\d{4}$/.test(pin)) return asText('PIN must be exactly 4 digits.');
      const ok = await this.onboarding.verifyUserPin(phone, pin);
      if (!ok) return asText('Wrong PIN. Try again, or cancel.');
      return this.executeCable(phone);
    }
    const bet = this.pendingBetting.get(phone);
    if (bet?.step === 'pin') {
      if (!/^\d{4}$/.test(pin)) return asText('PIN must be exactly 4 digits.');
      const ok = await this.onboarding.verifyUserPin(phone, pin);
      if (!ok) return asText('Wrong PIN. Try again, or cancel.');
      return this.executeBetting(phone);
    }
    return null;
  }

  async continueAny(
    phone: string,
    raw: string,
    btn: string | null,
    lower: string,
  ): Promise<RampReply | RampReply[] | null> {
    if (this.pendingElectricity.has(phone)) {
      return this.continueElectricity(phone, raw, btn, lower);
    }
    if (this.pendingCable.has(phone)) {
      return this.continueCable(phone, raw, btn, lower);
    }
    if (this.pendingBetting.has(phone)) {
      return this.continueBetting(phone, raw, btn, lower);
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  //  Electricity
  // ---------------------------------------------------------------------------

  private async continueElectricity(
    phone: string,
    raw: string,
    btn: string | null,
    lower: string,
  ): Promise<RampReply | RampReply[]> {
    const pending = this.pendingElectricity.get(phone);
    if (!pending) return asText('Nothing in progress. Tap Bills & top-up to start.');

    if (btn === 'elec_cancel' || btn === 'menu_home' || lower === 'cancel' || lower === 'menu') {
      this.clearAll(phone);
      const user = await this.store.getUser(phone).catch(() => null);
      return btn === 'menu_home' || lower === 'menu'
        ? this.onboarding.mainMenuButtons(user)
        : [asText('Electricity cancelled.'), this.onboarding.mainMenuButtons(user)];
    }

    if (pending.step === 'disco') {
      let disco = pending.discoOptions?.[0];
      if (btn?.startsWith('elec_disco_')) {
        const i = Number(btn.slice('elec_disco_'.length));
        disco = pending.discoOptions?.[i];
      }
      if (!disco) return asText('Pick a DISCO from the list.');
      this.pendingElectricity.set(phone, {
        ...pending,
        step: 'meter_type',
        discoCode: disco.code,
        discoName: disco.name,
        minNgn: disco.minNgn,
        maxNgn: disco.maxNgn,
      });
      return {
        type: 'buttons',
        body: `*${disco.name}*\n\nPrepaid (token) or postpaid (bill)?`,
        footer: 'Meter type',
        buttons: [
          { id: 'elec_type_prepaid', title: 'Prepaid' },
          { id: 'elec_type_postpaid', title: 'Postpaid' },
          { id: 'elec_cancel', title: 'Cancel' },
        ],
      };
    }

    if (pending.step === 'meter_type') {
      let meterType: MeterType | undefined;
      if (btn === 'elec_type_prepaid' || lower === 'prepaid') meterType = MeterType.Prepaid;
      if (btn === 'elec_type_postpaid' || lower === 'postpaid') meterType = MeterType.Postpaid;
      if (!meterType) return asText('Tap Prepaid or Postpaid:');
      this.pendingElectricity.set(phone, { ...pending, step: 'meter', meterType });
      return asText('Send your meter number:');
    }

    if (pending.step === 'meter') {
      const meterNumber = raw.replace(/\s+/g, '').trim();
      if (meterNumber.length < 8) return asText('That meter number looks too short. Try again:');
      try {
        const name = await this.bills.verifyMeterName(
          pending.discoCode!,
          meterNumber,
          pending.meterType!,
        );
        this.pendingElectricity.set(phone, {
          ...pending,
          step: 'amount',
          meterNumber,
          customerName: name,
        });
        return asText(
          [
            `Meter *${meterNumber}*`,
            `Name: *${name}*`,
            '',
            `How much? (₦${(pending.minNgn ?? 0).toLocaleString('en-NG')}–₦${(pending.maxNgn ?? 0).toLocaleString('en-NG')})`,
            'Reply with the amount in naira.',
          ].join('\n'),
        );
      } catch (e) {
        return asText(
          `${e instanceof Error ? e.message : 'Could not verify that meter.'}\n\nSend the meter number again:`,
        );
      }
    }

    if (pending.step === 'amount') {
      const n = Number(String(raw).replace(/[₦,\s]/g, ''));
      const ngn = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
      const min = pending.minNgn ?? 1;
      const max = pending.maxNgn ?? 100_000;
      if (!ngn || ngn < min || ngn > max) {
        return asText(
          `Enter an amount between ₦${min.toLocaleString('en-NG')} and ₦${max.toLocaleString('en-NG')}:`,
        );
      }
      const quote = this.naira.quoteUsdcForNgn(ngn);
      const next: PendingElectricity = {
        ...pending,
        step: 'pay_from',
        amountNgn: quote.amountNgn,
        amountUsdc: quote.amountUsdc,
        rate: quote.rate,
      };
      this.pendingElectricity.set(phone, next);
      return this.payFromPrompt(phone, next, 'electricity');
    }

    if (pending.step === 'pay_from') {
      if (btn === 'pay_from_stellar' || lower === 'stellar' || btn === 'pay_from_wallet') {
        return this.pinPrompt(phone, { ...pending, payChain: 'stellar' }, 'electricity');
      }
      if (btn === 'pay_from_celo' || lower === 'celo') {
        return this.pinPrompt(phone, { ...pending, payChain: 'celo' }, 'electricity');
      }
      return this.payFromPrompt(phone, pending, 'electricity');
    }

    if (pending.step === 'pin') {
      if (!/^\d{4}$/.test(raw.trim())) {
        return asText('PIN must be exactly 4 digits. Try again, or cancel.');
      }
      const ok = await this.onboarding.verifyUserPin(phone, raw.trim());
      if (!ok) return asText('Wrong PIN. Try again, or cancel.');
      return this.executeElectricity(phone);
    }

    return asText('Something went wrong. Tap Bills & top-up to start again.');
  }

  // ---------------------------------------------------------------------------
  //  Cable
  // ---------------------------------------------------------------------------

  private async continueCable(
    phone: string,
    raw: string,
    btn: string | null,
    lower: string,
  ): Promise<RampReply | RampReply[]> {
    const pending = this.pendingCable.get(phone);
    if (!pending) return asText('Nothing in progress. Tap Bills & top-up to start.');

    if (btn === 'cable_cancel' || btn === 'menu_home' || lower === 'cancel' || lower === 'menu') {
      this.clearAll(phone);
      const user = await this.store.getUser(phone).catch(() => null);
      return btn === 'menu_home' || lower === 'menu'
        ? this.onboarding.mainMenuButtons(user)
        : [asText('Cable TV cancelled.'), this.onboarding.mainMenuButtons(user)];
    }

    if (pending.step === 'provider') {
      const prov = CABLE_PROVIDERS.find(
        (p) => btn === `cable_prov_${p.id}` || lower === p.label.toLowerCase(),
      );
      if (!prov) return asText('Pick DStv, GOtv or StarTimes from the list.');
      let packages: PendingCable['packageOptions'] = [];
      try {
        packages = await this.bills.listCablePackages(prov.id);
      } catch (e) {
        return asText(
          `${e instanceof Error ? e.message : 'Catalogue unavailable.'}\nTry another provider.`,
        );
      }
      if (!packages.length) {
        return asText(`No ${prov.label} packages available right now.`);
      }
      this.pendingCable.set(phone, {
        ...pending,
        step: 'package',
        provider: prov.id,
        providerLabel: prov.label,
        packageOptions: packages,
      });
      return {
        type: 'list',
        header: this.onboarding.brandName(),
        body: `${prov.label} — pick a package`,
        footer: 'Then smartcard number',
        button: 'Packages',
        sections: [
          {
            title: 'Bouquet',
            rows: packages.map((p, i) => ({
              id: `cable_pkg_${i}`,
              title: waListTitle(p.name),
              description: `₦${p.amountNgn.toLocaleString('en-NG')}`,
            })),
          },
        ],
      };
    }

    if (pending.step === 'package') {
      let pkg = pending.packageOptions?.[0];
      if (btn?.startsWith('cable_pkg_')) {
        const i = Number(btn.slice('cable_pkg_'.length));
        pkg = pending.packageOptions?.[i];
      }
      if (!pkg) return asText('Pick a package from the list.');
      this.pendingCable.set(phone, {
        ...pending,
        step: 'smartcard',
        packageCode: pkg.code,
        packageName: pkg.name,
        amountNgn: pkg.amountNgn,
      });
      return asText(
        `*${pkg.name}* — ₦${pkg.amountNgn.toLocaleString('en-NG')}\n\nSend your smartcard / IUC number:`,
      );
    }

    if (pending.step === 'smartcard') {
      const smartCardNumber = raw.replace(/\s+/g, '').trim();
      if (smartCardNumber.length < 8) {
        return asText('That smartcard number looks too short. Try again:');
      }
      try {
        const name = await this.bills.verifySmartCardName(pending.provider!, smartCardNumber);
        const quote = this.naira.quoteUsdcForNgn(pending.amountNgn!);
        const next: PendingCable = {
          ...pending,
          step: 'pay_from',
          smartCardNumber,
          customerName: name,
          amountNgn: quote.amountNgn,
          amountUsdc: quote.amountUsdc,
          rate: quote.rate,
        };
        this.pendingCable.set(phone, next);
        const intro = asText(`Smartcard *${smartCardNumber}*\nName: *${name}*`);
        const payAsk = await this.payFromPrompt(phone, next, 'cable');
        return Array.isArray(payAsk) ? [intro, ...payAsk] : [intro, payAsk];
      } catch (e) {
        return asText(
          `${e instanceof Error ? e.message : 'Could not verify that smartcard.'}\n\nSend the number again:`,
        );
      }
    }

    if (pending.step === 'pay_from') {
      if (btn === 'pay_from_stellar' || lower === 'stellar' || btn === 'pay_from_wallet') {
        return this.pinPrompt(phone, { ...pending, payChain: 'stellar' }, 'cable');
      }
      if (btn === 'pay_from_celo' || lower === 'celo') {
        return this.pinPrompt(phone, { ...pending, payChain: 'celo' }, 'cable');
      }
      return this.payFromPrompt(phone, pending, 'cable');
    }

    if (pending.step === 'pin') {
      if (!/^\d{4}$/.test(raw.trim())) {
        return asText('PIN must be exactly 4 digits. Try again, or cancel.');
      }
      const ok = await this.onboarding.verifyUserPin(phone, raw.trim());
      if (!ok) return asText('Wrong PIN. Try again, or cancel.');
      return this.executeCable(phone);
    }

    return asText('Something went wrong. Tap Bills & top-up to start again.');
  }

  // ---------------------------------------------------------------------------
  //  Betting
  // ---------------------------------------------------------------------------

  private async continueBetting(
    phone: string,
    raw: string,
    btn: string | null,
    lower: string,
  ): Promise<RampReply | RampReply[]> {
    const pending = this.pendingBetting.get(phone);
    if (!pending) return asText('Nothing in progress. Tap Bills & top-up to start.');

    if (btn === 'bet_cancel' || btn === 'menu_home' || lower === 'cancel' || lower === 'menu') {
      this.clearAll(phone);
      const user = await this.store.getUser(phone).catch(() => null);
      return btn === 'menu_home' || lower === 'menu'
        ? this.onboarding.mainMenuButtons(user)
        : [asText('Betting top-up cancelled.'), this.onboarding.mainMenuButtons(user)];
    }

    if (pending.step === 'company') {
      let company = pending.companyOptions?.[0];
      if (btn?.startsWith('bet_co_')) {
        const i = Number(btn.slice('bet_co_'.length));
        company = pending.companyOptions?.[i];
      }
      if (!company) return asText('Pick a betting platform from the list.');
      this.pendingBetting.set(phone, {
        ...pending,
        step: 'customer',
        companyCode: company.code,
        companyName: company.name,
        minNgn: company.minNgn,
        maxNgn: company.maxNgn,
      });
      return asText(`*${company.name}*\n\nSend your betting customer / user ID:`);
    }

    if (pending.step === 'customer') {
      const customerId = raw.trim();
      if (customerId.length < 3) return asText('That ID looks too short. Try again:');
      try {
        const name = await this.bills.verifyBettingName(pending.companyCode!, customerId);
        this.pendingBetting.set(phone, {
          ...pending,
          step: 'amount',
          customerId,
          customerName: name,
        });
        return asText(
          [
            `ID *${customerId}*`,
            /^\d{10,14}$/.test(name) ? `Verified: *${name}*` : `Name: *${name}*`,
            '',
            `How much? (₦${(pending.minNgn && pending.minNgn > 0 ? pending.minNgn : 100).toLocaleString('en-NG')}–₦${(pending.maxNgn && pending.maxNgn > 0 ? pending.maxNgn : 50_000).toLocaleString('en-NG')})`,
          ].join('\n'),
        );
      } catch (e) {
        return asText(
          `${e instanceof Error ? e.message : 'Could not verify that ID.'}\n\nSend the customer ID again:`,
        );
      }
    }

    if (pending.step === 'amount') {
      const n = Number(String(raw).replace(/[₦,\s]/g, ''));
      const ngn = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
      const min = pending.minNgn && pending.minNgn > 0 ? pending.minNgn : 100;
      const max = pending.maxNgn && pending.maxNgn > 0 ? pending.maxNgn : 50_000;
      if (!ngn || ngn < min || ngn > max) {
        return asText(
          `Enter an amount between ₦${min.toLocaleString('en-NG')} and ₦${max.toLocaleString('en-NG')}:`,
        );
      }
      const quote = this.naira.quoteUsdcForNgn(ngn);
      const next: PendingBetting = {
        ...pending,
        step: 'pay_from',
        amountNgn: quote.amountNgn,
        amountUsdc: quote.amountUsdc,
        rate: quote.rate,
      };
      this.pendingBetting.set(phone, next);
      return this.payFromPrompt(phone, next, 'betting');
    }

    if (pending.step === 'pay_from') {
      if (btn === 'pay_from_stellar' || lower === 'stellar' || btn === 'pay_from_wallet') {
        return this.pinPrompt(phone, { ...pending, payChain: 'stellar' }, 'betting');
      }
      if (btn === 'pay_from_celo' || lower === 'celo') {
        return this.pinPrompt(phone, { ...pending, payChain: 'celo' }, 'betting');
      }
      return this.payFromPrompt(phone, pending, 'betting');
    }

    if (pending.step === 'pin') {
      if (!/^\d{4}$/.test(raw.trim())) {
        return asText('PIN must be exactly 4 digits. Try again, or cancel.');
      }
      const ok = await this.onboarding.verifyUserPin(phone, raw.trim());
      if (!ok) return asText('Wrong PIN. Try again, or cancel.');
      return this.executeBetting(phone);
    }

    return asText('Something went wrong. Tap Bills & top-up to start again.');
  }

  // ---------------------------------------------------------------------------
  //  Shared pay / pin / execute
  // ---------------------------------------------------------------------------

  private async spendCoverage(phone: string, amountUsdc: number) {
    let stellarUsdc = 0;
    let celoTotal = 0;
    try {
      const user = await this.store.getUser(phone).catch(() => null);
      const wallet = user?.zyloWallet;
      if (wallet && /^G[A-Z0-9]{55}$/i.test(wallet)) {
        const bal = await this.stellar.getBalances(wallet);
        stellarUsdc = Number(formatSacAmount(bal.usdc));
      }
    } catch {
      /* ignore */
    }
    try {
      if (this.celo.isConfigured()) {
        const addr = await this.celo.provisionWallet(phone);
        if (addr) {
          const bal = await this.celo.getStableBalances(addr);
          celoTotal = bal.total;
        }
      }
    } catch {
      /* ignore */
    }
    return {
      stellarOk: stellarUsdc + 1e-9 >= amountUsdc,
      celoOk: celoTotal + 1e-9 >= amountUsdc,
      stellarUsdc,
      celoTotal,
    };
  }

  private async payFromPrompt(
    phone: string,
    pending: { amountNgn?: number; amountUsdc?: number; rate?: number; payChain?: SpendChain },
    kind: 'electricity' | 'cable' | 'betting',
  ): Promise<RampReply | RampReply[]> {
    const usdc = pending.amountUsdc ?? 0;
    const ngn = pending.amountNgn ?? 0;
    const cover = await this.spendCoverage(phone, usdc);
    const label =
      kind === 'electricity' ? 'Electricity' : kind === 'cable' ? 'Cable TV' : 'Betting';
    const recap = [
      `${label} ₦${ngn.toLocaleString('en-NG')} ≈ ${usdc} USDC (₦${pending.rate}/USDC)`,
      `Stellar USDC: *${cover.stellarUsdc}*`,
      this.celo.isConfigured()
        ? `Celo digital dollars: *${formatCeloStable(cover.celoTotal)}*`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    if (cover.stellarOk && !cover.celoOk) {
      return this.pinPrompt(phone, { ...pending, payChain: 'stellar' }, kind);
    }
    if (!cover.stellarOk && cover.celoOk) {
      return this.pinPrompt(phone, { ...pending, payChain: 'celo' }, kind);
    }
    if (!cover.stellarOk && !cover.celoOk) {
      return asText(`${recap}\n\nNot enough USDC. Fund your wallet, then try again.`);
    }

    return [
      asText(recap),
      this.onboarding.payFromChainButtons({
        body: 'Pay from which wallet?',
        stellarOk: cover.stellarOk,
        celoOk: cover.celoOk,
      }),
    ];
  }

  private pinPrompt(
    phone: string,
    pending: {
      amountNgn?: number;
      amountUsdc?: number;
      payChain?: SpendChain;
      discoName?: string;
      meterNumber?: string;
      providerLabel?: string;
      packageName?: string;
      smartCardNumber?: string;
      companyName?: string;
      customerId?: string;
    },
    kind: 'electricity' | 'cable' | 'betting',
  ): RampReply | RampReply[] {
    if (kind === 'electricity') {
      this.pendingElectricity.set(phone, {
        ...(this.pendingElectricity.get(phone) as PendingElectricity),
        ...pending,
        step: 'pin',
      });
    } else if (kind === 'cable') {
      this.pendingCable.set(phone, {
        ...(this.pendingCable.get(phone) as PendingCable),
        ...pending,
        step: 'pin',
      });
    } else {
      this.pendingBetting.set(phone, {
        ...(this.pendingBetting.get(phone) as PendingBetting),
        ...pending,
        step: 'pin',
      });
    }

    const chain = pending.payChain === 'celo' ? 'Celo' : 'Stellar';
    const detail =
      kind === 'electricity'
        ? `${pending.discoName} · ${pending.meterNumber}`
        : kind === 'cable'
          ? `${pending.providerLabel} · ${pending.packageName} · ${pending.smartCardNumber}`
          : `${pending.companyName} · ${pending.customerId}`;

    const lines = [
      `Confirm ${kind === 'electricity' ? 'electricity' : kind === 'cable' ? 'cable TV' : 'betting'}`,
      detail,
      `₦${(pending.amountNgn ?? 0).toLocaleString('en-NG')} ≈ ${pending.amountUsdc} USDC`,
      `Pay from: ${chain}`,
      '',
      'Enter your 4-digit PIN to confirm.',
    ];

    const config = getRampConfig();
    if (pinFlowEnabled() && usableWhatsAppFlowId(config.whatsapp.pinFlowId)) {
      const prefix = kind === 'electricity' ? 'elecpin' : kind === 'cable' ? 'cablepin' : 'betpin';
      return {
        type: 'flow',
        header: this.onboarding.brandName(),
        body: lines.join('\n'),
        footer: 'PIN',
        flowId: config.whatsapp.pinFlowId,
        flowToken: `${prefix}:${phone}:${Date.now()}`,
        cta: 'Enter PIN',
        screen: 'PIN',
      };
    }

    const cancelId =
      kind === 'electricity' ? 'elec_cancel' : kind === 'cable' ? 'cable_cancel' : 'bet_cancel';
    return {
      type: 'buttons',
      body: lines.join('\n'),
      footer: 'Or cancel',
      buttons: [
        { id: cancelId, title: 'Cancel' },
        { id: 'menu_home', title: 'Main menu' },
      ],
    };
  }

  private async ensureWallet(phone: string): Promise<string | null> {
    const user = await this.store.getUser(phone).catch(() => null);
    if (user?.zyloWallet && /^G[A-Z0-9]{55}$/i.test(user.zyloWallet)) {
      return user.zyloWallet;
    }
    try {
      return await this.stellar.provisionWallet(phone);
    } catch {
      return null;
    }
  }

  private async executeElectricity(phone: string): Promise<RampReply | RampReply[]> {
    const pending = this.pendingElectricity.get(phone);
    if (!pending?.discoCode || !pending.meterType || !pending.meterNumber || !pending.amountNgn) {
      this.clearAll(phone);
      return asText('Session expired. Tap Electricity to start again.');
    }
    const wallet = await this.ensureWallet(phone);
    if (!wallet) {
      return asText('Your Stellar wallet is not ready yet. Check balance, then try again.');
    }
    try {
      const result = await this.bills.executeElectricity({
        phone,
        zyloWallet: wallet,
        discoCode: pending.discoCode,
        discoName: pending.discoName || pending.discoCode,
        meterType: pending.meterType,
        meterNumber: pending.meterNumber,
        amountNgn: pending.amountNgn,
        customerName: pending.customerName,
        chain: pending.payChain,
      });
      this.clearAll(phone);
      const user = await this.store.getUser(phone).catch(() => null);
      return [asText(result.message), this.onboarding.mainMenuButtons(user)];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn({ err: msg, phone }, '[zylo-ramp] electricity execute failed');
      this.pendingElectricity.set(phone, { ...pending, step: 'pin' });
      return asText(`${msg}\n\nEnter PIN again to retry, or cancel.`);
    }
  }

  private async executeCable(phone: string): Promise<RampReply | RampReply[]> {
    const pending = this.pendingCable.get(phone);
    if (
      !pending?.provider ||
      !pending.packageCode ||
      !pending.smartCardNumber ||
      !pending.amountNgn
    ) {
      this.clearAll(phone);
      return asText('Session expired. Tap Cable TV to start again.');
    }
    const wallet = await this.ensureWallet(phone);
    if (!wallet) {
      return asText('Your Stellar wallet is not ready yet. Check balance, then try again.');
    }
    try {
      const result = await this.bills.executeCable({
        phone,
        zyloWallet: wallet,
        provider: pending.provider,
        providerLabel: pending.providerLabel || pending.provider,
        packageCode: pending.packageCode,
        packageName: pending.packageName || pending.packageCode,
        smartCardNumber: pending.smartCardNumber,
        amountNgn: pending.amountNgn,
        customerName: pending.customerName,
        chain: pending.payChain,
      });
      this.clearAll(phone);
      const user = await this.store.getUser(phone).catch(() => null);
      return [asText(result.message), this.onboarding.mainMenuButtons(user)];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn({ err: msg, phone }, '[zylo-ramp] cable execute failed');
      this.pendingCable.set(phone, { ...pending, step: 'pin' });
      return asText(`${msg}\n\nEnter PIN again to retry, or cancel.`);
    }
  }

  private async executeBetting(phone: string): Promise<RampReply | RampReply[]> {
    const pending = this.pendingBetting.get(phone);
    if (!pending?.companyCode || !pending.customerId || !pending.amountNgn) {
      this.clearAll(phone);
      return asText('Session expired. Tap Betting top-up to start again.');
    }
    const wallet = await this.ensureWallet(phone);
    if (!wallet) {
      return asText('Your Stellar wallet is not ready yet. Check balance, then try again.');
    }
    try {
      const result = await this.bills.executeBetting({
        phone,
        zyloWallet: wallet,
        companyCode: pending.companyCode,
        companyName: pending.companyName || pending.companyCode,
        customerId: pending.customerId,
        amountNgn: pending.amountNgn,
        customerName: pending.customerName,
        chain: pending.payChain,
      });
      this.clearAll(phone);
      const user = await this.store.getUser(phone).catch(() => null);
      return [asText(result.message), this.onboarding.mainMenuButtons(user)];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn({ err: msg, phone }, '[zylo-ramp] betting execute failed');
      this.pendingBetting.set(phone, { ...pending, step: 'pin' });
      return asText(`${msg}\n\nEnter PIN again to retry, or cancel.`);
    }
  }
}

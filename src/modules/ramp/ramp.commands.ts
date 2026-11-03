import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  getRampConfig,
  pinFlowEnabled,
  usableWhatsAppFlowId,
  type RampConfig,
} from './ramp.config';
import { AIRTIME_MAX_NGN, AIRTIME_MIN_NGN, AIRTIME_NETWORKS, RampBillsService } from './ramp.bills';
import { RampUtilityChatService } from './ramp.utility-chat';
import { MobileNetwork } from '../bills/bills-provider.interface';
import { formatCeloStable, RampCeloWalletService } from './ramp.celo-wallet';
import { RampNairaService, type SpendChain } from './ramp.naira';
import { RampOnboardingService } from './ramp.onboarding';
import { formatSacAmount, RampStellarWalletService } from './ramp.stellar-wallet';
import {
  buildIncomingCreditCaption,
  celoTxUrl,
  formatUsdcWithNgn,
  formatWhatsAppWalletBalance,
  isUsdcLikeAsset,
  shortEvmAddr,
  shortStellarAddr,
  shortTxHash,
  stellarTxUrl,
} from './ramp.format';
import { parseBankDetailsInput } from './ramp.bank-parse';
import {
  RampIntentService,
  type RampCurrency,
  type RampIntentName,
  type RampParsedIntent,
} from './ramp.intent';
import { renderTransferReceiptPng } from './ramp.receipt';
import { RampStoreService, type RampPayoutAccount } from './ramp.store';
import { RampTxNotifyDedupe } from './ramp.tx-notify-dedupe';
import {
  celoWalletAddressReplies,
  clearPendingDeposit,
  deliverDepositDetails,
  fundNetworkPicker,
  getPendingDeposit,
  type DepositFormatChoice,
  walletAddressReplies,
} from './ramp.wallet-handoff';
import { RampWhatsAppService, type RampReply, type WhatsAppSendOpts } from './ramp.whatsapp';
import { Phone } from '../../core/utils/phone.util';
import { RequestContext } from '../../core/context/request-context';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { HashingService } from '../../infrastructure/security/hashing.service';
import { UserType } from '@prisma/client';

const STELLAR_ADDR_RE = /^[GC][A-Z0-9]{55}$/;
const CELO_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

/** `celo` = digital dollars (USDC/USDT/cUSD) on Celo. */
export type TransferAsset = 'usdc' | 'xlm' | 'celo';

/** One resolved Send Money recipient (after contact / username / address lookup). */
export type TransferDestCandidate = {
  to: string;
  /** Primary label: @username, saved alias, or short address */
  toLabel: string;
  /** Optional human name (WhatsApp / contact label) */
  displayName?: string | null;
  kind: 'contact' | 'username' | 'address';
  /** True when address maps to a known BANJEE user */
  knownUser: boolean;
};

type PendingTransfer = {
  step: 'to' | 'confirm_to' | 'pick_to' | 'amount' | 'confirm' | 'pin';
  asset: TransferAsset;
  to?: string;
  /** Display name: @username or shortened address */
  toLabel?: string;
  displayName?: string | null;
  toKind?: TransferDestCandidate['kind'];
  /** When multiple matches — user must pick one */
  candidates?: TransferDestCandidate[];
  amount?: number;
};

/** WhatsApp multi-step: NGN bank send funded from USDC wallet. */
type PendingBankSend = {
  step: 'bank_query' | 'account' | 'confirm_name' | 'amount' | 'pay_from' | 'pin';
  bankCode?: string;
  bankName?: string;
  accountNumber?: string;
  accountName?: string;
  amountNgn?: number;
  amountUsdc?: number;
  rate?: number;
  payChain?: SpendChain;
};

/** WhatsApp multi-step: airtime via bills provider (SMEPlug + ClubKonnect fallback). */
type PendingAirtime = {
  step: 'network' | 'phone' | 'amount' | 'pay_from' | 'pin';
  network?: MobileNetwork;
  networkLabel?: string;
  recipientPhone?: string;
  amountNgn?: number;
  amountUsdc?: number;
  rate?: number;
  payChain?: SpendChain;
};

/** WhatsApp multi-step: data bundle via bills catalogue (SMEPlug `sp:` preferred). */
type PendingData = {
  step: 'network' | 'plan' | 'phone' | 'pay_from' | 'pin';
  network?: MobileNetwork;
  networkLabel?: string;
  recipientPhone?: string;
  planCode?: string;
  planName?: string;
  amountNgn?: number;
  amountUsdc?: number;
  rate?: number;
  payChain?: SpendChain;
  /** Snapshot of list rows for this network (index → plan). */
  planOptions?: Array<{ code: string; name: string; amountNgn: number }>;
};

/** WhatsApp multi-step: Sell USDC → NGN off-ramp (primary product). */
type PendingSell = {
  step:
    | 'network'
    | 'amount'
    | 'quote'
    | 'bank'
    | 'bank_collect'
    | 'bank_verify'
    | 'bank_set_default'
    | 'pin';
  chain?: SpendChain;
  amountUsdc?: number;
  availableBalance?: number;
  rate?: number;
  feeNgn?: number;
  ngnGross?: number;
  ngnPayout?: number;
  /** Epoch ms when the locked quote expires. */
  quoteExpiresAt?: number;
  /** Staged payout after name-enquiry (before user confirms save). */
  stagedPayout?: {
    bankName: string;
    bankCode: string;
    accountNumber: string;
    accountName: string;
  };
  /** After saving a non-default account, ask to promote it. */
  pendingDefaultId?: number;
};

type LastTransferDetails = {
  asset: TransferAsset;
  amount: number;
  to: string;
  toLabel: string;
  hash: string;
};

/** After a successful send — purpose note + optional save beneficiary (Xara-style). */
type PostTransferFollowup = {
  step: 'purpose' | 'save_ask' | 'save_alias';
  amount: number;
  asset: TransferAsset;
  to: string;
  toLabel: string;
};

const ALIAS_RE = /^[a-z0-9_]{2,20}$/;
const USERNAME_DEST_RE = /^@?[a-zA-Z0-9_]{3,20}$/;

function assetLabel(asset: TransferAsset): string {
  if (asset === 'xlm') return 'XLM';
  if (asset === 'celo') return 'Celo USD';
  return 'USDC';
}

function shortTransferAddr(addr: string): string {
  return CELO_ADDR_RE.test(addr) ? shortEvmAddr(addr) : shortStellarAddr(addr);
}

function transferTxUrl(asset: TransferAsset, hash: string): string {
  return asset === 'celo' ? celoTxUrl(hash) : stellarTxUrl(hash);
}

function isAdmin(phone: string, config: RampConfig): boolean {
  return Boolean(config.adminWhatsappNumber && phone === config.adminWhatsappNumber);
}

function parseAmount(raw: string): number | null {
  const n = Number(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 1e6) / 1e6;
}

function asText(text: string): RampReply {
  return { type: 'text', text };
}

/** Prefer BANJEE username; else WhatsApp first name. */
function greetUser(
  user: { username?: string | null; whatsappName?: string | null } | null,
): string {
  if (user?.username) return user.username;
  const wa = (user?.whatsappName || '').trim();
  if (wa) return wa.split(/\s+/)[0] || wa;
  return 'there';
}

function rateText(config: RampConfig): string {
  return [
    'Rates (NGN per 1 USDC)',
    `• sell USDC → you get ₦${config.rates.sellNgn}`,
    `• buy USDC  → you pay ₦${config.rates.buyNgn}`,
    '',
    `Max order: ${config.maxOrderUsdc} USDC`,
  ].join('\n');
}

/** Buy USDC (pay NGN) is paused — keep the menu entry but block the flow. */
function buyUsdcComingSoon(): RampReply {
  return asText(
    [
      'Buy USDC — coming soon.',
      '',
      'For now you can fund your wallet (deposit USDC), sell USDC to Naira, or buy airtime/data.',
      'Reply *menu* for options.',
    ].join('\n'),
  );
}

function maskBankAccount(accountNumber: string): string {
  const digits = String(accountNumber || '').replace(/\D/g, '');
  if (digits.length < 4) return '••••';
  return `•••• ${digits.slice(-4)}`;
}

function depositForChain(
  config: RampConfig,
  chain: string,
  user: { zyloWallet?: string | null } | null,
): string {
  if (chain === 'stellar') {
    // Per-user smart wallet is the sell deposit address (funds already there / send-to-self N/A).
    // For sell, user holds USDC in zyloWallet — we pull via send_to_naira_vault later.
    // Until operator pull is wired, still ask them to ensure balance is in their BANJEE wallet.
    return user?.zyloWallet || config.stellar.depositAddress || '';
  }
  return config.celo.depositAddress || '';
}

function chainLabel(chain: string): string {
  return chain === 'stellar' ? 'Stellar' : 'Celo';
}

@Injectable()
export class RampCommandsService {
  /** In-flight transfers (WhatsApp multi-step). Lost on process restart. */
  private readonly pendingTransfer = new Map<string, PendingTransfer>();
  /** Soft Celo invite shown once per process (not shoved every hi). */
  private readonly celoPromptShown = new Set<string>();
  /** In-flight NGN bank sends. Lost on process restart. */
  private readonly pendingBankSend = new Map<string, PendingBankSend>();
  /** In-flight airtime top-ups. Lost on process restart. */
  private readonly pendingAirtime = new Map<string, PendingAirtime>();
  /** In-flight data purchases. Lost on process restart. */
  private readonly pendingData = new Map<string, PendingData>();
  /** In-flight Sell USDC off-ramp. Lost on process restart. */
  private readonly pendingSell = new Map<string, PendingSell>();
  /** Standalone payout-account settings (add/verify outside sell). */
  private readonly pendingPayoutSettings = new Map<
    string,
    {
      step: 'collect' | 'verify' | 'set_default';
      staged?: {
        bankName: string;
        bankCode: string;
        accountNumber: string;
        accountName: string;
      };
      /** Account number waiting for bank pick when multiple matches. */
      pendingAccountNumber?: string;
      pendingNameHint?: string;
      askDefaultId?: number;
    }
  >();
  /** Change PIN: current → new → confirm. Forgot PIN: new → confirm (WA identity). */
  private readonly pendingPinChange = new Map<
    string,
    {
      mode: 'change' | 'forgot';
      step: 'current' | 'new' | 'confirm';
      newPin?: string;
    }
  >();
  /** KYC (BVN) collection — verification goes live when linked to platform KYC. */
  private readonly pendingKyc = new Map<string, { step: 'bvn' | 'dob'; bvn?: string }>();
  /** Last successful send — for “View details” without dumping raw data in chat. */
  private readonly lastTransfer = new Map<string, LastTransferDetails>();
  /** Purpose / save-beneficiary follow-up after a send. */
  private readonly postTransfer = new Map<string, PostTransferFollowup>();
  /** Free-text intent disambiguation (e.g. send vs sell). */
  private readonly pendingIntentClarify = new Map<
    string,
    NonNullable<RampParsedIntent['alternatives']>
  >();

  constructor(
    private readonly store: RampStoreService,
    private readonly whatsapp: RampWhatsAppService,
    private readonly onboarding: RampOnboardingService,
    private readonly stellarWallets: RampStellarWalletService,
    private readonly celoWallets: RampCeloWalletService,
    private readonly naira: RampNairaService,
    private readonly bills: RampBillsService,
    private readonly utilityChat: RampUtilityChatService,
    private readonly intents: RampIntentService,
    private readonly txNotifyDedupe: RampTxNotifyDedupe,
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RampCommandsService.name);
  }

  private clearTransfer(phone: string): void {
    this.pendingTransfer.delete(phone);
  }

  private clearBankSend(phone: string): void {
    this.pendingBankSend.delete(phone);
  }

  private clearAirtime(phone: string): void {
    this.pendingAirtime.delete(phone);
  }

  private clearData(phone: string): void {
    this.pendingData.delete(phone);
  }

  private clearSell(phone: string): void {
    this.pendingSell.delete(phone);
  }

  private clearPayoutSettings(phone: string): void {
    this.pendingPayoutSettings.delete(phone);
  }

  private clearPinChange(phone: string): void {
    this.pendingPinChange.delete(phone);
  }

  private clearKyc(phone: string): void {
    this.pendingKyc.delete(phone);
  }

  private clearPostTransfer(phone: string): void {
    this.postTransfer.delete(phone);
  }

  private clearIntentClarify(phone: string): void {
    this.pendingIntentClarify.delete(phone);
  }

  /** Wipe every in-progress send-money draft (bank, crypto, follow-ups, deposit handoff). */
  private clearSendMoneyState(phone: string): void {
    this.clearTransfer(phone);
    this.clearBankSend(phone);
    this.clearPostTransfer(phone);
    clearPendingDeposit(phone);
  }

  private clearAllFlows(phone: string): void {
    this.clearSendMoneyState(phone);
    this.clearAirtime(phone);
    this.clearData(phone);
    this.utilityChat.clearAll(phone);
    this.clearSell(phone);
    this.clearPayoutSettings(phone);
    this.clearPinChange(phone);
    this.clearKyc(phone);
    this.clearIntentClarify(phone);
  }

  private hasActiveFlow(phone: string): boolean {
    return (
      this.pendingTransfer.has(phone) ||
      this.pendingBankSend.has(phone) ||
      this.pendingSell.has(phone) ||
      this.pendingAirtime.has(phone) ||
      this.pendingData.has(phone) ||
      this.utilityChat.hasActive(phone) ||
      this.pendingPayoutSettings.has(phone) ||
      this.pendingPinChange.has(phone) ||
      this.pendingKyc.has(phone) ||
      this.postTransfer.has(phone)
    );
  }

  /** Convert NGN notional → USDC using sell rate (for “5000 naira worth of usdc”). */
  private ngnToUsdc(amountNgn: number): number {
    const rate = getRampConfig().rates.sellNgn;
    if (!rate || rate <= 0) return 0;
    return Math.round((amountNgn / rate) * 1e6) / 1e6;
  }

  private resolveIntentAmountUsdc(parsed: {
    amount?: number | null;
    currency?: RampCurrency | null;
  }): number | null {
    if (parsed.amount == null || !(parsed.amount > 0)) return null;
    if (parsed.currency === 'ngn') return this.ngnToUsdc(parsed.amount);
    return parsed.amount;
  }

  private async startSellWithAmount(
    phone: string,
    amountUsdc: number,
    chainHint?: 'stellar' | 'celo' | null,
  ): Promise<RampReply | RampReply[]> {
    this.clearAllFlows(phone);
    const bals = await this.sellNetworkBalances(phone);
    let chain: SpendChain | null = chainHint || null;
    if (chain === 'celo' && bals.celo <= 1e-6) chain = null;
    if (chain === 'stellar' && bals.stellar <= 1e-6) chain = null;
    if (!chain) {
      if (bals.stellar > 1e-6 && !(bals.celo > 1e-6)) chain = 'stellar';
      else if (bals.celo > 1e-6 && !(bals.stellar > 1e-6)) chain = 'celo';
    }
    if (!chain) {
      if (bals.stellar > 1e-6 || bals.celo > 1e-6) {
        this.pendingSell.set(phone, { step: 'network', amountUsdc });
        return {
          type: 'buttons',
          body: [
            `Sell *${amountUsdc} USDC* — which network?`,
            `Stellar: *${bals.stellar.toFixed(2)}*`,
            `Celo: *${bals.celo.toFixed(2)}*`,
          ].join('\n'),
          buttons: [
            { id: 'sell_net_stellar', title: 'Stellar' },
            { id: 'sell_net_celo', title: 'Celo' },
            { id: 'sell_cancel', title: 'Cancel' },
          ],
        };
      }
      return this.startSellFlow(phone);
    }
    const available = chain === 'stellar' ? bals.stellar : bals.celo;
    if (amountUsdc > available + 1e-9) {
      return asText(
        `You only have ${available.toFixed(2)} USDC on ${chainLabel(chain)}. Try a smaller amount.`,
      );
    }
    const quoted = this.buildSellQuote({
      step: 'quote',
      chain,
      amountUsdc,
      availableBalance: available,
    });
    this.pendingSell.set(phone, quoted);
    return this.sellQuoteMessage(phone, quoted);
  }

  private async startSendFromIntent(
    phone: string,
    opts: {
      amount?: number | null;
      currency?: RampCurrency | null;
      recipient?: string | null;
      chain?: 'stellar' | 'celo' | null;
    },
  ): Promise<RampReply | RampReply[]> {
    this.clearAllFlows(phone);
    const asset: TransferAsset =
      opts.chain === 'celo' || opts.currency === 'celo'
        ? 'celo'
        : opts.currency === 'xlm'
          ? 'xlm'
          : 'usdc';
    if (asset === 'celo' && !this.celoWallets.isConfigured()) {
      return asText('Celo transfers are not available right now.');
    }

    let amount = opts.amount ?? null;
    if (opts.currency === 'ngn' && amount != null) {
      amount = this.ngnToUsdc(amount);
    }

    const base: PendingTransfer = {
      step: 'to',
      asset,
      ...(amount != null && amount > 0 ? { amount } : {}),
    };

    if (!opts.recipient) {
      this.pendingTransfer.set(phone, base);
      const balLine = await this.assetBalanceLine(phone, asset);
      return asText(
        [
          `Send ${assetLabel(asset)}.`,
          balLine,
          amount != null ? `Amount locked: *${amount} ${assetLabel(asset)}*.` : '',
          '',
          'Who should receive it? (username, saved contact, or address)',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }

    const dest =
      asset === 'celo'
        ? await this.resolveCeloTransferDestination(phone, opts.recipient)
        : await this.resolveTransferDestination(phone, opts.recipient);
    const presented = this.presentTransferMatches(phone, base, dest);
    const cur = this.pendingTransfer.get(phone);
    if (cur && amount != null && amount > 0) {
      this.pendingTransfer.set(phone, { ...cur, amount });
    }
    return presented;
  }

  private intentClarifyButtons(
    phone: string,
    alts: NonNullable<RampParsedIntent['alternatives']>,
  ): RampReply {
    this.pendingIntentClarify.set(phone, alts.slice(0, 2));
    const buttons = alts.slice(0, 2).map((a, i) => ({
      id: `intent_disambig_${i}`,
      title: a.label.slice(0, 20),
    }));
    buttons.push({ id: 'intent_disambig_other', title: 'Something else' });
    return {
      type: 'buttons',
      body: 'Did you want to:',
      footer: 'Pick one',
      buttons,
    };
  }

  private async dispatchParsedIntent(
    phone: string,
    parsed: RampParsedIntent,
    config: RampConfig,
  ): Promise<RampReply | RampReply[] | null> {
    switch (parsed.intent) {
      case 'cancel':
        this.clearAllFlows(phone);
        return asText('Cancelled. Reply with what you’d like to do next.');

      case 'balance':
        return this.handleBalance(phone);

      case 'rates':
        return asText(rateText(config));

      case 'wallet':
        return this.handleWalletAddress(phone);

      case 'history': {
        const last = this.viewLastTransfer(phone);
        try {
          const status = await this.statusText(phone);
          if (status && !/no open order/i.test(status)) {
            return [asText(status), last];
          }
        } catch {
          /* ignore */
        }
        return last;
      }

      case 'settings':
        this.clearAllFlows(phone);
        return this.settingsMenu();

      case 'airtime':
        this.clearAllFlows(phone);
        return this.startAirtime(phone);

      case 'data':
        this.clearAllFlows(phone);
        return this.startData(phone);

      case 'buy': {
        this.clearAllFlows(phone);
        return buyUsdcComingSoon();
      }

      case 'sell': {
        const amount = this.resolveIntentAmountUsdc(parsed);
        if (amount != null) {
          return this.startSellWithAmount(phone, amount, parsed.chain);
        }
        return this.startSellFlow(phone);
      }

      case 'send':
        // Naira amount (not “naira worth of USDC”) → Nigerian bank payout flow.
        if (
          parsed.currency === 'ngn' &&
          (parsed.bankAccount || parsed.bankQuery || parsed.amount != null)
        ) {
          return this.startBankSendFromIntent(phone, {
            amountNgn: parsed.amount,
            accountNumber: parsed.bankAccount,
            bankQuery: parsed.bankQuery,
          });
        }
        return this.startSendFromIntent(phone, {
          amount: parsed.amount,
          currency: parsed.currency,
          recipient: parsed.recipient,
          chain: parsed.chain,
        });

      case 'ambiguous':
        if (parsed.alternatives?.length) {
          return this.intentClarifyButtons(phone, parsed.alternatives);
        }
        return null;

      case 'general':
      case 'unknown':
      default:
        return null;
    }
  }

  /**
   * Free-text intent layer — additive to menus. Skips when mid-flow or button taps
   * (except disambiguation buttons). Still lands in confirm/PIN before any spend.
   */
  private async tryIntentLayer(
    phone: string,
    raw: string,
    btn: string | null,
    config: RampConfig,
  ): Promise<RampReply | RampReply[] | null> {
    if (btn?.startsWith('intent_disambig_')) {
      if (btn === 'intent_disambig_other') {
        this.clearIntentClarify(phone);
        return asText('No problem — say what you want (e.g. send, sell, balance) or tap the menu.');
      }
      const idx = Number(btn.slice('intent_disambig_'.length));
      const alts = this.pendingIntentClarify.get(phone) || [];
      const picked = alts[idx];
      this.clearIntentClarify(phone);
      if (!picked) return asText('That option expired. Try again in your own words.');
      return this.dispatchParsedIntent(
        phone,
        {
          intent: picked.intent,
          confidence: 0.95,
          amount: picked.amount,
          currency: picked.currency,
          recipient: picked.recipient,
          source: 'regex',
        },
        config,
      );
    }

    // Mid-flow / button navigation — keep state machine in charge
    if (btn || this.hasActiveFlow(phone) || this.pendingIntentClarify.has(phone)) {
      if (this.pendingIntentClarify.has(phone) && !btn && raw.trim()) {
        // User typed instead of tapping — reclassify
        this.clearIntentClarify(phone);
      } else if (btn || this.hasActiveFlow(phone)) {
        return null;
      }
    }

    if (!raw.trim()) return null;
    // Skip pure greetings / menu keywords handled elsewhere
    if (/^(hi|hello|hey|menu|start|help)$/i.test(raw.trim())) return null;

    const parsed = await this.intents.classify(raw);
    this.logger.info(
      {
        phone,
        intent: parsed.intent,
        confidence: parsed.confidence,
        source: parsed.source,
        amount: parsed.amount,
        recipient: parsed.recipient,
      },
      '[zylo-ramp] intent classified',
    );

    if (parsed.intent === 'unknown' && parsed.confidence < 0.5) {
      // Low-confidence unknown → try general Q&A for question-shaped text
      if (/\?|\b(what|why|how|is|are|can|does|do)\b/i.test(raw)) {
        return asText(await this.intents.answerGeneral(raw));
      }
      return null;
    }

    if (parsed.intent === 'general') {
      return asText(await this.intents.answerGeneral(raw));
    }

    if (parsed.intent === 'ambiguous') {
      const alts = parsed.alternatives?.length
        ? parsed.alternatives
        : [
            {
              intent: 'send' as RampIntentName,
              label: parsed.recipient ? `Send to ${parsed.recipient}` : 'Send USDC',
              amount: parsed.amount,
              recipient: parsed.recipient,
              currency: parsed.currency || 'usdc',
            },
            {
              intent: 'sell' as RampIntentName,
              label: parsed.amount ? `Sell ${parsed.amount} USDC` : 'Sell USDC',
              amount: parsed.amount,
              currency: 'usdc' as RampCurrency,
            },
          ];
      return this.intentClarifyButtons(phone, alts);
    }

    return this.dispatchParsedIntent(phone, parsed, config);
  }

  private postTransferDoneButtons(phone: string): RampReply {
    void phone;
    return {
      type: 'buttons',
      body: 'Anything else?',
      footer: 'Tap for more',
      buttons: [
        { id: 'xfer_view_tx', title: 'View details' },
        { id: 'wallet_balance', title: 'Balance' },
        { id: 'menu_home', title: 'Main menu' },
      ],
    };
  }

  private askSaveBeneficiary(pending: PostTransferFollowup): RampReply {
    return {
      type: 'buttons',
      body: `Save ${pending.toLabel} as a contact? You can send to them by name next time — e.g. send 1 usdc to mum`,
      footer: 'Optional',
      buttons: [
        { id: 'xfer_save_yes', title: 'Yes, save' },
        { id: 'xfer_save_no', title: 'No, thanks' },
        { id: 'menu_home', title: 'Main menu' },
      ],
    };
  }

  private async handlePostTransferFollowup(
    phone: string,
    raw: string,
    btn: string | null,
    lower: string,
  ): Promise<RampReply | RampReply[] | null> {
    const pending = this.postTransfer.get(phone);
    if (!pending) return null;

    if (btn === 'menu_home' || lower === 'menu' || lower === 'cancel') {
      this.clearPostTransfer(phone);
      return null; // let menu handler run
    }

    const label = assetLabel(pending.asset);

    if (pending.step === 'purpose') {
      if (
        btn === 'xfer_purpose_personal' ||
        btn === 'xfer_purpose_bills' ||
        btn === 'xfer_purpose_skip' ||
        lower === 'skip' ||
        lower === 'personal' ||
        lower === 'bills' ||
        lower === 'business'
      ) {
        let note = 'Got it.';
        if (btn === 'xfer_purpose_personal' || lower === 'personal') {
          note = `Noted as personal — ${pending.amount} ${label} to ${pending.toLabel}.`;
        } else if (btn === 'xfer_purpose_bills' || lower === 'bills' || lower === 'business') {
          note = `Noted as bills / business — ${pending.amount} ${label} to ${pending.toLabel}.`;
        } else {
          note = 'No problem.';
        }

        // If already a BANJEE @username or saved-looking short name without address dump, still offer rename/save
        const alreadyNamed = pending.toLabel.startsWith('@') || ALIAS_RE.test(pending.toLabel);
        this.postTransfer.set(phone, { ...pending, step: 'save_ask' });
        if (alreadyNamed && pending.toLabel.startsWith('@')) {
          // Peer username — offer custom alias anyway (like Xara renaming)
          return [
            asText(note),
            {
              type: 'buttons',
              body: `Want a shorter name for ${pending.toLabel}? You can send with that nickname next time.`,
              footer: 'Optional',
              buttons: [
                { id: 'xfer_save_yes', title: 'Yes, save alias' },
                { id: 'xfer_save_no', title: 'No, thanks' },
                { id: 'menu_home', title: 'Main menu' },
              ],
            },
          ];
        }
        return [asText(note), this.askSaveBeneficiary(pending)];
      }
      // Ignore unrelated text while waiting — re-prompt
      return {
        type: 'buttons',
        body: `What was the purpose of your ${pending.amount} ${label} transfer to ${pending.toLabel}?`,
        buttons: [
          { id: 'xfer_purpose_personal', title: 'Personal' },
          { id: 'xfer_purpose_bills', title: 'Bills / business' },
          { id: 'xfer_purpose_skip', title: 'Skip' },
        ],
      };
    }

    if (pending.step === 'save_ask') {
      if (btn === 'xfer_save_no' || lower === 'no' || lower === 'no, thanks') {
        this.clearPostTransfer(phone);
        return [asText('All set.'), this.postTransferDoneButtons(phone)];
      }
      if (btn === 'xfer_save_yes' || lower === 'yes' || lower === 'yes, save') {
        this.postTransfer.set(phone, { ...pending, step: 'save_alias' });
        const hint = pending.toLabel.startsWith('@') ? pending.toLabel.replace(/^@/, '') : 'mum';
        return asText(
          `What name should I save them as?\nExample: ${hint}\n(2–20 letters/numbers/_)`,
        );
      }
      return this.askSaveBeneficiary(pending);
    }

    if (pending.step === 'save_alias') {
      const alias = raw.trim().replace(/^@/, '').toLowerCase();
      if (!ALIAS_RE.test(alias)) {
        return asText('Name must be 2–20 characters (letters, numbers, _). Try again:');
      }
      // Don't overwrite global usernames that aren't this address — allow local alias always
      try {
        await this.store.upsertContact(phone, alias, pending.to, pending.toLabel);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.logger.warn({ err: message, phone }, '[zylo-ramp] save contact failed');
        this.clearPostTransfer(phone);
        return [
          asText(
            'Could not save contact (DB may need migrate). You can still send by username or address.',
          ),
          this.postTransferDoneButtons(phone),
        ];
      }
      this.clearPostTransfer(phone);
      return [
        asText(
          [`Contact “${alias}” saved.`, `You can now send with: send 1 usdc to ${alias}`].join(
            '\n',
          ),
        ),
        this.postTransferDoneButtons(phone),
      ];
    }

    return null;
  }

  /** Shared with the web portal (RampPortalActionsService). */
  async ensureZyloWallet(phone: string): Promise<string | null> {
    try {
      const migrated = await this.stellarWallets.migrateToClassicIfNeeded(phone);
      if (migrated.wallet && /^G[A-Z0-9]{55}$/i.test(migrated.wallet)) {
        return migrated.wallet;
      }
    } catch (e) {
      this.logger.warn(
        { err: e instanceof Error ? e.message : String(e), phone },
        '[zylo-ramp] migrate/ensure G wallet failed',
      );
    }

    const user = await this.store.getUser(phone).catch(() => null);
    if (user?.zyloWallet && /^G[A-Z0-9]{55}$/i.test(user.zyloWallet)) {
      return user.zyloWallet;
    }
    if (!this.stellarWallets.isConfigured()) return null;
    try {
      const wallet = await this.stellarWallets.provisionWallet(phone);
      if (wallet && /^G[A-Z0-9]{55}$/i.test(wallet)) {
        await this.store.upsertUser(phone, { zyloWallet: wallet });
        return wallet;
      }
      return wallet;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn({ err: message, phone }, '[zylo-ramp] lazy wallet provision failed');
      return null;
    }
  }

  /** Whether to offer Celo opt-in on the balance Options list (one-shot). */
  private shouldOfferCeloOptIn(
    phone: string,
    user: { celoWallet?: string | null } | null,
  ): boolean {
    if (!this.celoWallets.isConfigured()) return false;
    if (user?.celoWallet && /^0x[a-fA-F0-9]{40}$/.test(user.celoWallet)) return false;
    if (this.celoPromptShown.has(phone)) return false;
    this.celoPromptShown.add(phone);
    return true;
  }

  /** Lazy-provision custodial Celo 0x when user opts in or spends on Celo. */
  /** Shared with the web portal (RampPortalActionsService). */
  async ensureCeloWallet(phone: string): Promise<string | null> {
    if (!this.celoWallets.isConfigured()) return null;
    const user = await this.store.getUser(phone).catch(() => null);
    if (user?.celoWallet && /^0x[a-fA-F0-9]{40}$/.test(user.celoWallet)) {
      return user.celoWallet;
    }
    try {
      return await this.celoWallets.provisionWallet(phone);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn({ err: message, phone }, '[zylo-ramp] lazy Celo provision failed');
      return null;
    }
  }

  private async spendCoverage(
    phone: string,
    amountUsdc: number,
  ): Promise<{ stellarOk: boolean; celoOk: boolean; stellarUsdc: number; celoTotal: number }> {
    let stellarUsdc = 0;
    let celoTotal = 0;
    try {
      const wallet = await this.ensureZyloWallet(phone);
      if (wallet) {
        const bal = await this.stellarWallets.getBalances(wallet);
        stellarUsdc = Number(formatSacAmount(bal.usdc));
      }
    } catch {
      /* ignore */
    }
    try {
      const celo = await this.ensureCeloWallet(phone);
      if (celo) {
        const bal = await this.celoWallets.getStableBalances(celo);
        celoTotal = bal.total;
      }
    } catch {
      /* ignore */
    }
    return {
      stellarUsdc,
      celoTotal,
      stellarOk: stellarUsdc + 1e-9 >= amountUsdc,
      celoOk: this.celoWallets.isConfigured() && celoTotal + 1e-9 >= amountUsdc,
    };
  }

  private async handleBalance(phone: string): Promise<RampReply | RampReply[]> {
    const wallet = await this.ensureZyloWallet(phone);
    if (!wallet) {
      return asText(
        'Your Stellar wallet is not ready yet. Try again in a minute or message support.',
      );
    }
    try {
      const { usdc, xlm } = await this.stellarWallets.getBalances(wallet);
      const stellarUsdc = Number(formatSacAmount(usdc));
      const stellarXlm = Number(formatSacAmount(xlm));

      const groups: Parameters<typeof formatWhatsAppWalletBalance>[0] = [
        {
          chain: 'Stellar',
          assets: [
            { symbol: 'USDC', amount: stellarUsdc, usd: true },
            { symbol: 'XLM', amount: stellarXlm, usd: false },
          ],
        },
      ];

      const user = await this.store.getUser(phone).catch(() => null);
      // Only show Celo balances if they already have an address — don't auto-create.
      if (user?.celoWallet && /^0x[a-fA-F0-9]{40}$/.test(user.celoWallet)) {
        try {
          const bal = await this.celoWallets.getStableBalances(user.celoWallet);
          groups.push({
            chain: 'Celo',
            assets: [
              { symbol: 'USDC', amount: bal.usdc, usd: true },
              { symbol: 'USDT', amount: bal.usdt, usd: true },
              { symbol: 'cUSD', amount: bal.cusd, usd: true },
            ],
          });
        } catch (e) {
          this.logger.warn(
            { err: e instanceof Error ? e.message : String(e), phone },
            '[zylo-ramp] Celo balance failed',
          );
        }
      }

      const actions = ['Send', 'Fund', 'Buy', 'Sell'];
      if (this.shouldOfferCeloOptIn(phone, user)) {
        actions.push('Get Celo');
      }

      const body = formatWhatsAppWalletBalance(groups, {
        walletName: this.onboarding.brandName(),
        actions,
      });

      const offerCelo = actions.includes('Get Celo');
      return this.onboarding.balanceActionButtons(body, { offerCelo });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn({ err: message, phone, wallet }, '[zylo-ramp] balance failed');
      return asText('Could not read balance right now. Try again shortly.');
    }
  }

  private async handleWalletAddress(phone: string): Promise<RampReply | RampReply[]> {
    const user = await this.store.getUser(phone).catch(() => null);
    const wallet = user?.zyloWallet || (await this.ensureZyloWallet(phone));
    if (!wallet) {
      return asText(
        'Your Stellar wallet is not ready yet. Try again in a minute or message support.',
      );
    }

    const hasCelo =
      this.celoWallets.isConfigured() &&
      Boolean(user?.celoWallet && /^0x[a-fA-F0-9]{40}$/.test(user.celoWallet));

    // Never dump both networks in one turn — ask first when Celo exists.
    if (hasCelo) {
      return fundNetworkPicker();
    }

    return walletAddressReplies({
      brandName: this.onboarding.brandName(),
      phone,
      wallet,
      switchToCelo: this.celoWallets.isConfigured(),
    });
  }

  private async handleFundNetwork(
    phone: string,
    network: 'stellar' | 'celo',
  ): Promise<RampReply | RampReply[]> {
    const user = await this.store.getUser(phone).catch(() => null);
    const brand = this.onboarding.brandName();

    if (network === 'celo') {
      const celo =
        user?.celoWallet && /^0x[a-fA-F0-9]{40}$/.test(user.celoWallet)
          ? user.celoWallet
          : await this.ensureCeloWallet(phone);
      if (!celo) {
        return asText('Celo wallets are not available right now. Try again later.');
      }
      return celoWalletAddressReplies({
        brandName: brand,
        phone,
        wallet: celo,
        switchToStellar: true,
      });
    }

    const wallet = user?.zyloWallet || (await this.ensureZyloWallet(phone));
    if (!wallet) {
      return asText(
        'Your Stellar wallet is not ready yet. Try again in a minute or message support.',
      );
    }
    return walletAddressReplies({
      brandName: brand,
      phone,
      wallet,
      switchToCelo: this.celoWallets.isConfigured(),
    });
  }

  private async handleFundFormat(
    phone: string,
    format: DepositFormatChoice,
  ): Promise<RampReply | RampReply[]> {
    const draft = getPendingDeposit(phone);
    if (!draft) {
      return [
        asText('No deposit in progress. Tap Fund wallet to start again.'),
        this.onboarding.mainMenuButtons(await this.store.getUser(phone).catch(() => null)),
      ];
    }
    clearPendingDeposit(phone);
    return deliverDepositDetails(draft, format);
  }

  private startTransfer(): RampReply {
    if (this.celoWallets.isConfigured()) {
      return {
        type: 'buttons',
        body: 'Transfer from your BANJEE wallet.\nWhich network?',
        buttons: [
          { id: 'xfer_chain_stellar', title: 'Stellar' },
          { id: 'xfer_chain_celo', title: 'Celo' },
          { id: 'menu_send', title: 'Back' },
        ],
      };
    }
    return this.startStellarAssetPick();
  }

  private startStellarAssetPick(): RampReply {
    return {
      type: 'buttons',
      body: 'Transfer on Stellar.\nWhat do you want to send?',
      buttons: [
        { id: 'xfer_usdc', title: 'USDC' },
        { id: 'xfer_xlm', title: 'XLM' },
        { id: 'menu_send', title: 'Back' },
      ],
    };
  }

  /** One-line wallet balance for the asset being sent (empty if unread). */
  private async assetBalanceLine(phone: string, asset: TransferAsset): Promise<string> {
    try {
      if (asset === 'celo') {
        const celo = await this.ensureCeloWallet(phone);
        if (!celo) return '';
        const bal = await this.celoWallets.getStableBalances(celo);
        return `Your Celo balance: *${formatCeloStable(bal.total)}*`;
      }
      const wallet = await this.ensureZyloWallet(phone);
      if (!wallet) return '';
      const bal = await this.stellarWallets.getBalances(wallet);
      if (asset === 'xlm') {
        return `Your balance: *${formatSacAmount(bal.xlm)} XLM*`;
      }
      return `Your balance: *${formatSacAmount(bal.usdc)} USDC*`;
    } catch {
      return '';
    }
  }

  private async beginTransfer(phone: string, asset: TransferAsset): Promise<RampReply> {
    this.clearBankSend(phone);
    this.pendingTransfer.set(phone, { step: 'to', asset });
    const label = assetLabel(asset);
    const balLine = await this.assetBalanceLine(phone, asset);
    if (asset === 'celo') {
      return asText(
        [
          `Transfer ${label} on Celo.`,
          balLine,
          '',
          'Who should receive it?',
          '• Saved contact name (e.g. mum)',
          '• BANJEE username (e.g. your_name or @your_name)',
          '• or a Celo address (0x…)',
          '',
          'Or reply cancel.',
        ]
          .filter((line) => line !== '')
          .join('\n')
          .replace(/\n{3,}/g, '\n\n'),
      );
    }
    return asText(
      [
        `Transfer ${label} from your BANJEE wallet.`,
        balLine,
        '',
        'Who should receive it?',
        '• Saved contact name (e.g. mum)',
        '• BANJEE username (e.g. your_name or @your_name)',
        '• or a Stellar address (G… / C…)',
        '',
        'Or reply cancel.',
      ]
        .filter((line) => line !== '')
        .join('\n')
        .replace(/\n{3,}/g, '\n\n'),
    );
  }

  private async beginBankSend(phone: string): Promise<RampReply> {
    this.clearTransfer(phone);
    await this.ensureLegacyPayoutMigrated(phone);
    const def = await this.store.getDefaultPayoutAccount(phone);
    if (def?.bankCode) {
      this.pendingBankSend.set(phone, { step: 'bank_query' });
      return {
        type: 'buttons',
        body: [
          'Send Naira to a Nigerian bank.',
          '',
          `Saved: *${def.accountName}*`,
          `${def.bankName} · ${def.accountNumber}`,
          '',
          'Use this account?',
        ].join('\n'),
        buttons: [
          { id: 'bank_use_saved', title: 'Use saved' },
          { id: 'bank_use_other', title: 'Different' },
          { id: 'bank_cancel', title: 'Cancel' },
        ],
      };
    }
    this.pendingBankSend.set(phone, { step: 'bank_query' });
    return asText(
      [
        'Send Naira to a Nigerian bank.',
        '',
        'Reply with the *bank name* (e.g. Opay, GTBank, Access).',
        'Or reply cancel.',
      ].join('\n'),
    );
  }

  /**
   * Free-text “Send 300 naira to 9078426686 OPay” — jump into the bank-send
   * state machine with whatever pieces we already have.
   */
  private async startBankSendFromIntent(
    phone: string,
    opts: {
      amountNgn?: number | null;
      accountNumber?: string | null;
      bankQuery?: string | null;
    },
  ): Promise<RampReply | RampReply[]> {
    this.clearAllFlows(phone);
    await this.ensureLegacyPayoutMigrated(phone);

    const amountNgn =
      opts.amountNgn != null && opts.amountNgn > 0 ? Math.round(Number(opts.amountNgn)) : null;
    const accountNumber = opts.accountNumber?.replace(/\D/g, '') || null;
    const bankQuery = (opts.bankQuery || '').trim() || null;

    if (!bankQuery && !accountNumber) {
      const started = await this.beginBankSend(phone);
      if (amountNgn != null) {
        // Remember amount once they pick a bank/account.
        const pending = this.pendingBankSend.get(phone);
        if (pending) this.pendingBankSend.set(phone, { ...pending, amountNgn });
      }
      return started;
    }

    if (!bankQuery) {
      this.pendingBankSend.set(phone, {
        step: 'bank_query',
        ...(amountNgn != null ? { amountNgn } : {}),
        ...(accountNumber && /^\d{10}$/.test(accountNumber) ? { accountNumber } : {}),
      });
      return asText(
        [
          amountNgn != null
            ? `Send ₦${amountNgn.toLocaleString('en-NG')} to a Nigerian bank.`
            : 'Send Naira to a Nigerian bank.',
          accountNumber ? `Account: *${accountNumber}*` : '',
          '',
          'Reply with the *bank name* (e.g. Opay, GTBank, Access).',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }

    let banks: Awaited<ReturnType<RampNairaService['listBanks']>>;
    try {
      banks = await this.naira.listBanks();
    } catch (e) {
      this.logger.warn(
        { err: e instanceof Error ? e.message : String(e) },
        '[zylo-ramp] listBanks failed for intent bank send',
      );
      return asText(
        'Could not load banks right now. Try again shortly, or tap Send money → To bank.',
      );
    }

    const matches = this.naira.filterBanks(banks, bankQuery);
    if (matches.length === 0) {
      this.pendingBankSend.set(phone, {
        step: 'bank_query',
        ...(amountNgn != null ? { amountNgn } : {}),
        ...(accountNumber && /^\d{10}$/.test(accountNumber) ? { accountNumber } : {}),
      });
      return asText(`No bank matched “${bankQuery}”. Reply with another bank name:`);
    }

    if (matches.length > 1) {
      this.pendingBankSend.set(phone, {
        step: 'bank_query',
        ...(amountNgn != null ? { amountNgn } : {}),
        ...(accountNumber && /^\d{10}$/.test(accountNumber) ? { accountNumber } : {}),
      });
      return [
        asText(`Found ${matches.length} banks for “${bankQuery}”:`),
        this.bankMatchesList(matches),
      ];
    }

    const bank = matches[0]!;
    if (!accountNumber || !/^\d{10}$/.test(accountNumber)) {
      this.pendingBankSend.set(phone, {
        step: 'account',
        bankCode: bank.code,
        bankName: bank.name,
        ...(amountNgn != null ? { amountNgn } : {}),
      });
      return asText(
        [
          `Bank: *${bank.name}*`,
          amountNgn != null ? `Amount: ₦${amountNgn.toLocaleString('en-NG')}` : '',
          '',
          'Reply with the 10-digit account number:',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }

    try {
      const resolved = await this.naira.resolveAccount(accountNumber, bank.code);
      const pending: PendingBankSend = {
        step: 'confirm_name',
        bankCode: bank.code,
        bankName: bank.name,
        accountNumber: resolved.accountNumber,
        accountName: resolved.accountName,
        ...(amountNgn != null ? { amountNgn } : {}),
      };
      this.pendingBankSend.set(phone, pending);
      return {
        type: 'buttons',
        body: [
          amountNgn != null ? `Send ₦${amountNgn.toLocaleString('en-NG')}` : 'Send Naira',
          '',
          `Account found:`,
          `*${resolved.accountName}*`,
          `${bank.name} · ${resolved.accountNumber}`,
          '',
          'Is this correct?',
        ].join('\n'),
        buttons: [
          { id: 'bank_name_yes', title: 'Yes, continue' },
          { id: 'bank_name_no', title: 'No, re-enter' },
          { id: 'menu_home', title: 'Main menu' },
        ],
      };
    } catch (e) {
      this.logger.warn(
        { err: e instanceof Error ? e.message : String(e), phone },
        '[zylo-ramp] resolveAccount failed for intent bank send',
      );
      this.pendingBankSend.set(phone, {
        step: 'account',
        bankCode: bank.code,
        bankName: bank.name,
        ...(amountNgn != null ? { amountNgn } : {}),
      });
      return asText(
        `Could not verify ${accountNumber} at ${bank.name}. Check the number and reply with the 10-digit account:`,
      );
    }
  }

  private bankMatchesList(matches: { code: string; name: string }[]): RampReply {
    return {
      type: 'list',
      body: 'Pick your bank:',
      button: 'Banks',
      sections: [
        {
          title: 'Banks',
          rows: matches.slice(0, 10).map((b) => ({
            id: `bank_pick_${b.code}`,
            title: b.name.slice(0, 24),
            description: `Code ${b.code}`,
          })),
        },
      ],
    };
  }

  private async bankSendPayFromPrompt(
    phone: string,
    pending: PendingBankSend,
  ): Promise<RampReply | RampReply[]> {
    const ngn = pending.amountNgn ?? 0;
    const usdc = pending.amountUsdc ?? 0;
    const cover = await this.spendCoverage(phone, usdc);
    const balLines = [
      `Stellar USDC: *${cover.stellarUsdc}*`,
      this.celoWallets.isConfigured()
        ? `Celo digital dollars: *${formatCeloStable(cover.celoTotal)}*`
        : '',
    ].filter(Boolean);

    const recap = [
      `Send ₦${ngn.toLocaleString('en-NG')} to ${pending.accountName}`,
      `${pending.bankName} · ${pending.accountNumber}`,
      `≈ ${usdc} USDC at ₦${pending.rate}/USDC`,
      ...balLines,
    ].join('\n');

    if (!cover.stellarOk && !cover.celoOk) {
      return asText(
        [
          recap,
          '',
          `Not enough on either wallet. Need ~${usdc} USDC / digital dollars.`,
          'Fund Stellar USDC or Celo USDC/USDT/cUSD, then try again.',
        ].join('\n'),
      );
    }

    // Only one chain can cover → skip picker (default Stellar when both, but here only one).
    if (cover.stellarOk && !cover.celoOk) {
      return this.bankSendPinPrompt(phone, { ...pending, payChain: 'stellar' });
    }
    if (!cover.stellarOk && cover.celoOk) {
      return this.bankSendPinPrompt(phone, { ...pending, payChain: 'celo' });
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

  private bankSendPinPrompt(phone: string, pending: PendingBankSend): RampReply | RampReply[] {
    const next = { ...pending, step: 'pin' as const };
    this.pendingBankSend.set(phone, next);
    const ngn = pending.amountNgn ?? 0;
    const usdc = pending.amountUsdc ?? 0;
    const config = getRampConfig();
    const chain = pending.payChain === 'celo' ? 'celo' : 'stellar';
    const payHint =
      chain === 'celo'
        ? 'Enter your 4-digit PIN to pay from Celo digital dollars.'
        : 'Enter your 4-digit PIN to pay from Stellar USDC.';
    const body = [
      `Confirm bank send`,
      `₦${ngn.toLocaleString('en-NG')} (≈ ${usdc} USDC)`,
      `To ${pending.accountName}`,
      `${pending.bankName} · ${pending.accountNumber}`,
      `Pay from: ${chain === 'celo' ? 'Celo dollars' : 'Stellar USDC'}`,
      '',
      payHint,
    ].join('\n');

    if (pinFlowEnabled() && usableWhatsAppFlowId(config.whatsapp.pinFlowId)) {
      const recap = `₦${ngn.toLocaleString('en-NG')} (≈ ${usdc} USDC) → ${pending.accountName}`;
      return {
        type: 'flow',
        body: `${[
          `Confirm bank send`,
          recap,
          `${pending.bankName} · ${pending.accountNumber}`,
          `Pay from: ${chain === 'celo' ? 'Celo dollars' : 'Stellar USDC'}`,
        ]
          .filter(Boolean)
          .join('\n')}\n\nTap *Enter PIN* — popup (PIN stays out of chat).`,
        footer: 'PIN confirms payment',
        flowId: usableWhatsAppFlowId(config.whatsapp.pinFlowId),
        flowToken: `bankpin:${phone}:${Date.now()}`,
        cta: 'Enter PIN',
        screen: 'PIN',
        data: { recap },
      };
    }

    return [
      asText(body),
      {
        type: 'buttons',
        body: 'Or cancel',
        buttons: [
          { id: 'bank_cancel', title: 'Cancel' },
          { id: 'menu_home', title: 'Main menu' },
        ],
      },
    ];
  }

  private async executePendingBankSend(phone: string): Promise<RampReply | RampReply[]> {
    const pending = this.pendingBankSend.get(phone);
    if (
      !pending?.bankCode ||
      !pending.bankName ||
      !pending.accountNumber ||
      !pending.accountName ||
      !pending.amountNgn
    ) {
      this.clearBankSend(phone);
      return asText('Nothing to confirm. Tap Send money → To bank to start again.');
    }

    const wallet = await this.ensureZyloWallet(phone);
    if (!wallet) {
      return asText('Your Stellar wallet is not ready yet.');
    }
    if (pending.payChain === 'celo') {
      const celo = await this.ensureCeloWallet(phone);
      if (!celo) {
        return asText('Your Celo wallet is not ready yet.');
      }
    }

    try {
      const result = await this.naira.executeBankSend({
        phone,
        zyloWallet: wallet,
        amountNgn: pending.amountNgn,
        bankCode: pending.bankCode,
        bankName: pending.bankName,
        accountNumber: pending.accountNumber,
        accountName: pending.accountName,
        chain: pending.payChain === 'celo' ? 'celo' : 'stellar',
      });
      this.clearBankSend(phone);
      const user = await this.store.getUser(phone).catch(() => null);
      if (result.completed && result.receiptPng) {
        return [
          {
            type: 'image',
            buffer: result.receiptPng,
            mimeType: 'image/png',
            filename: 'banjee-bank-receipt.png',
            caption: result.message,
          },
          this.onboarding.mainMenuButtons(user),
        ];
      }
      if (result.completed) {
        return [this.onboarding.mainMenuButtons(user)];
      }
      return [asText(result.message), this.onboarding.mainMenuButtons(user)];
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn({ err: message, phone }, '[zylo-ramp] bank send execute failed');

      // Submitted but RPC never confirmed — USDC may already have left. Do not re-PIN.
      if (/not confirmed/i.test(message)) {
        this.clearBankSend(phone);
        const hashMatch = message.match(/\b([a-f0-9]{64})\b/i);
        const tx = hashMatch?.[1] ? `\nTx: ${hashMatch[1]}` : '';
        return asText(
          [
            'Payment was submitted but the network was slow to confirm.',
            'Check your USDC balance before trying again — retrying can send twice.',
            tx,
            '',
            'If USDC dropped and Naira did not arrive, message support with the tx above.',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      }

      // Keep pending so they can retry PIN after fixing balance, wrong PIN path, etc.
      this.pendingBankSend.set(phone, { ...pending, step: 'pin' });
      const hint = asText(`${message}\n\nReply your 4-digit PIN to retry, or cancel.`);
      const pinAsk = this.bankSendPinPrompt(phone, { ...pending, step: 'pin' });
      return Array.isArray(pinAsk) ? [hint, ...pinAsk] : [hint, pinAsk];
    }
  }

  private async continueBankSend(
    phone: string,
    raw: string,
    btn: string | null,
    lower: string,
  ): Promise<RampReply | RampReply[] | null> {
    const pending = this.pendingBankSend.get(phone);
    if (!pending) return null;

    if (btn === 'menu_home' || btn === 'bank_cancel' || lower === 'cancel' || lower === 'menu') {
      this.clearBankSend(phone);
      const user = await this.store.getUser(phone).catch(() => null);
      return [asText('Bank transfer cancelled.'), this.onboarding.mainMenuButtons(user)];
    }

    if (btn === 'bank_use_saved' || lower === 'use saved') {
      await this.ensureLegacyPayoutMigrated(phone);
      const def = await this.store.getDefaultPayoutAccount(phone);
      if (!def?.bankCode) {
        this.pendingBankSend.set(phone, { step: 'bank_query' });
        return asText('No saved account yet. Reply with the bank name (e.g. Opay):');
      }
      this.pendingBankSend.set(phone, {
        step: 'amount',
        bankCode: def.bankCode,
        bankName: def.bankName,
        accountNumber: def.accountNumber,
        accountName: def.accountName,
      });
      const config = getRampConfig();
      return asText(
        [
          `Sending to *${def.accountName}*`,
          `${def.bankName} · ${def.accountNumber}`,
          '',
          'How much Naira?',
          `Min ₦${config.minBankSendNgn.toLocaleString('en-NG')} · Max ₦${config.maxBankSendNgn.toLocaleString('en-NG')}`,
        ].join('\n'),
      );
    }

    if (btn === 'bank_use_other') {
      this.pendingBankSend.set(phone, { step: 'bank_query' });
      return asText('Reply with the *bank name* (e.g. Opay, GTBank, Access):');
    }

    if (
      pending.step === 'bank_query' ||
      (pending.step === 'account' && btn?.startsWith('bank_pick_'))
    ) {
      if (btn?.startsWith('bank_pick_')) {
        const code = btn.slice('bank_pick_'.length);
        try {
          const banks = await this.naira.listBanks();
          const bank = banks.find((b) => b.code === code);
          if (!bank) {
            return asText('Bank not found. Reply with the bank name again:');
          }
          const prefilledAcct = pending.accountNumber?.replace(/\D/g, '') || '';
          if (/^\d{10}$/.test(prefilledAcct)) {
            try {
              const resolved = await this.naira.resolveAccount(prefilledAcct, bank.code);
              this.pendingBankSend.set(phone, {
                step: 'confirm_name',
                bankCode: bank.code,
                bankName: bank.name,
                accountNumber: resolved.accountNumber,
                accountName: resolved.accountName,
                ...(pending.amountNgn != null ? { amountNgn: pending.amountNgn } : {}),
              });
              return {
                type: 'buttons',
                body: [
                  pending.amountNgn != null
                    ? `Send ₦${pending.amountNgn.toLocaleString('en-NG')}`
                    : 'Send Naira',
                  '',
                  `Account found:`,
                  `*${resolved.accountName}*`,
                  `${bank.name} · ${resolved.accountNumber}`,
                  '',
                  'Is this correct?',
                ].join('\n'),
                buttons: [
                  { id: 'bank_name_yes', title: 'Yes, continue' },
                  { id: 'bank_name_no', title: 'No, re-enter' },
                  { id: 'menu_home', title: 'Main menu' },
                ],
              };
            } catch {
              // Fall through to ask for the account number.
            }
          }
          this.pendingBankSend.set(phone, {
            step: 'account',
            bankCode: bank.code,
            bankName: bank.name,
            ...(pending.amountNgn != null ? { amountNgn: pending.amountNgn } : {}),
          });
          return asText(`Bank: *${bank.name}*\n\nReply with the 10-digit account number:`);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          this.logger.warn({ err: message }, '[zylo-ramp] listBanks failed');
          return asText('Could not load banks right now. Try again shortly.');
        }
      }

      if (pending.step === 'bank_query') {
        const q = raw.trim();
        if (!q || btn) {
          return asText('Reply with the bank name (e.g. Opay, GTBank):');
        }
        try {
          const banks = await this.naira.listBanks();
          const matches = this.naira.filterBanks(banks, q);
          if (matches.length === 0) {
            return asText(`No bank matched “${q}”. Try another name:`);
          }
          if (matches.length === 1) {
            const bank = matches[0]!;
            this.pendingBankSend.set(phone, {
              step: 'account',
              bankCode: bank.code,
              bankName: bank.name,
            });
            return asText(`Bank: *${bank.name}*\n\nReply with the 10-digit account number:`);
          }
          return [
            asText(`Found ${matches.length} banks for “${q}”:`),
            this.bankMatchesList(matches),
          ];
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          this.logger.warn({ err: message }, '[zylo-ramp] listBanks failed');
          return asText('Could not load banks right now. Try again shortly.');
        }
      }
    }

    if (pending.step === 'account') {
      const acct = raw.replace(/\D/g, '');
      if (!/^\d{10}$/.test(acct)) {
        return asText('Account number must be 10 digits. Try again:');
      }
      if (!pending.bankCode) {
        this.pendingBankSend.set(phone, { step: 'bank_query' });
        return asText('Start again — reply with the bank name:');
      }
      try {
        const resolved = await this.naira.resolveAccount(acct, pending.bankCode);
        this.pendingBankSend.set(phone, {
          ...pending,
          step: 'confirm_name',
          accountNumber: resolved.accountNumber,
          accountName: resolved.accountName,
        });
        return {
          type: 'buttons',
          body: [
            `Account found:`,
            `*${resolved.accountName}*`,
            `${pending.bankName} · ${resolved.accountNumber}`,
            '',
            'Is this correct?',
          ].join('\n'),
          buttons: [
            { id: 'bank_name_yes', title: 'Yes, continue' },
            { id: 'bank_name_no', title: 'No, re-enter' },
            { id: 'menu_home', title: 'Main menu' },
          ],
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.logger.warn({ err: message, phone }, '[zylo-ramp] resolveAccount failed');
        return asText('Could not verify that account. Check the number and try again:');
      }
    }

    if (pending.step === 'confirm_name') {
      if (btn === 'bank_name_no' || lower === 'no') {
        this.pendingBankSend.set(phone, {
          step: 'account',
          bankCode: pending.bankCode,
          bankName: pending.bankName,
        });
        return asText('Reply with the 10-digit account number:');
      }
      if (btn === 'bank_name_yes' || lower === 'yes') {
        if (pending.bankCode && pending.bankName && pending.accountNumber && pending.accountName) {
          try {
            const existing = await this.store.listPayoutAccounts(phone);
            await this.store.upsertPayoutAccount({
              phone,
              bankName: pending.bankName,
              bankCode: pending.bankCode,
              accountNumber: pending.accountNumber,
              accountName: pending.accountName,
              makeDefault: existing.length === 0,
            });
          } catch (e) {
            this.logger.warn(
              { err: e instanceof Error ? e.message : String(e), phone },
              '[zylo-ramp] save payout from bank send skipped',
            );
          }
        }
        // Free-text intent already supplied the Naira amount — skip asking again.
        if (
          pending.amountNgn != null &&
          Number.isInteger(pending.amountNgn) &&
          pending.amountNgn > 0
        ) {
          const config = getRampConfig();
          if (
            pending.amountNgn < config.minBankSendNgn ||
            pending.amountNgn > config.maxBankSendNgn
          ) {
            this.pendingBankSend.set(phone, { ...pending, step: 'amount', amountNgn: undefined });
            return asText(
              [
                `₦${pending.amountNgn.toLocaleString('en-NG')} is outside limits.`,
                `Min ₦${config.minBankSendNgn.toLocaleString('en-NG')} · Max ₦${config.maxBankSendNgn.toLocaleString('en-NG')}`,
                '',
                'Reply with a new amount:',
              ].join('\n'),
            );
          }
          const quote = this.naira.quoteUsdcForNgn(pending.amountNgn);
          const next: PendingBankSend = {
            ...pending,
            step: 'pay_from',
            amountNgn: quote.amountNgn,
            amountUsdc: quote.amountUsdc,
            rate: quote.rate,
          };
          return this.bankSendPayFromPrompt(phone, next);
        }
        this.pendingBankSend.set(phone, { ...pending, step: 'amount' });
        const config = getRampConfig();
        return asText(
          [
            `How much Naira to send?`,
            `Min ₦${config.minBankSendNgn.toLocaleString('en-NG')} · Max ₦${config.maxBankSendNgn.toLocaleString('en-NG')}`,
            '',
            'Reply with the amount (e.g. 5000).',
          ].join('\n'),
        );
      }
      return asText('Tap Yes to continue, or No to re-enter the account.');
    }

    if (pending.step === 'amount') {
      const amountNgn = Math.round(Number(String(raw).replace(/,/g, '')));
      if (!Number.isFinite(amountNgn) || amountNgn <= 0 || !Number.isInteger(amountNgn)) {
        return asText('Enter a whole Naira amount (e.g. 5000):');
      }
      const config = getRampConfig();
      if (amountNgn < config.minBankSendNgn || amountNgn > config.maxBankSendNgn) {
        return asText(
          `Amount must be between ₦${config.minBankSendNgn.toLocaleString('en-NG')} and ₦${config.maxBankSendNgn.toLocaleString('en-NG')}.`,
        );
      }
      try {
        const quote = this.naira.quoteUsdcForNgn(amountNgn);
        const next: PendingBankSend = {
          ...pending,
          step: 'pay_from',
          amountNgn: quote.amountNgn,
          amountUsdc: quote.amountUsdc,
          rate: quote.rate,
        };
        this.pendingBankSend.set(phone, next);
        return this.bankSendPayFromPrompt(phone, next);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return asText(message);
      }
    }

    if (pending.step === 'pay_from') {
      if (btn === 'pay_from_stellar' || lower === 'stellar' || btn === 'pay_from_wallet') {
        return this.bankSendPinPrompt(phone, { ...pending, payChain: 'stellar' });
      }
      if (btn === 'pay_from_celo' || lower === 'celo') {
        return this.bankSendPinPrompt(phone, { ...pending, payChain: 'celo' });
      }
      // Legacy bank-balance soft-land → Stellar
      if (btn === 'pay_from_bank') {
        return this.bankSendPinPrompt(phone, { ...pending, payChain: 'stellar' });
      }
      return this.bankSendPayFromPrompt(phone, pending);
    }

    if (pending.step === 'pin') {
      const pin = raw.trim();
      if (!/^\d{4}$/.test(pin)) {
        return asText('PIN must be exactly 4 digits. Try again, or cancel.');
      }
      const ok = await this.onboarding.verifyUserPin(phone, pin);
      if (!ok) {
        return asText('Wrong PIN. Try again, or cancel.');
      }
      return this.executePendingBankSend(phone);
    }

    return null;
  }

  private startAirtime(phone: string): RampReply {
    this.clearTransfer(phone);
    this.clearBankSend(phone);
    this.clearData(phone);
    this.utilityChat.clearAll(phone);
    this.clearPostTransfer(phone);
    this.pendingAirtime.set(phone, { step: 'network' });
    return {
      type: 'list',
      header: this.onboarding.brandName(),
      body: 'Buy airtime — pick a network',
      footer: 'Pay with Stellar or Celo',
      button: 'Networks',
      sections: [
        {
          title: 'Network',
          rows: AIRTIME_NETWORKS.map((n) => ({
            id: `airtime_net_${n.id}`,
            title: n.label,
            description: `Top up ${n.label}`,
          })),
        },
      ],
    };
  }

  private topUpMenu(): RampReply {
    return this.utilityChat.billsMenu();
  }

  private startData(phone: string): RampReply {
    this.clearTransfer(phone);
    this.clearBankSend(phone);
    this.clearAirtime(phone);
    this.utilityChat.clearAll(phone);
    this.clearPostTransfer(phone);
    this.pendingData.set(phone, { step: 'network' });
    return {
      type: 'list',
      header: this.onboarding.brandName(),
      body: 'Buy data — pick a network',
      footer: 'SMEPlug plans preferred',
      button: 'Networks',
      sections: [
        {
          title: 'Network',
          rows: AIRTIME_NETWORKS.map((n) => ({
            id: `data_net_${n.id}`,
            title: n.label,
            description: `${n.label} data bundles`,
          })),
        },
      ],
    };
  }

  private async airtimePayFromPrompt(
    phone: string,
    pending: PendingAirtime,
  ): Promise<RampReply | RampReply[]> {
    const ngn = pending.amountNgn ?? 0;
    const usdc = pending.amountUsdc ?? 0;
    const cover = await this.spendCoverage(phone, usdc);
    const recap = [
      `Airtime ₦${ngn.toLocaleString('en-NG')} ${pending.networkLabel} → ${pending.recipientPhone}`,
      `≈ ${usdc} USDC at ₦${pending.rate}/USDC`,
      `Stellar USDC: *${cover.stellarUsdc}*`,
      this.celoWallets.isConfigured()
        ? `Celo digital dollars: *${formatCeloStable(cover.celoTotal)}*`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    if (!cover.stellarOk && !cover.celoOk) {
      return asText(
        [recap, '', `Not enough on either wallet. Need ~${usdc} USDC / digital dollars.`].join(
          '\n',
        ),
      );
    }
    if (cover.stellarOk && !cover.celoOk) {
      return this.airtimePinPrompt(phone, { ...pending, payChain: 'stellar' });
    }
    if (!cover.stellarOk && cover.celoOk) {
      return this.airtimePinPrompt(phone, { ...pending, payChain: 'celo' });
    }
    return [
      asText(recap),
      this.onboarding.payFromChainButtons({
        body: 'Pay from which wallet?',
        stellarOk: true,
        celoOk: true,
      }),
    ];
  }

  private airtimePinPrompt(phone: string, pending: PendingAirtime): RampReply | RampReply[] {
    const next = { ...pending, step: 'pin' as const };
    this.pendingAirtime.set(phone, next);
    const ngn = pending.amountNgn ?? 0;
    const usdc = pending.amountUsdc ?? 0;
    const chain = pending.payChain === 'celo' ? 'celo' : 'stellar';
    const payHint =
      chain === 'celo'
        ? 'Enter your 4-digit PIN to pay from Celo digital dollars.'
        : 'Enter your 4-digit PIN to pay from Stellar USDC.';
    const body = [
      `Confirm airtime`,
      `₦${ngn.toLocaleString('en-NG')} ${pending.networkLabel} → ${pending.recipientPhone}`,
      `≈ ${usdc} USDC at ₦${pending.rate}/USDC`,
      `Pay from: ${chain === 'celo' ? 'Celo dollars' : 'Stellar USDC'}`,
      '',
      payHint,
    ].join('\n');

    if (pinFlowEnabled() && usableWhatsAppFlowId(getRampConfig().whatsapp.pinFlowId)) {
      const flowId = usableWhatsAppFlowId(getRampConfig().whatsapp.pinFlowId);
      const recap = `₦${ngn.toLocaleString('en-NG')} ${pending.networkLabel} → ${pending.recipientPhone}`;
      return {
        type: 'flow',
        body: `${[
          'Confirm airtime',
          recap,
          `Pay from: ${chain === 'celo' ? 'Celo dollars' : 'Stellar USDC'}`,
        ]
          .filter(Boolean)
          .join('\n')}\n\nTap *Enter PIN* — popup (PIN stays out of chat).`,
        footer: 'PIN confirms top-up',
        flowId,
        flowToken: `airpin:${phone}:${Date.now()}`,
        cta: 'Enter PIN',
        screen: 'PIN',
        data: { recap },
      };
    }

    return [
      asText(body),
      {
        type: 'buttons',
        body: 'Or cancel',
        buttons: [
          { id: 'airtime_cancel', title: 'Cancel' },
          { id: 'menu_home', title: 'Main menu' },
        ],
      },
    ];
  }

  private async executePendingAirtime(phone: string): Promise<RampReply | RampReply[]> {
    const pending = this.pendingAirtime.get(phone);
    if (!pending?.network || !pending.recipientPhone || !pending.amountNgn) {
      this.clearAirtime(phone);
      return asText('Nothing to confirm. Tap Buy airtime to start again.');
    }

    const wallet = await this.ensureZyloWallet(phone);
    if (!wallet) {
      return asText('Your Stellar wallet is not ready yet.');
    }
    if (pending.payChain === 'celo') {
      const celo = await this.ensureCeloWallet(phone);
      if (!celo) {
        return asText('Your Celo wallet is not ready yet.');
      }
    }

    try {
      const result = await this.bills.executeAirtime({
        phone,
        zyloWallet: wallet,
        network: pending.network,
        recipientPhone: pending.recipientPhone,
        amountNgn: pending.amountNgn,
        chain: pending.payChain === 'celo' ? 'celo' : 'stellar',
      });
      this.clearAirtime(phone);
      const user = await this.store.getUser(phone).catch(() => null);
      const replies: RampReply[] = [];
      if (result.receiptPng) {
        replies.push({
          type: 'image',
          buffer: result.receiptPng,
          mimeType: 'image/png',
          filename: 'banjee-airtime-receipt.png',
          caption: result.message.slice(0, 1024),
        });
        replies.push(this.onboarding.mainMenuButtons(user));
      } else {
        replies.push(asText(result.message), this.onboarding.mainMenuButtons(user));
      }
      return replies;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn({ err: message, phone }, '[zylo-ramp] airtime execute failed');

      if (/not confirmed/i.test(message)) {
        this.clearAirtime(phone);
        const hashMatch = message.match(/\b([a-f0-9]{64})\b/i);
        const tx = hashMatch?.[1] ? `\nTx: ${hashMatch[1]}` : '';
        return asText(
          [
            'Payment was submitted but the network was slow to confirm.',
            'Check your balance before trying again — retrying can charge twice.',
            tx,
          ]
            .filter(Boolean)
            .join('\n'),
        );
      }

      this.pendingAirtime.set(phone, { ...pending, step: 'pin' });
      const hint = asText(`${message}\n\nReply your 4-digit PIN to retry, or cancel.`);
      const pinAsk = this.airtimePinPrompt(phone, { ...pending, step: 'pin' });
      return Array.isArray(pinAsk) ? [hint, ...pinAsk] : [hint, pinAsk];
    }
  }

  private async continueAirtime(
    phone: string,
    raw: string,
    btn: string | null,
    lower: string,
  ): Promise<RampReply | RampReply[] | null> {
    const pending = this.pendingAirtime.get(phone);
    if (!pending) return null;

    if (btn === 'menu_home' || btn === 'airtime_cancel' || lower === 'cancel' || lower === 'menu') {
      this.clearAirtime(phone);
      const user = await this.store.getUser(phone).catch(() => null);
      return [asText('Airtime cancelled.'), this.onboarding.mainMenuButtons(user)];
    }

    if (pending.step === 'network' || btn?.startsWith('airtime_net_')) {
      const code = btn?.startsWith('airtime_net_') ? btn.slice('airtime_net_'.length) : null;
      const net = AIRTIME_NETWORKS.find((n) => n.id === code);
      if (!net) {
        return this.startAirtime(phone);
      }
      this.pendingAirtime.set(phone, {
        step: 'phone',
        network: net.id,
        networkLabel: net.label,
      });
      return {
        type: 'buttons',
        body: `Network: *${net.label}*\n\nWhose number gets the airtime?`,
        footer: 'Or reply a phone number',
        buttons: [
          { id: 'airtime_self', title: 'My number' },
          { id: 'airtime_cancel', title: 'Cancel' },
          { id: 'menu_home', title: 'Main menu' },
        ],
      };
    }

    if (pending.step === 'phone') {
      let recipient: string | undefined;
      if (btn === 'airtime_self' || lower === 'me' || lower === 'my number') {
        recipient =
          Phone.fromWhatsAppId(phone) || Phone.normalize(phone) || phone.replace(/\D/g, '');
      } else {
        const digits = raw.replace(/\D/g, '');
        recipient =
          Phone.normalize(raw) ||
          Phone.normalize(`0${digits}`) ||
          (digits.length >= 10 ? digits : undefined);
      }
      if (!recipient) {
        return asText('Send a valid Nigerian mobile number, or tap My number:');
      }
      // ClubKonnect expects local 0… form; BillsService normalises again.
      const local = recipient.startsWith('+234')
        ? `0${recipient.slice(4)}`
        : recipient.startsWith('234')
          ? `0${recipient.slice(3)}`
          : recipient.startsWith('0')
            ? recipient
            : `0${recipient}`;
      this.pendingAirtime.set(phone, { ...pending, step: 'amount', recipientPhone: local });
      return {
        type: 'buttons',
        body: `To ${local} (${pending.networkLabel})\n\nTap an amount (₦${AIRTIME_MIN_NGN}–₦${AIRTIME_MAX_NGN.toLocaleString('en-NG')}), or reply any amount:`,
        footer: 'Paid with USDC',
        buttons: [
          { id: 'airtime_amt_100', title: '₦100' },
          { id: 'airtime_amt_200', title: '₦200' },
          { id: 'airtime_amt_500', title: '₦500' },
        ],
      };
    }

    if (pending.step === 'amount') {
      let ngn: number | null = null;
      if (btn?.startsWith('airtime_amt_')) {
        ngn = Number(btn.slice('airtime_amt_'.length));
      } else {
        const n = Number(String(raw).replace(/[₦,\s]/g, ''));
        if (Number.isFinite(n) && n > 0) ngn = Math.round(n);
      }
      if (!ngn || ngn < AIRTIME_MIN_NGN || ngn > AIRTIME_MAX_NGN) {
        return asText(
          `Enter an amount between ₦${AIRTIME_MIN_NGN} and ₦${AIRTIME_MAX_NGN.toLocaleString('en-NG')}:`,
        );
      }
      const quote = this.naira.quoteUsdcForNgn(ngn);
      const next: PendingAirtime = {
        ...pending,
        step: 'pay_from',
        amountNgn: quote.amountNgn,
        amountUsdc: quote.amountUsdc,
        rate: quote.rate,
      };
      this.pendingAirtime.set(phone, next);
      return this.airtimePayFromPrompt(phone, next);
    }

    if (pending.step === 'pay_from') {
      if (btn === 'pay_from_stellar' || lower === 'stellar' || btn === 'pay_from_wallet') {
        return this.airtimePinPrompt(phone, { ...pending, payChain: 'stellar' });
      }
      if (btn === 'pay_from_celo' || lower === 'celo') {
        return this.airtimePinPrompt(phone, { ...pending, payChain: 'celo' });
      }
      return this.airtimePayFromPrompt(phone, pending);
    }

    if (pending.step === 'pin') {
      const pin = raw.trim();
      if (!/^\d{4}$/.test(pin)) {
        return asText('PIN must be exactly 4 digits. Try again, or cancel.');
      }
      const ok = await this.onboarding.verifyUserPin(phone, pin);
      if (!ok) {
        return asText('Wrong PIN. Try again, or cancel.');
      }
      return this.executePendingAirtime(phone);
    }

    return null;
  }

  private waListTitle(text: string, max = 24): string {
    const t = String(text || '').trim();
    if (t.length <= max) return t;
    return `${t.slice(0, max - 1)}…`;
  }

  private async dataPayFromPrompt(
    phone: string,
    pending: PendingData,
  ): Promise<RampReply | RampReply[]> {
    const ngn = pending.amountNgn ?? 0;
    const usdc = pending.amountUsdc ?? 0;
    const cover = await this.spendCoverage(phone, usdc);
    const recap = [
      `Data *${pending.planName}*`,
      `₦${ngn.toLocaleString('en-NG')} ${pending.networkLabel} → ${pending.recipientPhone}`,
      `≈ ${usdc} USDC at ₦${pending.rate}/USDC`,
      `Stellar USDC: *${cover.stellarUsdc}*`,
      this.celoWallets.isConfigured()
        ? `Celo digital dollars: *${formatCeloStable(cover.celoTotal)}*`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    if (!cover.stellarOk && !cover.celoOk) {
      return asText(
        [recap, '', `Not enough on either wallet. Need ~${usdc} USDC / digital dollars.`].join(
          '\n',
        ),
      );
    }
    if (cover.stellarOk && !cover.celoOk) {
      return this.dataPinPrompt(phone, { ...pending, payChain: 'stellar' });
    }
    if (!cover.stellarOk && cover.celoOk) {
      return this.dataPinPrompt(phone, { ...pending, payChain: 'celo' });
    }
    return [
      asText(recap),
      this.onboarding.payFromChainButtons({
        body: 'Pay from which wallet?',
        stellarOk: true,
        celoOk: true,
      }),
    ];
  }

  private dataPinPrompt(phone: string, pending: PendingData): RampReply | RampReply[] {
    const next = { ...pending, step: 'pin' as const };
    this.pendingData.set(phone, next);
    const ngn = pending.amountNgn ?? 0;
    const usdc = pending.amountUsdc ?? 0;
    const chain = pending.payChain === 'celo' ? 'celo' : 'stellar';
    const payHint =
      chain === 'celo'
        ? 'Enter your 4-digit PIN to pay from Celo digital dollars.'
        : 'Enter your 4-digit PIN to pay from Stellar USDC.';
    const body = [
      'Confirm data',
      `*${pending.planName}*`,
      `₦${ngn.toLocaleString('en-NG')} ${pending.networkLabel} → ${pending.recipientPhone}`,
      `≈ ${usdc} USDC at ₦${pending.rate}/USDC`,
      `Pay from: ${chain === 'celo' ? 'Celo dollars' : 'Stellar USDC'}`,
      '',
      payHint,
    ].join('\n');

    if (pinFlowEnabled() && usableWhatsAppFlowId(getRampConfig().whatsapp.pinFlowId)) {
      const flowId = usableWhatsAppFlowId(getRampConfig().whatsapp.pinFlowId);
      const recap = `${pending.planName} · ₦${ngn.toLocaleString('en-NG')}`;
      return {
        type: 'flow',
        body: `${[
          'Confirm data',
          recap,
          `Pay from: ${chain === 'celo' ? 'Celo dollars' : 'Stellar USDC'}`,
        ]
          .filter(Boolean)
          .join('\n')}\n\nTap *Enter PIN* — popup (PIN stays out of chat).`,
        footer: 'PIN confirms data',
        flowId: flowId,
        flowToken: `datapin:${phone}:${Date.now()}`,
        cta: 'Enter PIN',
        screen: 'PIN',
        data: { recap },
      };
    }

    return [
      asText(body),
      {
        type: 'buttons',
        body: 'Or cancel',
        footer: 'PIN in chat',
        buttons: [
          { id: 'data_cancel', title: 'Cancel' },
          { id: 'menu_home', title: 'Main menu' },
        ],
      },
    ];
  }

  private async executePendingData(phone: string): Promise<RampReply | RampReply[]> {
    const pending = this.pendingData.get(phone);
    if (
      !pending?.network ||
      !pending.recipientPhone ||
      !pending.planCode ||
      !pending.planName ||
      !pending.amountNgn
    ) {
      this.clearData(phone);
      return asText('Nothing to confirm. Tap Buy data to start again.');
    }

    const wallet = await this.ensureZyloWallet(phone);
    if (!wallet) {
      return asText('Your Stellar wallet is not ready yet.');
    }
    if (pending.payChain === 'celo') {
      const celo = await this.ensureCeloWallet(phone);
      if (!celo) {
        return asText('Your Celo wallet is not ready yet.');
      }
    }

    try {
      const result = await this.bills.executeData({
        phone,
        zyloWallet: wallet,
        network: pending.network,
        recipientPhone: pending.recipientPhone,
        planCode: pending.planCode,
        planName: pending.planName,
        amountNgn: pending.amountNgn,
        chain: pending.payChain === 'celo' ? 'celo' : 'stellar',
      });
      this.clearData(phone);
      const user = await this.store.getUser(phone).catch(() => null);
      const replies: RampReply[] = [];
      if (result.receiptPng) {
        replies.push({
          type: 'image',
          buffer: result.receiptPng,
          mimeType: 'image/png',
          filename: 'banjee-data-receipt.png',
          caption: result.message.slice(0, 1024),
        });
        replies.push(this.onboarding.mainMenuButtons(user));
      } else {
        replies.push(asText(result.message), this.onboarding.mainMenuButtons(user));
      }
      return replies;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn({ err: message, phone }, '[zylo-ramp] data execute failed');

      if (/not confirmed/i.test(message)) {
        this.clearData(phone);
        return asText(
          [
            'Payment was submitted but the network was slow to confirm.',
            'Check your balance before trying again — retrying can charge twice.',
          ].join('\n'),
        );
      }

      this.pendingData.set(phone, { ...pending, step: 'pin' });
      const hint = asText(`${message}\n\nReply your 4-digit PIN to retry, or cancel.`);
      const pinAsk = this.dataPinPrompt(phone, { ...pending, step: 'pin' });
      return Array.isArray(pinAsk) ? [hint, ...pinAsk] : [hint, pinAsk];
    }
  }

  private async continueData(
    phone: string,
    raw: string,
    btn: string | null,
    lower: string,
  ): Promise<RampReply | RampReply[] | null> {
    const pending = this.pendingData.get(phone);
    if (!pending) return null;

    if (btn === 'menu_home' || btn === 'data_cancel' || lower === 'cancel' || lower === 'menu') {
      this.clearData(phone);
      const user = await this.store.getUser(phone).catch(() => null);
      return [asText('Data purchase cancelled.'), this.onboarding.mainMenuButtons(user)];
    }

    if (pending.step === 'network' || btn?.startsWith('data_net_')) {
      const code = btn?.startsWith('data_net_') ? btn.slice('data_net_'.length) : null;
      const net = AIRTIME_NETWORKS.find((n) => n.id === code);
      if (!net) {
        return this.startData(phone);
      }
      let planOptions: Array<{ code: string; name: string; amountNgn: number }> = [];
      try {
        planOptions = await this.bills.listDataPlansForNetwork(net.id);
      } catch (e) {
        this.logger.warn(
          { err: e instanceof Error ? e.message : String(e), network: net.id },
          '[zylo-ramp] data catalogue failed',
        );
        return asText('Could not load data plans right now. Try again shortly.');
      }
      if (!planOptions.length) {
        return asText(`No data plans available for ${net.label} right now.`);
      }
      this.pendingData.set(phone, {
        step: 'plan',
        network: net.id,
        networkLabel: net.label,
        planOptions,
      });
      return {
        type: 'list',
        header: this.onboarding.brandName(),
        body: `${net.label} data — pick a plan`,
        footer: 'Prices in Naira',
        button: 'Plans',
        sections: [
          {
            title: 'Plans',
            rows: planOptions.map((p, i) => ({
              id: `data_plan_${i}`,
              title: this.waListTitle(p.name),
              description: `₦${p.amountNgn.toLocaleString('en-NG')}`,
            })),
          },
        ],
      };
    }

    if (pending.step === 'plan' || btn?.startsWith('data_plan_')) {
      const idx = btn?.startsWith('data_plan_') ? Number(btn.slice('data_plan_'.length)) : NaN;
      const plan = pending.planOptions?.[idx];
      if (!plan) {
        return asText('Pick a plan from the list:');
      }
      this.pendingData.set(phone, {
        ...pending,
        step: 'phone',
        planCode: plan.code,
        planName: plan.name,
        amountNgn: plan.amountNgn,
      });
      return {
        type: 'buttons',
        body: `*${plan.name}*\n₦${plan.amountNgn.toLocaleString('en-NG')} (${pending.networkLabel})\n\nWhose number gets the data?`,
        footer: 'Or reply a phone number',
        buttons: [
          { id: 'data_self', title: 'My number' },
          { id: 'data_cancel', title: 'Cancel' },
          { id: 'menu_home', title: 'Main menu' },
        ],
      };
    }

    if (pending.step === 'phone') {
      let recipient: string | undefined;
      if (btn === 'data_self' || lower === 'me' || lower === 'my number') {
        recipient =
          Phone.fromWhatsAppId(phone) || Phone.normalize(phone) || phone.replace(/\D/g, '');
      } else {
        const digits = raw.replace(/\D/g, '');
        recipient =
          Phone.normalize(raw) ||
          Phone.normalize(`0${digits}`) ||
          (digits.length >= 10 ? digits : undefined);
      }
      if (!recipient) {
        return asText('Send a valid Nigerian mobile number, or tap My number:');
      }
      const local = recipient.startsWith('+234')
        ? `0${recipient.slice(4)}`
        : recipient.startsWith('234')
          ? `0${recipient.slice(3)}`
          : recipient.startsWith('0')
            ? recipient
            : `0${recipient}`;
      const ngn = pending.amountNgn ?? 0;
      const quote = this.naira.quoteUsdcForNgn(ngn);
      const next: PendingData = {
        ...pending,
        step: 'pay_from',
        recipientPhone: local,
        amountNgn: quote.amountNgn,
        amountUsdc: quote.amountUsdc,
        rate: quote.rate,
      };
      this.pendingData.set(phone, next);
      return this.dataPayFromPrompt(phone, next);
    }

    if (pending.step === 'pay_from') {
      if (btn === 'pay_from_stellar' || lower === 'stellar' || btn === 'pay_from_wallet') {
        return this.dataPinPrompt(phone, { ...pending, payChain: 'stellar' });
      }
      if (btn === 'pay_from_celo' || lower === 'celo') {
        return this.dataPinPrompt(phone, { ...pending, payChain: 'celo' });
      }
      return this.dataPayFromPrompt(phone, pending);
    }

    if (pending.step === 'pin') {
      const pin = raw.trim();
      if (!/^\d{4}$/.test(pin)) {
        return asText('PIN must be exactly 4 digits. Try again, or cancel.');
      }
      const ok = await this.onboarding.verifyUserPin(phone, pin);
      if (!ok) {
        return asText('Wrong PIN. Try again, or cancel.');
      }
      return this.executePendingData(phone);
    }

    return null;
  }

  /**
   * Resolve a Stellar destination to the user's current classic G… when the
   * address (or username) belongs to a BANJEE wallet — including legacy C….
   */
  private async resolveZyloDepositAddress(
    addressOrNull: string | null | undefined,
    peerPhone?: string,
  ): Promise<string | null> {
    let peer =
      (addressOrNull
        ? await this.store.findUserByZyloWallet(addressOrNull).catch(() => null)
        : null) || null;
    if (!peer && peerPhone) {
      peer = await this.store.getUser(peerPhone).catch(() => null);
    }
    if (!peer) return null;

    if (peer.zyloWallet && /^G[A-Z0-9]{55}$/i.test(peer.zyloWallet)) {
      return peer.zyloWallet;
    }

    // Lazy-migrate recipient so @username always lands on classic G…
    if (this.stellarWallets.isClassicConfigured()) {
      try {
        const mig = await this.stellarWallets.migrateToClassicIfNeeded(peer.phone);
        if (mig.wallet && /^G[A-Z0-9]{55}$/i.test(mig.wallet)) {
          return mig.wallet;
        }
      } catch (e) {
        this.logger.warn(
          { err: e instanceof Error ? e.message : String(e), phone: peer.phone },
          '[zylo-ramp] recipient C→G migrate failed during resolve',
        );
      }
    }

    return peer.zyloWallet || null;
  }

  private recipientDisplayLine(c: TransferDestCandidate): string {
    const name = (c.displayName || '').trim();
    if (name && c.toLabel) return `${c.toLabel} (${name})`;
    return c.toLabel;
  }

  private foundRecipientBody(c: TransferDestCandidate): string {
    const found = `Found: *${this.recipientDisplayLine(c)}*`;
    if (c.kind === 'address') {
      const short = shortTransferAddr(c.to);
      const lines = [
        found,
        `Wallet: ${short}`,
        c.to,
        c.knownUser ? '' : 'New recipient — no saved contact match',
        '',
        'Send to this recipient?',
      ];
      return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
    }
    return [found, `Wallet: ${shortTransferAddr(c.to)}`, '', 'Send to this recipient?'].join('\n');
  }

  private applyTransferCandidate(
    pending: PendingTransfer,
    c: TransferDestCandidate,
  ): PendingTransfer {
    return {
      ...pending,
      step: 'confirm_to',
      to: c.to,
      toLabel: c.toLabel,
      displayName: c.displayName || null,
      toKind: c.kind,
      candidates: undefined,
    };
  }

  private recipientConfirmButtons(): RampReply {
    return {
      type: 'buttons',
      body: 'Confirm recipient',
      buttons: [
        { id: 'xfer_to_yes', title: 'Yes' },
        { id: 'xfer_to_no', title: 'No, retry' },
        { id: 'xfer_cancel', title: 'Cancel' },
      ],
    };
  }

  private pickRecipientList(candidates: TransferDestCandidate[]): RampReply {
    return {
      type: 'list',
      header: this.onboarding.brandName(),
      body: `Found ${candidates.length} matches. Pick who to send to:`,
      footer: 'Or reply cancel',
      button: 'Pick',
      sections: [
        {
          title: 'Recipients',
          rows: candidates.slice(0, 10).map((c, i) => ({
            id: `xfer_pick_${i}`,
            title: this.recipientDisplayLine(c).slice(0, 24),
            description: `${c.kind} · ${shortTransferAddr(c.to)}`.slice(0, 72),
          })),
        },
      ],
    };
  }

  private presentTransferMatches(
    phone: string,
    pending: PendingTransfer,
    result: { matches: TransferDestCandidate[] } | { error: string },
  ): RampReply | RampReply[] {
    if ('error' in result) return asText(result.error);
    if (result.matches.length === 0) {
      return asText('No matching recipient. Try a username, saved contact, or address:');
    }
    if (result.matches.length === 1) {
      const c = result.matches[0]!;
      this.pendingTransfer.set(phone, this.applyTransferCandidate(pending, c));
      return [asText(this.foundRecipientBody(c)), this.recipientConfirmButtons()];
    }
    this.pendingTransfer.set(phone, {
      ...pending,
      step: 'pick_to',
      candidates: result.matches.slice(0, 10),
      to: undefined,
      toLabel: undefined,
      displayName: undefined,
    });
    return this.pickRecipientList(result.matches);
  }

  private dedupeDestCandidates(list: TransferDestCandidate[]): TransferDestCandidate[] {
    const seen = new Set<string>();
    const out: TransferDestCandidate[] = [];
    for (const c of list) {
      const key = c.to.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
    return out;
  }

  /** Resolve Stellar destination(s): address, saved alias, or BANJEE @username. */
  /** Shared with the web portal (RampPortalActionsService). */
  async resolveTransferDestination(
    fromPhone: string,
    raw: string,
  ): Promise<{ matches: TransferDestCandidate[] } | { error: string }> {
    const trimmed = raw.trim();
    const asAddr = trimmed.toUpperCase();
    if (STELLAR_ADDR_RE.test(asAddr)) {
      const current = await this.resolveZyloDepositAddress(asAddr);
      const to = current && /^G[A-Z0-9]{55}$/i.test(current) ? current : asAddr;
      const owner = await this.store.findUserByZyloWallet(to).catch(() => null);
      return {
        matches: [
          {
            to,
            toLabel: owner?.username ? `@${owner.username}` : shortTransferAddr(to),
            displayName: owner?.whatsappName || null,
            kind: 'address',
            knownUser: Boolean(owner),
          },
        ],
      };
    }

    if (!USERNAME_DEST_RE.test(trimmed)) {
      return {
        error:
          'Send a name (saved contact or BANJEE username, e.g. mum / your_name) or a Stellar address (G…):',
      };
    }

    const handle = trimmed.replace(/^@/, '').toLowerCase();
    const matches: TransferDestCandidate[] = [];

    const contacts = await this.store.searchContacts(fromPhone, handle, 8).catch(() => []);
    for (const contact of contacts) {
      if (!contact.address) continue;
      const remapped = await this.resolveZyloDepositAddress(contact.address);
      const to = remapped || contact.address;
      if (!STELLAR_ADDR_RE.test(to.toUpperCase()) && !/^G[A-Z0-9]{55}$/i.test(to)) continue;
      if (remapped && remapped !== contact.address) {
        void this.store
          .upsertContact(fromPhone, contact.alias, remapped, contact.label)
          .catch(() => null);
      }
      const owner = await this.store.findUserByZyloWallet(to).catch(() => null);
      matches.push({
        to,
        toLabel: contact.alias,
        displayName: contact.label || owner?.whatsappName || owner?.username || null,
        kind: 'contact',
        knownUser: Boolean(owner),
      });
    }

    const users = await this.store
      .searchUsersByUsername(handle, { exceptPhone: fromPhone, limit: 8 })
      .catch(() => []);
    for (const peer of users) {
      const wallet = await this.resolveZyloDepositAddress(
        peer.zyloWallet || peer.zyloWalletLegacy,
        peer.phone,
      );
      if (!wallet || !/^G[A-Z0-9]{55}$/i.test(wallet)) continue;
      matches.push({
        to: wallet,
        toLabel: `@${peer.username || handle}`,
        displayName: peer.whatsappName || null,
        kind: 'username',
        knownUser: true,
      });
    }

    const deduped = this.preferExactDestMatches(handle, this.dedupeDestCandidates(matches));
    if (!deduped.length) {
      return {
        error: `No contact or BANJEE user named “${handle}”. Check the spelling, or send a Stellar address:`,
      };
    }
    return { matches: deduped };
  }

  /** If any exact alias/@username hit exists, drop weaker prefix/contains noise. */
  private preferExactDestMatches(
    handle: string,
    matches: TransferDestCandidate[],
  ): TransferDestCandidate[] {
    const key = handle.replace(/^@/, '').toLowerCase();
    const exact = matches.filter((m) => {
      const label = m.toLabel.replace(/^@/, '').toLowerCase();
      return label === key;
    });
    return exact.length ? exact : matches;
  }

  /**
   * Resolve Celo destination(s): 0x address, saved alias, or BANJEE @username →
   * peer Celo wallet (provisioned if they are on BANJEE but never opted in).
   */
  /** Shared with the web portal (RampPortalActionsService). */
  async resolveCeloTransferDestination(
    fromPhone: string,
    raw: string,
  ): Promise<{ matches: TransferDestCandidate[] } | { error: string }> {
    const trimmed = raw.trim();

    if (CELO_ADDR_RE.test(trimmed)) {
      const owner = await this.store.findUserByCeloWallet(trimmed).catch(() => null);
      return {
        matches: [
          {
            to: trimmed,
            toLabel: owner?.username ? `@${owner.username}` : shortEvmAddr(trimmed),
            displayName: owner?.whatsappName || null,
            kind: 'address',
            knownUser: Boolean(owner),
          },
        ],
      };
    }

    if (STELLAR_ADDR_RE.test(trimmed.toUpperCase())) {
      const peer = await this.store.findUserByZyloWallet(trimmed.toUpperCase()).catch(() => null);
      if (peer) {
        const celo = await this.ensureCeloWallet(peer.phone);
        if (celo) {
          return {
            matches: [
              {
                to: celo,
                toLabel: peer.username ? `@${peer.username}` : shortEvmAddr(celo),
                displayName: peer.whatsappName || null,
                kind: 'username',
                knownUser: true,
              },
            ],
          };
        }
      }
      return {
        error:
          'That looks like a Stellar address. For Celo sends, use a username, saved contact, or 0x… address:',
      };
    }

    if (!USERNAME_DEST_RE.test(trimmed)) {
      return {
        error:
          'Send a name (saved contact or BANJEE username, e.g. mum / your_name) or a Celo address (0x…):',
      };
    }

    const handle = trimmed.replace(/^@/, '').toLowerCase();
    const matches: TransferDestCandidate[] = [];

    const contacts = await this.store.searchContacts(fromPhone, handle, 8).catch(() => []);
    for (const contact of contacts) {
      if (!contact.address) continue;
      if (CELO_ADDR_RE.test(contact.address)) {
        const owner = await this.store.findUserByCeloWallet(contact.address).catch(() => null);
        matches.push({
          to: contact.address,
          toLabel: contact.alias,
          displayName: contact.label || owner?.whatsappName || owner?.username || null,
          kind: 'contact',
          knownUser: Boolean(owner),
        });
        continue;
      }
      if (STELLAR_ADDR_RE.test(contact.address.toUpperCase())) {
        const peer = await this.store
          .findUserByZyloWallet(contact.address.toUpperCase())
          .catch(() => null);
        if (peer) {
          const celo = await this.ensureCeloWallet(peer.phone);
          if (celo) {
            void this.store
              .upsertContact(fromPhone, contact.alias, celo, contact.label)
              .catch(() => null);
            matches.push({
              to: celo,
              toLabel: contact.alias,
              displayName: contact.label || peer.whatsappName || peer.username || null,
              kind: 'contact',
              knownUser: true,
            });
          }
        }
      }
    }

    const users = await this.store
      .searchUsersByUsername(handle, { exceptPhone: fromPhone, limit: 8 })
      .catch(() => []);
    for (const peer of users) {
      const celo = await this.ensureCeloWallet(peer.phone);
      if (!celo) continue;
      matches.push({
        to: celo,
        toLabel: `@${peer.username || handle}`,
        displayName: peer.whatsappName || null,
        kind: 'username',
        knownUser: true,
      });
    }

    const deduped = this.preferExactDestMatches(handle, this.dedupeDestCandidates(matches));
    if (!deduped.length) {
      return {
        error: `No contact or BANJEE user named “${handle}” with a Celo wallet. Check spelling, or send a 0x… address:`,
      };
    }
    return { matches: deduped };
  }

  private transferRecapLines(pending: PendingTransfer): string[] {
    const label = assetLabel(pending.asset);
    const dest = this.recipientDisplayLine({
      to: pending.to || '',
      toLabel: pending.toLabel || (pending.to ? shortTransferAddr(pending.to) : '—'),
      displayName: pending.displayName,
      kind: pending.toKind || 'address',
      knownUser: Boolean(pending.displayName || pending.toLabel?.startsWith('@')),
    });
    const amount = pending.amount ?? 0;
    const network = pending.asset === 'celo' ? 'Celo' : 'Stellar';
    const feeNote =
      pending.asset === 'celo' ? 'Gas: sponsored by BANJEE' : 'Fee: covered by BANJEE';
    return [`${amount} ${label} → ${dest}`, `Network: ${network} · ${feeNote}`];
  }

  /** Sell-style recap card before PIN. */
  private transferConfirmPrompt(phone: string, pending: PendingTransfer): RampReply {
    const next = { ...pending, step: 'confirm' as const };
    this.pendingTransfer.set(phone, next);
    return {
      type: 'buttons',
      body: [...this.transferRecapLines(next), '', 'Confirm this transfer?'].join('\n'),
      footer: 'Like Sell — review before PIN',
      buttons: [
        { id: 'xfer_confirm', title: 'Confirm' },
        { id: 'xfer_cancel', title: 'Cancel' },
      ],
    };
  }

  private transferPinPrompt(phone: string, pending: PendingTransfer): RampReply | RampReply[] {
    const recap = this.transferRecapLines(pending).join('\n');
    const next = { ...pending, step: 'pin' as const };
    this.pendingTransfer.set(phone, next);

    const flowId = pinFlowEnabled() ? usableWhatsAppFlowId(getRampConfig().whatsapp.pinFlowId) : '';
    if (flowId) {
      return {
        type: 'flow',
        header: this.onboarding.brandName(),
        body: `${recap}\n\nTap *Enter PIN* — popup (PIN stays out of chat).`,
        footer: 'Or reply cancel',
        flowId,
        flowToken: `zylo_xfer_${phone}_${Date.now()}`,
        cta: 'Enter PIN',
        screen: 'PIN',
        data: { recap: this.transferRecapLines(pending)[0] || '' },
      };
    }

    return asText([recap, '', 'Enter your 4-digit PIN to confirm (or reply cancel).'].join('\n'));
  }

  private async executePendingTransfer(phone: string): Promise<RampReply | RampReply[]> {
    const pending = this.pendingTransfer.get(phone);
    if (!pending || !pending.to || !pending.amount) {
      this.clearTransfer(phone);
      return asText('Nothing to confirm. Tap Wallet → Transfer to start again.');
    }

    const { to, amount, asset } = pending;
    const toLabel = pending.toLabel || shortTransferAddr(to);
    const label = assetLabel(asset);

    if (asset === 'celo') {
      const celo = await this.ensureCeloWallet(phone);
      if (!celo) {
        return asText('Your Celo wallet is not ready yet. Open Check balance → Get Celo wallet.');
      }

      try {
        const { txHash: hash, symbol } = await this.celoWallets.transferStable({
          phone,
          to,
          amount,
        });

        this.clearTransfer(phone);
        this.lastTransfer.set(phone, { asset, amount, to, toLabel, hash });

        let balanceLine = '';
        try {
          const bal = await this.celoWallets.getStableBalances(celo);
          balanceLine = `Celo left: ${formatCeloStable(bal.total)}`;
        } catch {
          /* ignore */
        }

        const user = await this.store.getUser(phone).catch(() => null);
        const sentLabel = symbol === 'cUSD' ? 'cUSD' : symbol;

        const replies: RampReply[] = [];
        let hasReceipt = false;
        try {
          const receiptPng = await renderTransferReceiptPng({
            brandName: this.onboarding.brandName(),
            amount,
            asset: sentLabel,
            toLabel,
            toAddress: to,
            fromAddress: celo,
            txHash: hash,
            balanceLeft: balanceLine || null,
            username: user?.username,
          });
          replies.push({
            type: 'image',
            buffer: receiptPng,
            mimeType: 'image/png',
            filename: 'banjee-receipt.png',
            caption: [
              `✅ Sent ${amount} ${sentLabel} (Celo) to ${toLabel}`,
              `Tx ${shortTxHash(hash)}`,
              balanceLine,
            ]
              .filter(Boolean)
              .join('\n'),
          });
          hasReceipt = true;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          this.logger.warn({ err: message }, '[zylo-ramp] receipt image failed');
        }

        if (!hasReceipt) {
          replies.push(
            asText(
              [
                `✅ Sent ${amount} ${sentLabel} (Celo) to ${toLabel}`,
                `Tx ${shortTxHash(hash)}`,
                celoTxUrl(hash),
                balanceLine,
              ]
                .filter(Boolean)
                .join('\n'),
            ),
          );
        }

        const greet = greetUser(user);
        this.postTransfer.set(phone, {
          step: 'purpose',
          amount,
          asset,
          to,
          toLabel,
        });
        replies.push({
          type: 'buttons',
          body: `Hey ${greet}, what was the purpose of your ${amount} ${sentLabel} transfer to ${toLabel}? This helps you track spending.`,
          footer: 'Optional',
          buttons: [
            { id: 'xfer_purpose_personal', title: 'Personal' },
            { id: 'xfer_purpose_bills', title: 'Bills / business' },
            { id: 'xfer_purpose_skip', title: 'Skip' },
          ],
        });

        void this.notifyRecipientTransfer({
          senderPhone: phone,
          senderUsername: user?.username,
          senderWhatsappName: user?.whatsappName,
          fromWallet: celo,
          toWallet: to,
          toLabel,
          amount,
          asset,
          hash,
          sentSymbol: sentLabel,
        });

        return replies;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.logger.error(
          { err: message, phone, to, amount, asset },
          '[zylo-ramp] Celo transfer failed',
        );
        this.pendingTransfer.set(phone, { ...pending, step: 'pin' });
        const hint = asText(
          [
            'Transfer failed — your recipient and amount are still saved.',
            message.includes('Insufficient')
              ? message
              : 'Reply your 4-digit PIN to retry, or cancel.',
          ]
            .filter(Boolean)
            .join('\n'),
        );
        const pinAsk = this.transferPinPrompt(phone, { ...pending, step: 'pin' });
        return Array.isArray(pinAsk) ? [hint, ...pinAsk] : [hint, pinAsk];
      }
    }

    const wallet = await this.ensureZyloWallet(phone);
    if (!wallet) {
      return asText('Your Stellar wallet is not ready yet.');
    }

    try {
      const hash =
        asset === 'xlm'
          ? await this.stellarWallets.transferXlm(wallet, to, amount, phone)
          : await this.stellarWallets.transferUsdc(wallet, to, amount, phone);

      // Only drop the draft after a successful chain send
      this.clearTransfer(phone);

      this.lastTransfer.set(phone, { asset, amount, to, toLabel, hash });

      let balanceLine = '';
      try {
        const bal = await this.stellarWallets.getBalances(wallet);
        balanceLine =
          asset === 'xlm'
            ? `XLM left: ${formatSacAmount(bal.xlm)}`
            : `USDC left: ${formatSacAmount(bal.usdc)}`;
      } catch {
        /* ignore */
      }

      const user = await this.store.getUser(phone).catch(() => null);

      const replies: RampReply[] = [];
      let hasReceipt = false;
      try {
        const receiptPng = await renderTransferReceiptPng({
          brandName: this.onboarding.brandName(),
          amount,
          asset: label,
          toLabel,
          toAddress: to,
          fromAddress: wallet,
          txHash: hash,
          balanceLeft: balanceLine || null,
          username: user?.username,
        });
        replies.push({
          type: 'image',
          buffer: receiptPng,
          mimeType: 'image/png',
          filename: 'banjee-receipt.png',
          caption: [
            `✅ Sent ${amount} ${label} to ${toLabel}`,
            `Tx ${shortTxHash(hash)}`,
            balanceLine,
          ]
            .filter(Boolean)
            .join('\n'),
        });
        hasReceipt = true;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.logger.warn({ err: message }, '[zylo-ramp] receipt image failed');
      }

      // Avoid duplicate "✅ Sent…" text when the receipt caption already says it.
      if (!hasReceipt) {
        replies.push(
          asText(
            [`✅ Sent ${amount} ${label} to ${toLabel}`, `Tx ${shortTxHash(hash)}`, balanceLine]
              .filter(Boolean)
              .join('\n'),
          ),
        );
      }

      const greet = greetUser(user);
      this.postTransfer.set(phone, {
        step: 'purpose',
        amount,
        asset,
        to,
        toLabel,
      });
      replies.push({
        type: 'buttons',
        body: `Hey ${greet}, what was the purpose of your ${amount} ${label} transfer to ${toLabel}? This helps you track spending.`,
        footer: 'Optional',
        buttons: [
          { id: 'xfer_purpose_personal', title: 'Personal' },
          { id: 'xfer_purpose_bills', title: 'Bills / business' },
          { id: 'xfer_purpose_skip', title: 'Skip' },
        ],
      });

      // Recipient receipt (if they have a BANJEE WhatsApp account)
      void this.notifyRecipientTransfer({
        senderPhone: phone,
        senderUsername: user?.username,
        senderWhatsappName: user?.whatsappName,
        fromWallet: wallet,
        toWallet: to,
        toLabel,
        amount,
        asset,
        hash,
      });

      return replies;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error({ err: message, phone, to, amount, asset }, '[zylo-ramp] transfer failed');
      // Keep recipient + amount so they retry PIN without starting over
      this.pendingTransfer.set(phone, { ...pending, step: 'pin' });
      const hint = asText(
        [
          'Transfer failed — your recipient and amount are still saved.',
          message.includes('Insufficient')
            ? message
            : message.includes('Simulation') || message.includes('Contract #')
              ? message.replace(/^Simulation failed:\s*/i, '')
              : message.includes('not confirmed')
                ? 'Network was slow confirming the tx. Check your balance before retrying — a second PIN can send twice.'
                : 'Reply your 4-digit PIN to retry, or cancel.',
        ]
          .filter(Boolean)
          .join('\n'),
      );
      if (message.includes('not confirmed')) {
        this.clearTransfer(phone);
        return hint;
      }
      const pinAsk = this.transferPinPrompt(phone, { ...pending, step: 'pin' });
      return Array.isArray(pinAsk) ? [hint, ...pinAsk] : [hint, pinAsk];
    }
  }

  private viewLastTransfer(phone: string): RampReply {
    const last = this.lastTransfer.get(phone);
    if (!last) {
      return asText('No recent transfer details. Reply menu to continue.');
    }
    return asText(
      [
        'Transfer details',
        `Amount: ${last.amount} ${assetLabel(last.asset)}`,
        `To: ${last.toLabel}`,
        last.to,
        '',
        `Tx: ${last.hash}`,
        transferTxUrl(last.asset, last.hash),
      ].join('\n'),
    );
  }

  /**
   * Push receipt + credit note to the beneficiary if they are a BANJEE user.
   * Shared with the web portal (RampPortalActionsService).
   */
  async notifyRecipientTransfer(input: {
    senderPhone: string;
    senderUsername?: string | null;
    senderWhatsappName?: string | null;
    fromWallet: string;
    toWallet: string;
    toLabel: string;
    amount: number;
    asset: TransferAsset;
    hash: string;
    sentSymbol?: string;
  }): Promise<void> {
    try {
      if (!this.txNotifyDedupe.tryClaim(input.hash, input.toWallet)) return;

      const recipient =
        (input.asset === 'celo'
          ? await this.store.findUserByCeloWallet(input.toWallet).catch(() => null)
          : await this.store.findUserByZyloWallet(input.toWallet).catch(() => null)) || null;
      if (!recipient?.phone || recipient.phone === input.senderPhone) return;

      const label = input.sentSymbol || assetLabel(input.asset);
      const fromLabel = input.senderUsername
        ? `@${input.senderUsername}`
        : (input.senderWhatsappName || '').trim().split(/\s+/)[0] ||
          shortTransferAddr(input.fromWallet);
      const rate = getRampConfig().rates.sellNgn;
      const txLink = transferTxUrl(input.asset, input.hash);

      let balancePretty: string | null = null;
      try {
        if (input.asset === 'celo') {
          const bal = await this.celoWallets.getStableBalances(input.toWallet);
          balancePretty = formatCeloStable(bal.total);
        } else {
          const bal = await this.stellarWallets.getBalances(input.toWallet);
          balancePretty =
            input.asset === 'xlm' ? formatSacAmount(bal.xlm) : formatSacAmount(bal.usdc);
        }
      } catch {
        /* ignore */
      }

      const caption = buildIncomingCreditCaption({
        amount: input.amount,
        asset: label,
        balancePretty,
        sellRateNgn: rate,
        includeTxUrl: false,
      });
      const amountHero = isUsdcLikeAsset(label) ? formatUsdcWithNgn(input.amount, rate) : null;

      try {
        const receiptPng = await renderTransferReceiptPng({
          brandName: this.onboarding.brandName(),
          amount: input.amount,
          asset: label,
          amountHero,
          toLabel: recipient.username ? `@${recipient.username}` : input.toLabel,
          toAddress: input.toWallet,
          fromAddress: input.fromWallet,
          fromLabel,
          txHash: input.hash,
          direction: 'received',
        });
        await this.whatsapp.dispatchReplies(recipient.phone, {
          type: 'image',
          buffer: receiptPng,
          mimeType: 'image/png',
          filename: 'banjee-received.png',
          caption,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.logger.warn({ err: message }, '[zylo-ramp] recipient receipt image failed');
        const body = buildIncomingCreditCaption({
          amount: input.amount,
          asset: label,
          balancePretty,
          sellRateNgn: rate,
          includeTxUrl: true,
          txUrl: txLink,
        });
        await this.whatsapp.dispatchReplies(
          recipient.phone,
          this.onboarding.balanceActionButtons(body),
        );
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn({ err: message }, '[zylo-ramp] recipient notify failed');
    }
  }

  private async continueTransfer(
    phone: string,
    raw: string,
    lower: string,
    btn: string | null = null,
  ): Promise<RampReply | RampReply[] | null> {
    const pending = this.pendingTransfer.get(phone);
    if (!pending) return null;

    if (btn === 'xfer_cancel' || btn === 'menu_home' || lower === 'cancel' || lower === 'menu') {
      this.clearTransfer(phone);
      if (btn === 'menu_home' || lower === 'menu') return null;
      const user = await this.store.getUser(phone).catch(() => null);
      return [asText('Transfer cancelled.'), this.onboarding.mainMenuButtons(user)];
    }

    const label = assetLabel(pending.asset);

    if (pending.step === 'to') {
      if (btn) {
        return asText(
          pending.asset === 'celo'
            ? 'Reply with a username, saved contact, or Celo address (0x…):'
            : 'Reply with a username, saved contact, or Stellar address (G…):',
        );
      }
      const dest =
        pending.asset === 'celo'
          ? await this.resolveCeloTransferDestination(phone, raw)
          : await this.resolveTransferDestination(phone, raw);
      return this.presentTransferMatches(phone, pending, dest);
    }

    if (pending.step === 'pick_to') {
      if (btn?.startsWith('xfer_pick_')) {
        const idx = Number(btn.slice('xfer_pick_'.length));
        const c = pending.candidates?.[idx];
        if (!c) {
          return asText('That option expired. Send the recipient name or address again:');
        }
        const next = this.applyTransferCandidate(pending, c);
        this.pendingTransfer.set(phone, next);
        return [asText(this.foundRecipientBody(c)), this.recipientConfirmButtons()];
      }
      // Free-text retry while picking
      if (!btn && raw.trim()) {
        const dest =
          pending.asset === 'celo'
            ? await this.resolveCeloTransferDestination(phone, raw)
            : await this.resolveTransferDestination(phone, raw);
        return this.presentTransferMatches(phone, { ...pending, step: 'to' }, dest);
      }
      return this.pickRecipientList(pending.candidates || []);
    }

    if (pending.step === 'confirm_to') {
      const yes = btn === 'xfer_to_yes' || lower === 'yes' || lower === 'y' || lower === 'confirm';
      const no =
        btn === 'xfer_to_no' ||
        lower === 'no' ||
        lower === 'n' ||
        lower === 'no, retry' ||
        lower === 'retry';
      if (no) {
        this.pendingTransfer.set(phone, {
          asset: pending.asset,
          step: 'to',
        });
        return asText(
          pending.asset === 'celo'
            ? 'Okay — send a username, saved contact, or Celo address (0x…):'
            : 'Okay — send a username, saved contact, or Stellar address (G…):',
        );
      }
      if (!yes) {
        const c: TransferDestCandidate = {
          to: pending.to || '',
          toLabel: pending.toLabel || shortTransferAddr(pending.to || ''),
          displayName: pending.displayName,
          kind: pending.toKind || 'address',
          knownUser: Boolean(pending.toKind && pending.toKind !== 'address'),
        };
        return [asText(this.foundRecipientBody(c)), this.recipientConfirmButtons()];
      }
      if (!pending.to) {
        this.pendingTransfer.set(phone, { asset: pending.asset, step: 'to' });
        return asText('Recipient missing. Send a name or address again:');
      }
      // Quick-send already supplied amount → sell-style recap next.
      if (pending.amount && pending.amount > 0) {
        return this.transferConfirmPrompt(phone, pending);
      }
      this.pendingTransfer.set(phone, { ...pending, step: 'amount' });
      const balLine = await this.assetBalanceLine(phone, pending.asset);
      const who = this.recipientDisplayLine({
        to: pending.to,
        toLabel: pending.toLabel || shortTransferAddr(pending.to),
        displayName: pending.displayName,
        kind: pending.toKind || 'address',
        knownUser: true,
      });
      return asText(
        [`Sending to *${who}*.`, balLine, `How much ${label}? (e.g. 1 or 0.5)`]
          .filter(Boolean)
          .join('\n'),
      );
    }

    if (pending.step === 'amount') {
      if (btn) {
        const balLine = await this.assetBalanceLine(phone, pending.asset);
        return asText([`How much ${label}? (e.g. 1 or 0.5)`, balLine].filter(Boolean).join('\n'));
      }
      const amount = parseAmount(raw);
      if (!amount) {
        const balLine = await this.assetBalanceLine(phone, pending.asset);
        return asText(['Invalid amount. Example: 1', balLine].filter(Boolean).join('\n'));
      }
      const config = getRampConfig();
      const max = pending.asset === 'xlm' ? config.maxTransferXlm : config.maxOrderUsdc;
      if (amount > max) {
        return asText(`Max ${label} transfer right now: ${max}`);
      }
      return this.transferConfirmPrompt(phone, { ...pending, amount });
    }

    if (pending.step === 'confirm') {
      if (btn === 'xfer_confirm' || lower === 'confirm' || lower === 'yes') {
        return this.transferPinPrompt(phone, pending);
      }
      return this.transferConfirmPrompt(phone, pending);
    }

    if (pending.step === 'pin') {
      const pin = raw.trim();
      if (!/^\d{4}$/.test(pin)) {
        return asText('PIN must be exactly 4 digits. Try again, or cancel:');
      }
      const ok = await this.onboarding.verifyUserPin(phone, pin);
      if (!ok) {
        return asText('Wrong PIN. Try again, or cancel:');
      }
      return this.executePendingTransfer(phone);
    }

    return null;
  }

  /**
   * Natural-language send:
   * - "send 0.02 xlm to ljtwp"
   * - "i want to send 0.02 xlm to ljtwp"
   * - "please transfer 1 usdc to @aji"
   * - "send 1 celo to @aji"
   * - "send usdc to aji" (asks amount next)
   */
  private async tryQuickSend(phone: string, raw: string): Promise<RampReply | RampReply[] | null> {
    const text = raw.trim();

    // Optional fluff: "i want to", "please", "can you", "i'd like to", …
    const preamble =
      '(?:(?:i\\s+(?:want\\s+to|wanna|would\\s+like\\s+to)|please|can\\s+you|could\\s+you)\\s+)?';

    const withAmt = text.match(
      new RegExp(
        `^${preamble}(?:send|transfer|pay)\\s+(\\d+(?:\\.\\d+)?)\\s*(usdc|xlm|celo)\\s+to\\s+(.+?)$`,
        'i',
      ),
    );
    // "send xlm 0.02 to ljtwp"
    const withAmtAssetFirst = text.match(
      new RegExp(
        `^${preamble}(?:send|transfer|pay)\\s+(usdc|xlm|celo)\\s+(\\d+(?:\\.\\d+)?)\\s+to\\s+(.+?)$`,
        'i',
      ),
    );
    const noAmt = text.match(
      new RegExp(`^${preamble}(?:send|transfer|pay)\\s+(usdc|xlm|celo)\\s+to\\s+(.+?)$`, 'i'),
    );

    let asset: TransferAsset;
    let amount: number | null = null;
    let destRaw: string;

    const parseAsset = (rawAsset: string): TransferAsset => {
      const a = rawAsset.toLowerCase();
      if (a === 'xlm') return 'xlm';
      if (a === 'celo') return 'celo';
      return 'usdc';
    };

    if (withAmt?.[1] && withAmt[2] && withAmt[3]) {
      amount = parseAmount(withAmt[1]);
      asset = parseAsset(withAmt[2]);
      destRaw = withAmt[3].trim();
      if (!amount) {
        return asText('Invalid amount. Example: i want to send 0.02 xlm to ljtwp');
      }
    } else if (withAmtAssetFirst?.[1] && withAmtAssetFirst[2] && withAmtAssetFirst[3]) {
      asset = parseAsset(withAmtAssetFirst[1]);
      amount = parseAmount(withAmtAssetFirst[2]);
      destRaw = withAmtAssetFirst[3].trim();
      if (!amount) {
        return asText('Invalid amount. Example: send xlm 0.02 to ljtwp');
      }
    } else if (noAmt?.[1] && noAmt[2]) {
      asset = parseAsset(noAmt[1]);
      destRaw = noAmt[2].trim();
    } else {
      return null;
    }

    if (asset === 'celo' && !this.celoWallets.isConfigured()) {
      return asText('Celo transfers are not available right now.');
    }

    // Strip trailing punctuation / "please"
    destRaw = destRaw
      .replace(/[.,!?]+$/g, '')
      .replace(/\s+please$/i, '')
      .trim();

    const dest =
      asset === 'celo'
        ? await this.resolveCeloTransferDestination(phone, destRaw)
        : await this.resolveTransferDestination(phone, destRaw);

    const base: PendingTransfer = {
      step: 'to',
      asset,
      ...(amount != null ? { amount } : {}),
    };

    // Always confirm recipient first (and amount→recap→PIN after Yes).
    const presented = this.presentTransferMatches(phone, base, dest);
    if (amount == null) return presented;

    const config = getRampConfig();
    const label = assetLabel(asset);
    const max = asset === 'xlm' ? config.maxTransferXlm : config.maxOrderUsdc;
    if (amount > max) {
      this.clearTransfer(phone);
      return asText(`Max ${label} transfer right now: ${max}`);
    }

    // Keep amount on pending after presentTransferMatches mutated the map.
    const cur = this.pendingTransfer.get(phone);
    if (cur) {
      this.pendingTransfer.set(phone, { ...cur, amount });
    }
    return presented;
  }

  private async sellNetworkBalances(phone: string): Promise<{ stellar: number; celo: number }> {
    let stellar = 0;
    let celo = 0;
    try {
      const wallet = await this.ensureZyloWallet(phone);
      if (wallet) {
        const bal = await this.stellarWallets.getBalances(wallet);
        stellar = Number(formatSacAmount(bal.usdc));
      }
    } catch {
      /* ignore */
    }
    try {
      const user = await this.store.getUser(phone).catch(() => null);
      if (user?.celoWallet && /^0x[a-fA-F0-9]{40}$/.test(user.celoWallet)) {
        const bal = await this.celoWallets.getStableBalances(user.celoWallet);
        celo = bal.total;
      }
    } catch {
      /* ignore */
    }
    return { stellar, celo };
  }

  private async startSellFlow(phone: string): Promise<RampReply | RampReply[]> {
    this.clearAllFlows(phone);
    const bals = await this.sellNetworkBalances(phone);
    const stellarOk = bals.stellar > 1e-6;
    const celoOk = this.celoWallets.isConfigured() && bals.celo > 1e-6;

    if (!stellarOk && !celoOk) {
      return asText(
        'You don’t have USDC to sell yet. Tap Check balance → Fund wallet, then try Sell USDC again.',
      );
    }

    if (stellarOk && celoOk) {
      this.pendingSell.set(phone, { step: 'network' });
      return {
        type: 'buttons',
        body: [
          'Sell USDC — which network?',
          `Stellar: *${bals.stellar.toFixed(2)}* USDC`,
          `Celo: *${bals.celo.toFixed(2)}*`,
        ].join('\n'),
        buttons: [
          { id: 'sell_net_stellar', title: 'Stellar' },
          { id: 'sell_net_celo', title: 'Celo' },
          { id: 'menu_home', title: 'Main menu' },
        ],
      };
    }

    const chain: SpendChain = stellarOk ? 'stellar' : 'celo';
    const available = stellarOk ? bals.stellar : bals.celo;
    return this.sellAskAmount(phone, chain, available);
  }

  private sellAskAmount(phone: string, chain: SpendChain, availableBalance: number): RampReply {
    this.pendingSell.set(phone, {
      step: 'amount',
      chain,
      availableBalance,
    });
    const label = chainLabel(chain);
    const pretty = availableBalance.toFixed(2);
    return {
      type: 'buttons',
      body: [
        `How much USDC would you like to sell?`,
        `You have *${pretty} USDC* available on ${label}.`,
        'Type an amount, or tap Sell all.',
      ].join('\n'),
      buttons: [
        { id: 'sell_all', title: 'Sell all' },
        { id: 'menu_home', title: 'Main menu' },
      ],
    };
  }

  private buildSellQuote(pending: PendingSell): PendingSell {
    const config = getRampConfig();
    const amount = pending.amountUsdc || 0;
    const rate = config.rates.sellNgn;
    const feeNgn = config.sellFeeNgn;
    const ngnGross = Math.round(amount * rate);
    const ngnPayout = Math.max(0, ngnGross - feeNgn);
    return {
      ...pending,
      step: 'quote',
      rate,
      feeNgn,
      ngnGross,
      ngnPayout,
      quoteExpiresAt: Date.now() + config.rateQuoteSeconds * 1000,
    };
  }

  private async sellQuoteMessage(phone: string, pending: PendingSell): Promise<RampReply> {
    const config = getRampConfig();
    const amount = pending.amountUsdc || 0;
    const rate = pending.rate || config.rates.sellNgn;
    const fee = pending.feeNgn ?? config.sellFeeNgn;
    const gross = pending.ngnGross ?? Math.round(amount * rate);
    const payout = pending.ngnPayout ?? Math.max(0, gross - fee);
    const lockSec = Math.max(
      1,
      Math.round(((pending.quoteExpiresAt || Date.now()) - Date.now()) / 1000),
    );
    const lockLabel = lockSec >= 60 ? `${Math.round(lockSec / 60)} min` : `${lockSec} seconds`;
    const when = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

    await this.ensureLegacyPayoutMigrated(phone);
    const def = await this.store.getDefaultPayoutAccount(phone);
    const payoutLine = def
      ? `To: *${def.bankName}* ${maskBankAccount(def.accountNumber)} (${def.accountName})`
      : 'Next: save a payout account (asked once).';

    return {
      type: 'buttons',
      body: [
        `Sell *${amount} USDC* (${chainLabel(pending.chain || 'stellar')})`,
        `Rate: ₦${rate.toLocaleString('en-NG')} / USDC · BANJEE · ${when}`,
        `Gross: ₦${gross.toLocaleString('en-NG')}`,
        `Fee: ₦${fee.toLocaleString('en-NG')}`,
        `You receive: *₦${payout.toLocaleString('en-NG')}*`,
        payoutLine,
        '',
        `This rate is locked for ${lockLabel}.`,
      ].join('\n'),
      footer: def ? 'PIN required to sell' : 'Confirm before it expires',
      buttons: def
        ? [
            { id: 'sell_quote_confirm', title: 'Sell now' },
            { id: 'sell_bank_change', title: 'Change bank' },
            { id: 'sell_cancel', title: 'Cancel' },
          ]
        : [
            { id: 'sell_quote_confirm', title: 'Confirm' },
            { id: 'sell_cancel', title: 'Cancel' },
          ],
    };
  }

  /** Ask for 4-digit PIN (or Flow popup) before debiting USDC / FalconPay. */
  private sellPinPrompt(
    phone: string,
    pending: PendingSell,
    def: RampPayoutAccount,
  ): RampReply | RampReply[] {
    const config = getRampConfig();
    const amount = pending.amountUsdc || 0;
    const fee = pending.feeNgn ?? config.sellFeeNgn;
    const payout =
      pending.ngnPayout ?? Math.max(0, Math.round(amount * config.rates.sellNgn) - fee);
    const chain = pending.chain || 'stellar';
    const next: PendingSell = { ...pending, step: 'pin' };
    this.pendingSell.set(phone, next);

    const body = [
      'Confirm sale',
      `Sell *${amount} USDC* (${chainLabel(chain)})`,
      `You receive: *₦${payout.toLocaleString('en-NG')}*`,
      `To: ${def.bankName} ${def.accountNumber}`,
      `(${def.accountName})`,
      '',
      'Enter your 4-digit PIN to sell.',
    ].join('\n');

    if (pinFlowEnabled() && usableWhatsAppFlowId(config.whatsapp.pinFlowId)) {
      const recap = `${amount} USDC → ₦${payout.toLocaleString('en-NG')} · ${def.accountName}`;
      return {
        type: 'flow',
        body: `${['Confirm sale', recap, `${def.bankName} · ${def.accountNumber}`].join(
          '\n',
        )}\n\nTap *Enter PIN* — popup (PIN stays out of chat).`,
        footer: 'PIN confirms sale',
        flowId: usableWhatsAppFlowId(config.whatsapp.pinFlowId),
        flowToken: `sellpin:${phone}:${Date.now()}`,
        cta: 'Enter PIN',
        screen: 'PIN',
        data: { recap },
      };
    }

    return [
      asText(body),
      {
        type: 'buttons',
        body: 'Or cancel',
        buttons: [
          { id: 'sell_cancel', title: 'Cancel' },
          { id: 'menu_home', title: 'Main menu' },
        ],
      },
    ];
  }

  private async sellBankConfirmPrompt(phone: string, pending: PendingSell): Promise<RampReply> {
    await this.ensureLegacyPayoutMigrated(phone);
    const def = await this.store.getDefaultPayoutAccount(phone);

    if (!def) {
      this.pendingSell.set(phone, { ...pending, step: 'bank_collect' });
      return asText(
        [
          'Add your NGN payout account before selling.',
          'Send: bank <bank> <10-digit account> <account name>',
          'e.g. bank Opay 0123456789 Jane Doe',
          '(The word “bank” is optional.)',
        ].join('\n'),
      );
    }

    this.pendingSell.set(phone, { ...pending, step: 'bank' });
    return {
      type: 'buttons',
      body: [
        `Payout to: *${def.bankName}* ${def.accountNumber}`,
        `(${def.accountName})`,
        '',
        `Tap *Use this* to sell now — ₦${(pending.ngnPayout || 0).toLocaleString('en-NG')} goes to this account.`,
      ].join('\n'),
      buttons: [
        { id: 'sell_bank_use', title: 'Use this' },
        { id: 'sell_bank_change', title: 'Use different' },
        { id: 'sell_cancel', title: 'Cancel' },
      ],
    };
  }

  /** One-time: copy ZyRampUser.bank* into payout_accounts if none exist. */
  private async ensureLegacyPayoutMigrated(phone: string): Promise<void> {
    const existing = await this.store.listPayoutAccounts(phone);
    if (existing.length > 0) return;
    const user = await this.store.getUser(phone).catch(() => null);
    if (!user?.bankAccount || !user?.bankName || !user?.accountName) return;
    const acct = user.bankAccount.replace(/\D/g, '');
    if (!/^\d{10}$/.test(acct)) return;
    try {
      const banks = await this.naira.listBanks();
      const matches = this.naira.filterBanks(banks, user.bankName);
      const bank = matches[0];
      if (!bank) return;
      await this.store.upsertPayoutAccount({
        phone,
        bankName: bank.name,
        bankCode: bank.code,
        accountNumber: acct,
        accountName: user.accountName,
        makeDefault: true,
      });
    } catch (e) {
      this.logger.warn(
        { err: e instanceof Error ? e.message : String(e), phone },
        '[zylo-ramp] legacy payout migrate skipped',
      );
    }
  }

  /**
   * Parse + name-enquiry a free-text bank line for sell or settings.
   */
  private async collectAndVerifyPayoutDetails(
    phone: string,
    raw: string,
    ctx: 'sell' | 'settings',
  ): Promise<RampReply | RampReply[]> {
    const parsed = parseBankDetailsInput(raw);
    if (!parsed.ok) {
      return asText(parsed.error);
    }

    let banks;
    try {
      banks = await this.naira.listBanks();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn({ err: message }, '[zylo-ramp] listBanks failed during payout collect');
      return asText('Could not load banks right now. Try again shortly.');
    }

    const matches = this.naira.filterBanks(banks, parsed.value.bankQuery);
    if (matches.length === 0) {
      return asText(
        `No bank matched “${parsed.value.bankQuery}”. Check the spelling and resend:\nbank <bank> <10-digit account> <account name>`,
      );
    }
    if (matches.length > 1) {
      if (ctx === 'sell') {
        const pending = this.pendingSell.get(phone);
        if (pending) {
          this.pendingSell.set(phone, {
            ...pending,
            step: 'bank_collect',
            stagedPayout: {
              bankName: parsed.value.bankQuery,
              bankCode: '',
              accountNumber: parsed.value.accountNumber,
              accountName: parsed.value.accountNameHint,
            },
          });
        }
      } else {
        this.pendingPayoutSettings.set(phone, {
          step: 'collect',
          pendingAccountNumber: parsed.value.accountNumber,
          pendingNameHint: parsed.value.accountNameHint,
        });
      }
      return [
        asText(
          `Found ${matches.length} banks for “${parsed.value.bankQuery}”. Pick one — we’ll verify ${parsed.value.accountNumber}:`,
        ),
        this.bankMatchesList(matches),
      ];
    }

    const bank = matches[0]!;
    return this.verifyStagedPayout(phone, ctx, {
      bankName: bank.name,
      bankCode: bank.code,
      accountNumber: parsed.value.accountNumber,
      accountNameHint: parsed.value.accountNameHint,
    });
  }

  private async verifyStagedPayout(
    phone: string,
    ctx: 'sell' | 'settings',
    input: {
      bankName: string;
      bankCode: string;
      accountNumber: string;
      accountNameHint: string;
    },
  ): Promise<RampReply | RampReply[]> {
    try {
      const resolved = await this.naira.resolveAccount(input.accountNumber, input.bankCode);
      const staged = {
        bankName: input.bankName,
        bankCode: input.bankCode,
        accountNumber: resolved.accountNumber,
        accountName: resolved.accountName,
      };

      if (ctx === 'sell') {
        const pending = this.pendingSell.get(phone);
        if (!pending) {
          return asText('Sale session expired. Tap Sell USDC to start again.');
        }
        this.pendingSell.set(phone, {
          ...pending,
          step: 'bank_verify',
          stagedPayout: staged,
        });
      } else {
        this.pendingPayoutSettings.set(phone, { step: 'verify', staged });
      }

      return {
        type: 'buttons',
        body: [
          `Verified: *${staged.accountName}*`,
          `${staged.bankName} ${staged.accountNumber}`,
          '',
          'Save this as your payout account?',
        ].join('\n'),
        buttons: [
          { id: ctx === 'sell' ? 'sell_payout_save' : 'payout_save', title: 'Confirm' },
          { id: ctx === 'sell' ? 'sell_payout_discard' : 'payout_cancel', title: 'Cancel' },
        ],
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn({ err: message, phone }, '[zylo-ramp] payout name enquiry failed');
      return asText(
        `Couldn’t verify that account (${message}). Check bank + 10-digit number and resend:\nbank <bank> <account_number> <account_name>`,
      );
    }
  }

  private async saveStagedPayout(
    phone: string,
    staged: {
      bankName: string;
      bankCode: string;
      accountNumber: string;
      accountName: string;
    },
    makeDefault: boolean,
  ): Promise<RampPayoutAccount> {
    const existing = await this.store.listPayoutAccounts(phone);
    const forceDefault = makeDefault || existing.length === 0;
    return this.store.upsertPayoutAccount({
      phone,
      bankName: staged.bankName,
      bankCode: staged.bankCode,
      accountNumber: staged.accountNumber,
      accountName: staged.accountName,
      makeDefault: forceDefault,
    });
  }

  private async continueSell(
    phone: string,
    raw: string,
    lower: string,
    btn: string | null,
  ): Promise<RampReply | RampReply[] | null> {
    const pending = this.pendingSell.get(phone);
    if (!pending) return null;

    if (btn === 'sell_cancel' || btn === 'menu_home' || lower === 'cancel' || lower === 'menu') {
      this.clearSell(phone);
      if (btn === 'menu_home' || lower === 'menu') return null;
      const user = await this.store.getUser(phone).catch(() => null);
      return [asText('Sale cancelled.'), this.onboarding.mainMenuButtons(user)];
    }

    if (pending.step === 'network' || btn === 'sell_net_stellar' || btn === 'sell_net_celo') {
      const bals = await this.sellNetworkBalances(phone);
      let chain: SpendChain | null = pending.chain || null;
      if (btn === 'sell_net_stellar') chain = 'stellar';
      if (btn === 'sell_net_celo') chain = 'celo';
      if (!chain) {
        return asText('Pick Stellar or Celo.');
      }
      const available = chain === 'stellar' ? bals.stellar : bals.celo;
      if (available <= 1e-6) {
        return asText(`No USDC on ${chainLabel(chain)}. Fund that network, or pick the other one.`);
      }
      // Free-text “sell 5 usdc” already supplied amount — jump to quote.
      if (pending.amountUsdc && pending.amountUsdc > 0) {
        if (pending.amountUsdc > available + 1e-9) {
          return asText(
            `You only have ${available.toFixed(2)} USDC on ${chainLabel(chain)}. Try a smaller amount.`,
          );
        }
        const quoted = this.buildSellQuote({
          ...pending,
          chain,
          availableBalance: available,
          amountUsdc: pending.amountUsdc,
        });
        this.pendingSell.set(phone, quoted);
        return this.sellQuoteMessage(phone, quoted);
      }
      return this.sellAskAmount(phone, chain, available);
    }

    if (pending.step === 'amount') {
      let amount: number | null = null;
      if (btn === 'sell_all') {
        amount = pending.availableBalance || 0;
      } else {
        amount = parseAmount(raw);
      }
      if (!amount || amount <= 0) {
        return asText('Enter a valid USDC amount, or tap Sell all.');
      }
      const config = getRampConfig();
      const available = pending.availableBalance || 0;
      if (amount > available + 1e-9) {
        return asText(
          `You only have ${available.toFixed(2)} USDC on ${chainLabel(pending.chain || 'stellar')}.`,
        );
      }
      if (amount > config.maxOrderUsdc) {
        return asText(`Max sell right now is ${config.maxOrderUsdc} USDC.`);
      }
      const quoted = this.buildSellQuote({
        ...pending,
        amountUsdc: amount,
      });
      this.pendingSell.set(phone, quoted);
      return this.sellQuoteMessage(phone, quoted);
    }

    if (pending.step === 'quote') {
      if (btn === 'sell_bank_change') {
        this.pendingSell.set(phone, {
          ...pending,
          step: 'bank_collect',
          stagedPayout: undefined,
        });
        return asText(
          [
            'Send new payout details:',
            'bank <bank> <10-digit account> <account name>',
            'e.g. bank Opay 0123456789 Jane Doe',
          ].join('\n'),
        );
      }
      if (btn !== 'sell_quote_confirm' && lower !== 'confirm' && lower !== 'sell now') {
        return this.sellQuoteMessage(phone, pending);
      }
      const now = Date.now();
      if (!pending.quoteExpiresAt || now > pending.quoteExpiresAt) {
        const refreshed = this.buildSellQuote(pending);
        this.pendingSell.set(phone, refreshed);
        return [
          asText('That rate expired. Here’s an updated quote — confirm again to continue.'),
          await this.sellQuoteMessage(phone, refreshed),
        ];
      }
      await this.ensureLegacyPayoutMigrated(phone);
      const def = await this.store.getDefaultPayoutAccount(phone);
      if (def?.bankCode) {
        // Saved account — ask PIN, then debit (no second “Use this” ask).
        return this.sellPinPrompt(phone, pending, def);
      }
      return this.sellBankConfirmPrompt(phone, pending);
    }

    if (pending.step === 'pin') {
      const pin = raw.trim();
      if (!/^\d{4}$/.test(pin)) {
        const def = await this.store.getDefaultPayoutAccount(phone);
        if (!def?.bankCode) {
          this.pendingSell.set(phone, { ...pending, step: 'bank_collect' });
          return asText(
            'No verified payout account on file. Send:\nbank <bank> <10-digit account> <account name>',
          );
        }
        const hint = asText('PIN must be exactly 4 digits. Try again, or cancel.');
        const pinAsk = this.sellPinPrompt(phone, pending, def);
        return Array.isArray(pinAsk) ? [hint, ...pinAsk] : [hint, pinAsk];
      }
      const ok = await this.onboarding.verifyUserPin(phone, pin);
      if (!ok) {
        return asText('Wrong PIN. Try again, or cancel.');
      }
      if (!pending.quoteExpiresAt || Date.now() > pending.quoteExpiresAt) {
        const refreshed = this.buildSellQuote(pending);
        this.pendingSell.set(phone, refreshed);
        return [
          asText('That rate expired. Here’s an updated quote — confirm again to continue.'),
          await this.sellQuoteMessage(phone, refreshed),
        ];
      }
      const def = await this.store.getDefaultPayoutAccount(phone);
      if (!def?.bankCode) {
        this.pendingSell.set(phone, { ...pending, step: 'bank_collect' });
        return asText(
          'No verified payout account on file. Send:\nbank <bank> <10-digit account> <account name>',
        );
      }
      return this.executeSellToPayout(phone, pending, def);
    }

    if (
      pending.step === 'bank' ||
      pending.step === 'bank_collect' ||
      pending.step === 'bank_verify' ||
      pending.step === 'bank_set_default'
    ) {
      if (btn === 'sell_bank_change') {
        this.pendingSell.set(phone, {
          ...pending,
          step: 'bank_collect',
          stagedPayout: undefined,
        });
        return asText(
          [
            'Send new payout details:',
            'bank <bank> <10-digit account> <account name>',
            'e.g. bank Opay 0123456789 Jane Doe',
          ].join('\n'),
        );
      }

      if (btn === 'sell_payout_discard') {
        this.pendingSell.set(phone, {
          ...pending,
          step: 'bank_collect',
          stagedPayout: undefined,
        });
        return asText(
          'Not saved. Resend payout details:\nbank <bank> <10-digit account> <account name>',
        );
      }

      if (btn === 'sell_payout_save' && pending.stagedPayout) {
        const existing = await this.store.listPayoutAccounts(phone);
        const saved = await this.saveStagedPayout(
          phone,
          pending.stagedPayout,
          existing.length === 0,
        );
        if (existing.length > 0 && !saved.isDefault) {
          this.pendingSell.set(phone, {
            ...pending,
            step: 'bank_set_default',
            pendingDefaultId: saved.id,
            stagedPayout: undefined,
          });
          return {
            type: 'buttons',
            body: `Saved ${saved.bankName} ${saved.accountNumber}. Set as new default?`,
            buttons: [
              { id: 'sell_default_yes', title: 'Yes' },
              { id: 'sell_default_no', title: 'No' },
            ],
          };
        }
        return this.sellBankConfirmPrompt(phone, {
          ...pending,
          step: 'bank',
          stagedPayout: undefined,
        });
      }

      if (pending.step === 'bank_set_default') {
        if (btn === 'sell_default_yes' && pending.pendingDefaultId) {
          await this.store.setDefaultPayoutAccount(phone, pending.pendingDefaultId);
        }
        return this.sellBankConfirmPrompt(phone, {
          ...pending,
          step: 'bank',
          pendingDefaultId: undefined,
        });
      }

      if (pending.step === 'bank_collect') {
        if (btn?.startsWith('bank_pick_') && pending.stagedPayout?.accountNumber) {
          const code = btn.slice('bank_pick_'.length);
          try {
            const banks = await this.naira.listBanks();
            const bank = banks.find((b) => b.code === code);
            if (!bank) {
              return asText('Bank not found. Resend your details or pick again.');
            }
            return this.verifyStagedPayout(phone, 'sell', {
              bankName: bank.name,
              bankCode: bank.code,
              accountNumber: pending.stagedPayout.accountNumber,
              accountNameHint: pending.stagedPayout.accountName,
            });
          } catch (e) {
            return asText(
              `Couldn’t load that bank (${e instanceof Error ? e.message : String(e)}). Try again.`,
            );
          }
        }
        if (btn) {
          return asText(
            'Send payout details as text:\nbank <bank> <10-digit account> <account name>',
          );
        }
        return this.collectAndVerifyPayoutDetails(phone, raw, 'sell');
      }

      if (pending.step === 'bank_verify') {
        return asText('Tap Confirm to save the verified account, or Cancel.');
      }

      // step === 'bank' — use default / confirm sell → debit USDC + FalconPay
      const confirmSell =
        btn === 'sell_bank_confirm' ||
        btn === 'sell_bank_use' ||
        lower === 'confirm' ||
        lower === 'use this';
      if (!confirmSell) {
        // User typed something while we expected Use this — try parse as new account
        if (!btn && raw.trim()) {
          this.pendingSell.set(phone, { ...pending, step: 'bank_collect' });
          return this.collectAndVerifyPayoutDetails(phone, raw, 'sell');
        }
        return this.sellBankConfirmPrompt(phone, pending);
      }
      if (!pending.quoteExpiresAt || Date.now() > pending.quoteExpiresAt) {
        const refreshed = this.buildSellQuote(pending);
        this.pendingSell.set(phone, refreshed);
        return [
          asText('That rate expired before bank confirm. Review the new quote:'),
          await this.sellQuoteMessage(phone, refreshed),
        ];
      }

      const def = await this.store.getDefaultPayoutAccount(phone);
      if (!def?.bankCode) {
        this.pendingSell.set(phone, { ...pending, step: 'bank_collect' });
        return asText(
          'No verified payout account on file. Send:\nbank <bank> <10-digit account> <account name>',
        );
      }

      return this.sellPinPrompt(phone, pending, def);
    }

    return null;
  }

  /** Debit USDC + FalconPay to a saved/verified payout account; PNG receipt. */
  private async executeSellToPayout(
    phone: string,
    pending: PendingSell,
    def: RampPayoutAccount,
  ): Promise<RampReply | RampReply[]> {
    await this.store.upsertUser(phone, {
      bankName: def.bankName,
      bankAccount: def.accountNumber,
      accountName: def.accountName,
    });

    const config = getRampConfig();
    const amount = pending.amountUsdc || 0;
    const chain = pending.chain || 'stellar';
    const fee = pending.feeNgn ?? config.sellFeeNgn;
    const payout =
      pending.ngnPayout ?? Math.max(0, Math.round(amount * config.rates.sellNgn) - fee);

    if (amount <= 0 || payout < config.minBankSendNgn) {
      return asText(
        `Payout too small (min ₦${config.minBankSendNgn.toLocaleString('en-NG')}). Sell a larger amount.`,
      );
    }

    const wallet = await this.ensureZyloWallet(phone);
    if (!wallet) {
      return asText('Your Stellar wallet is not ready yet. Finish onboarding or message support.');
    }
    if (chain === 'celo') {
      const celo = await this.ensureCeloWallet(phone);
      if (!celo) {
        return asText('Your Celo wallet is not ready yet.');
      }
    }

    try {
      const open = await this.store.findOpenOrderForPhone(phone);
      if (open?.type === 'sell' && open.status === 'awaiting_crypto') {
        await this.store.updateOrder(open.ref, { status: 'cancelled' });
      }
    } catch {
      /* ignore */
    }

    this.clearSell(phone);

    let payoutBankCode = def.bankCode;
    let payoutBankName = def.bankName;
    try {
      const resolved = await this.naira.resolveSupportedBank(def.bankCode, def.bankName);
      payoutBankCode = resolved.code;
      payoutBankName = resolved.name;
      if (resolved.code !== def.bankCode || resolved.name !== def.bankName) {
        await this.store.upsertPayoutAccount({
          phone,
          bankCode: resolved.code,
          bankName: resolved.name,
          accountNumber: def.accountNumber,
          accountName: def.accountName,
          makeDefault: true,
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const user = await this.store.getUser(phone).catch(() => null);
      return [asText(['Sale failed.', message].join('\n')), this.onboarding.mainMenuButtons(user)];
    }

    try {
      const result = await this.naira.executeBankSend({
        phone,
        zyloWallet: wallet,
        amountNgn: payout,
        amountUsdc: amount,
        rate: pending.rate || config.rates.sellNgn,
        bankCode: payoutBankCode,
        bankName: payoutBankName,
        accountNumber: def.accountNumber,
        accountName: def.accountName,
        chain,
      });

      const user = await this.store.getUser(phone).catch(() => null);

      if (result.completed) {
        if (result.receiptPng) {
          return [
            {
              type: 'image',
              buffer: result.receiptPng,
              mimeType: 'image/png',
              filename: 'banjee-sale-receipt.png',
              caption: result.message,
            },
            this.onboarding.mainMenuButtons(user),
          ];
        }
        return [this.onboarding.mainMenuButtons(user)];
      }

      return [asText(result.message), this.onboarding.mainMenuButtons(user)];
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error({ err: message, phone, amount, chain }, '[zylo-ramp] sell execute failed');
      const user = await this.store.getUser(phone).catch(() => null);
      return [
        asText(
          [
            'Sale failed.',
            message,
            '',
            'Funds were not moved unless a tx is shown above. Tap Sell USDC to retry, or message support.',
          ].join('\n'),
        ),
        this.onboarding.mainMenuButtons(user),
      ];
    }
  }

  private settingsMenu(): RampReply {
    return {
      type: 'list',
      header: this.onboarding.brandName(),
      body: 'Settings',
      footer: 'PIN · KYC · Payout',
      button: 'Open',
      sections: [
        {
          title: 'Security & identity',
          rows: [
            {
              id: 'settings_change_pin',
              title: 'Change PIN',
              description: 'Update your 4-digit PIN',
            },
            {
              id: 'settings_kyc',
              title: 'KYC',
              description: 'Verify identity (BVN)',
            },
          ],
        },
        {
          title: 'Payout',
          rows: [
            {
              id: 'settings_payouts',
              title: 'Payout accounts',
              description: 'View, change default, remove',
            },
            {
              id: 'settings_payout_add',
              title: 'Add payout account',
              description: 'Verify a new NUBAN',
            },
          ],
        },
      ],
    };
  }

  private startChangePin(phone: string): RampReply {
    this.clearAllFlows(phone);
    this.pendingPinChange.set(phone, { mode: 'change', step: 'current' });
    return asText(
      [
        'Change PIN',
        '',
        'Enter your *current* 4-digit PIN to continue.',
        'Or reply *cancel*.',
      ].join('\n'),
    );
  }

  /** WhatsApp-first forgot PIN — chat identity proves ownership (no current PIN). */
  private startForgotPin(phone: string): RampReply {
    this.clearAllFlows(phone);
    this.pendingPinChange.set(phone, { mode: 'forgot', step: 'new' });
    return asText(
      [
        'Reset PIN',
        '',
        'You’re messaging from this WhatsApp number, so we can reset without the old PIN.',
        'Enter a *new* 4-digit PIN for WhatsApp *and* the web portal.',
        'Or reply *cancel*.',
      ].join('\n'),
    );
  }

  /** Keep web portal User.pinHash in sync when PIN is set from WhatsApp. */
  private async syncPlatformPin(phone: string, newPin: string): Promise<void> {
    const phoneE164 = Phone.fromWhatsAppId(phone) || Phone.normalize(phone) || undefined;
    if (!phoneE164) return;

    const tenantId = getRampConfig().tenantId;
    if (!tenantId) return;

    try {
      const pinHash = await this.hashing.hash(newPin);
      await RequestContext.runAsSystem({}, async () => {
        const result = await this.prisma.user.updateMany({
          where: {
            tenantId,
            phoneE164,
            type: UserType.CUSTOMER,
            deletedAt: null,
          },
          data: {
            pinHash,
            pinSetAt: new Date(),
            pinResetRequired: false,
            failedPinAttempts: 0,
            lockedUntil: null,
          },
        });
        if (result.count > 0) {
          await this.prisma.session.updateMany({
            where: {
              user: { phoneE164, tenantId, type: UserType.CUSTOMER },
              revokedAt: null,
            },
            data: { revokedAt: new Date(), revokedReason: 'pin_reset_whatsapp' },
          });
          this.logger.info(
            { phone: Phone.mask(phoneE164), count: result.count },
            '[zylo-ramp] synced platform User PIN from WhatsApp reset',
          );
        }
      });
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '[zylo-ramp] platform PIN sync failed (ramp PIN still updated)',
      );
    }
  }

  private async continueChangePin(
    phone: string,
    raw: string,
    lower: string,
    btn: string | null,
  ): Promise<RampReply | RampReply[] | null> {
    const pending = this.pendingPinChange.get(phone);
    if (!pending) return null;

    if (btn === 'menu_home' || lower === 'cancel' || lower === 'menu') {
      this.clearPinChange(phone);
      if (btn === 'menu_home' || lower === 'menu') return null;
      return [
        asText(pending.mode === 'forgot' ? 'PIN reset cancelled.' : 'PIN change cancelled.'),
        this.settingsMenu(),
      ];
    }

    const pin = raw.trim();

    if (pending.step === 'current') {
      if (!/^\d{4}$/.test(pin)) {
        return asText('PIN must be exactly 4 digits. Enter your current PIN, or cancel.');
      }
      const ok = await this.onboarding.verifyUserPin(phone, pin);
      if (!ok) {
        return asText('Wrong PIN. Try again, or cancel.');
      }
      this.pendingPinChange.set(phone, { mode: pending.mode, step: 'new' });
      return asText('Enter your *new* 4-digit PIN:');
    }

    if (pending.step === 'new') {
      if (!/^\d{4}$/.test(pin)) {
        return asText('New PIN must be exactly 4 digits. Try again, or cancel.');
      }
      this.pendingPinChange.set(phone, {
        mode: pending.mode,
        step: 'confirm',
        newPin: pin,
      });
      return asText('Type the same new PIN once more to confirm:');
    }

    if (pending.step === 'confirm') {
      if (!/^\d{4}$/.test(pin)) {
        return asText('PIN must be exactly 4 digits. Confirm again, or cancel.');
      }
      if (pin !== pending.newPin) {
        this.pendingPinChange.set(phone, { mode: pending.mode, step: 'new' });
        return asText("Those didn't match. Enter your *new* 4-digit PIN again:");
      }
      const saved = await this.onboarding.setUserPin(phone, pin);
      this.clearPinChange(phone);
      if (!saved) {
        return [asText('Could not save PIN. Try again from Settings.'), this.settingsMenu()];
      }
      await this.syncPlatformPin(phone, pin);
      const portal = getRampConfig().webPortalUrl;
      return [
        asText(
          [
            pending.mode === 'forgot' ? 'PIN reset ✅' : 'PIN updated ✅',
            'Use the new PIN for sells, sends, top-ups, and web portal login.',
            portal ? `Web: ${portal}/login` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        ),
        this.settingsMenu(),
      ];
    }

    return null;
  }

  private startKyc(phone: string): RampReply {
    this.clearAllFlows(phone);
    this.pendingKyc.set(phone, { step: 'bvn' });
    return asText(
      [
        'KYC — identity check',
        '',
        'Tier 1 uses your *BVN* + date of birth.',
        'Tier 2 (later) adds your *NIN* for higher limits.',
        '',
        'Reply your 11-digit BVN now.',
        'Or reply *cancel*.',
      ].join('\n'),
    );
  }

  private continueKyc(
    phone: string,
    raw: string,
    lower: string,
    btn: string | null,
  ): RampReply | RampReply[] | null {
    const pending = this.pendingKyc.get(phone);
    if (!pending) return null;

    if (btn === 'menu_home' || lower === 'cancel' || lower === 'menu') {
      this.clearKyc(phone);
      if (btn === 'menu_home' || lower === 'menu') return null;
      return [asText('KYC cancelled.'), this.settingsMenu()];
    }

    if (pending.step === 'bvn') {
      const bvn = raw.replace(/\D/g, '');
      if (!/^\d{11}$/.test(bvn)) {
        return asText('BVN must be exactly 11 digits. Try again, or cancel.');
      }
      this.pendingKyc.set(phone, { step: 'dob', bvn });
      return asText(
        ['BVN noted.', '', 'Reply your date of birth as *YYYY-MM-DD*', 'e.g. 1995-08-08'].join(
          '\n',
        ),
      );
    }

    if (pending.step === 'dob') {
      const dob = raw.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
        return asText('Use YYYY-MM-DD (e.g. 1995-08-08). Try again, or cancel.');
      }
      const parsed = Date.parse(dob);
      if (!Number.isFinite(parsed) || parsed > Date.now()) {
        return asText('That date looks invalid. Use YYYY-MM-DD, or cancel.');
      }
      // Do not persist BVN/DOB in chat logs beyond this reply — live PayVessel
      // verify needs a platform User linked to this WhatsApp number (next step).
      this.clearKyc(phone);
      this.logger.info(
        { phone, bvnLast4: (pending.bvn || '').slice(-4), dobYear: dob.slice(0, 4) },
        '[zylo-ramp] KYC details collected; live verify not wired to WhatsApp yet',
      );
      return [
        asText(
          [
            'Details received ✅',
            '',
            'Live BVN verification on WhatsApp is *coming soon*.',
            'We’ll unlock higher limits once identity checks go live here.',
            '',
            'You can still sell, send, and top up with your PIN.',
          ].join('\n'),
        ),
        this.settingsMenu(),
      ];
    }

    return null;
  }

  private async payoutAccountsMenu(phone: string): Promise<RampReply | RampReply[]> {
    await this.ensureLegacyPayoutMigrated(phone);
    const accounts = await this.store.listPayoutAccounts(phone);
    if (accounts.length === 0) {
      this.pendingPayoutSettings.set(phone, { step: 'collect' });
      return asText(
        [
          'No payout accounts saved yet.',
          'Send: bank <bank> <10-digit account> <account name>',
          'e.g. bank Opay 0123456789 Jane Doe',
        ].join('\n'),
      );
    }
    const lines = accounts.map((a, i) => {
      const tag = a.isDefault ? ' (default)' : '';
      return `${i + 1}. ${a.bankName} ${a.accountNumber} — ${a.accountName}${tag}`;
    });
    const rows = accounts.slice(0, 8).flatMap((a) => {
      const base = [
        {
          id: `payout_default_${a.id}`,
          title: a.isDefault ? `Default ✓ ${a.bankName}` : `Make default`,
          description: `${a.accountNumber} · ${a.accountName}`.slice(0, 72),
        },
        {
          id: `payout_del_${a.id}`,
          title: `Remove ${a.bankName}`.slice(0, 24),
          description: a.accountNumber,
        },
      ];
      return a.isDefault ? [base[1]!] : base;
    });
    return [
      asText(['Your payout accounts:', ...lines].join('\n')),
      {
        type: 'list',
        body: 'Manage an account',
        button: 'Manage',
        sections: [
          {
            title: 'Accounts',
            rows: [
              ...rows.slice(0, 9),
              {
                id: 'settings_payout_add',
                title: 'Add account',
                description: 'Verify a new NUBAN',
              },
            ],
          },
        ],
      },
    ];
  }

  private async withPayoutMenu(phone: string, preface: string): Promise<RampReply[]> {
    const menu = await this.payoutAccountsMenu(phone);
    return [asText(preface), ...(Array.isArray(menu) ? menu : [menu])];
  }

  private async continuePayoutSettings(
    phone: string,
    raw: string,
    lower: string,
    btn: string | null,
  ): Promise<RampReply | RampReply[] | null> {
    const pending = this.pendingPayoutSettings.get(phone);
    if (!pending && !btn?.startsWith('payout_') && btn !== 'settings_payout_add') {
      return null;
    }

    if (btn === 'payout_cancel' || lower === 'cancel' || lower === 'menu' || btn === 'menu_home') {
      this.clearPayoutSettings(phone);
      if (btn === 'menu_home' || lower === 'menu') return null;
      return [asText('Cancelled.'), this.settingsMenu()];
    }

    if (
      btn?.startsWith('payout_default_') &&
      btn !== 'payout_default_yes' &&
      btn !== 'payout_default_no'
    ) {
      const id = Number(btn.slice('payout_default_'.length));
      const saved = await this.store.setDefaultPayoutAccount(phone, id);
      this.clearPayoutSettings(phone);
      if (!saved) return asText('Account not found.');
      return this.withPayoutMenu(
        phone,
        `Default payout set to ${saved.bankName} ${saved.accountNumber} (${saved.accountName}).`,
      );
    }

    if (btn?.startsWith('payout_del_')) {
      const id = Number(btn.slice('payout_del_'.length));
      const ok = await this.store.deletePayoutAccount(phone, id);
      this.clearPayoutSettings(phone);
      return this.withPayoutMenu(phone, ok ? 'Payout account removed.' : 'Account not found.');
    }

    if (btn === 'payout_save' && pending?.staged) {
      const existing = await this.store.listPayoutAccounts(phone);
      const saved = await this.saveStagedPayout(phone, pending.staged, existing.length === 0);
      if (existing.length > 0 && !saved.isDefault) {
        this.pendingPayoutSettings.set(phone, {
          step: 'set_default',
          askDefaultId: saved.id,
        });
        return {
          type: 'buttons',
          body: `Saved ${saved.bankName} ${saved.accountNumber}. Set as new default?`,
          buttons: [
            { id: 'payout_default_yes', title: 'Yes' },
            { id: 'payout_default_no', title: 'No' },
          ],
        };
      }
      this.clearPayoutSettings(phone);
      return this.withPayoutMenu(
        phone,
        `Saved payout: ${saved.bankName} ${saved.accountNumber} (${saved.accountName}).`,
      );
    }

    if (pending?.step === 'set_default') {
      if (btn === 'payout_default_yes' && pending.askDefaultId) {
        await this.store.setDefaultPayoutAccount(phone, pending.askDefaultId);
      }
      this.clearPayoutSettings(phone);
      return this.payoutAccountsMenu(phone);
    }

    if (btn === 'settings_payout_add' || pending?.step === 'collect') {
      if (btn?.startsWith('bank_pick_') && pending?.pendingAccountNumber) {
        const code = btn.slice('bank_pick_'.length);
        try {
          const banks = await this.naira.listBanks();
          const bank = banks.find((b) => b.code === code);
          if (!bank) return asText('Bank not found. Try again.');
          return this.verifyStagedPayout(phone, 'settings', {
            bankName: bank.name,
            bankCode: bank.code,
            accountNumber: pending.pendingAccountNumber,
            accountNameHint: pending.pendingNameHint || '',
          });
        } catch (e) {
          return asText(`Couldn’t load banks (${e instanceof Error ? e.message : String(e)}).`);
        }
      }
      if (btn === 'settings_payout_add') {
        this.pendingPayoutSettings.set(phone, { step: 'collect' });
        return asText(
          'Send: bank <bank> <10-digit account> <account name>\ne.g. bank Opay 0123456789 Jane Doe',
        );
      }
      if (!btn && raw.trim()) {
        return this.collectAndVerifyPayoutDetails(phone, raw, 'settings');
      }
      return asText('Send bank details, or reply cancel.');
    }

    if (pending?.step === 'verify') {
      return asText('Tap Confirm to save, or Cancel.');
    }

    return null;
  }

  private async handleSell(
    phone: string,
    amount: number,
    config: RampConfig,
    chain = 'celo',
  ): Promise<string> {
    if (amount > config.maxOrderUsdc) {
      return `Max order is ${config.maxOrderUsdc} USDC while float is small. Try: sell ${config.maxOrderUsdc}`;
    }
    const open = await this.store.findOpenOrderForPhone(phone);
    if (open)
      return `You already have open order ${open.ref} (${open.status}). Reply cancel first.`;

    const user = await this.store.getUser(phone);
    if (!user?.bankAccount || !user?.bankName || !user?.accountName) {
      return [
        'Save your NGN payout details first:',
        'bank <bank> <account_number> <account_name>',
        'e.g. bank Opay 0123456789 Jane Doe',
      ].join('\n');
    }

    const deposit = depositForChain(config, chain, user);
    if (!deposit) {
      if (chain === 'stellar') {
        return 'Your Stellar smart wallet is not ready yet. Finish onboarding or message support.';
      }
      return `${chainLabel(chain)} deposit address not configured yet.`;
    }

    const ngnGross = Math.round(amount * config.rates.sellNgn);
    const feeNgn = config.sellFeeNgn;
    const ngn = Math.max(0, ngnGross - feeNgn);
    const ref = this.store.shortRef('SELL');
    const expiresAt = new Date(Date.now() + config.orderTtlMinutes * 60_000);

    await this.store.createOrder({
      ref,
      type: 'sell',
      phone,
      chain,
      amountUsdc: amount,
      amountNgn: ngn,
      rate: config.rates.sellNgn,
      status: 'awaiting_crypto',
      depositAddress: deposit,
      payoutBank: {
        bankName: user.bankName,
        accountNumber: user.bankAccount,
        accountName: user.accountName,
      },
      txHash: null,
      expiresAt,
    });

    const networkNote =
      chain === 'stellar'
        ? 'USDC will be taken from your BANJEE Stellar wallet after confirmation.'
        : 'USDC will be taken from your BANJEE Celo wallet after confirmation.';

    return [
      `Order *${ref}* created`,
      `Sell ${amount} USDC (${chainLabel(chain)})`,
      `Rate: ₦${config.rates.sellNgn.toLocaleString('en-NG')} / USDC`,
      `Fee: ₦${feeNgn.toLocaleString('en-NG')}`,
      `You receive: ₦${ngn.toLocaleString('en-NG')}`,
      networkNote,
      `Payout: ${user.bankName} ${maskBankAccount(user.bankAccount)} (${user.accountName})`,
      `Order window: ${config.orderTtlMinutes} min. Reply cancel to stop.`,
    ].join('\n');
  }

  private async handleBuy(
    phone: string,
    amount: number,
    config: RampConfig,
    chain = 'celo',
  ): Promise<string> {
    if (amount > config.maxOrderUsdc) {
      return `Max order is ${config.maxOrderUsdc} USDC while float is small. Try: buy ${config.maxOrderUsdc}`;
    }
    const open = await this.store.findOpenOrderForPhone(phone);
    if (open)
      return `You already have open order ${open.ref} (${open.status}). Reply cancel first.`;

    const user = await this.store.getUser(phone);
    let payoutWallet: string | null | undefined =
      chain === 'stellar' ? user?.zyloWallet || user?.stellarWallet : null;
    if (chain === 'celo') {
      payoutWallet =
        user?.celoWallet || (await this.ensureCeloWallet(phone)) || user?.wallet || null;
    }
    if (!payoutWallet) {
      return chain === 'stellar'
        ? 'Your Stellar smart wallet is not ready yet. Finish onboarding or message support.'
        : 'Your Celo wallet is not ready yet. Finish onboarding or message support.';
    }

    if (!config.ngn.accountNumber) {
      return 'Operator NGN account not configured (WA_RAMP_NGN_ACCOUNT_NUMBER).';
    }

    const ngn = Math.round(amount * config.rates.buyNgn);
    const ref = this.store.shortRef('BUY');
    const expiresAt = new Date(Date.now() + config.orderTtlMinutes * 60_000);

    await this.store.createOrder({
      ref,
      type: 'buy',
      phone,
      chain,
      amountUsdc: amount,
      amountNgn: ngn,
      rate: config.rates.buyNgn,
      status: 'awaiting_ngn',
      wallet: payoutWallet,
      txHash: null,
      expiresAt,
    });

    return [
      `Buy ${amount} USDC on ${chainLabel(chain)} → pay ₦${ngn.toLocaleString('en-NG')}`,
      `Rate: ₦${config.rates.buyNgn} / USDC`,
      `Ref: ${ref}`,
      '',
      'Pay NGN to:',
      `${config.ngn.bankName}`,
      `${config.ngn.accountNumber}`,
      `${config.ngn.accountName}`,
      `Narration / ref: ${ref}`,
      '',
      `After you pay, wait for confirmation. USDC goes to (${chainLabel(chain)}):`,
      payoutWallet,
      '',
      `Expires in ${config.orderTtlMinutes} min. Reply cancel to stop.`,
    ].join('\n');
  }

  private async statusText(phone: string): Promise<string> {
    const open = await this.store.findOpenOrderForPhone(phone);
    if (!open) return 'No open order. Use the menu to Buy or Sell.';
    return [
      `Order ${open.ref}`,
      `Type: ${open.type}`,
      `Amount: ${open.amountUsdc} USDC / ₦${open.amountNgn}`,
      `Status: ${open.status}`,
    ].join('\n');
  }

  async notifyAdmin(text: string, opts: WhatsAppSendOpts = {}): Promise<void> {
    const config = getRampConfig();
    if (!config.adminWhatsappNumber) return;
    try {
      await this.whatsapp.sendText(config.adminWhatsappNumber, text, opts);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error({ err: message }, '[zylo-ramp] admin notify failed');
    }
  }

  /**
   * @returns replies for WhatsApp dispatcher
   */
  async handleRampIncoming({
    from,
    text,
    phoneNumberId,
    buttonId,
    contactName,
    flowPin,
    flowOnboard,
  }: {
    from: string;
    text?: string;
    phoneNumberId?: string | null;
    buttonId?: string | null;
    contactName?: string | null;
    flowPin?: string | null;
    flowOnboard?: {
      username: string;
      email: string;
      pin: string;
      pinConfirm: string;
    } | null;
  }): Promise<RampReply | RampReply[]> {
    const config = getRampConfig();
    const sendOpts: WhatsAppSendOpts = phoneNumberId ? { phoneNumberId } : {};
    const phone = String(from).replace(/\D/g, '');
    const raw = (text || '').trim();
    const lower = raw.toLowerCase();
    const btn = buttonId || null;

    try {
      const onboarded = await this.onboarding.handleOnboarding({
        phone,
        text: raw,
        buttonId: btn,
        contactName,
        flowOnboard,
      });
      if (onboarded) return onboarded;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error({ err: message }, '[zylo-ramp] onboarding error');
    }

    try {
      await this.store.expireStaleOrders(config.orderTtlMinutes);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn({ err: message }, '[zylo-ramp] expireStaleOrders failed (migrate?)');
    }

    try {
      const follow = await this.handlePostTransferFollowup(phone, raw, btn, lower);
      if (follow) return follow;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn({ err: message }, '[zylo-ramp] post-transfer followup failed');
    }

    if (
      btn === 'menu_home' ||
      btn === 'menu_more' ||
      lower === 'menu' ||
      lower === 'hi' ||
      lower === 'hello' ||
      lower === 'start'
    ) {
      this.clearAllFlows(phone);
      const user = await this.store.getUser(phone).catch(() => null);
      return this.onboarding.mainMenuButtons(user);
    }

    // WhatsApp Flow PIN submit (popup) — sell, crypto transfer, bank send, airtime, data, or utilities
    if (flowPin || btn === 'xfer_flow_pin') {
      const pin = String(flowPin || raw).trim();
      const utilityPin = await this.utilityChat.handleFlowPin(phone, pin);
      if (utilityPin) return utilityPin;
      const sellPending = this.pendingSell.get(phone);
      if (sellPending?.step === 'pin') {
        if (!/^\d{4}$/.test(pin)) {
          const def = await this.store.getDefaultPayoutAccount(phone);
          const hint = asText('PIN must be exactly 4 digits.');
          if (!def?.bankCode) return hint;
          const pinAsk = this.sellPinPrompt(phone, sellPending, def);
          return Array.isArray(pinAsk) ? [hint, ...pinAsk] : [hint, pinAsk];
        }
        const ok = await this.onboarding.verifyUserPin(phone, pin);
        if (!ok) {
          return asText('Wrong PIN. Try again, or cancel.');
        }
        if (!sellPending.quoteExpiresAt || Date.now() > sellPending.quoteExpiresAt) {
          const refreshed = this.buildSellQuote(sellPending);
          this.pendingSell.set(phone, refreshed);
          return [
            asText('That rate expired. Here’s an updated quote — confirm again to continue.'),
            await this.sellQuoteMessage(phone, refreshed),
          ];
        }
        const def = await this.store.getDefaultPayoutAccount(phone);
        if (!def?.bankCode) {
          this.pendingSell.set(phone, { ...sellPending, step: 'bank_collect' });
          return asText(
            'No verified payout account on file. Send:\nbank <bank> <10-digit account> <account name>',
          );
        }
        return this.executeSellToPayout(phone, sellPending, def);
      }
      const dataPending = this.pendingData.get(phone);
      if (dataPending?.step === 'pin') {
        if (!/^\d{4}$/.test(pin)) {
          const hint = asText('PIN must be exactly 4 digits.');
          const pinAsk = this.dataPinPrompt(phone, dataPending);
          return Array.isArray(pinAsk) ? [hint, ...pinAsk] : [hint, pinAsk];
        }
        const ok = await this.onboarding.verifyUserPin(phone, pin);
        if (!ok) {
          const hint = asText('Wrong PIN. Try again, or cancel.');
          const pinAsk = this.dataPinPrompt(phone, dataPending);
          return Array.isArray(pinAsk) ? [hint, ...pinAsk] : [hint, pinAsk];
        }
        return this.executePendingData(phone);
      }
      const airPending = this.pendingAirtime.get(phone);
      if (airPending?.step === 'pin') {
        if (!/^\d{4}$/.test(pin)) {
          const hint = asText('PIN must be exactly 4 digits.');
          const pinAsk = this.airtimePinPrompt(phone, airPending);
          return Array.isArray(pinAsk) ? [hint, ...pinAsk] : [hint, pinAsk];
        }
        const ok = await this.onboarding.verifyUserPin(phone, pin);
        if (!ok) {
          const hint = asText('Wrong PIN. Try again, or cancel.');
          const pinAsk = this.airtimePinPrompt(phone, airPending);
          return Array.isArray(pinAsk) ? [hint, ...pinAsk] : [hint, pinAsk];
        }
        return this.executePendingAirtime(phone);
      }
      const bankPending = this.pendingBankSend.get(phone);
      if (bankPending?.step === 'pin') {
        if (!/^\d{4}$/.test(pin)) {
          const hint = asText('PIN must be exactly 4 digits.');
          const pinAsk = this.bankSendPinPrompt(phone, bankPending);
          return Array.isArray(pinAsk) ? [hint, ...pinAsk] : [hint, pinAsk];
        }
        const ok = await this.onboarding.verifyUserPin(phone, pin);
        if (!ok) {
          const hint = asText('Wrong PIN. Try again, or cancel.');
          const pinAsk = this.bankSendPinPrompt(phone, bankPending);
          return Array.isArray(pinAsk) ? [hint, ...pinAsk] : [hint, pinAsk];
        }
        return this.executePendingBankSend(phone);
      }
      const pending = this.pendingTransfer.get(phone);
      if (pending?.step === 'pin') {
        if (!/^\d{4}$/.test(pin)) {
          const hint = asText('PIN must be exactly 4 digits.');
          const pinAsk = this.transferPinPrompt(phone, pending);
          return Array.isArray(pinAsk) ? [hint, ...pinAsk] : [hint, pinAsk];
        }
        const ok = await this.onboarding.verifyUserPin(phone, pin);
        if (!ok) {
          const hint = asText('Wrong PIN. Try again, or cancel.');
          const pinAsk = this.transferPinPrompt(phone, pending);
          return Array.isArray(pinAsk) ? [hint, ...pinAsk] : [hint, pinAsk];
        }
        return this.executePendingTransfer(phone);
      }
    }

    if (this.pendingBankSend.has(phone)) {
      const bankReply = await this.continueBankSend(phone, raw, btn, lower);
      if (bankReply) return bankReply;
    }

    if (this.pendingSell.has(phone)) {
      const sellReply = await this.continueSell(phone, raw, lower, btn);
      if (sellReply) return sellReply;
    }

    if (this.pendingPayoutSettings.has(phone)) {
      const payReply = await this.continuePayoutSettings(phone, raw, lower, btn);
      if (payReply) return payReply;
    }

    if (this.pendingPinChange.has(phone)) {
      const pinReply = await this.continueChangePin(phone, raw, lower, btn);
      if (pinReply) return pinReply;
    }

    if (this.pendingKyc.has(phone)) {
      const kycReply = this.continueKyc(phone, raw, lower, btn);
      if (kycReply) return kycReply;
    }

    if (this.pendingAirtime.has(phone)) {
      const airReply = await this.continueAirtime(phone, raw, btn, lower);
      if (airReply) return airReply;
    }

    if (this.pendingData.has(phone)) {
      const dataReply = await this.continueData(phone, raw, btn, lower);
      if (dataReply) return dataReply;
    }

    if (this.utilityChat.hasActive(phone)) {
      const utilReply = await this.utilityChat.continueAny(phone, raw, btn, lower);
      if (utilReply) return utilReply;
    }

    if (this.pendingTransfer.has(phone)) {
      // Asset / chain restart buttons fall through to menu handlers below.
      const restartXfer =
        btn === 'xfer_usdc' ||
        btn === 'xfer_xlm' ||
        btn === 'xfer_chain_stellar' ||
        btn === 'xfer_chain_celo';
      if (!restartXfer) {
        const xferReply = await this.continueTransfer(phone, raw, lower, btn);
        if (xferReply) return xferReply;
      }
    }

    // Free-text intent (LLM + regex) — additive; menus/buttons still work.
    try {
      const intentReply = await this.tryIntentLayer(phone, raw, btn, config);
      if (intentReply) return intentReply;
    } catch (e) {
      this.logger.warn(
        { err: e instanceof Error ? e.message : String(e), phone },
        '[zylo-ramp] intent layer failed',
      );
    }

    if (btn === 'xfer_view_tx') {
      return this.viewLastTransfer(phone);
    }

    if (btn === 'menu_rates' || lower === 'rate' || lower === 'rates') {
      const user = await this.store.getUser(phone).catch(() => null);
      return [asText(rateText(config)), this.onboarding.mainMenuButtons(user)];
    }
    if (btn === 'menu_send' || lower === 'send money' || lower === 'send') {
      this.clearAirtime(phone);
      this.clearData(phone);
      this.clearSendMoneyState(phone);
      return this.onboarding.sendMoneyMenu();
    }
    if (
      btn === 'menu_topup' ||
      btn === 'menu_bills' ||
      lower === 'top up' ||
      lower === 'topup' ||
      lower === 'bills'
    ) {
      return this.topUpMenu();
    }
    if (btn === 'menu_airtime' || lower === 'buy airtime' || lower === 'airtime') {
      return this.startAirtime(phone);
    }
    if (btn === 'menu_data' || lower === 'buy data' || lower === 'data') {
      return this.startData(phone);
    }
    if (
      btn === 'menu_electricity' ||
      lower === 'electricity' ||
      lower === 'buy electricity' ||
      lower === 'power'
    ) {
      this.clearAirtime(phone);
      this.clearData(phone);
      return this.utilityChat.startElectricity(phone);
    }
    if (btn === 'menu_cable' || lower === 'cable' || lower === 'cable tv' || lower === 'dstv') {
      this.clearAirtime(phone);
      this.clearData(phone);
      return this.utilityChat.startCable(phone);
    }
    if (
      btn === 'menu_betting' ||
      lower === 'betting' ||
      lower === 'bet' ||
      lower === 'betting top-up'
    ) {
      this.clearAirtime(phone);
      this.clearData(phone);
      return this.utilityChat.startBetting(phone);
    }
    if (btn === 'menu_utilities') {
      return this.utilityChat.utilitiesMenu();
    }
    if (btn === 'menu_settings' || lower === 'settings') {
      return this.settingsMenu();
    }
    if (
      btn === 'menu_web' ||
      lower === 'web' ||
      lower === 'portal' ||
      lower === 'website' ||
      lower === 'open portal'
    ) {
      const url = config.webPortalUrl;
      return asText(
        [
          `${this.onboarding.brandName()} web portal`,
          '',
          url,
          '',
          'Open that link → Create account with *this same WhatsApp number* + a PIN.',
          'Using a different phone creates a separate account.',
          'Already registered? Log in with that phone + PIN.',
          '',
          'One-tap signed login from chat is coming soon.',
        ].join('\n'),
      );
    }
    if (btn === 'settings_change_pin' || lower === 'change pin' || lower === 'update pin') {
      return this.startChangePin(phone);
    }
    if (
      lower === 'forgot pin' ||
      lower === 'reset pin' ||
      lower === 'forgotpin' ||
      lower === 'resetpin' ||
      lower.startsWith('forgot pin')
    ) {
      return this.startForgotPin(phone);
    }
    if (btn === 'settings_kyc' || lower === 'kyc' || lower === 'verify bvn') {
      return this.startKyc(phone);
    }
    if (btn === 'settings_payouts') {
      return this.payoutAccountsMenu(phone);
    }
    if (
      btn === 'settings_payout_add' ||
      btn === 'payout_save' ||
      btn === 'payout_cancel' ||
      btn === 'payout_default_yes' ||
      btn === 'payout_default_no' ||
      btn?.startsWith('payout_default_') ||
      btn?.startsWith('payout_del_')
    ) {
      return (await this.continuePayoutSettings(phone, raw, lower, btn)) || this.settingsMenu();
    }
    if (btn === 'menu_balance' || lower === 'check balance') {
      return this.handleBalance(phone);
    }
    if (btn === 'celo_get_wallet') {
      this.celoPromptShown.add(phone);
      const celo = await this.ensureCeloWallet(phone);
      if (!celo) {
        return asText('Celo wallets are not available right now. Try again later.');
      }
      return celoWalletAddressReplies({
        brandName: this.onboarding.brandName(),
        phone,
        wallet: celo,
        switchToStellar: true,
      });
    }
    if (btn === 'fund_net_stellar') {
      return this.handleFundNetwork(phone, 'stellar');
    }
    if (btn === 'fund_net_celo') {
      return this.handleFundNetwork(phone, 'celo');
    }
    if (btn === 'fund_fmt_qr') {
      return this.handleFundFormat(phone, 'qr');
    }
    if (btn === 'fund_fmt_address') {
      return this.handleFundFormat(phone, 'address');
    }
    if (btn === 'fund_fmt_both') {
      return this.handleFundFormat(phone, 'both');
    }
    if (btn === 'celo_skip' || lower === 'not now') {
      this.celoPromptShown.add(phone);
      const user = await this.store.getUser(phone).catch(() => null);
      return [
        asText('No problem — you can add Celo later from Check balance.'),
        this.onboarding.mainMenuButtons(user),
      ];
    }
    if (btn === 'send_bank' || lower === 'to bank' || lower === 'send to bank') {
      return this.beginBankSend(phone);
    }
    if (btn === 'send_crypto') {
      return this.startTransfer();
    }
    if (btn === 'xfer_chain_stellar') {
      return this.startStellarAssetPick();
    }
    if (btn === 'xfer_chain_celo' || lower === 'transfer celo' || lower === 'send celo') {
      if (!this.celoWallets.isConfigured()) {
        return asText('Celo transfers are not available right now.');
      }
      return this.beginTransfer(phone, 'celo');
    }
    if (btn === 'menu_wallet' || lower === 'wallet menu') {
      this.clearTransfer(phone);
      return this.onboarding.walletMenuButtons();
    }
    if (btn === 'wallet_balance' || lower === 'balance') {
      return this.handleBalance(phone);
    }

    const quickSend = await this.tryQuickSend(phone, raw);
    if (quickSend) return quickSend;

    if (btn === 'wallet_transfer' || lower === 'transfer') {
      return this.startTransfer();
    }
    if (btn === 'xfer_usdc' || lower === 'transfer usdc' || lower === 'send usdc') {
      return this.beginTransfer(phone, 'usdc');
    }
    if (btn === 'xfer_xlm' || lower === 'transfer xlm' || lower === 'send xlm') {
      return this.beginTransfer(phone, 'xlm');
    }
    if (btn === 'wallet_address') {
      return this.handleWalletAddress(phone);
    }
    if (btn === 'menu_buy' || lower === 'buy usdc' || lower === 'buy crypto' || lower === 'buy') {
      return buyUsdcComingSoon();
    }
    if (btn === 'menu_sell' || lower === 'sell usdc' || lower === 'cash out' || lower === 'sell') {
      return this.startSellFlow(phone);
    }
    if (btn === 'sell_net_stellar' || btn === 'sell_net_celo') {
      this.pendingSell.set(phone, { step: 'network' });
      return (await this.continueSell(phone, raw, lower, btn)) || this.startSellFlow(phone);
    }
    if (
      btn === 'sell_all' ||
      btn === 'sell_quote_confirm' ||
      btn === 'sell_bank_confirm' ||
      btn === 'sell_bank_use' ||
      btn === 'sell_bank_change' ||
      btn === 'sell_payout_save' ||
      btn === 'sell_payout_discard' ||
      btn === 'sell_default_yes' ||
      btn === 'sell_default_no' ||
      btn === 'sell_cancel'
    ) {
      if (!this.pendingSell.has(phone) && btn !== 'sell_cancel') {
        return this.startSellFlow(phone);
      }
      return (await this.continueSell(phone, raw, lower, btn)) || asText('Sale cancelled.');
    }
    if (btn === 'buy_chain_celo' || btn === 'buy_chain_stellar') return buyUsdcComingSoon();
    if (btn === 'sell_chain_celo') {
      const bals = await this.sellNetworkBalances(phone);
      return this.sellAskAmount(phone, 'celo', bals.celo);
    }
    if (btn === 'sell_chain_stellar') {
      const bals = await this.sellNetworkBalances(phone);
      return this.sellAskAmount(phone, 'stellar', bals.stellar);
    }
    if (btn === 'buy_celo_1' || btn === 'buy_stellar_1' || btn === 'buy_1') {
      return buyUsdcComingSoon();
    }
    if (btn === 'sell_celo_1')
      return asText(await this.handleSell(phone, config.maxOrderUsdc, config, 'celo'));
    if (btn === 'sell_stellar_1')
      return asText(await this.handleSell(phone, config.maxOrderUsdc, config, 'stellar'));
    // legacy ids
    if (btn === 'sell_1')
      return asText(await this.handleSell(phone, config.maxOrderUsdc, config, 'celo'));

    if (lower === 'help') {
      const user = await this.store.getUser(phone).catch(() => null);
      return [
        asText(
          [
            `${this.onboarding.brandName()} — USDC (${config.chainsLabel}) ↔ NGN`,
            '',
            'Use the buttons, or just say what you want:',
            '• “send james 2 usdc” / “sell 5 usdc” / “what’s my balance”',
            '• “buy airtime” / “what’s the rate” / “my wallet address”',
            '• Or tap the menu anytime',
            '• cancel / menu',
          ].join('\n'),
        ),
        this.onboarding.mainMenuButtons(user),
      ];
    }

    if (lower === 'status') {
      try {
        return asText(await this.statusText(phone));
      } catch {
        return asText('Ramp database not ready yet. Ask the operator to run: npm run migrate');
      }
    }

    if (lower === 'cancel' || btn === 'cancel') {
      const open = await this.store.findOpenOrderForPhone(phone);
      if (!open) return asText('Nothing to cancel.');
      if (!['awaiting_crypto', 'awaiting_ngn'].includes(open.status)) {
        return asText(`Order ${open.ref} is ${open.status} and can't be cancelled from chat.`);
      }
      await this.store.updateOrder(open.ref, { status: 'cancelled' });
      return asText(`Cancelled ${open.ref}.`);
    }

    if (lower === 'my wallet' || lower === 'wallet' || lower === 'address') {
      return this.handleWalletAddress(phone);
    }

    const walletCelo = raw.match(/^wallet(?:\s+celo)?\s+(0x[a-fA-F0-9]{40})$/i);
    if (walletCelo?.[1]) {
      await this.store.upsertUser(phone, { wallet: walletCelo[1] });
      const user = await this.store.getUser(phone);
      return [
        asText(`Saved Celo wallet:\n${walletCelo[1]}`),
        this.onboarding.mainMenuButtons(user),
      ];
    }

    const walletStellar = raw.match(/^wallet\s+stellar\s+([G][A-Z0-9]{55})$/i);
    if (walletStellar?.[1]) {
      await this.store.upsertUser(phone, { stellarWallet: walletStellar[1] });
      const user = await this.store.getUser(phone);
      return [
        asText(`Saved Stellar wallet:\n${walletStellar[1]}`),
        this.onboarding.mainMenuButtons(user),
      ];
    }

    const bankAttempt =
      /^(?:bank\s+)?\S+\s+\d{6,14}\s+\S+/i.test(raw.trim()) || /^bank\s+/i.test(raw.trim());
    if (bankAttempt) {
      // Prefer in-progress sell collect; otherwise settings/add flow with verification.
      if (this.pendingSell.get(phone)?.step === 'bank_collect') {
        return this.collectAndVerifyPayoutDetails(phone, raw, 'sell');
      }
      this.pendingPayoutSettings.set(phone, { step: 'collect' });
      return this.collectAndVerifyPayoutDetails(phone, raw, 'settings');
    }

    const sellMatch = lower.match(/^sell\s+(\d+(?:\.\d+)?)\s*(usdc|usdt)?(?:\s+(celo|stellar))?$/);
    if (sellMatch?.[1]) {
      const amount = parseAmount(sellMatch[1]);
      if (!amount) return asText('Invalid amount. Example: sell 1 usdc stellar');
      const chain = (sellMatch[3] || 'stellar') as SpendChain;
      this.clearAllFlows(phone);
      const bals = await this.sellNetworkBalances(phone);
      const available = chain === 'celo' ? bals.celo : bals.stellar;
      if (available <= 1e-6) {
        return asText(`No USDC on ${chainLabel(chain)} to sell.`);
      }
      if (amount > available + 1e-9) {
        return asText(`You only have ${available.toFixed(2)} USDC on ${chainLabel(chain)}.`);
      }
      const quoted = this.buildSellQuote({
        step: 'quote',
        chain,
        amountUsdc: amount,
        availableBalance: available,
      });
      this.pendingSell.set(phone, quoted);
      return this.sellQuoteMessage(phone, quoted);
    }

    const buyMatch = lower.match(/^buy\s+(\d+(?:\.\d+)?)\s*(usdc|usdt)?(?:\s+(celo|stellar))?$/);
    if (buyMatch?.[1]) {
      return buyUsdcComingSoon();
    }

    const confirmMatch = lower.match(/^confirm\s+(buy_[a-f0-9]+|sell_[a-f0-9]+)$/);
    if (confirmMatch?.[1]) {
      if (!isAdmin(phone, config)) return asText('Admin only.');
      const order = await this.store.findOrder(confirmMatch[1]);
      if (!order) return asText('Order not found.');

      if (order.type === 'buy' && order.status === 'awaiting_ngn') {
        await this.store.updateOrder(order.ref, { status: 'ngn_received' });
        await this.whatsapp.sendText(
          order.phone,
          [
            `✅ NGN received for ${order.ref}`,
            `Sending ${order.amountUsdc} USDC to:`,
            order.wallet,
            '',
            "If it doesn't arrive in a few minutes, reply status.",
          ].join('\n'),
          sendOpts,
        );
        return asText(
          [
            `Marked ${order.ref} as ngn_received.`,
            `Send ${order.amountUsdc} USDC on Celo to ${order.wallet}`,
            `Then reply: sent ${order.ref} <txHash>`,
          ].join('\n'),
        );
      }

      if (order.type === 'sell' && order.status === 'crypto_received') {
        await this.store.updateOrder(order.ref, { status: 'completed' });
        await this.whatsapp.sendText(
          order.phone,
          [
            `✅ Completed ${order.ref}`,
            `₦${order.amountNgn.toLocaleString('en-NG')} sent to your bank.`,
          ].join('\n'),
          sendOpts,
        );
        return asText(`Completed ${order.ref}.`);
      }

      return asText(`Cannot confirm ${order.ref} in status ${order.status}.`);
    }

    const sentMatch = raw.match(/^sent\s+(buy_[a-f0-9]+)\s+(0x[a-fA-F0-9]{64})$/i);
    if (sentMatch?.[1] && sentMatch[2]) {
      if (!isAdmin(phone, config)) return asText('Admin only.');
      const order = await this.store.findOrder(sentMatch[1]);
      if (!order) return asText('Order not found.');
      await this.store.updateOrder(order.ref, { status: 'completed', txHash: sentMatch[2] });
      void this.store
        .recordVolume({
          asset: 'usdc',
          amount: Number(order.amountUsdc),
          kind: 'buy',
          dedupeKey: `buy:${order.ref}`,
        })
        .catch(() => undefined);
      await this.whatsapp.sendText(
        order.phone,
        [`✅ ${order.amountUsdc} USDC sent`, `Tx: ${sentMatch[2]}`, `Ref: ${order.ref}`].join('\n'),
        sendOpts,
      );
      return asText(`Marked ${order.ref} completed.`);
    }

    if (lower === 'orders') {
      if (!isAdmin(phone, config)) return asText('Admin only.');
      const open = await this.store.listOpenOrders();
      if (!open.length) return asText('No open orders.');
      return asText(
        open
          .map((o) => `${o.ref} ${o.type} ${o.amountUsdc}u ₦${o.amountNgn} ${o.status} ${o.phone}`)
          .join('\n'),
      );
    }

    const user = await this.store.getUser(phone).catch(() => null);
    return [asText('Tap a button below, or reply menu'), this.onboarding.mainMenuButtons(user)];
  }
}

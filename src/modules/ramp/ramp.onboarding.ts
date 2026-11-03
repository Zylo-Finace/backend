import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PinoLogger } from 'nestjs-pino';

import { getRampConfig } from './ramp.config';
import { RampStellarWalletService } from './ramp.stellar-wallet';
import { RampStoreService, type RampUser } from './ramp.store';
import { walletAddressReplies, walletSignupHandoffReplies } from './ramp.wallet-handoff';
import { RampWhatsAppService, type RampReply } from './ramp.whatsapp';

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PIN_RE = /^\d{4}$/;

/** Prefer WhatsApp name (e.g. Ajidokwu), else @username. */
function greetName(
  user?: {
    username?: string | null;
    whatsappName?: string | null;
  } | null,
): string {
  const wa = (user?.whatsappName || '').trim();
  if (wa) return wa.split(/\s+/)[0] || wa;
  const username = (user?.username || '').trim();
  if (username) return username;
  return '';
}

/** How long the chat waits before we reply and finish wallet setup in the background. */
const WALLET_WAIT_MS = 45_000;

@Injectable()
export class RampOnboardingService {
  constructor(
    private readonly store: RampStoreService,
    private readonly stellarWallets: RampStellarWalletService,
    private readonly whatsapp: RampWhatsAppService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RampOnboardingService.name);
  }

  brandName(): string {
    return (
      process.env.WA_RAMP_BRAND_NAME ||
      process.env.ZYLO_BRAND_NAME ||
      getRampConfig().brandName ||
      'Banjee'
    );
  }

  /** Active Stellar wallet must be classic G… (Celo is optional). */
  hasWallet(user: RampUser | null | undefined): boolean {
    return Boolean(user?.zyloWallet && /^G[A-Z0-9]{55}$/i.test(user.zyloWallet));
  }

  mainMenuButtons(user: RampUser | null | undefined): RampReply {
    if (!this.hasWallet(user)) {
      // Brand-new: cool Get started list. Mid-signup: resume CTA.
      if (this.hasStartedSignup(user)) {
        return this.incompleteMenuButtons(user);
      }
      return this.welcomeButtons({
        username: user?.username,
        whatsappName: user?.whatsappName,
      });
    }
    const brand = this.brandName();
    const name = greetName(user);
    const greet = name ? `Hey ${name} 👋` : 'Hey there 👋';
    // List (not 3-button) so Sell stays #1 with 4 primary actions.
    return {
      type: 'list',
      header: brand,
      body: [
        greet,
        'I can help you sell USDC for cash, send money, pay bills & manage your wallet.',
      ].join('\n'),
      footer: 'Sell · Send · Bills · Rates · Wallet · Settings',
      button: 'Menu',
      sections: [
        {
          title: 'What next',
          rows: [
            {
              id: 'menu_sell',
              title: 'Sell USDC',
              description: 'Cash out to your bank',
            },
            {
              id: 'menu_send',
              title: 'Send money',
              description: `Bank or ${brand} wallet`,
            },
            {
              id: 'menu_topup',
              title: 'Bills & top-up',
              description: 'Airtime, data, power, TV, betting',
            },
            {
              id: 'menu_rates',
              title: 'Check rates',
              description: 'Buy & sell NGN per USDC',
            },
            {
              id: 'menu_balance',
              title: 'Check balance',
              description: 'Stellar & Celo',
            },
            {
              id: 'menu_settings',
              title: 'Settings',
              description: 'PIN, KYC, payout accounts',
            },
          ],
        },
      ],
    };
  }

  /** Where to send — Naira bank vs crypto wallet transfer. */
  sendMoneyMenu(): RampReply {
    const brand = this.brandName();
    return {
      type: 'list',
      header: brand,
      body: 'Send money — pick a destination.',
      footer: `To bank (NGN) · To ${brand} wallet`,
      button: 'Choose',
      sections: [
        {
          title: 'Send to',
          rows: [
            {
              id: 'send_bank',
              title: 'To bank (NGN)',
              description: 'Pay any Nigerian bank account',
            },
            {
              id: 'send_crypto',
              title: `To ${brand} wallet`,
              description: 'Choose Stellar or Celo next',
            },
          ],
        },
      ],
    };
  }

  /** Stellar USDC vs Celo digital dollars (WhatsApp max 3 buttons). */
  payFromChainButtons(opts?: { body?: string; stellarOk?: boolean; celoOk?: boolean }): RampReply {
    const stellarOk = opts?.stellarOk !== false;
    const celoOk = opts?.celoOk !== false;
    const buttons: Array<{ id: string; title: string }> = [];
    if (stellarOk) buttons.push({ id: 'pay_from_stellar', title: 'Stellar USDC' });
    if (celoOk) buttons.push({ id: 'pay_from_celo', title: 'Celo dollars' });
    buttons.push({ id: 'menu_home', title: 'Main menu' });
    return {
      type: 'buttons',
      body: opts?.body || 'Pay from which wallet?',
      footer: 'Celo USDC/USDT/cUSD = 1:1',
      buttons: buttons.slice(0, 3),
    };
  }

  /**
   * Check balance hub — crypto actions + top-up + Buy/Sell USDC.
   * Optional Celo opt-in is a list row (not a second message).
   */
  balanceHubButtons(body: string, opts?: { offerCelo?: boolean }): RampReply {
    const walletRows: Array<{ id: string; title: string; description: string }> = [
      {
        id: 'wallet_address',
        title: 'Fund wallet',
        description: 'Deposit address + QR',
      },
      {
        id: 'wallet_transfer',
        title: 'Transfer crypto',
        description: 'Stellar or Celo',
      },
      {
        id: 'wallet_balance',
        title: 'Refresh balance',
        description: 'Stellar + Celo',
      },
      {
        id: 'menu_send',
        title: 'Send money',
        description: 'Bank or crypto',
      },
    ];
    if (opts?.offerCelo) {
      walletRows.push({
        id: 'celo_get_wallet',
        title: 'Get Celo address',
        description: 'Optional digital dollars',
      });
    }
    return {
      type: 'list',
      header: this.brandName(),
      body,
      footer: 'Send · Fund · Bills · Buy · Sell',
      button: 'Actions',
      sections: [
        {
          title: 'Wallet',
          rows: walletRows,
        },
        {
          title: 'Top up',
          rows: [
            {
              id: 'menu_airtime',
              title: 'Buy airtime',
              description: 'MTN, Airtel, Glo, 9mobile',
            },
            {
              id: 'menu_data',
              title: 'Buy data',
              description: 'Mobile data bundles',
            },
            {
              id: 'menu_utilities',
              title: 'Power · TV · Betting',
              description: 'Electricity, cable, betting',
            },
          ],
        },
        {
          title: 'Buy & sell',
          rows: [
            {
              id: 'menu_buy',
              title: 'Buy USDC',
              description: 'Coming soon',
            },
            {
              id: 'menu_sell',
              title: 'Sell USDC',
              description: 'Cash out to your bank',
            },
          ],
        },
      ],
    };
  }

  /** True once the user has saved any signup field (not just opened the chat). */
  private hasStartedSignup(user: RampUser | null | undefined): boolean {
    return Boolean(user?.username || user?.email || user?.pinHash || user?.pinSetupHash);
  }

  /** Shown when signup was started but wallet is not ready. */
  incompleteMenuButtons(user?: RampUser | null): RampReply {
    const name = user?.username || user?.whatsappName || 'there';
    return {
      type: 'buttons',
      header: this.brandName(),
      body: `Hey ${name} — you're almost set.\nTap below to finish (we kept what you already entered).`,
      footer: 'Required before buy / sell / transfer',
      buttons: [
        { id: 'onboard_continue', title: 'Continue signup' },
        { id: 'menu_rates', title: 'See rates' },
        { id: 'onboard_how', title: 'How it works' },
      ],
    };
  }

  /**
   * Resume from saved fields so a failed step never wipes username/email/PIN.
   * Priority: wallet retry → PIN confirm → PIN → email → username.
   */
  private nextSignupStep(user: RampUser | null | undefined): string {
    if (!user) return 'await_username';
    if (user.pinHash && !this.hasWallet(user)) return 'await_wallet';
    if (user.pinSetupHash) return 'await_pin_confirm';
    if (user.email) return 'await_pin';
    if (user.username) return 'await_email';
    const step = user.onboardingStep;
    if (step && step !== 'welcome' && step !== 'done') return step;
    return 'await_username';
  }

  walletMenuButtons(): RampReply {
    return {
      type: 'buttons',
      header: this.brandName(),
      body: 'Your Stellar wallet',
      footer: 'Balance · Transfer · Address',
      buttons: [
        { id: 'wallet_balance', title: 'Balance' },
        { id: 'wallet_transfer', title: 'Transfer' },
        { id: 'wallet_address', title: 'My address' },
      ],
    };
  }

  /** After a balance check — CTAs like Xara (fund / transfer / refresh + ramp). */
  balanceActionButtons(body: string, opts?: { offerCelo?: boolean }): RampReply {
    return this.balanceHubButtons(body, opts);
  }

  welcomeButtons(opts?: {
    username?: string | null;
    whatsappName?: string | null;
    contactName?: string | null;
  }): RampReply {
    const brand = this.brandName();
    const name = greetName({
      username: opts?.username,
      whatsappName: opts?.whatsappName || opts?.contactName,
    });
    const greet = name ? `Hey ${name} 👋` : 'Hey there 👋';
    const chains = getRampConfig().chainsLabel;
    return {
      type: 'list',
      header: brand,
      body: [
        greet,
        '',
        `${brand} here — buy & sell USDC for Naira in WhatsApp.`,
        `We support ${chains}.`,
        '',
        'Tap Get started to continue.',
      ].join('\n'),
      footer: `${chains} ↔ NGN`,
      button: 'Get started',
      sections: [
        {
          title: 'Start here',
          rows: [
            {
              id: 'onboard_start',
              title: 'Create account',
              description: 'Username, email, PIN + wallet',
            },
            {
              id: 'menu_rates',
              title: 'See rates',
              description: 'USDC to NGN and back',
            },
            {
              id: 'onboard_how',
              title: 'How it works',
              description: 'Buy, sell, transfer in chat',
            },
          ],
        },
      ],
    };
  }

  private howItWorksText(): string {
    const brand = this.brandName();
    return [
      `How ${brand} works`,
      '',
      `Buy: you pay NGN → we send USDC into your ${brand} smart wallet (Stellar) or Celo address.`,
      `Sell: USDC in your wallet → we pay NGN to your bank.`,
      '',
      'You’ll set a username, email, and PIN. We create your Stellar smart wallet automatically.',
      'From Wallet you can check balance, transfer USDC, or copy your deposit address.',
    ].join('\n');
  }

  /**
   * @returns replies if handled; null if not in onboarding
   */
  async handleOnboarding({
    phone,
    text,
    buttonId,
    contactName,
    flowOnboard,
  }: {
    phone: string;
    text: string;
    buttonId?: string | null;
    contactName?: string | null;
    flowOnboard?: {
      username: string;
      email: string;
      pin: string;
      pinConfirm: string;
    } | null;
  }): Promise<RampReply | RampReply[] | null> {
    let user: RampUser | null;
    try {
      user = await this.store.getUser(phone);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn({ err: message }, '[zylo-ramp] getUser failed during onboarding');
      return {
        type: 'text',
        text: 'Account setup needs a quick DB update. Operator: run npm run migrate',
      };
    }

    if (contactName) {
      try {
        user = (await this.store.upsertUser(phone, { whatsappName: contactName })) || user;
      } catch {
        /* ignore */
      }
    }

    // Migrate legacy Soroban C… → classic G… (idempotent). Celo stays optional.
    if (
      user?.isOnboarded &&
      user.pinHash &&
      user.zyloWallet &&
      /^C[A-Z0-9]{55}$/i.test(user.zyloWallet) &&
      this.stellarWallets.isClassicConfigured()
    ) {
      try {
        const result = await this.stellarWallets.migrateToClassicIfNeeded(phone);
        user = (await this.store.getUser(phone)) || user;
        if (result.notifiedNeeded && result.wallet) {
          // Quiet: short notice + Stellar address/QR only (no full signup stack / menu / Celo).
          return [
            {
              type: 'text',
              text: [
                'We’ve upgraded your Stellar wallet to a classic address (works in Lobstr & most apps).',
                'Your balance was moved over. Use this *new* deposit address going forward.',
              ].join('\n'),
            },
            walletAddressReplies({
              brandName: this.brandName(),
              phone,
              wallet: result.wallet,
              switchToCelo: false,
            }),
          ];
        }
      } catch (e) {
        this.logger.warn(
          { err: e instanceof Error ? e.message : String(e), phone },
          '[zylo-ramp] C→G migration failed',
        );
      }
    }

    // Flow popup completed (username + email + PIN)
    if (flowOnboard || buttonId === 'onboard_flow_done') {
      if (this.hasWallet(user) && user?.isOnboarded) {
        return this.mainMenuButtons(user);
      }
      return this.completeFromFlow(phone, flowOnboard || null, contactName || user?.whatsappName);
    }

    const btn = buttonId || null;
    const lower = (text || '').trim().toLowerCase();
    const wantsContinue =
      btn === 'onboard_start' ||
      btn === 'onboard_continue' ||
      lower === 'complete onboarding' ||
      lower === 'continue signup' ||
      lower === 'create account';

    // Fully set up with a wallet → leave to main commands
    if (this.hasWallet(user) && user?.isOnboarded && !wantsContinue) {
      return null;
    }

    // Profile done but wallet missing → provision on tap
    if (
      user?.isOnboarded &&
      user.pinHash &&
      user.username &&
      !this.hasWallet(user) &&
      (wantsContinue ||
        btn === 'menu_home' ||
        lower === 'menu' ||
        lower === 'hi' ||
        lower === 'hello')
    ) {
      if (wantsContinue) {
        return this.provisionMissingWallet(phone);
      }
      return this.incompleteMenuButtons(user);
    }

    const config = getRampConfig();
    const softNav =
      btn === 'menu_rates' ||
      btn === 'onboard_how' ||
      btn === 'menu_home' ||
      ['hi', 'hello', 'menu', 'help', 'start', 'cancel'].includes(lower);

    // Fresh chat — no saved signup fields yet
    if (!user?.isOnboarded && !this.hasStartedSignup(user)) {
      if (btn === 'onboard_how') {
        return [
          { type: 'text', text: this.howItWorksText() },
          this.welcomeButtons({
            username: user?.username,
            whatsappName: user?.whatsappName,
            contactName,
          }),
        ];
      }
      if (btn === 'menu_rates') {
        return [
          {
            type: 'text',
            text: [
              'Rates (NGN per 1 USDC)',
              `• sell USDC → ₦${config.rates.sellNgn}`,
              `• buy USDC  → ₦${config.rates.buyNgn}`,
              '',
              'Create an account to trade.',
            ].join('\n'),
          },
          this.welcomeButtons({
            username: user?.username,
            whatsappName: user?.whatsappName,
            contactName,
          }),
        ];
      }
      if (wantsContinue) {
        return this.beginOrResumeSignup(phone, contactName || user?.whatsappName);
      }
      // Actively collecting username — don't reset to welcome
      if (user?.onboardingStep === 'await_username') {
        // fall through to step handlers below
      } else {
        await this.store.upsertUser(phone, {
          onboardingStep: 'welcome',
          whatsappName: contactName || user?.whatsappName || null,
        });
        return this.welcomeButtons({
          username: user?.username,
          whatsappName: user?.whatsappName,
          contactName,
        });
      }
    }

    // Soft nav while mid-signup — don't wipe progress
    if (!user?.isOnboarded && this.hasStartedSignup(user) && softNav && !wantsContinue) {
      if (btn === 'onboard_how') {
        return [{ type: 'text', text: this.howItWorksText() }, this.incompleteMenuButtons(user)];
      }
      if (btn === 'menu_rates') {
        return [
          {
            type: 'text',
            text: [
              'Rates (NGN per 1 USDC)',
              `• sell USDC → ₦${config.rates.sellNgn}`,
              `• buy USDC  → ₦${config.rates.buyNgn}`,
            ].join('\n'),
          },
          this.incompleteMenuButtons(user),
        ];
      }
      return this.incompleteMenuButtons(user);
    }

    if (wantsContinue && !this.hasWallet(user)) {
      return this.beginOrResumeSignup(phone, contactName || user?.whatsappName);
    }

    // Soft nav while waiting on username (before any field saved)
    if (
      !user?.isOnboarded &&
      user?.onboardingStep === 'await_username' &&
      !user.username &&
      softNav &&
      !wantsContinue
    ) {
      return this.beginOrResumeSignup(phone, contactName || user?.whatsappName);
    }

    const step = this.nextSignupStep(user);

    if (step === 'await_wallet') {
      return this.provisionMissingWallet(phone);
    }

    if (step === 'await_username') {
      const username = (text || '').trim().replace(/^@/, '').toLowerCase();
      if (!USERNAME_RE.test(username)) {
        return {
          type: 'text',
          text: [
            'Pick a username — type it in the message box below ⬇️',
            '',
            '3–20 characters (letters, numbers, _).',
            'Example: your_name',
          ].join('\n'),
        };
      }
      if (await this.store.isUsernameTaken(username, phone)) {
        return {
          type: 'text',
          text: `“${username}” is taken. Try another one below ⬇️`,
        };
      }
      await this.store.upsertUser(phone, { username, onboardingStep: 'await_email' });
      return {
        type: 'text',
        text: [`Nice, @${username} is yours ✅`, '', 'Next — type your email below ⬇️'].join('\n'),
      };
    }

    if (step === 'await_email') {
      const email = (text || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) {
        return {
          type: 'text',
          text: "That doesn't look like an email. Type it below ⬇️",
        };
      }
      await this.store.upsertUser(phone, { email, onboardingStep: 'await_pin' });
      return {
        type: 'text',
        text: [
          'Email saved ✅',
          '',
          'Create a 4-digit PIN (don’t reuse a bank PIN — it shows in this chat).',
          '',
          'Type your PIN below ⬇️',
        ].join('\n'),
      };
    }

    if (step === 'await_pin') {
      const pin = (text || '').trim();
      if (!PIN_RE.test(pin)) {
        return {
          type: 'text',
          text: 'PIN must be exactly 4 digits. Type it below ⬇️',
        };
      }
      const pinSetupHash = await bcrypt.hash(pin, 10);
      await this.store.upsertUser(phone, { pinSetupHash, onboardingStep: 'await_pin_confirm' });
      return {
        type: 'text',
        text: 'One more time — type the same PIN to confirm ⬇️',
      };
    }

    if (step === 'await_pin_confirm') {
      const pin = (text || '').trim();
      if (!PIN_RE.test(pin)) {
        return {
          type: 'text',
          text: 'PIN must be exactly 4 digits. Confirm again below ⬇️',
        };
      }
      const fresh = await this.store.getUser(phone);
      const ok = fresh?.pinSetupHash && (await bcrypt.compare(pin, fresh.pinSetupHash));
      if (!ok) {
        await this.store.upsertUser(phone, { pinSetupHash: null, onboardingStep: 'await_pin' });
        return {
          type: 'text',
          text: "Those didn't match. Type a new 4-digit PIN below ⬇️",
        };
      }
      return this.finishOnboarding(phone, pin);
    }

    // Fallback
    if (!this.hasWallet(user)) {
      if (this.hasStartedSignup(user)) return this.incompleteMenuButtons(user);
      return this.welcomeButtons({
        username: user?.username,
        whatsappName: user?.whatsappName,
        contactName,
      });
    }

    return null;
  }

  /** Open Flow form if configured; otherwise resume the current chat step. */
  private async beginOrResumeSignup(
    phone: string,
    contactName?: string | null,
  ): Promise<RampReply | RampReply[]> {
    const user = await this.store.getUser(phone);
    const flowId = getRampConfig().whatsapp.onboardFlowId;
    const step = this.nextSignupStep(user);

    if (step === 'await_wallet' || (user?.pinHash && !this.hasWallet(user))) {
      return this.provisionMissingWallet(phone);
    }

    // Full form only when nothing is saved yet (don't wipe partial signup)
    if (flowId && step === 'await_username' && !user?.username) {
      await this.store.upsertUser(phone, {
        onboardingStep: 'await_username',
        whatsappName: contactName || user?.whatsappName || null,
      });
      return {
        type: 'flow',
        header: this.brandName(),
        body: 'Tap below to open the signup form — username, email, and PIN.',
        footer: 'Takes about a minute',
        flowId,
        flowToken: `zylo_onboard_${phone}_${Date.now()}`,
        cta: 'Open form',
        screen: 'ACCOUNT',
      };
    }

    if (step === 'await_email') {
      await this.store.upsertUser(phone, { onboardingStep: 'await_email' });
      return {
        type: 'text',
        text: [`Welcome back, @${user?.username}.`, '', 'Type your email below ⬇️'].join('\n'),
      };
    }
    if (step === 'await_pin') {
      await this.store.upsertUser(phone, { onboardingStep: 'await_pin' });
      return {
        type: 'text',
        text: [
          'Welcome back — create your 4-digit PIN below ⬇️',
          user?.email ? `(Email saved: ${user.email})` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      };
    }
    if (step === 'await_pin_confirm') {
      await this.store.upsertUser(phone, { onboardingStep: 'await_pin_confirm' });
      return {
        type: 'text',
        text: 'Type your 4-digit PIN once more to confirm ⬇️',
      };
    }

    await this.store.upsertUser(phone, {
      onboardingStep: 'await_username',
      whatsappName: contactName || user?.whatsappName || null,
    });
    return {
      type: 'text',
      text: [
        `Let's set up your ${this.brandName()} account ✨`,
        '',
        'Step 1 of 3 — pick a username.',
        'Type it in the message box below ⬇️',
        '',
        '3–20 characters (letters, numbers, _).',
        'Example: your_name',
        '',
        'Friends can send you USDC with:',
        'send 1 usdc to your_name',
      ].join('\n'),
    };
  }

  private async provisionMissingWallet(phone: string): Promise<RampReply | RampReply[]> {
    const user = await this.store.getUser(phone);
    if (!user?.username || !user.pinHash) {
      return this.beginOrResumeSignup(phone, user?.whatsappName);
    }
    const zyloWallet = await this.waitForStellarWallet(phone);
    if (!zyloWallet || !/^G[A-Z0-9]{55}$/i.test(zyloWallet)) {
      this.scheduleWalletProvision(phone);
      return [
        {
          type: 'text',
          text: [
            'Your profile is saved ✅',
            '',
            'Still creating your Stellar wallet (can take up to a minute).',
            'We’ll message you when it’s ready — or tap Continue signup in ~30s.',
          ].join('\n'),
        },
        this.incompleteMenuButtons(user),
      ];
    }
    return this.walletReadyReplies(phone, zyloWallet);
  }

  /** Wait briefly for classic G… provision. */
  private async waitForStellarWallet(phone: string): Promise<string | null> {
    try {
      const stellarP = this.stellarWallets.provisionWallet(phone);
      const raced = await Promise.race([
        stellarP,
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), WALLET_WAIT_MS);
        }),
      ]);
      if (!raced) {
        void stellarP.catch(() => undefined);
        return null;
      }
      return raced;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error({ err: message, phone }, '[zylo-ramp] wallet provision failed');
      return null;
    }
  }

  /**
   * Keep registering after the chat timeout so a late success isn’t thrown away.
   * Notifies the user on WhatsApp when the G… address is ready.
   */
  private scheduleWalletProvision(phone: string): void {
    void (async () => {
      try {
        const wallet = await this.stellarWallets.provisionWallet(phone);
        if (!wallet || !/^G[A-Z0-9]{55}$/i.test(wallet)) return;
        const existing = await this.store.getUser(phone);
        await this.store.upsertUser(phone, {
          zyloWallet: wallet,
          onboardingStep: 'done',
          onboardedAt: existing?.onboardedAt || new Date(),
        });
        const replies = await this.walletReadyReplies(phone, wallet);
        await this.whatsapp.dispatchReplies(phone, replies);
        this.logger.info({ phone, wallet }, '[zylo-ramp] background G wallet ready + notified');
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.logger.error(
          { err: message, phone },
          '[zylo-ramp] background wallet provision failed',
        );
      }
    })();
  }

  private async walletReadyReplies(phone: string, zyloWallet: string): Promise<RampReply[]> {
    const done = await this.store.upsertUser(phone, {
      zyloWallet,
      onboardingStep: 'done',
      onboardedAt: new Date(),
    });
    const handoff = walletSignupHandoffReplies({
      brandName: this.brandName(),
      phone,
      username: done?.username,
      wallet: zyloWallet,
      celoWallet: done?.celoWallet,
    });
    return handoff;
  }

  private async completeFromFlow(
    phone: string,
    data: {
      username: string;
      email: string;
      pin: string;
      pinConfirm: string;
    } | null,
    contactName?: string | null,
  ): Promise<RampReply | RampReply[]> {
    const flowId = getRampConfig().whatsapp.onboardFlowId;
    const reopen = (): RampReply =>
      flowId
        ? {
            type: 'flow',
            header: this.brandName(),
            body: 'Fix the details below and submit again.',
            flowId,
            flowToken: `zylo_onboard_${phone}_${Date.now()}`,
            cta: 'Open form',
            screen: 'ACCOUNT',
          }
        : {
            type: 'text',
            text: 'Reply with a username to continue signup in chat.',
          };

    if (!data) {
      return [{ type: 'text', text: 'Signup form was empty. Try again.' }, reopen()];
    }

    const username = data.username.trim().replace(/^@/, '').toLowerCase();
    const email = data.email.trim().toLowerCase();
    const pin = String(data.pin).trim();
    const pinConfirm = String(data.pinConfirm || '').trim();

    if (!USERNAME_RE.test(username)) {
      return [
        {
          type: 'text',
          text: 'Username must be 3–20 characters (letters, numbers, _).',
        },
        reopen(),
      ];
    }
    if (await this.store.isUsernameTaken(username, phone)) {
      return [{ type: 'text', text: `“${username}” is taken. Pick another username.` }, reopen()];
    }
    if (!EMAIL_RE.test(email)) {
      return [{ type: 'text', text: "That doesn't look like an email." }, reopen()];
    }
    if (!PIN_RE.test(pin) || !PIN_RE.test(pinConfirm)) {
      return [{ type: 'text', text: 'PIN must be exactly 4 digits.' }, reopen()];
    }
    if (pin !== pinConfirm) {
      return [{ type: 'text', text: "PINs didn't match. Try again." }, reopen()];
    }

    await this.store.upsertUser(phone, {
      username,
      email,
      whatsappName: contactName || null,
      onboardingStep: 'await_pin_confirm',
    });
    return this.finishOnboarding(phone, pin);
  }

  private async finishOnboarding(phone: string, pin: string): Promise<RampReply | RampReply[]> {
    const pinHash = await bcrypt.hash(pin, 10);
    await this.store.upsertUser(phone, {
      pinHash,
      pinSetupHash: null,
      onboardingStep: 'done',
      onboardedAt: new Date(),
    });

    const zyloWallet = await this.waitForStellarWallet(phone);
    if (!zyloWallet || !/^G[A-Z0-9]{55}$/i.test(zyloWallet)) {
      this.scheduleWalletProvision(phone);
      const user = await this.store.getUser(phone);
      return [
        {
          type: 'text',
          text: [
            `You're in, ${user?.username || 'there'} ✅`,
            '',
            'Profile + PIN saved.',
            'Creating your Stellar wallet now — this can take up to a minute.',
            'We’ll ping you here when it’s ready (or tap Continue signup shortly).',
          ].join('\n'),
        },
        this.incompleteMenuButtons(user),
      ];
    }

    return this.walletReadyReplies(phone, zyloWallet);
  }

  async verifyUserPin(phone: string, pin: string): Promise<boolean> {
    const user = await this.store.getUser(phone);
    if (!user?.pinHash) return false;
    if (!PIN_RE.test(String(pin || ''))) return false;
    return bcrypt.compare(String(pin), user.pinHash);
  }

  /** Replace PIN after the caller has already verified the current one. */
  async setUserPin(phone: string, newPin: string): Promise<boolean> {
    if (!PIN_RE.test(String(newPin || ''))) return false;
    const pinHash = await bcrypt.hash(newPin, 10);
    await this.store.upsertUser(phone, { pinHash, pinSetupHash: null });
    return true;
  }
}

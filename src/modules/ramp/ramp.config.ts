/**
 * WhatsApp USDC ↔ NGN ramp config (env-driven).
 * Enable with WA_RAMP_ENABLED=true (or set WHATSAPP_TOKEN).
 *
 * Phone numbers:
 * - WHATSAPP_PHONE_NUMBER_ID       = test / default
 * - WHATSAPP_PHONE_NUMBER_ID_LIVE  = production (preferred when set)
 * Inbound webhooks reply using the phone_number_id Meta sends in the payload.
 */

import { getAddress } from 'ethers';

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function isRampEnabled(): boolean {
  if (process.env.WA_RAMP_ENABLED === 'false') return false;
  if (process.env.WA_RAMP_ENABLED === 'true') return true;
  return Boolean(
    process.env.WHATSAPP_TOKEN &&
    (process.env.WHATSAPP_PHONE_NUMBER_ID_LIVE || process.env.WHATSAPP_PHONE_NUMBER_ID),
  );
}

/** True when ramp is on but cannot actually send WhatsApp messages. */
export function isRampMisconfigured(): boolean {
  if (!isRampEnabled()) return false;
  const token = process.env.WHATSAPP_TOKEN || '';
  const phoneId =
    process.env.WHATSAPP_PHONE_NUMBER_ID_LIVE || process.env.WHATSAPP_PHONE_NUMBER_ID || '';
  return !token || !phoneId;
}

/** Prefer live ID when configured; else test/default. */
export function resolveWhatsAppPhoneNumberId(override?: string | null): string {
  if (override) return String(override);
  return process.env.WHATSAPP_PHONE_NUMBER_ID_LIVE || process.env.WHATSAPP_PHONE_NUMBER_ID || '';
}

/**
 * Meta Flow ids are numeric strings. Empty / garbage values cause (#131009)
 * and break the PIN step — treat those as “no Flow, use chat PIN”.
 */
export function usableWhatsAppFlowId(raw: string | null | undefined): string {
  const id = String(raw || '').trim();
  if (!/^\d{8,30}$/.test(id)) return '';
  return id;
}

/** PIN popup only when explicitly enabled (chat PIN is the default). */
export function pinFlowEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(String(process.env.WA_RAMP_PIN_FLOW_ENABLED || '').trim());
}

/** Celo mainnet Circle USDC / Mento cUSD / bridged USDT defaults (EIP-55). */
const CELO_MAINNET_USDC = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C';
const CELO_MAINNET_CUSD = '0x765de816845861e75A25Fca8693AA1d4d8e6cDd6';
const CELO_MAINNET_USDT = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e';

/** Accept hex EOAs; return EIP-55 checksummed or '' if invalid. */
function ethAddressOrEmpty(value: string): string {
  const v = String(value || '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(v)) return '';
  try {
    return getAddress(v.toLowerCase());
  } catch {
    return '';
  }
}

export interface RampConfig {
  brandName: string;
  /** Public web portal URL (WhatsApp “web” / “portal” command). */
  webPortalUrl: string;
  chainsLabel: string;
  whatsapp: {
    token: string;
    phoneNumberId: string;
    phoneNumberIdTest: string;
    phoneNumberIdLive: string;
    verifyToken: string;
    /** Meta WhatsApp Flow id for PIN popup (passcode). Optional. */
    pinFlowId: string;
    /** Meta WhatsApp Flow id for signup popup (username/email/PIN). Optional. */
    onboardFlowId: string;
  };
  celo: {
    rpcUrl: string;
    depositAddress: string;
    usdcAddress: string;
    usdtAddress: string;
    cusdAddress: string;
    /** BIP-39 mnemonic for per-user HD EOAs (index 0 = gas sponsor). */
    hdMnemonic: string;
  };
  stellar: {
    depositAddress: string;
    usdcIssuer: string;
    /** Circle USDC SAC contract id (C...) — used for legacy Soroban drain. */
    usdcContractId: string;
    /** Native XLM SAC contract id (C...) — used for legacy Soroban drain. */
    xlmContractId: string;
    /** Soroban factory — kept for draining legacy C… wallets. */
    factoryContractId: string;
    rpcUrl: string;
    /** Horizon URL for classic G… accounts. */
    horizonUrl: string;
    networkPassphrase: string;
    /** Operator secret (S...) — createAccount, fees, legacy C… transfers. */
    operatorSecret: string;
    /**
     * BIP-39 mnemonic for per-user classic G… keypairs.
     * When set, new wallets are G… (not factory C…).
     */
    hdMnemonic: string;
    /** XLM sent on createAccount (covers reserves + USDC trustline + fees). */
    activationXlm: number;
  };
  ngn: {
    bankName: string;
    accountNumber: string;
    accountName: string;
  };
  rates: {
    sellNgn: number;
    buyNgn: number;
  };
  /** Flat NGN fee deducted from sell payout (itemized; never folded into rate). */
  sellFeeNgn: number;
  /** How long a sell quote stays valid before re-quote is required. */
  rateQuoteSeconds: number;
  maxOrderUsdc: number;
  /** Max XLM transfer via WhatsApp (separate from USDC ramp float). */
  maxTransferXlm: number;
  orderTtlMinutes: number;
  adminWhatsappNumber: string;
  /**
   * Platform tenant for Naira ledger + FalconPay payouts from WhatsApp.
   * When set, bank sends credit the linked User wallet then call PayoutService.
   */
  tenantId: string;
  /** Max NGN per WhatsApp bank send. */
  maxBankSendNgn: number;
  /** Min NGN per WhatsApp bank send. */
  minBankSendNgn: number;
}

/** Runtime overrides from `zylo_ramp_settings` (admin dashboard). Env remains fallback. */
export type RampRateOverrides = {
  sellNgn?: number;
  buyNgn?: number;
  maxOrderUsdc?: number;
  maxBankSendNgn?: number;
  minBankSendNgn?: number;
  sellFeeNgn?: number;
  updatedAt?: string;
};

let rateOverrides: RampRateOverrides = {};

export function applyRampRateOverrides(next: RampRateOverrides): void {
  rateOverrides = { ...rateOverrides, ...next };
}

export function getRampRateOverrides(): RampRateOverrides {
  return { ...rateOverrides };
}

export function getRampConfig(): RampConfig {
  return {
    brandName: process.env.WA_RAMP_BRAND_NAME || process.env.ZYLO_BRAND_NAME || 'Banjee',
    webPortalUrl: (
      process.env.WA_RAMP_WEB_PORTAL_URL ||
      process.env.ZYLO_WEB_PORTAL_URL ||
      'https://zylo-iota-eight.vercel.app'
    ).replace(/\/$/, ''),
    chainsLabel: process.env.WA_RAMP_CHAINS_LABEL || 'Celo & Stellar',
    whatsapp: {
      token: process.env.WHATSAPP_TOKEN || '',
      phoneNumberId: resolveWhatsAppPhoneNumberId(),
      phoneNumberIdTest: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
      phoneNumberIdLive: process.env.WHATSAPP_PHONE_NUMBER_ID_LIVE || '',
      verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || 'wa-ramp-verify',
      pinFlowId: usableWhatsAppFlowId(
        process.env.WA_RAMP_PIN_FLOW_ID || process.env.WHATSAPP_PIN_FLOW_ID || '',
      ),
      onboardFlowId: usableWhatsAppFlowId(
        process.env.WA_RAMP_ONBOARD_FLOW_ID || process.env.WHATSAPP_ONBOARD_FLOW_ID || '',
      ),
    },
    celo: {
      rpcUrl:
        process.env.CELO_RPC_URL || process.env.WA_RAMP_CELO_RPC_URL || 'https://forno.celo.org',
      depositAddress:
        process.env.WA_RAMP_CELO_DEPOSIT_ADDRESS || process.env.CELO_DEPOSIT_ADDRESS || '',
      usdcAddress:
        ethAddressOrEmpty(
          process.env.WA_RAMP_CELO_USDC_ADDRESS ||
            process.env.WA_RAMP_USDC_ADDRESS ||
            process.env.CELO_USDC_ADDRESS ||
            process.env.USDC_ADDRESS ||
            '',
        ) || CELO_MAINNET_USDC,
      usdtAddress:
        ethAddressOrEmpty(process.env.WA_RAMP_CELO_USDT_ADDRESS || '') || CELO_MAINNET_USDT,
      cusdAddress:
        ethAddressOrEmpty(process.env.WA_RAMP_CELO_CUSD_ADDRESS || '') || CELO_MAINNET_CUSD,
      hdMnemonic: (process.env.WA_RAMP_CELO_HD_MNEMONIC || '').trim(),
    },
    stellar: {
      depositAddress:
        process.env.WA_RAMP_STELLAR_DEPOSIT_ADDRESS || process.env.STELLAR_DEPOSIT_ADDRESS || '',
      usdcIssuer: process.env.WA_RAMP_STELLAR_USDC_ISSUER || '',
      usdcContractId: (() => {
        const fromEnv =
          process.env.WA_RAMP_STELLAR_USDC_CONTRACT || process.env.STELLAR_USDC_CONTRACT || '';
        if (fromEnv) return fromEnv;
        const passphrase =
          process.env.WA_RAMP_STELLAR_NETWORK_PASSPHRASE ||
          process.env.STELLAR_NETWORK_PASSPHRASE ||
          '';
        if (passphrase.includes('Public Global')) {
          return 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75';
        }
        return 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
      })(),
      xlmContractId: (() => {
        const fromEnv =
          process.env.WA_RAMP_STELLAR_XLM_CONTRACT || process.env.STELLAR_XLM_CONTRACT || '';
        if (fromEnv) return fromEnv;
        const passphrase =
          process.env.WA_RAMP_STELLAR_NETWORK_PASSPHRASE ||
          process.env.STELLAR_NETWORK_PASSPHRASE ||
          '';
        if (passphrase.includes('Public Global')) {
          return 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA';
        }
        return 'CDLZFC3SYJYDZT7K67MOJMPAIC4HMHIAEMCMBY46JGOVEUZOZK37XFAD';
      })(),
      factoryContractId:
        process.env.WA_RAMP_STELLAR_FACTORY_ID || process.env.STELLAR_FACTORY_CONTRACT_ID || '',
      rpcUrl:
        process.env.WA_RAMP_STELLAR_RPC_URL ||
        process.env.STELLAR_RPC_URL ||
        'https://soroban-testnet.stellar.org',
      horizonUrl: (() => {
        const fromEnv =
          process.env.WA_RAMP_STELLAR_HORIZON_URL || process.env.STELLAR_HORIZON_URL || '';
        if (fromEnv) return fromEnv;
        const passphrase =
          process.env.WA_RAMP_STELLAR_NETWORK_PASSPHRASE ||
          process.env.STELLAR_NETWORK_PASSPHRASE ||
          '';
        if (passphrase.includes('Public Global')) {
          return 'https://horizon.stellar.org';
        }
        return 'https://horizon-testnet.stellar.org';
      })(),
      networkPassphrase:
        process.env.WA_RAMP_STELLAR_NETWORK_PASSPHRASE ||
        process.env.STELLAR_NETWORK_PASSPHRASE ||
        'Test SDF Network ; September 2015',
      operatorSecret:
        process.env.WA_RAMP_STELLAR_OPERATOR_SECRET || process.env.STELLAR_OPERATOR_SECRET || '',
      hdMnemonic: (process.env.WA_RAMP_STELLAR_HD_MNEMONIC || '').trim(),
      activationXlm: num('WA_RAMP_STELLAR_ACTIVATION_XLM', 2),
    },
    ngn: {
      bankName: process.env.WA_RAMP_NGN_BANK_NAME || process.env.NGN_BANK_NAME || 'Opay',
      accountNumber: process.env.WA_RAMP_NGN_ACCOUNT_NUMBER || process.env.NGN_ACCOUNT_NUMBER || '',
      accountName: process.env.WA_RAMP_NGN_ACCOUNT_NAME || process.env.NGN_ACCOUNT_NAME || '',
    },
    rates: {
      sellNgn: rateOverrides.sellNgn ?? num('WA_RAMP_RATE_SELL_NGN', num('RATE_SELL_NGN', 1550)),
      buyNgn: rateOverrides.buyNgn ?? num('WA_RAMP_RATE_BUY_NGN', num('RATE_BUY_NGN', 1600)),
    },
    sellFeeNgn: Math.max(0, Math.round(rateOverrides.sellFeeNgn ?? num('WA_RAMP_SELL_FEE_NGN', 0))),
    rateQuoteSeconds: Math.max(30, Math.round(num('WA_RAMP_RATE_QUOTE_SECONDS', 90))),
    maxOrderUsdc:
      rateOverrides.maxOrderUsdc ?? num('WA_RAMP_MAX_ORDER_USDC', num('MAX_ORDER_USDC', 1)),
    maxTransferXlm: num('WA_RAMP_MAX_TRANSFER_XLM', 10),
    orderTtlMinutes: num('WA_RAMP_ORDER_TTL_MINUTES', num('ORDER_TTL_MINUTES', 20)),
    adminWhatsappNumber: (
      process.env.WA_RAMP_ADMIN_WHATSAPP_NUMBER ||
      process.env.ADMIN_WHATSAPP_NUMBER ||
      ''
    ).replace(/\D/g, ''),
    tenantId: process.env.WA_RAMP_TENANT_ID || process.env.ZYLO_RAMP_TENANT_ID || '',
    maxBankSendNgn: rateOverrides.maxBankSendNgn ?? num('WA_RAMP_MAX_BANK_SEND_NGN', 500_000),
    minBankSendNgn: rateOverrides.minBankSendNgn ?? num('WA_RAMP_MIN_BANK_SEND_NGN', 100),
  };
}

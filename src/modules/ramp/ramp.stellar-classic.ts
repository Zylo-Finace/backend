import { createHash } from 'node:crypto';

/** Circle USDC / Stellar amounts use 7 decimal places. */
const USDC_DECIMALS = 7;

export function isClassicStellarAddress(addr: string | null | undefined): boolean {
  return Boolean(addr && /^G[A-Z0-9]{55}$/i.test(addr));
}

export function isContractStellarAddress(addr: string | null | undefined): boolean {
  return Boolean(addr && /^C[A-Z0-9]{55}$/i.test(addr));
}

/**
 * Deterministic ed25519 seed for classic G… custody.
 * Feed into `Keypair.fromRawEd25519Seed`.
 */
export function stellarClassicSeed(phone: string, hdMnemonic: string): Buffer {
  const digits = String(phone || '').replace(/\D/g, '');
  return createHash('sha256')
    .update(`zylo:stellar:classic:${hdMnemonic.trim()}:${digits}`)
    .digest();
}

export function formatSacAmount(raw: bigint): string {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const whole = abs / 10n ** BigInt(USDC_DECIMALS);
  const frac = abs % 10n ** BigInt(USDC_DECIMALS);
  const fracStr = frac.toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  const body = fracStr ? `${whole}.${fracStr}` : whole.toString();
  return neg ? `-${body}` : body;
}

export function formatUsdcAmount(raw: bigint): string {
  return formatSacAmount(raw);
}

export function usdcToStroops(amount: number): bigint {
  const scaled = Math.round(amount * 10 ** USDC_DECIMALS);
  return BigInt(scaled);
}

/**
 * Stable user_id bytes for factory.register — SHA-256 of `zylo:{e164Phone}`.
 */
export function stellarUserIdBytes(phone: string): Buffer {
  const normalized = String(phone || '').replace(/\D/g, '');
  return createHash('sha256').update(`zylo:${normalized}`).digest();
}

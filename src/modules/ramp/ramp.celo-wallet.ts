import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { Contract, HDNodeWallet, JsonRpcProvider, Wallet, formatUnits, parseUnits } from 'ethers';
import { PinoLogger } from 'nestjs-pino';

import { getRampConfig } from './ramp.config';
import { RampStoreService } from './ramp.store';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
] as const;

type Erc20 = {
  balanceOf: (owner: string) => Promise<bigint>;
  decimals: () => Promise<number | bigint>;
  transfer: (
    to: string,
    amount: bigint,
  ) => Promise<{ hash: string; wait: () => Promise<{ hash?: string } | null> }>;
};

/** Gas dust sent from sponsor when a user EOA cannot pay fees (~0.01 CELO). */
const GAS_TOPUP_WEI = parseUnits('0.01', 18);

export type CeloStableSymbol = 'USDC' | 'USDT' | 'cUSD';

export type CeloStableBalances = {
  usdc: number;
  usdt: number;
  cusd: number;
  /** Sum at 1:1 — “digital dollars”. */
  total: number;
};

export type PreferredStable = {
  symbol: CeloStableSymbol;
  address: string;
  balance: number;
};

/**
 * Stable derivation index for a phone (1..2^31-1). Index 0 is reserved for gas sponsor.
 */
export function celoUserIndex(phone: string): number {
  const digits = String(phone || '').replace(/\D/g, '');
  const hash = createHash('sha256').update(`zylo:celo:${digits}`).digest();
  const n = hash.readUInt32BE(0) % 0x7ffffffe;
  return n + 1;
}

export function formatCeloStable(amount: number): string {
  if (!Number.isFinite(amount)) return '0';
  return amount.toFixed(6).replace(/\.?0+$/, '') || '0';
}

/** 1:1 sum of Celo stables (6dp). */
export function sumDigitalDollars(usdc: number, usdt: number, cusd: number): number {
  return Math.round((usdc + usdt + cusd) * 1e6) / 1e6;
}

/**
 * Prefer highest single stable that covers `needAmount` (Tycoon shop style).
 * Falls through lower balances if the top one is short.
 */
export function pickPreferredStable(
  balances: Pick<CeloStableBalances, 'usdc' | 'usdt' | 'cusd'>,
  needAmount: number,
): CeloStableSymbol | null {
  const ranked: Array<{ symbol: CeloStableSymbol; balance: number }> = [
    { symbol: 'USDC' as const, balance: balances.usdc },
    { symbol: 'USDT' as const, balance: balances.usdt },
    { symbol: 'cUSD' as const, balance: balances.cusd },
  ];
  ranked.sort((a, b) => b.balance - a.balance);

  for (const row of ranked) {
    if (row.balance + 1e-9 >= needAmount) return row.symbol;
  }
  return null;
}

/**
 * Custodial Celo EOAs (HD) + USDC/USDT/cUSD treated as 1:1 digital dollars.
 */
@Injectable()
export class RampCeloWalletService {
  constructor(
    private readonly store: RampStoreService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RampCeloWalletService.name);
  }

  private provider(): JsonRpcProvider {
    return new JsonRpcProvider(getRampConfig().celo.rpcUrl);
  }

  /** HD account for path m/44'/60'/0'/0/{index}. */
  walletForIndex(index: number): HDNodeWallet {
    const { hdMnemonic } = getRampConfig().celo;
    if (!hdMnemonic) {
      throw new Error('WA_RAMP_CELO_HD_MNEMONIC is not set');
    }
    // ethers fromPhrase defaults to m/44'/60'/0'/0/0; pass full path for other indices.
    if (index === 0) {
      return HDNodeWallet.fromPhrase(hdMnemonic);
    }
    return HDNodeWallet.fromPhrase(hdMnemonic, undefined, `m/44'/60'/0'/0/${index}`);
  }

  gasSponsor(): HDNodeWallet {
    return this.walletForIndex(0);
  }

  walletForPhone(phone: string): HDNodeWallet {
    return this.walletForIndex(celoUserIndex(phone));
  }

  isConfigured(): boolean {
    return Boolean(getRampConfig().celo.hdMnemonic);
  }

  /**
   * Derive + persist celoWallet. Idempotent.
   */
  async provisionWallet(phone: string): Promise<string | null> {
    if (!this.isConfigured()) {
      this.logger.warn('[zylo-ramp] Celo HD mnemonic missing — skip Celo provision');
      return null;
    }
    const normalized = String(phone || '').replace(/\D/g, '');
    const existing = await this.store.getUser(normalized);
    if (existing?.celoWallet && /^0x[a-fA-F0-9]{40}$/.test(existing.celoWallet)) {
      return existing.celoWallet;
    }

    const address = this.walletForPhone(normalized).address;
    await this.store.upsertUser(normalized, { celoWallet: address });
    this.logger.info({ phone: normalized, address }, '[zylo-ramp] Celo wallet provisioned');
    return address;
  }

  private tokenAddress(symbol: CeloStableSymbol): string {
    const { celo } = getRampConfig();
    if (symbol === 'USDC') return celo.usdcAddress;
    if (symbol === 'USDT') return celo.usdtAddress;
    return celo.cusdAddress;
  }

  async getStableBalances(address: string): Promise<CeloStableBalances> {
    const provider = this.provider();
    const owner = address;
    const read = async (symbol: CeloStableSymbol): Promise<number> => {
      const token = this.tokenAddress(symbol);
      if (!token || !/^0x[a-fA-F0-9]{40}$/.test(token)) return 0;
      try {
        const c = new Contract(token, ERC20_ABI, provider) as unknown as Erc20;
        const [raw, decimals] = await Promise.all([
          c.balanceOf(owner),
          c.decimals().catch(() => 6),
        ]);
        const d = Number(decimals);
        return Number(formatUnits(raw, d));
      } catch (e) {
        this.logger.warn(
          { err: e instanceof Error ? e.message : String(e), symbol, token },
          '[zylo-ramp] Celo balanceOf failed',
        );
        return 0;
      }
    };

    const [usdc, usdt, cusd] = await Promise.all([read('USDC'), read('USDT'), read('cUSD')]);
    return { usdc, usdt, cusd, total: sumDigitalDollars(usdc, usdt, cusd) };
  }

  /**
   * Prefer the highest single stable that covers `needAmount` (Tycoon shop style).
   * Falls through lower balances if the top one is short.
   */
  getPreferredStable(balances: CeloStableBalances, needAmount: number): PreferredStable | null {
    const symbol = pickPreferredStable(balances, needAmount);
    if (!symbol) return null;
    const balance =
      symbol === 'USDC' ? balances.usdc : symbol === 'USDT' ? balances.usdt : balances.cusd;
    return { symbol, address: this.tokenAddress(symbol), balance };
  }

  /**
   * Ensure the user EOA can pay gas, then ERC-20 transfer to `to`.
   */
  async transferStable(opts: {
    phone: string;
    to: string;
    amount: number;
    symbol?: CeloStableSymbol;
  }): Promise<{ txHash: string; symbol: CeloStableSymbol }> {
    const { phone, to, amount } = opts;
    if (!(amount > 0)) throw new Error('Invalid Celo transfer amount');
    if (!/^0x[a-fA-F0-9]{40}$/.test(to)) throw new Error('Invalid Celo destination');

    const user = this.walletForPhone(phone).connect(this.provider());
    const balances = await this.getStableBalances(user.address);
    const preferred =
      opts.symbol != null
        ? {
            symbol: opts.symbol,
            address: this.tokenAddress(opts.symbol),
            balance:
              opts.symbol === 'USDC'
                ? balances.usdc
                : opts.symbol === 'USDT'
                  ? balances.usdt
                  : balances.cusd,
          }
        : this.getPreferredStable(balances, amount);

    if (!preferred || preferred.balance + 1e-9 < amount) {
      throw new Error(
        `Insufficient Celo digital dollars. Need ~${formatCeloStable(amount)}, have ${formatCeloStable(balances.total)}.`,
      );
    }

    await this.ensureGas(user);

    const token = new Contract(preferred.address, ERC20_ABI, user) as unknown as Erc20;
    const decimals = Number(await token.decimals().catch(() => 6));
    const wei = parseUnits(amount.toFixed(Math.min(6, decimals)), decimals);
    const tx = await token.transfer(to, wei);
    const receipt = await tx.wait();
    const txHash = String(receipt?.hash || tx.hash);
    this.logger.info(
      { phone, to, amount, symbol: preferred.symbol, txHash },
      '[zylo-ramp] Celo stable transferred',
    );
    return { txHash, symbol: preferred.symbol };
  }

  private async ensureGas(user: Wallet | HDNodeWallet): Promise<void> {
    const provider = this.provider();
    const bal = await provider.getBalance(user.address);
    if (bal >= GAS_TOPUP_WEI / 2n) return;

    const sponsor = this.gasSponsor().connect(provider);
    const sponsorBal = await provider.getBalance(sponsor.address);
    if (sponsorBal < GAS_TOPUP_WEI * 2n) {
      throw new Error('Celo gas sponsor is low on CELO — fund the HD wallet index 0, then retry.');
    }
    const tx = await sponsor.sendTransaction({
      to: user.address,
      value: GAS_TOPUP_WEI,
    });
    await tx.wait();
    this.logger.info({ to: user.address, tx: tx.hash }, '[zylo-ramp] Celo gas top-up');
  }
}

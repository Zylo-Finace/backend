/** Shorten Stellar C/G addresses for chat display. */
export function shortStellarAddr(addr: string, head = 6, tail = 4): string {
  const a = String(addr || '');
  if (a.length <= head + tail + 1) return a;
  return `${a.slice(0, head)}…${a.slice(-tail)}`;
}

/** Shorten tx hashes for chat display. */
export function shortTxHash(hash: string, head = 8, tail = 6): string {
  const h = String(hash || '');
  if (h.length <= head + tail + 1) return h;
  return `${h.slice(0, head)}…${h.slice(-tail)}`;
}

/** Shorten PAY-/bs_ refs for receipt rows — keeps the date prefix readable. */
export function shortPaymentRef(ref: string, head = 18, tail = 8): string {
  const r = String(ref || '').trim();
  if (r.length <= head + tail + 1) return r;
  return `${r.slice(0, head)}…${r.slice(-tail)}`;
}

export function stellarTxUrl(hash: string): string {
  return `https://stellar.expert/explorer/public/tx/${hash}`;
}

export function stellarContractUrl(addr: string): string {
  return `https://stellar.expert/explorer/public/contract/${addr}`;
}

export function shortEvmAddr(addr: string, head = 6, tail = 4): string {
  const a = String(addr || '');
  if (a.length <= head + tail + 1) return a;
  return `${a.slice(0, head)}…${a.slice(-tail)}`;
}

export function celoTxUrl(hash: string): string {
  return `https://celoscan.io/tx/${hash}`;
}

/** One held asset on a chain (zeros should be omitted before calling). */
export type WalletBalanceLine = {
  symbol: string;
  /** Human amount (not stroops). */
  amount: number;
  /** Counts toward *Total: $…* (stables). XLM = false. */
  usd?: boolean;
};

export type WalletBalanceGroup = {
  chain: string;
  assets: WalletBalanceLine[];
};

export type FormatWalletBalanceOpts = {
  /** Shown next to wallet emoji, e.g. BANJEE */
  walletName?: string;
  /** chain (default) | asset */
  groupBy?: 'chain' | 'asset';
  /** Actions the user can actually take — joined with · */
  actions?: string[];
};

const DUST = 1e-12;

/**
 * Format a balance amount for WhatsApp: 2dp by default; keep finer digits when
 * the raw amount has meaningful precision below $0.01 (e.g. small XLM).
 */
export function formatBalanceAmount(amount: number): string {
  if (!Number.isFinite(amount)) return '0.00';
  const abs = Math.abs(amount);
  if (abs > 0 && abs < 0.01) {
    const s = amount.toFixed(7).replace(/\.?0+$/, '');
    return s || '0';
  }
  return amount.toFixed(2);
}

function alignMonospaceRows(rows: Array<{ label: string; amount: number }>): string {
  if (rows.length === 0) return '';
  const formatted = rows.map((r) => ({
    label: r.label,
    text: formatBalanceAmount(r.amount),
  }));
  const maxLabel = Math.max(...formatted.map((r) => r.label.length));
  const maxInt = Math.max(
    ...formatted.map((r) => {
      const i = r.text.indexOf('.');
      return i >= 0 ? i : r.text.length;
    }),
  );
  return formatted
    .map((r) => {
      const dot = r.text.indexOf('.');
      const intPart = dot >= 0 ? r.text.slice(0, dot) : r.text;
      const frac = dot >= 0 ? r.text.slice(dot) : '';
      const label = r.label.padEnd(maxLabel, ' ');
      const amt = intPart.padStart(maxInt, ' ') + frac;
      return `${label}  ${amt}`;
    })
    .join('\n');
}

/**
 * Concise WhatsApp wallet balance body (*bold*, ```monospace```).
 * Omits zero balances; USD total is sum of usd-flagged assets only.
 */
export function formatWhatsAppWalletBalance(
  groups: WalletBalanceGroup[],
  opts: FormatWalletBalanceOpts = {},
): string {
  const groupBy = opts.groupBy === 'asset' ? 'asset' : 'chain';
  const walletName = (opts.walletName || 'Wallet').trim() || 'Wallet';
  const actions =
    opts.actions && opts.actions.length > 0 ? opts.actions : ['Send', 'Fund', 'Buy', 'Sell'];

  type Row = { chain: string; symbol: string; amount: number; usd: boolean };
  const rows: Row[] = [];
  for (const g of groups) {
    for (const a of g.assets) {
      if (!Number.isFinite(a.amount) || Math.abs(a.amount) <= DUST) continue;
      rows.push({
        chain: g.chain,
        symbol: a.symbol,
        amount: a.amount,
        usd: a.usd !== false,
      });
    }
  }

  let totalUsd = 0;
  for (const r of rows) {
    if (r.usd) totalUsd += r.amount;
  }
  // Avoid float noise in the headline
  totalUsd = Math.round(totalUsd * 100) / 100;

  const lines: string[] = [`👛 *${walletName}*`, `*Total: $${totalUsd.toFixed(2)}*`];

  if (rows.length === 0) {
    lines.push('', '_No balances yet — fund your wallet to start._', '', actions.join(' · '));
    return lines.join('\n');
  }

  if (groupBy === 'asset') {
    const bySymbol = new Map<string, Row[]>();
    for (const r of rows) {
      const list = bySymbol.get(r.symbol) || [];
      list.push(r);
      bySymbol.set(r.symbol, list);
    }
    for (const [symbol, list] of bySymbol) {
      lines.push('', `*${symbol}*`);
      const mono = alignMonospaceRows(
        list.map((r) => ({
          label: r.chain,
          amount: r.amount,
        })),
      );
      lines.push('```', mono, '```');
    }
  } else {
    const byChain = new Map<string, Row[]>();
    for (const r of rows) {
      const list = byChain.get(r.chain) || [];
      list.push(r);
      byChain.set(r.chain, list);
    }
    for (const [chain, list] of byChain) {
      lines.push('', `*${chain}*`);
      const mono = alignMonospaceRows(
        list.map((r) => ({
          label: r.symbol,
          amount: r.amount,
        })),
      );
      lines.push('```', mono, '```');
    }
  }

  lines.push('', actions.join(' · '));
  return lines.join('\n');
}

/** NGN notional at the live sell rate (2dp). */
export function usdcToNgnApprox(amountUsdc: number, sellRateNgn: number): number {
  if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) return 0;
  if (!Number.isFinite(sellRateNgn) || sellRateNgn <= 0) return 0;
  return Math.round(amountUsdc * sellRateNgn * 100) / 100;
}

function formatNgnApprox(ngn: number): string {
  return ngn.toLocaleString('en-NG', {
    minimumFractionDigits: Number.isInteger(ngn) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

/** e.g. 0.01 USDC (≈₦15.50) — for card hero + captions. */
export function formatUsdcWithNgn(amountUsdc: number, sellRateNgn: number): string {
  const pretty = formatBalanceAmount(amountUsdc);
  const ngn = usdcToNgnApprox(amountUsdc, sellRateNgn);
  if (ngn <= 0) return `${pretty} USDC`;
  return `${pretty} USDC (≈₦${formatNgnApprox(ngn)})`;
}

export function isUsdcLikeAsset(asset: string): boolean {
  const a = String(asset || '')
    .trim()
    .toUpperCase();
  return a === 'USDC' || a === 'USDT' || a === 'CUSD' || a === 'CELO USD';
}

/**
 * Caption under an incoming-funds receipt card (or text-only fallback).
 * Card already shows From/To/Reference — keep text lean.
 */
export function buildIncomingCreditCaption(opts: {
  amount: number;
  asset: string;
  /** Formatted wallet balance for this asset, e.g. "2.01" */
  balancePretty: string | null;
  sellRateNgn: number;
  /**
   * Text when a receipt card is attached (Reference is on the card).
   * True for text-only fallback — one clickable explorer URL, no short-hash twin.
   */
  includeTxUrl?: boolean;
  txUrl?: string | null;
}): string {
  const asset = String(opts.asset || 'USDC').trim();
  const displayAsset = asset === 'Celo USD' ? 'USDC' : asset;
  const amountPretty = formatBalanceAmount(opts.amount);
  const usdcLike = isUsdcLikeAsset(asset);

  const lead = usdcLike
    ? `💰 *+${formatUsdcWithNgn(opts.amount, opts.sellRateNgn)}* received`
    : `💰 *+${amountPretty} ${displayAsset}* received`;

  const lines: string[] = [lead];

  if (opts.balancePretty) {
    if (usdcLike) {
      const balNum = Number(String(opts.balancePretty).replace(/,/g, ''));
      if (Number.isFinite(balNum) && balNum >= 0 && opts.sellRateNgn > 0) {
        const balNgn = usdcToNgnApprox(balNum, opts.sellRateNgn);
        lines.push(
          `New balance: ${opts.balancePretty} ${displayAsset} (≈₦${formatNgnApprox(balNgn)})`,
        );
      } else {
        lines.push(`New balance: ${opts.balancePretty} ${displayAsset}`);
      }
    } else {
      lines.push(`New balance: ${opts.balancePretty} ${displayAsset}`);
    }
  }

  if (opts.includeTxUrl && opts.txUrl) {
    // Single clickable line (WhatsApp has no custom link text).
    lines.push(`Tx: ${opts.txUrl}`);
  }

  lines.push('Reply *menu* for options.');
  return lines.filter(Boolean).join('\n').slice(0, 1024);
}

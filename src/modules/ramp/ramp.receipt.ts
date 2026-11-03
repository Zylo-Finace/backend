import { readFileSync, existsSync } from 'node:fs';

import sharp from 'sharp';

import { shortPaymentRef, shortStellarAddr, shortTxHash } from './ramp.format';

export type TransferReceiptInput = {
  brandName: string;
  amount: number;
  asset: string;
  /**
   * Optional hero override, e.g. "0.01 USDC (≈₦16)" for received USDC credits.
   * Falls back to `${amount} ${asset}`.
   */
  amountHero?: string | null;
  toLabel: string;
  toAddress: string;
  fromAddress?: string | null;
  /** Sender display (@user) — used on both sent and received receipts. */
  fromLabel?: string | null;
  txHash: string;
  balanceLeft?: string | null;
  username?: string | null;
  at?: Date;
  /** Default sent (payer). Use received for the beneficiary copy. */
  direction?: 'sent' | 'received';
  /** Shown under the amount on received XLM credits. */
  footnote?: string | null;
};

/** Alpine (`font-dejavu`) + common Linux paths. */
const FONT_REGULAR = [
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/ttf-dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/liberation/LiberationSans-Regular.ttf',
];

const FONT_BOLD = [
  '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/ttf-dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/liberation/LiberationSans-Bold.ttf',
];

let cachedFontFaceCss: string | null | undefined;

function loadFontB64(candidates: string[]): string | null {
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      return readFileSync(path).toString('base64');
    } catch {
      /* try next */
    }
  }
  return null;
}

function fontFaceCss(): string {
  if (cachedFontFaceCss !== undefined) return cachedFontFaceCss || '';
  const regular = loadFontB64(FONT_REGULAR);
  const bold = loadFontB64(FONT_BOLD);
  if (!regular) {
    cachedFontFaceCss = '';
    return '';
  }
  const faces = [
    `@font-face{font-family:'BanjeeReceipt';src:url('data:font/ttf;base64,${regular}') format('truetype');font-weight:400;font-style:normal;}`,
  ];
  if (bold) {
    faces.push(
      `@font-face{font-family:'BanjeeReceipt';src:url('data:font/ttf;base64,${bold}') format('truetype');font-weight:700;font-style:normal;}`,
    );
  }
  cachedFontFaceCss = `<style>${faces.join('')}</style>`;
  return cachedFontFaceCss;
}

function fontFamily(): string {
  return fontFaceCss()
    ? "'BanjeeReceipt', 'DejaVu Sans', sans-serif"
    : "'DejaVu Sans', 'Liberation Sans', Arial, sans-serif";
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Prefer ASCII punctuation so missing glyphs never become tofu boxes. */
function asciiSafe(s: string): string {
  return String(s)
    .replace(/[…⋯]/g, '...')
    .replace(/[·•]/g, '-')
    .replace(/[–—]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
}

/** e.g. on 06 Aug 2026 23:17 */
function formatWhen(d: Date): string {
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mon = months[d.getUTCMonth()];
  const yyyy = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `on ${dd} ${mon} ${yyyy} ${hh}:${mm}`;
}

/** White ticket body: rounded top + serrated bottom. */
function ticketPath(x: number, y: number, w: number, bodyH: number, tooth = 14): string {
  const bottom = y + bodyH;
  const teeth = Math.floor(w / tooth);
  let d = `M ${x + 18} ${y} L ${x + w - 18} ${y} Q ${x + w} ${y} ${x + w} ${y + 18} L ${x + w} ${bottom}`;
  for (let i = 0; i < teeth; i++) {
    const x0 = x + w - i * tooth;
    d += ` L ${x0 - tooth / 2} ${bottom + 10} L ${x0 - tooth} ${bottom}`;
  }
  d += ` L ${x} ${bottom} L ${x} ${y + 18} Q ${x} ${y} ${x + 18} ${y} Z`;
  return d;
}

/**
 * Banjee portal palette — matches frontend `globals.css` brand greens so
 * WhatsApp PNGs read as the same product as the web app.
 */
const THEME = {
  pageFrom: '#E2F1E8',
  pageTo: '#F4F5F3',
  brand: '#0A7A4E',
  brandBright: '#25D366',
  ink: '#0F1512',
  muted: '#58625D',
  soft: '#9CA3AF',
  rule: '#C9CEC9',
  shadow: '#065A38',
  success: '#0A7A4E',
  warning: '#F79009',
  danger: '#F04438',
  white: '#FFFFFF',
} as const;

function receiptPageDefs(id: string): string {
  return `
    <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${THEME.pageFrom}"/>
      <stop offset="100%" stop-color="${THEME.pageTo}"/>
    </linearGradient>
    <filter id="${id}Soft" x="-10%" y="-10%" width="120%" height="130%">
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="${THEME.shadow}" flood-opacity="0.14"/>
    </filter>`;
}

/**
 * Branded PNG receipt for WhatsApp after a successful transfer.
 * Light ticket card (Xara-style), rendered at 2x for sharpness on phones.
 */
export async function renderTransferReceiptPng(input: TransferReceiptInput): Promise<Buffer> {
  const ff = fontFamily();
  const brand = esc(asciiSafe(input.brandName || 'Banjee').toLowerCase());
  const heroRaw = (input.amountHero || `${input.amount} ${input.asset}`).trim();
  // "1.95 USDC (≈₦2,650.40)" — keep the crypto amount large; NGN approx on a second line
  // so long heroes never clip the right edge of the ticket.
  const heroSplit = heroRaw.match(/^(.+?)\s+(\((?:≈|~)?\s*₦.+\))$/u);
  const heroPrimary = esc(asciiSafe(heroSplit?.[1] || heroRaw));
  const heroSecondary = heroSplit?.[2] ? esc(asciiSafe(heroSplit[2])) : '';
  const heroPrimaryLen = (heroSplit?.[1] || heroRaw).length;
  const heroSize =
    heroPrimaryLen <= 10 ? 44 : heroPrimaryLen <= 14 ? 36 : heroPrimaryLen <= 18 ? 30 : 26;
  const toLabel = esc(asciiSafe(input.toLabel));
  const toShort = esc(asciiSafe(shortStellarAddr(input.toAddress, 8, 6)));
  const fromShort = input.fromAddress
    ? esc(asciiSafe(shortStellarAddr(input.fromAddress, 8, 6)))
    : null;
  const txShort = esc(asciiSafe(shortTxHash(input.txHash, 12, 8)));
  const when = esc(formatWhen(input.at || new Date()));
  const who = input.username ? esc(asciiSafe(`@${input.username}`)) : null;
  const fromLabel = input.fromLabel
    ? esc(asciiSafe(input.fromLabel))
    : who || fromShort || 'Banjee wallet';
  const received = input.direction === 'received';
  const footnote = input.footnote ? esc(asciiSafe(input.footnote)) : '';

  const rows: Array<{ k: string; v: string }> = received
    ? [
        { k: 'Status:', v: 'Received' },
        { k: 'From:', v: fromLabel },
        { k: 'To:', v: toLabel },
        { k: 'Your wallet:', v: toShort },
      ]
    : [
        { k: 'Status:', v: 'Sent' },
        { k: 'Sender:', v: fromLabel },
        { k: 'Recipient:', v: toLabel },
        { k: 'Address:', v: toShort },
      ];
  if (!received && fromShort) rows.push({ k: 'From wallet:', v: fromShort });
  rows.push({ k: 'Network:', v: 'Stellar' });
  rows.push({ k: 'Reference:', v: txShort });

  const W = 720;
  const cardX = 40;
  const cardY = 36;
  const cardW = W - 80;
  const rowH = 52;
  const heroBlockExtra = heroSecondary ? 28 : 0;
  const rowsStart = (footnote ? 268 : 248) + heroBlockExtra;
  const bodyH = rowsStart - cardY + rows.length * rowH + 36;
  const H = cardY + bodyH + 28;

  const rowSvg = rows
    .map((r, i) => {
      const y = rowsStart + i * rowH;
      const dash =
        i < rows.length - 1
          ? `<line x1="${cardX + 36}" y1="${y + 22}" x2="${cardX + cardW - 36}" y2="${y + 22}" stroke="${THEME.rule}" stroke-width="1.5" stroke-dasharray="5 6"/>`
          : '';
      return `
      <text x="${cardX + 36}" y="${y}" fill="${THEME.muted}" font-size="18" font-family="${ff}">${r.k}</text>
      <text x="${cardX + cardW - 36}" y="${y}" fill="${THEME.ink}" font-size="18" font-family="${ff}" font-weight="700" text-anchor="end">${r.v}</text>
      ${dash}`;
    })
    .join('');

  const face = fontFaceCss();
  const path = ticketPath(cardX, cardY, cardW, bodyH);
  const whenY = heroSecondary ? 218 : 202;
  const footnoteY = heroSecondary ? 244 : 228;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    ${receiptPageDefs('page')}
  </defs>
  ${face}
  <rect width="${W}" height="${H}" fill="url(#page)"/>
  <path d="${path}" fill="${THEME.white}" filter="url(#pageSoft)"/>

  <text x="${cardX + 36}" y="88" fill="${THEME.brand}" font-size="28" font-family="${ff}" font-weight="700">${brand}.</text>
  <rect x="${cardX + cardW - 168}" y="62" width="132" height="32" rx="16" fill="${THEME.success}"/>
  <text x="${cardX + cardW - 102}" y="84" fill="${THEME.white}" font-size="13" font-family="${ff}" font-weight="700" text-anchor="middle" letter-spacing="1">COMPLETED</text>

  <text x="${cardX + 36}" y="160" fill="${THEME.brand}" font-size="${heroSize}" font-family="${ff}" font-weight="700">${heroPrimary}</text>
  ${
    heroSecondary
      ? `<text x="${cardX + 36}" y="188" fill="${THEME.muted}" font-size="20" font-family="${ff}" font-weight="600">${heroSecondary}</text>`
      : ''
  }
  <text x="${cardX + 36}" y="${whenY}" fill="${THEME.soft}" font-size="18" font-family="${ff}">${when}</text>
  ${footnote ? `<text x="${cardX + 36}" y="${footnoteY}" fill="${THEME.muted}" font-size="15" font-family="${ff}">${footnote}</text>` : ''}

  ${rowSvg}
</svg>`;

  return sharp(Buffer.from(svg))
    .resize(W * 2, H * 2, { kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 8, adaptiveFiltering: true })
    .toBuffer();
}

export type BankSendReceiptInput = {
  brandName: string;
  amountNgn: number;
  /** Omit or 0 when the send was funded from the NGN ledger (not USDC). */
  amountUsdc?: number | null;
  accountName: string;
  bankName: string;
  accountNumber: string;
  ref: string;
  stellarTxHash?: string | null;
  username?: string | null;
  at?: Date;
  /** submitted = FalconPay accepted; completed = NGN landed. */
  status?: 'submitted' | 'completed';
};

/**
 * Branded PNG receipt for WhatsApp after a bank (NGN) send.
 * Matches the in-app Ticket: solid Banjee-green header, white detail rows.
 */
export async function renderBankSendReceiptPng(input: BankSendReceiptInput): Promise<Buffer> {
  const ff = fontFamily();
  const brand = esc(asciiSafe(input.brandName || 'BANJEE'));
  const ngn = esc(`₦${Number(input.amountNgn).toLocaleString('en-NG')}`);
  const when = esc(formatWhen(input.at || new Date()));
  const who = input.username ? esc(asciiSafe(`@${input.username}`)) : 'Banjee wallet';
  const acct = String(input.accountNumber || '');
  const acctMasked =
    acct.length >= 4 ? `${'*'.repeat(Math.max(0, acct.length - 4))}${acct.slice(-4)}` : acct;
  const completed = input.status === 'completed';
  const badge = completed ? 'PAID' : 'SENT';
  const headline = completed ? 'Transfer complete' : 'Transfer on its way';
  const statusLine = completed ? 'Successful' : 'Submitted to bank';
  const paidWithUsdc =
    input.amountUsdc != null && Number(input.amountUsdc) > 0 ? `~${input.amountUsdc} USDC` : null;

  const rows: Array<{ k: string; v: string }> = [
    { k: 'Status', v: statusLine },
    { k: 'To', v: asciiSafe(`${input.accountName} · ${input.bankName}`) },
    { k: 'Account', v: asciiSafe(acctMasked) },
    ...(paidWithUsdc
      ? [{ k: 'Paid with', v: paidWithUsdc }]
      : [{ k: 'Paid with', v: 'Naira balance' }]),
    { k: 'Sender', v: who },
    { k: 'Reference', v: asciiSafe(shortPaymentRef(input.ref)) },
  ];
  if (input.stellarTxHash) {
    rows.push({ k: 'Stellar tx', v: asciiSafe(shortTxHash(input.stellarTxHash, 12, 8)) });
  }

  const W = 720;
  const cardX = 40;
  const cardY = 36;
  const cardW = W - 80;
  const headerH = 220;
  const rowH = 52;
  const rowsStart = cardY + headerH + 44;
  const bodyH = headerH + 24 + rows.length * rowH + 36;
  const H = cardY + bodyH + 28;

  const rowSvg = rows
    .map((r, i) => {
      const y = rowsStart + i * rowH;
      const dash =
        i < rows.length - 1
          ? `<line x1="${cardX + 36}" y1="${y + 22}" x2="${cardX + cardW - 36}" y2="${y + 22}" stroke="${THEME.rule}" stroke-width="1.5"/>`
          : '';
      return `
      <text x="${cardX + 36}" y="${y}" fill="${THEME.muted}" font-size="18" font-family="${ff}">${esc(r.k)}</text>
      <text x="${cardX + cardW - 36}" y="${y}" fill="${THEME.ink}" font-size="18" font-family="${ff}" font-weight="700" text-anchor="end">${esc(r.v)}</text>
      ${dash}`;
    })
    .join('');

  const face = fontFaceCss();
  const path = ticketPath(cardX, cardY, cardW, bodyH);

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    ${receiptPageDefs('pageBank')}
    <linearGradient id="headerGreen" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${THEME.brand}"/>
      <stop offset="100%" stop-color="${THEME.brandBright}"/>
    </linearGradient>
  </defs>
  ${face}
  <rect width="${W}" height="${H}" fill="url(#pageBank)"/>
  <path d="${path}" fill="${THEME.white}" filter="url(#pageBankSoft)"/>

  <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${headerH}" rx="22" fill="url(#headerGreen)"/>
  <rect x="${cardX}" y="${cardY + headerH - 28}" width="${cardW}" height="28" fill="url(#headerGreen)"/>

  <text x="${cardX + 36}" y="${cardY + 52}" fill="${THEME.white}" font-size="22" font-family="${ff}" font-weight="700" opacity="0.95">${brand}</text>
  <rect x="${cardX + cardW - 132}" y="${cardY + 28}" width="96" height="30" rx="15" fill="#FFFFFF" fill-opacity="0.22"/>
  <text x="${cardX + cardW - 84}" y="${cardY + 49}" fill="${THEME.white}" font-size="13" font-family="${ff}" font-weight="700" text-anchor="middle" letter-spacing="1">${badge}</text>

  <text x="${cardX + 36}" y="${cardY + 110}" fill="${THEME.white}" font-size="18" font-family="${ff}" opacity="0.9">${esc(headline)}</text>
  <text x="${cardX + 36}" y="${cardY + 168}" fill="${THEME.white}" font-size="48" font-family="${ff}" font-weight="700">${ngn}</text>
  <text x="${cardX + 36}" y="${cardY + 200}" fill="${THEME.white}" font-size="16" font-family="${ff}" opacity="0.85">${when}</text>

  ${rowSvg}
</svg>`;

  return sharp(Buffer.from(svg))
    .resize(W * 2, H * 2, { kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 8, adaptiveFiltering: true })
    .toBuffer();
}

export type AirtimeReceiptInput = {
  brandName: string;
  amountNgn: number;
  amountUsdc: number;
  networkLabel: string;
  recipientPhone: string;
  ref: string;
  orderId?: string | null;
  stellarTxHash?: string | null;
  username?: string | null;
  at?: Date;
  status?: 'submitted' | 'completed' | 'failed';
};

/** Branded PNG receipt for WhatsApp airtime top-up. */
export async function renderAirtimeReceiptPng(input: AirtimeReceiptInput): Promise<Buffer> {
  const ff = fontFamily();
  const brand = esc(asciiSafe(input.brandName || 'Banjee').toLowerCase());
  const ngn = esc(`NGN ${Number(input.amountNgn).toLocaleString('en-NG')}`);
  const when = esc(formatWhen(input.at || new Date()));
  const who = input.username ? esc(asciiSafe(`@${input.username}`)) : 'Banjee wallet';
  const badge =
    input.status === 'completed' ? 'SENT' : input.status === 'failed' ? 'FAILED' : 'PENDING';
  const badgeFill =
    input.status === 'completed'
      ? THEME.success
      : input.status === 'failed'
        ? THEME.danger
        : THEME.warning;

  const rows: Array<{ k: string; v: string }> = [
    {
      k: 'Status:',
      v: badge === 'SENT' ? 'Airtime sent' : badge === 'FAILED' ? 'Failed' : 'Submitted',
    },
    { k: 'Sender:', v: who },
    { k: 'Network:', v: asciiSafe(input.networkLabel) },
    { k: 'To:', v: asciiSafe(input.recipientPhone) },
    { k: 'Paid with:', v: `~${input.amountUsdc} USDC` },
    { k: 'Ref:', v: asciiSafe(shortPaymentRef(input.ref)) },
  ];
  if (input.orderId) rows.push({ k: 'Provider:', v: asciiSafe(String(input.orderId)) });
  if (input.stellarTxHash) {
    rows.push({ k: 'Stellar tx:', v: asciiSafe(shortTxHash(input.stellarTxHash, 12, 8)) });
  }

  const W = 720;
  const cardX = 40;
  const cardY = 36;
  const cardW = W - 80;
  const rowH = 52;
  const rowsStart = 248;
  const bodyH = rowsStart - cardY + rows.length * rowH + 36;
  const H = cardY + bodyH + 28;

  const rowSvg = rows
    .map((r, i) => {
      const y = rowsStart + i * rowH;
      const dash =
        i < rows.length - 1
          ? `<line x1="${cardX + 36}" y1="${y + 22}" x2="${cardX + cardW - 36}" y2="${y + 22}" stroke="${THEME.rule}" stroke-width="1.5" stroke-dasharray="5 6"/>`
          : '';
      return `
      <text x="${cardX + 36}" y="${y}" fill="${THEME.muted}" font-size="18" font-family="${ff}">${esc(r.k)}</text>
      <text x="${cardX + cardW - 36}" y="${y}" fill="${THEME.ink}" font-size="18" font-family="${ff}" font-weight="700" text-anchor="end">${esc(r.v)}</text>
      ${dash}`;
    })
    .join('');

  const face = fontFaceCss();
  const path = ticketPath(cardX, cardY, cardW, bodyH);

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    ${receiptPageDefs('pageAt')}
  </defs>
  ${face}
  <rect width="${W}" height="${H}" fill="url(#pageAt)"/>
  <path d="${path}" fill="${THEME.white}" filter="url(#pageAtSoft)"/>

  <text x="${cardX + 36}" y="88" fill="${THEME.brand}" font-size="28" font-family="${ff}" font-weight="700">${brand}.</text>
  <rect x="${cardX + cardW - 148}" y="62" width="112" height="32" rx="16" fill="${badgeFill}"/>
  <text x="${cardX + cardW - 92}" y="84" fill="${THEME.white}" font-size="13" font-family="${ff}" font-weight="700" text-anchor="middle" letter-spacing="1">${badge}</text>

  <text x="${cardX + 36}" y="168" fill="${THEME.brand}" font-size="44" font-family="${ff}" font-weight="700">${ngn}</text>
  <text x="${cardX + 36}" y="202" fill="${THEME.soft}" font-size="18" font-family="${ff}">${when}</text>

  ${rowSvg}
</svg>`;

  return sharp(Buffer.from(svg))
    .resize(W * 2, H * 2, { kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 8, adaptiveFiltering: true })
    .toBuffer();
}

export type BillReceiptInput = {
  brandName: string;
  /** Hero label under the brand, e.g. "Airtime sent" / "Electricity paid". */
  headline: string;
  amountNgn: number;
  amountUsdc?: number | null;
  /** Detail rows shown on the white body (label → value). */
  rows: Array<{ label: string; value: string }>;
  ref: string;
  username?: string | null;
  at?: Date;
  status?: 'submitted' | 'completed' | 'failed';
};

/**
 * Green Banjee Ticket-style PNG for any bill / utility purchase on WhatsApp.
 */
export async function renderBillReceiptPng(input: BillReceiptInput): Promise<Buffer> {
  const ff = fontFamily();
  const brand = esc(asciiSafe(input.brandName || 'BANJEE'));
  const ngn = esc(`₦${Number(input.amountNgn).toLocaleString('en-NG')}`);
  const when = esc(formatWhen(input.at || new Date()));
  const headline = esc(asciiSafe(input.headline || 'Payment'));
  const completed = input.status === 'completed' || input.status === undefined;
  const failed = input.status === 'failed';
  const badge = failed ? 'FAILED' : completed ? 'PAID' : 'SENT';

  const rows: Array<{ k: string; v: string }> = [
    ...input.rows.map((r) => ({ k: r.label, v: asciiSafe(r.value) })),
  ];
  if (input.amountUsdc != null && Number(input.amountUsdc) > 0) {
    rows.push({ k: 'Paid with', v: `~${input.amountUsdc} USDC` });
  }
  if (input.username) {
    rows.push({ k: 'Account', v: asciiSafe(`@${input.username}`) });
  }
  rows.push({ k: 'Reference', v: asciiSafe(shortPaymentRef(input.ref)) });

  const W = 720;
  const cardX = 40;
  const cardY = 36;
  const cardW = W - 80;
  const headerH = 220;
  const rowH = 52;
  const rowsStart = cardY + headerH + 44;
  const bodyH = headerH + 24 + rows.length * rowH + 36;
  const H = cardY + bodyH + 28;

  const rowSvg = rows
    .map((r, i) => {
      const y = rowsStart + i * rowH;
      const dash =
        i < rows.length - 1
          ? `<line x1="${cardX + 36}" y1="${y + 22}" x2="${cardX + cardW - 36}" y2="${y + 22}" stroke="${THEME.rule}" stroke-width="1.5"/>`
          : '';
      return `
      <text x="${cardX + 36}" y="${y}" fill="${THEME.muted}" font-size="18" font-family="${ff}">${esc(r.k)}</text>
      <text x="${cardX + cardW - 36}" y="${y}" fill="${THEME.ink}" font-size="18" font-family="${ff}" font-weight="700" text-anchor="end">${esc(r.v)}</text>
      ${dash}`;
    })
    .join('');

  const face = fontFaceCss();
  const path = ticketPath(cardX, cardY, cardW, bodyH);

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    ${receiptPageDefs('pageBill')}
    <linearGradient id="billHeaderGreen" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${THEME.brand}"/>
      <stop offset="100%" stop-color="${THEME.brandBright}"/>
    </linearGradient>
  </defs>
  ${face}
  <rect width="${W}" height="${H}" fill="url(#pageBill)"/>
  <path d="${path}" fill="${THEME.white}" filter="url(#pageBillSoft)"/>

  <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${headerH}" rx="22" fill="url(#billHeaderGreen)"/>
  <rect x="${cardX}" y="${cardY + headerH - 28}" width="${cardW}" height="28" fill="url(#billHeaderGreen)"/>

  <text x="${cardX + 36}" y="${cardY + 52}" fill="${THEME.white}" font-size="22" font-family="${ff}" font-weight="700" opacity="0.95">${brand}</text>
  <rect x="${cardX + cardW - 132}" y="${cardY + 28}" width="96" height="30" rx="15" fill="#FFFFFF" fill-opacity="0.22"/>
  <text x="${cardX + cardW - 84}" y="${cardY + 49}" fill="${THEME.white}" font-size="13" font-family="${ff}" font-weight="700" text-anchor="middle" letter-spacing="1">${badge}</text>

  <text x="${cardX + 36}" y="${cardY + 110}" fill="${THEME.white}" font-size="18" font-family="${ff}" opacity="0.9">${headline}</text>
  <text x="${cardX + 36}" y="${cardY + 168}" fill="${THEME.white}" font-size="48" font-family="${ff}" font-weight="700">${ngn}</text>
  <text x="${cardX + 36}" y="${cardY + 200}" fill="${THEME.white}" font-size="16" font-family="${ff}" opacity="0.85">${when}</text>

  ${rowSvg}
</svg>`;

  return sharp(Buffer.from(svg))
    .resize(W * 2, H * 2, { kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 8, adaptiveFiltering: true })
    .toBuffer();
}

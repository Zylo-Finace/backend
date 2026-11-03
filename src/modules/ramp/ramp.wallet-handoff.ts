import QRCode from 'qrcode';

import type { RampReply } from './ramp.whatsapp';

export type DepositNetwork = 'stellar' | 'celo';
export type DepositFormatChoice = 'qr' | 'address' | 'both';

export type PendingDepositHandoff = {
  network: DepositNetwork;
  address: string;
  acceptedAssets: string[];
  isReusable: boolean;
  /** Other network to offer as Switch (if any). */
  switchNetwork?: DepositNetwork;
  preface?: string;
};

/** In-memory handoff draft (same process lifetime as other ramp pending maps). */
const pendingDepositByPhone = new Map<string, PendingDepositHandoff>();

export function setPendingDeposit(phone: string, draft: PendingDepositHandoff): void {
  pendingDepositByPhone.set(phone, draft);
}

export function getPendingDeposit(phone: string): PendingDepositHandoff | null {
  return pendingDepositByPhone.get(phone) || null;
}

export function clearPendingDeposit(phone: string): void {
  pendingDepositByPhone.delete(phone);
}

/**
 * Build a deposit QR PNG.
 * Encodes the raw address — phone cameras and most wallets handle that
 * more reliably than URI schemes for smart-contract destinations.
 */
export async function depositQrPng(wallet: string): Promise<Buffer> {
  const payload = String(wallet || '').trim();
  if (!payload) {
    throw new Error('empty wallet for QR');
  }
  return QRCode.toBuffer(payload, {
    type: 'png',
    width: 640,
    margin: 3,
    errorCorrectionLevel: 'H',
    color: { dark: '#0B1220', light: '#FFFFFF' },
  });
}

function networkLabel(network: DepositNetwork): string {
  return network === 'celo' ? 'Celo' : 'Stellar';
}

function formatAssetsOr(assets: string[]): string {
  const list = assets.map((a) => a.trim()).filter(Boolean);
  if (list.length <= 1) return list[0] || 'USDC';
  if (list.length === 2) return `${list[0]} or ${list[1]}`;
  return `${list.slice(0, -1).join(', ')}, or ${list[list.length - 1]}`;
}

function formatAssetsList(assets: string[]): string {
  const list = assets.map((a) => a.trim()).filter(Boolean);
  return list.length ? list.join(', ') : 'USDC';
}

/** Short QR caption — never includes the raw address. */
export function formatDepositQrCaption(opts: {
  network: DepositNetwork;
  acceptedAssets: string[];
}): string {
  const label = networkLabel(opts.network);
  return `Scan to send ${formatAssetsOr(opts.acceptedAssets)} on ${label}.`;
}

/**
 * Safety / details bubble — no raw address (address is its own plain-text bubble).
 */
export function formatDepositSafetyMessage(opts: {
  network: DepositNetwork;
  acceptedAssets: string[];
  isReusable?: boolean;
  preface?: string;
  /** When false (QR-only), skip the “long-press address bubble” hint. */
  includeCopyHint?: boolean;
}): string {
  const label = networkLabel(opts.network);
  const isReusable = opts.isReusable !== false;
  const lines: string[] = [];
  if (opts.preface?.trim()) lines.push(opts.preface.trim());
  lines.push(
    `*${label}*`,
    `⚠️ Only send ${formatAssetsOr(opts.acceptedAssets)} on ${label}. Sending via another network may result in permanent loss of funds.`,
    `Accepted: ${formatAssetsList(opts.acceptedAssets)}`,
    isReusable
      ? 'This address is yours — safe to reuse for future deposits.'
      : 'This address is single-use or may expire — do not reuse it for later deposits.',
  );
  if (opts.includeCopyHint !== false) {
    lines.push('Long-press the address bubble above to copy.');
  }
  return lines.join('\n');
}

/** @deprecated use formatDepositSafetyMessage — kept for older tests naming */
export function formatDepositAddressMessage(opts: {
  network: DepositNetwork;
  address: string;
  acceptedAssets: string[];
  isReusable?: boolean;
  preface?: string;
}): string {
  return [formatDepositSafetyMessage(opts), '', opts.address.trim()].join('\n');
}

export function fundNetworkPicker(opts?: { body?: string }): RampReply {
  return {
    type: 'buttons',
    body: opts?.body || 'Fund wallet — which network?',
    footer: 'One network per deposit',
    buttons: [
      { id: 'fund_net_stellar', title: 'Stellar' },
      { id: 'fund_net_celo', title: 'Celo' },
      { id: 'menu_home', title: 'Main menu' },
    ],
  };
}

/** Step 1 after network is known — how to receive deposit details. */
export function fundFormatPicker(network: DepositNetwork): RampReply {
  const label = networkLabel(network);
  return {
    type: 'buttons',
    body: `How would you like your ${label} deposit details?`,
    footer: 'QR · address · or both',
    buttons: [
      { id: 'fund_fmt_qr', title: 'QR code' },
      { id: 'fund_fmt_address', title: 'Copyable address' },
      { id: 'fund_fmt_both', title: 'Both' },
    ],
  };
}

function switchNetworkButtons(switchTo?: DepositNetwork): RampReply {
  if (switchTo === 'celo') {
    return {
      type: 'buttons',
      body: 'Need a different network?',
      buttons: [
        { id: 'fund_net_celo', title: 'Switch to Celo' },
        { id: 'menu_home', title: 'Main menu' },
      ],
    };
  }
  if (switchTo === 'stellar') {
    return {
      type: 'buttons',
      body: 'Need a different network?',
      buttons: [
        { id: 'fund_net_stellar', title: 'Switch to Stellar' },
        { id: 'menu_home', title: 'Main menu' },
      ],
    };
  }
  return {
    type: 'buttons',
    body: 'Done?',
    buttons: [{ id: 'menu_home', title: 'Main menu' }],
  };
}

/**
 * Step 2 — deliver deposit details for the chosen format.
 * Never puts the raw address in an image caption.
 */
export async function deliverDepositDetails(
  draft: PendingDepositHandoff,
  format: DepositFormatChoice,
): Promise<RampReply[]> {
  const address = draft.address.trim();
  const safety = formatDepositSafetyMessage({
    network: draft.network,
    acceptedAssets: draft.acceptedAssets,
    isReusable: draft.isReusable,
    preface: draft.preface,
    includeCopyHint: format !== 'qr',
  });
  const qrCaption = formatDepositQrCaption({
    network: draft.network,
    acceptedAssets: draft.acceptedAssets,
  });

  const replies: RampReply[] = [];

  const pushQr = async () => {
    try {
      const qrPng = await depositQrPng(address);
      replies.push({
        type: 'image',
        buffer: qrPng,
        mimeType: 'image/png',
        filename: 'banjee-deposit-qr.png',
        caption: qrCaption.slice(0, 1024),
      });
    } catch {
      replies.push({
        type: 'text',
        text: 'QR image unavailable right now — choose Copyable address or Both and use the text address.',
      });
    }
  };

  if (format === 'qr') {
    await pushQr();
    // Safety is mandatory even when the user only wanted a QR.
    replies.push({ type: 'text', text: safety });
  } else if (format === 'address') {
    replies.push({ type: 'text', text: address });
    replies.push({ type: 'text', text: safety });
  } else {
    await pushQr();
    replies.push({ type: 'text', text: address });
    replies.push({ type: 'text', text: safety });
  }

  replies.push(switchNetworkButtons(draft.switchNetwork));
  return replies;
}

/** Begin handoff: store draft + ask format (does not send the address yet). */
export function beginDepositHandoff(phone: string, draft: PendingDepositHandoff): RampReply {
  setPendingDeposit(phone, draft);
  return fundFormatPicker(draft.network);
}

/** Stellar deposit — format picker first. */
export function walletAddressReplies(opts: {
  brandName: string;
  wallet: string;
  phone: string;
  preface?: string;
  switchToCelo?: boolean;
}): RampReply {
  const isContract = /^C[A-Z0-9]{55}$/i.test(opts.wallet);
  const preface = [
    opts.preface || '',
    isContract
      ? '⚠️ Legacy smart-wallet (C…). If BANJEE gave you a G… address, fund that instead.'
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  return beginDepositHandoff(opts.phone, {
    network: 'stellar',
    address: opts.wallet,
    acceptedAssets: ['USDC'],
    isReusable: true,
    preface: preface || undefined,
    switchNetwork: opts.switchToCelo ? 'celo' : undefined,
  });
}

/** Celo deposit — format picker first. */
export function celoWalletAddressReplies(opts: {
  brandName: string;
  wallet: string;
  phone: string;
  preface?: string;
  switchToStellar?: boolean;
}): RampReply {
  return beginDepositHandoff(opts.phone, {
    network: 'celo',
    address: opts.wallet,
    acceptedAssets: ['USDC', 'USDT', 'cUSD'],
    isReusable: true,
    preface: opts.preface,
    switchNetwork: opts.switchToStellar ? 'stellar' : undefined,
  });
}

export function celoSoftPromptButtons(): RampReply {
  return {
    type: 'buttons',
    body: 'Optional: get a Celo address for USDC, USDT, or cUSD.',
    footer: 'You can skip this',
    buttons: [
      { id: 'celo_get_wallet', title: 'Get Celo address' },
      { id: 'celo_skip', title: 'Not now' },
      { id: 'menu_home', title: 'Main menu' },
    ],
  };
}

/**
 * After signup: congrats + format picker for Stellar (one network).
 */
export function walletSignupHandoffReplies(opts: {
  brandName: string;
  phone: string;
  username?: string | null;
  wallet: string;
  celoWallet?: string | null;
}): RampReply[] {
  const { brandName, phone, username, wallet, celoWallet } = opts;
  const greet = username ? `You're in, ${username} ✅` : `${brandName} is ready ✅`;
  const hasCelo = Boolean(celoWallet && /^0x[a-fA-F0-9]{40}$/.test(celoWallet));
  return [
    { type: 'text', text: greet },
    walletAddressReplies({
      brandName,
      phone,
      wallet,
      switchToCelo: hasCelo,
    }),
  ];
}

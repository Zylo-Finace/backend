jest.mock('qrcode', () => ({
  __esModule: true,
  default: {
    toBuffer: jest.fn(() => Promise.resolve(Buffer.from('fake-qr-png'))),
  },
}));

import {
  deliverDepositDetails,
  formatDepositQrCaption,
  formatDepositSafetyMessage,
  fundFormatPicker,
} from './ramp.wallet-handoff';

describe('fundFormatPicker', () => {
  it('asks how to receive Stellar deposit details', () => {
    const msg = fundFormatPicker('stellar');
    expect(msg).toMatchObject({
      type: 'buttons',
      body: 'How would you like your Stellar deposit details?',
    });
  });
});

describe('formatDepositSafetyMessage', () => {
  it('never includes the raw address', () => {
    const msg = formatDepositSafetyMessage({
      network: 'stellar',
      acceptedAssets: ['USDC'],
      isReusable: true,
    });
    expect(msg).toContain('*Stellar*');
    expect(msg).toContain('Only send USDC on Stellar');
    expect(msg).toContain('Accepted: USDC');
    expect(msg).toContain('safe to reuse');
    expect(msg).not.toMatch(/G[A-Z0-9]{55}/);
  });
});

describe('formatDepositQrCaption', () => {
  it('names assets and network without an address', () => {
    expect(
      formatDepositQrCaption({
        network: 'celo',
        acceptedAssets: ['USDC', 'USDT', 'cUSD'],
      }),
    ).toBe('Scan to send USDC, USDT, or cUSD on Celo.');
  });
});

describe('deliverDepositDetails', () => {
  const draft = {
    network: 'stellar' as const,
    address: 'GBJVW2S5SB23X53PEGWGJ6YSJPOZ3KTCLEGD2UQWRYJY3SDMXQI3PGZ6',
    acceptedAssets: ['USDC'],
    isReusable: true,
    switchNetwork: 'celo' as const,
  };

  it('address format: bare address bubble then safety then switch', async () => {
    const replies = await deliverDepositDetails(draft, 'address');
    expect(replies[0]).toEqual({ type: 'text', text: draft.address });
    expect(replies[1]).toMatchObject({ type: 'text' });
    expect(String((replies[1] as { text: string }).text)).toContain('Only send USDC');
    expect(String((replies[1] as { text: string }).text)).not.toContain(draft.address);
    expect(replies[2]).toMatchObject({ type: 'buttons' });
  });

  it('qr format: image caption has no address, safety follows', async () => {
    const replies = await deliverDepositDetails(draft, 'qr');
    const img = replies.find((r) => typeof r === 'object' && r.type === 'image') as {
      type: 'image';
      caption?: string;
    };
    expect(img?.caption).toBe('Scan to send USDC on Stellar.');
    expect(img?.caption).not.toContain(draft.address);
    const safety = replies.find(
      (r) => typeof r === 'object' && r.type === 'text' && String(r.text).includes('Accepted:'),
    ) as { text: string };
    expect(safety.text).not.toContain(draft.address);
  });
});

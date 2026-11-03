import { formatBalanceAmount, formatWhatsAppWalletBalance } from './ramp.format';

describe('formatBalanceAmount', () => {
  it('uses 2dp for normal amounts', () => {
    expect(formatBalanceAmount(10)).toBe('10.00');
    expect(formatBalanceAmount(1.5)).toBe('1.50');
  });

  it('keeps precision for dust under 0.01', () => {
    expect(formatBalanceAmount(0.00012)).toBe('0.00012');
  });
});

describe('formatWhatsAppWalletBalance', () => {
  it('leads with total, omits zeros, aligns monospace by chain', () => {
    const msg = formatWhatsAppWalletBalance(
      [
        {
          chain: 'Stellar',
          assets: [
            { symbol: 'USDC', amount: 10, usd: true },
            { symbol: 'XLM', amount: 2.15, usd: false },
            { symbol: 'USDT', amount: 0, usd: true },
          ],
        },
        {
          chain: 'Celo',
          assets: [
            { symbol: 'USDC', amount: 0.19, usd: true },
            { symbol: 'USDT', amount: 0, usd: true },
            { symbol: 'cUSD', amount: 0, usd: true },
          ],
        },
      ],
      { walletName: 'Banjee', actions: ['Send', 'Fund', 'Buy', 'Sell'] },
    );

    expect(msg).toContain('*Total: $10.19*');
    expect(msg).toContain('*Stellar*');
    expect(msg).toContain('*Celo*');
    expect(msg).not.toContain('USDT');
    expect(msg).not.toContain('cUSD');
    expect(msg).toContain('```');
    expect(msg).toContain('Send · Fund · Buy · Sell');
    expect(msg.startsWith('👛 *Banjee*')).toBe(true);
  });

  it('excludes non-usd assets from total', () => {
    const msg = formatWhatsAppWalletBalance([
      {
        chain: 'Stellar',
        assets: [
          { symbol: 'USDC', amount: 1, usd: true },
          { symbol: 'XLM', amount: 100, usd: false },
        ],
      },
    ]);
    expect(msg).toContain('*Total: $1.00*');
    expect(msg).toContain('XLM');
  });
});

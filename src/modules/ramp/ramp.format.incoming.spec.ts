import { buildIncomingCreditCaption, formatUsdcWithNgn, usdcToNgnApprox } from './ramp.format';

describe('incoming credit formatting', () => {
  it('formats USDC with NGN at sell rate', () => {
    expect(usdcToNgnApprox(0.01, 1550)).toBe(15.5);
    expect(formatUsdcWithNgn(0.01, 1550)).toBe('0.01 USDC (≈₦15.50)');
  });

  it('builds a lean USDC caption with balance + NGN', () => {
    const text = buildIncomingCreditCaption({
      amount: 0.01,
      asset: 'USDC',
      balancePretty: '2.01',
      sellRateNgn: 1550,
      includeTxUrl: false,
    });
    expect(text).toContain('💰');
    expect(text).toContain('+0.01 USDC (≈₦15.50)');
    expect(text).toContain('New balance: 2.01 USDC (≈₦3,115.50)');
    expect(text).toContain('Reply *menu* for options.');
    expect(text).not.toContain('Hey');
    expect(text).not.toContain('stellar.expert');
  });

  it('skips NGN for XLM', () => {
    const text = buildIncomingCreditCaption({
      amount: 0.5,
      asset: 'XLM',
      balancePretty: '1.20',
      sellRateNgn: 1550,
      includeTxUrl: false,
    });
    expect(text).toContain('New balance: 1.20 XLM');
    expect(text).not.toContain('≈₦');
    expect(text).not.toContain('network fees');
  });

  it('includes a single tx URL on text-only fallback', () => {
    const text = buildIncomingCreditCaption({
      amount: 1,
      asset: 'USDC',
      balancePretty: '1.00',
      sellRateNgn: 1550,
      includeTxUrl: true,
      txUrl: 'https://stellar.expert/explorer/public/tx/abc',
    });
    expect(text).toContain('Tx: https://stellar.expert/explorer/public/tx/abc');
    expect(text.match(/stellar\.expert/g)?.length).toBe(1);
  });
});

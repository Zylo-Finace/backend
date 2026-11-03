import { parseBankDetailsInput, parseNairaBankSendPhrase } from './ramp.bank-parse';

describe('parseBankDetailsInput', () => {
  it('accepts bank keyword form', () => {
    const r = parseBankDetailsInput('bank Opay 0123456789 Jane Doe');
    expect(r).toEqual({
      ok: true,
      value: {
        bankQuery: 'Opay',
        accountNumber: '0123456789',
        accountNameHint: 'Jane Doe',
      },
    });
  });

  it('accepts without bank keyword', () => {
    const r = parseBankDetailsInput('GTBank 0123456789 Ada Lovelace');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.bankQuery).toBe('GTBank');
      expect(r.value.accountNumber).toBe('0123456789');
    }
  });

  it('rejects non-10-digit account with specific length', () => {
    const r = parseBankDetailsInput('bank Opay 012345678 Jane Doe');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('got 9');
      expect(r.error).toContain('10 digits');
    }
  });

  it('rejects empty / unparseable with actionable hint', () => {
    const r = parseBankDetailsInput('hello');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Couldn|format|Send:/i);
  });
});

describe('parseNairaBankSendPhrase', () => {
  it('parses send 300 naira to account then bank', () => {
    expect(parseNairaBankSendPhrase('Send 300 naira to 9078426686 OPay')).toEqual({
      amountNgn: 300,
      accountNumber: '9078426686',
      bankQuery: 'OPay',
    });
  });

  it('parses bank then account', () => {
    expect(parseNairaBankSendPhrase('transfer 5000 ngn to Opay 9078426686')).toEqual({
      amountNgn: 5000,
      accountNumber: '9078426686',
      bankQuery: 'Opay',
    });
  });

  it('ignores naira-worth-of-usdc crypto phrasing', () => {
    expect(parseNairaBankSendPhrase('send my mum 5000 naira worth of usdc')).toBeNull();
  });
});

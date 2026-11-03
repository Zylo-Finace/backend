import { classifyIntentRegex } from './ramp.intent';

describe('classifyIntentRegex', () => {
  it('parses send james 2 usdc', () => {
    const r = classifyIntentRegex('send james 2 usdc');
    expect(r.intent).toBe('send');
    expect(r.amount).toBe(2);
    expect(r.recipient?.toLowerCase()).toBe('james');
    expect(r.currency).toBe('usdc');
  });

  it('parses send 2 usdc to james', () => {
    const r = classifyIntentRegex('send 2 usdc to james');
    expect(r.intent).toBe('send');
    expect(r.amount).toBe(2);
    expect(r.recipient?.toLowerCase()).toBe('james');
  });

  it('parses sell / cash out', () => {
    expect(classifyIntentRegex('sell 5 usdc').intent).toBe('sell');
    expect(classifyIntentRegex('cash out 5usdc').intent).toBe('sell');
    expect(classifyIntentRegex('withdraw 5 usdc to my bank').amount).toBe(5);
  });

  it('parses balance and rates', () => {
    expect(classifyIntentRegex("what's my balance").intent).toBe('balance');
    expect(classifyIntentRegex('how much do i have').intent).toBe('balance');
    expect(classifyIntentRegex("what's the rate").intent).toBe('rates');
  });

  it('flags ambiguous bare amount+name', () => {
    const r = classifyIntentRegex('2 usdc james');
    expect(r.intent).toBe('ambiguous');
    expect(r.alternatives?.length).toBeGreaterThanOrEqual(2);
  });

  it('detects cancel and general', () => {
    expect(classifyIntentRegex('never mind').intent).toBe('cancel');
    expect(classifyIntentRegex('what is USDC').intent).toBe('general');
  });

  it('extracts stellar address recipient', () => {
    const g = `G${'A'.repeat(55)}`;
    const r = classifyIntentRegex(`transfer 0.5 usdc to ${g}`);
    expect(r.intent).toBe('send');
    expect(r.recipient).toBe(g);
  });

  it('routes send naira to bank account as ngn bank send', () => {
    const r = classifyIntentRegex('Send 300 naira to 9078426686 OPay');
    expect(r.intent).toBe('send');
    expect(r.currency).toBe('ngn');
    expect(r.amount).toBe(300);
    expect(r.bankAccount).toBe('9078426686');
    expect(r.bankQuery?.toLowerCase()).toBe('opay');
    expect(r.recipient).toBeNull();
  });
});

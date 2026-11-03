import { createHash } from 'node:crypto';

import {
  formatSacAmount,
  isClassicStellarAddress,
  isContractStellarAddress,
  stellarClassicSeed,
  usdcToStroops,
} from './ramp.stellar-classic';

describe('stellar classic address helpers', () => {
  it('detects G vs C addresses', () => {
    expect(isClassicStellarAddress('G' + 'A'.repeat(55))).toBe(true);
    expect(isContractStellarAddress('C' + 'A'.repeat(55))).toBe(true);
    expect(isClassicStellarAddress('C' + 'A'.repeat(55))).toBe(false);
  });
});

describe('stellarClassicSeed', () => {
  const mnemonic =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

  it('is deterministic for the same phone digits + mnemonic', () => {
    const a = stellarClassicSeed('2348168882530', mnemonic);
    const b = stellarClassicSeed('+234 816 888 2530', mnemonic);
    expect(a.equals(b)).toBe(true);
  });

  it('differs across phones', () => {
    expect(
      stellarClassicSeed('2348111111111', mnemonic).equals(
        stellarClassicSeed('2348222222222', mnemonic),
      ),
    ).toBe(false);
  });

  it('is 32 bytes', () => {
    expect(stellarClassicSeed('1', mnemonic).length).toBe(32);
  });

  it('does not collide with celo hash domain', () => {
    const seed = stellarClassicSeed('2348', mnemonic);
    const other = createHash('sha256').update(`zylo:celo:2348`).digest();
    expect(seed.equals(other)).toBe(false);
  });
});

describe('formatSacAmount / usdcToStroops', () => {
  it('round-trips typical amounts', () => {
    expect(formatSacAmount(usdcToStroops(1.5))).toBe('1.5');
    expect(formatSacAmount(usdcToStroops(0.0000001))).toBe('0.0000001');
  });
});

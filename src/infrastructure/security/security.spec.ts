import type { AppConfig } from '../../config/app.config';
import { isWeakPin } from '../../modules/auth/dto/auth.dto';
import { CryptoService } from './crypto.service';
import { HashingService } from './hashing.service';

const config = {
  security: { encryptionKey: Buffer.alloc(32, 9).toString('base64') },
} as AppConfig;

describe('HashingService', () => {
  const hashing = new HashingService();

  it('produces a verifiable Argon2id digest', async () => {
    const digest = await hashing.hash('correct horse battery staple');

    expect(digest).toMatch(/^\$argon2id\$/);
    expect(await hashing.verify(digest, 'correct horse battery staple')).toBe(true);
  });

  it('rejects the wrong plaintext', async () => {
    const digest = await hashing.hash('739205');
    expect(await hashing.verify(digest, '739206')).toBe(false);
  });

  it('salts every hash, so identical PINs do not share a digest', async () => {
    // Without a per-hash salt, an attacker who cracks one 4-digit PIN has cracked
    // every account that chose the same one.
    const [first, second] = await Promise.all([hashing.hash('1357'), hashing.hash('1357')]);

    expect(first).not.toBe(second);
    expect(await hashing.verify(first, '1357')).toBe(true);
    expect(await hashing.verify(second, '1357')).toBe(true);
  });

  it('treats a corrupt digest as a failed verification, not an error', async () => {
    // A 500 here would confirm to an attacker that the account row exists.
    await expect(hashing.verify('not-a-hash', 'anything')).resolves.toBe(false);
  });

  it('burns comparable time when no digest exists', async () => {
    // Guards against the timing oracle that distinguishes "no such user" from
    // "wrong PIN". Asserted loosely — this is about the code path, not a
    // wall-clock benchmark that would be flaky in CI.
    const started = Date.now();
    const result = await hashing.verifyWithDummy(null, '1234');
    const elapsed = Date.now() - started;

    expect(result).toBe(false);
    expect(elapsed).toBeGreaterThan(5);
  });

  describe('secureCompare', () => {
    it('matches identical strings', () => {
      expect(hashing.secureCompare('abc123', 'abc123')).toBe(true);
    });

    it('rejects different strings, including different lengths', () => {
      expect(hashing.secureCompare('abc123', 'abc124')).toBe(false);
      expect(hashing.secureCompare('abc', 'abcdef')).toBe(false);
    });
  });
});

describe('CryptoService', () => {
  const crypto = new CryptoService(config);

  it('refuses to construct with a wrongly sized key', () => {
    // Fails at boot rather than on the first 2FA enrolment months later.
    expect(
      () =>
        new CryptoService({
          security: { encryptionKey: Buffer.alloc(16).toString('base64') },
        } as AppConfig),
    ).toThrow(/32 bytes/);
  });

  it('round-trips a value', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    expect(crypto.decrypt(crypto.encrypt(secret))).toBe(secret);
  });

  it('produces a different ciphertext each time', () => {
    // A reused IV under GCM is catastrophic; identical plaintexts must not
    // produce identical envelopes.
    expect(crypto.encrypt('same')).not.toBe(crypto.encrypt('same'));
  });

  it('handles unicode and empty strings', () => {
    expect(crypto.decrypt(crypto.encrypt('Adaeze Okonkwo ₦'))).toBe('Adaeze Okonkwo ₦');
    expect(crypto.decrypt(crypto.encrypt(''))).toBe('');
  });

  it('detects tampering with the ciphertext', () => {
    const envelope = crypto.encrypt('balance:1000');
    const parts = envelope.split(':');
    // Flip the payload; GCM's auth tag must reject it.
    const tampered = [...parts.slice(0, 3), Buffer.from('balance:9999').toString('base64')].join(
      ':',
    );

    expect(() => crypto.decrypt(tampered)).toThrow();
  });

  it('rejects a value encrypted under a different key', () => {
    const other = new CryptoService({
      security: { encryptionKey: Buffer.alloc(32, 1).toString('base64') },
    } as AppConfig);

    expect(() => crypto.decrypt(other.encrypt('secret'))).toThrow();
  });

  it.each(['', 'garbage', 'v1:only:three', 'v2:a:b:c'])(
    'rejects malformed envelope %s',
    (input) => {
      expect(() => crypto.decrypt(input)).toThrow();
    },
  );

  it('passes null through the nullable helpers', () => {
    expect(crypto.encryptNullable(null)).toBeNull();
    expect(crypto.decryptNullable(undefined)).toBeNull();
  });

  it('generates high-entropy, url-safe tokens', () => {
    const token = crypto.randomToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(new Set(Array.from({ length: 100 }, () => crypto.randomToken())).size).toBe(100);
  });

  it('generates numeric OTPs of the requested length', () => {
    const otp = crypto.numericOtp(6);
    expect(otp).toMatch(/^\d{6}$/);
  });

  it('hashes deterministically with sha256', () => {
    expect(crypto.sha256('token')).toBe(crypto.sha256('token'));
    expect(crypto.sha256('token')).toHaveLength(64);
  });
});

describe('PIN policy', () => {
  it.each(['0000', '1111', '1234', '4321', '123456', '654321', '2580', '5555'])(
    'rejects the commonly-guessed PIN %s',
    (pin) => {
      // An attacker with a handful of attempts tries exactly these first, so
      // rate limiting alone is not enough — these must never be chosen.
      expect(isWeakPin(pin)).toBe(true);
    },
  );

  it.each(['7392', '8461', '739205', '905183'])('accepts the unpredictable PIN %s', (pin) => {
    expect(isWeakPin(pin)).toBe(false);
  });

  it('catches sequential runs of any length', () => {
    expect(isWeakPin('3456')).toBe(true);
    expect(isWeakPin('87654')).toBe(true);
  });
});

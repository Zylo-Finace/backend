import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';
import { AppException } from '../../core/errors/app.exception';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
/** 96 bits — the size GCM is specified for; longer nonces are re-hashed internally. */
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
/** Version prefix so a future key rotation or algorithm change stays decryptable. */
const ENVELOPE_VERSION = 'v1';

/**
 * Symmetric encryption for sensitive fields, plus token generation.
 *
 * ## Why GCM
 *
 * AES-256-**GCM** is authenticated: tampering with the ciphertext fails
 * decryption instead of silently yielding different plaintext. Unauthenticated
 * modes (CBC) let an attacker who can write to the database flip bits in a
 * decrypted value — the classic padding-oracle territory.
 *
 * ## Envelope format
 *
 * `v1:<iv>:<authTag>:<ciphertext>`, each part base64. The IV is random per
 * encryption and stored alongside: GCM's security collapses entirely if an IV is
 * ever reused with the same key, so it is never derived or reused.
 *
 * ## What this is not
 *
 * Encrypted columns are not searchable. Anything needing a lookup (phone number,
 * email, bank account number) stays plaintext and is protected by database-level
 * encryption at rest and access control instead. This service is for secrets we
 * only ever read back whole: TOTP seeds, provider API credentials, WhatsApp tokens.
 */
@Injectable()
export class CryptoService {
  private readonly key: Buffer;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const key = Buffer.from(config.security.encryptionKey, 'base64');

    // Fail at boot, not on the first encrypt. A short key would otherwise mean
    // the service starts fine and only breaks when someone enables 2FA.
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes (got ${key.length}). ` +
          'Generate one with: openssl rand -base64 32',
      );
    }
    this.key = key;
  }

  /** Encrypts a UTF-8 string into a self-describing envelope. */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);

    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [
      ENVELOPE_VERSION,
      iv.toString('base64'),
      authTag.toString('base64'),
      ciphertext.toString('base64'),
    ].join(':');
  }

  /**
   * Decrypts an envelope produced by {@link encrypt}.
   *
   * @throws AppException on any tampering, truncation or wrong key. The message
   *         is deliberately uniform — distinguishing "bad tag" from "bad format"
   *         hands an attacker a decryption oracle.
   */
  decrypt(envelope: string): string {
    const parts = envelope.split(':');
    if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
      throw AppException.internal('Unable to decrypt value');
    }

    const [, ivB64, tagB64, dataB64] = parts;
    try {
      const iv = Buffer.from(ivB64!, 'base64');
      const authTag = Buffer.from(tagB64!, 'base64');
      const ciphertext = Buffer.from(dataB64!, 'base64');

      if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
        throw new Error('Malformed envelope');
      }

      const decipher = createDecipheriv(ALGORITHM, this.key, iv);
      decipher.setAuthTag(authTag);

      // `final()` is where GCM verifies the tag; it throws if anything changed.
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch (cause) {
      throw AppException.internal('Unable to decrypt value', cause);
    }
  }

  /** Encrypts only when a value is present — for nullable columns. */
  encryptNullable(plaintext: string | null | undefined): string | null {
    return plaintext == null ? null : this.encrypt(plaintext);
  }

  decryptNullable(envelope: string | null | undefined): string | null {
    return envelope == null ? null : this.decrypt(envelope);
  }

  /**
   * SHA-256, hex encoded.
   *
   * For *non-secret* lookup keys only — refresh tokens, API keys, invitation
   * tokens. These are 256 bits of randomness already, so a slow KDF buys nothing:
   * they cannot be brute-forced or guessed from a dictionary. Passwords and PINs
   * are low-entropy and must use {@link HashingService} instead.
   */
  sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  /** Cryptographically secure URL-safe token. 32 bytes ⇒ 256 bits of entropy. */
  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  /**
   * A numeric OTP of fixed length, uniformly distributed.
   *
   * Uses `randomInt` rather than `Math.random()` (not cryptographic) and rejects
   * the naive `randomBytes % 10` (modulo bias skews the digit distribution).
   */
  numericOtp(length = 6): string {
    let otp = '';
    for (let index = 0; index < length; index += 1) {
      otp += randomInt(0, 10).toString();
    }
    return otp;
  }
}

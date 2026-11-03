import { timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * OWASP-recommended Argon2id parameters (Password Storage Cheat Sheet, 2024):
 * 19 MiB memory, 2 iterations, 1 degree of parallelism.
 *
 * Memory cost is the important dial — it is what makes GPU and ASIC cracking
 * expensive, because memory bandwidth does not parallelise the way raw hashing
 * does. Raising `timeCost` instead would slow us down without buying that.
 *
 * Budget check: 19 MiB per concurrent verification. 50 simultaneous logins ≈
 * 1 GB transient. That bounds how many auth requests a pod should accept at once
 * and is the reason authentication endpoints get their own tight rate limit.
 */
// `raw: false` is explicit so TypeScript resolves `hash()` to the string-returning
// overload rather than the Buffer one — the digest is stored as text.
const ARGON2_OPTIONS: argon2.HashOptions & { raw: false } = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  raw: false,
};

/** `needsRehash` compares only the cost parameters, not the variant. */
const ARGON2_REHASH_POLICY = {
  memoryCost: ARGON2_OPTIONS.memoryCost,
  timeCost: ARGON2_OPTIONS.timeCost,
  parallelism: ARGON2_OPTIONS.parallelism,
} as const;

/**
 * A pre-computed hash used to burn the same CPU when a user does not exist.
 * Generated once at startup; see {@link HashingService.verifyWithDummy}.
 */
const DUMMY_PLAINTEXT = 'wabot-timing-equaliser';

/**
 * Credential hashing.
 *
 * Argon2id over bcrypt: bcrypt silently truncates at 72 bytes, is not
 * memory-hard, and its cost factor is the only tunable. Argon2id won the Password
 * Hashing Competition and resists both GPU cracking (memory-hard) and side
 * channels (the `id` variant's hybrid addressing).
 */
@Injectable()
export class HashingService {
  private dummyHash?: string;

  /** Hashes a password or PIN. The salt is generated per call and embedded. */
  async hash(plaintext: string): Promise<string> {
    return argon2.hash(plaintext, ARGON2_OPTIONS);
  }

  /**
   * Verifies a plaintext against a stored digest.
   *
   * Never throws on a malformed hash — a corrupt row must read as "wrong
   * credential", not as a 500 that tells an attacker the record exists.
   */
  async verify(digest: string, plaintext: string): Promise<boolean> {
    try {
      return await argon2.verify(digest, plaintext);
    } catch {
      return false;
    }
  }

  /**
   * Verifies against a real digest, or burns equivalent CPU when there is none.
   *
   * Without this, "no such user" returns in ~1ms while "wrong password" takes
   * ~50ms, and that gap is a reliable oracle for enumerating which phone numbers
   * hold accounts. Enumeration of a customer base is itself a leak, and on a
   * WhatsApp product the phone number *is* the identity.
   */
  async verifyWithDummy(digest: string | null | undefined, plaintext: string): Promise<boolean> {
    if (digest) {
      return this.verify(digest, plaintext);
    }
    const dummy = (this.dummyHash ??= await argon2.hash(DUMMY_PLAINTEXT, ARGON2_OPTIONS));
    await this.verify(dummy, plaintext);
    return false;
  }

  /**
   * True when a stored digest was produced with weaker parameters than current
   * policy — the signal to transparently re-hash on next successful login.
   */
  needsRehash(digest: string): boolean {
    try {
      return argon2.needsRehash(digest, ARGON2_REHASH_POLICY);
    } catch {
      // Unparseable digest: treat as needing replacement.
      return true;
    }
  }

  /**
   * Constant-time comparison for values already reduced to a fixed-length digest
   * (session tokens, API keys, webhook signatures).
   *
   * `===` on strings short-circuits at the first differing byte, which leaks the
   * length of the matching prefix. Not for passwords — those go through
   * {@link verify}.
   */
  secureCompare(a: string, b: string): boolean {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    // `timingSafeEqual` throws on length mismatch, which would itself leak length.
    if (left.length !== right.length) {
      // Still burn a comparison so the timing profile stays flat.
      timingSafeEqual(left, left);
      return false;
    }
    return timingSafeEqual(left, right);
  }
}

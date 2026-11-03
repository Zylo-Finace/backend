import type { KycIdentifierType, KycProviderName } from '@prisma/client';

/** The details a customer typed, checked against the registry's record. */
export interface BasicVerificationRequest {
  identifier: string;
  firstName: string;
  middleName?: string;
  lastName: string;
  /** `MALE` or `FEMALE` — the only values the registries accept. */
  gender: string;
  /** `YYYY-MM-DD`. */
  birthday: string;
  /** Local Nigerian format, e.g. `08012345678`. */
  phoneNumber: string;
}

/** Field-by-field verdicts from a basic check. */
export interface BasicVerificationResult {
  outcome: VerificationOutcome;
  nameMatch: boolean;
  /** 0–100 similarity between the supplied and registered names. */
  nameMatchPercent?: number;
  birthdayMatch: boolean;
  genderMatch: boolean;
  phoneMatch: boolean;
  /** Verbatim per-field results, kept for the audit row. */
  raw: Record<string, unknown>;
  charge: VerificationCharge;
}

/**
 * The identity a registry holds, in our vocabulary rather than the provider's.
 *
 * Flat and provider-neutral on purpose: BVN and NIN payloads disagree about
 * field names for the same three facts (`surname`/`last_name`,
 * `birth_date`/`birthday`, `telephone_no`/`phone_number`), and every one of
 * those spellings is PayVessel's to change. Normalising at the adapter means the
 * KYC service compares one shape to itself.
 */
export interface RegistryIdentity {
  firstName?: string;
  middleName?: string;
  lastName?: string;
  /** BVN records carry a separate "name as printed on the card". */
  nameOnCard?: string;
  gender?: string;
  /** `YYYY-MM-DD` as returned upstream. */
  birthday?: string;
  phoneNumber?: string;
  /** BVN records carry up to two numbers; either may be the one in use. */
  phoneNumber2?: string;
}

/** The registry's own record, retrieved by identifier alone. */
export interface EnhancedVerificationResult {
  outcome: VerificationOutcome;
  identity?: RegistryIdentity;
  /**
   * Response with the photo stripped.
   *
   * Providers return a full-face image on enhanced checks. We have no use for
   * one, it is the most sensitive field in the payload, and storing it in a JSON
   * audit column is how a support query accidentally exports biometrics.
   */
  raw: Record<string, unknown>;
  charge: VerificationCharge;
}

export enum VerificationOutcome {
  /** Identifier found, and (basic only) the supplied details agreed. */
  Matched = 'matched',
  /** Identifier found but the supplied details disagreed. */
  Mismatch = 'mismatch',
  /** No such identifier upstream. */
  NotFound = 'not_found',
  /** The check could not run — provider error, timeout, or empty balance. */
  Failed = 'failed',
}

/** Providers bill per lookup, including for a "not found" answer. */
export interface VerificationCharge {
  charged: boolean;
  /** Decimal string in naira, e.g. `"25.00"`. */
  amount: string;
}

/**
 * A provider that can check a Nigerian BVN or NIN against the registry.
 *
 * Two modes, because they answer different questions and cost different
 * amounts. **Basic** takes what the customer typed and returns per-field
 * verdicts — cheap, and the right check when you already believe you know who
 * somebody is. **Enhanced** takes the number alone and returns the registry's
 * record — this is the one whose names are authoritative enough to write onto a
 * profile and send to a partner bank.
 */
export interface KycVerificationProvider {
  readonly name: KycProviderName;

  verifyBasic(
    type: KycIdentifierType,
    request: BasicVerificationRequest,
  ): Promise<BasicVerificationResult>;

  verifyEnhanced(type: KycIdentifierType, identifier: string): Promise<EnhancedVerificationResult>;
}

/** DI token for the configured verification provider. */
export const KYC_PROVIDER = Symbol('KYC_PROVIDER');

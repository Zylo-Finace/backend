import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import {
  KycCheckMode,
  KycCheckStatus,
  KycIdentifierType,
  KycLevel,
  KycStatus,
  type KycIdentityRecord,
  type KycProfile,
} from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';
import { RequestContext } from '../../core/context/request-context';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { InjectPrisma } from '../../infrastructure/database/prisma.module';
import type { ExtendedPrismaClient } from '../../infrastructure/database/prisma.service';
import { CryptoService } from '../../infrastructure/security/crypto.service';
import {
  KYC_PROVIDER,
  type EnhancedVerificationResult,
  type KycVerificationProvider,
  type RegistryIdentity,
  VerificationOutcome,
} from './kyc-provider.interface';
import {
  dateOfBirthMatches,
  genderMatches,
  joinName,
  nameSimilarity,
  normaliseGender,
  parseIsoDate,
  phoneMatches,
} from './kyc.matching';
import { atLeast, levelFor, limitsFor, rank, tierToLevel, type TierLimits } from './kyc.tiers';

/** Tier 1: what the customer supplies alongside their BVN. */
export interface VerifyBvnInput {
  userId: string;
  /** 11 digits. Formatting is stripped before use. */
  bvn: string;
  /** The phone number the customer says is attached to the BVN. */
  phoneNumber: string;
  /** `YYYY-MM-DD`. */
  dateOfBirth: string;
  /** Admin `User.id` when staff ran the check on the customer's behalf. */
  requestedBy?: string;
}

/** Tier 2: the NIN alone. Everything else is compared against the BVN record. */
export interface VerifyNinInput {
  userId: string;
  /** 11 digits. Formatting is stripped before use. */
  nin: string;
  requestedBy?: string;
}

export interface KycSnapshot {
  level: KycLevel;
  status: KycStatus;
  bvnVerified: boolean;
  ninVerified: boolean;
  /** Last four digits only — enough for support, useless to an attacker. */
  bvnLast4: string | null;
  ninLast4: string | null;
  /** The name the BVN registry holds. What a partner bank matches against. */
  verifiedName: string | null;
  limits: TierLimits;
  canHoldPermanentAccount: boolean;
  rejectionReason: string | null;
  verifiedAt: Date | null;
  /** What tier 2 still needs, when the customer is not there yet. */
  nextStep: string | null;
}

/** Which fields agreed, recorded on the audit row. Never shown to the customer. */
interface MatchDetail {
  nameMatchPercent?: number;
  nameMatch?: boolean;
  genderMatch?: boolean;
  dateOfBirthMatch?: boolean;
  phoneMatch?: boolean;
}

/** Nigerian BVN and NIN are both exactly eleven digits. */
const IDENTIFIER_PATTERN = /^\d{11}$/;

/**
 * Deliberately identical whichever supplied field failed.
 *
 * Tier 1 answers "do this phone number and date of birth belong to this BVN?".
 * Naming the field that failed turns that into a guessing game with feedback:
 * an attacker holding somebody's BVN could walk their date of birth one attempt
 * at a time. The failing fields go to the audit row, which staff can read and
 * the customer cannot.
 */
const TIER_1_MISMATCH =
  'The phone number and date of birth you entered do not match the record held against that BVN.';

/**
 * Customer identity verification and the tier ladder built on it.
 *
 * ## The ladder
 *
 * - **Tier 0** — registered. Nothing proven. Single-use on-ramp accounts only.
 * - **Tier 1** — the customer supplies a **BVN, a phone number and a date of
 *   birth**. We fetch the BVN record and check that both supplied fields match
 *   it. The registry's full identity is then stored as a
 *   {@link KycIdentityRecord}, which becomes the reference for everything after.
 * - **Tier 2** — the customer supplies **only a NIN**. We fetch the NIN record
 *   and compare it against the stored BVN record: name at or above the
 *   configured similarity floor (80% by default), gender and date of birth
 *   exact. Agreement means the two registries independently describe the same
 *   person, which is a far stronger claim than either check alone.
 * - **Tier 3** — tier 2 plus a human review.
 *
 * ## Why tier 2 compares registries rather than re-checking the customer
 *
 * Asking the customer to re-type their name for the NIN check would test
 * nothing: someone holding a stolen NIN can type the name that goes with it.
 * Comparing the NIN record to the *BVN record we already hold* is what makes the
 * step meaningful — the fraudster would need two government identifiers
 * describing the same person, which is the point of collecting the second one.
 *
 * ## Storing a BVN
 *
 * The number cannot be discarded: PayVessel's partner banks require it in the
 * account-creation call, so a one-way hash would mean no customer could ever be
 * issued an account. It is therefore encrypted (AES-256-GCM, via
 * {@link CryptoService}), hashed separately for duplicate detection, and
 * truncated to four digits for anything a human reads. Three different needs,
 * three different columns.
 */
@Injectable()
export class KycService {
  constructor(
    @InjectPrisma() private readonly db: ExtendedPrismaClient,
    @Inject(KYC_PROVIDER) private readonly provider: KycVerificationProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly crypto: CryptoService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(KycService.name);
  }

  // ===========================================================================
  //  Reads
  // ===========================================================================

  /** The customer's current standing. Safe to return over the API. */
  async getSnapshot(userId: string): Promise<KycSnapshot> {
    const profile = await this.db.kycProfile.findFirst({ where: { userId } });
    const bvnRecord = profile ? await this.identityRecord(profile.id, KycIdentifierType.BVN) : null;
    return toSnapshot(profile, bvnRecord);
  }

  /** Every identity record on file, newest registry first. For staff review. */
  async getIdentityRecords(userId: string): Promise<KycIdentityRecord[]> {
    const profile = await this.db.kycProfile.findFirst({
      where: { userId },
      select: { id: true },
    });
    if (!profile) return [];

    return this.db.kycIdentityRecord.findMany({
      where: { profileId: profile.id },
      orderBy: { capturedAt: 'desc' },
    });
  }

  /**
   * Whether this customer may be issued a permanent NUBAN.
   *
   * The single gate `AccountProvisioningService` consults. Deliberately a
   * question about *policy*, not about which fields happen to be populated, so
   * raising the bar is a config change rather than a hunt through call sites.
   */
  async canIssuePermanentAccount(userId: string): Promise<boolean> {
    const profile = await this.db.kycProfile.findFirst({
      where: { userId },
      select: { level: true, status: true },
    });
    if (!profile || profile.status !== KycStatus.VERIFIED) return false;

    const required = tierToLevel(this.config.kyc.staticAccountMinTier);
    return atLeast(profile.level, required) && limitsFor(profile.level).permanentAccount;
  }

  /**
   * The identifiers needed to ask a partner bank for an account.
   *
   * The only path that decrypts. Returns nothing unless the customer is
   * verified — an unverified BVN is not evidence, and passing one upstream would
   * produce exactly the compliance gap the tier ladder exists to prevent.
   */
  async getVerifiedIdentifiers(
    userId: string,
  ): Promise<{ bvn?: string; nin?: string; verifiedName?: string }> {
    const profile = await this.db.kycProfile.findFirst({ where: { userId } });
    if (!profile || profile.status !== KycStatus.VERIFIED) return {};

    const bvnRecord = await this.identityRecord(profile.id, KycIdentifierType.BVN);

    return {
      bvn:
        profile.bvnVerifiedAt && profile.bvnEncrypted
          ? this.crypto.decrypt(profile.bvnEncrypted)
          : undefined,
      nin:
        profile.ninVerifiedAt && profile.ninEncrypted
          ? this.crypto.decrypt(profile.ninEncrypted)
          : undefined,
      // The BVN registry's spelling. The partner bank matches the account name
      // against that record, not against anything the customer told us.
      verifiedName: bvnRecord ? joinName(bvnRecord) || undefined : undefined,
    };
  }

  // ===========================================================================
  //  Tier 1 — BVN
  // ===========================================================================

  /**
   * Verifies a BVN against the phone number and date of birth the customer gave.
   *
   * Idempotent for the common case: re-submitting a BVN that is already verified
   * on this profile returns immediately without spending another provider
   * charge.
   */
  async verifyBvn(input: VerifyBvnInput): Promise<KycSnapshot> {
    const tenantId = RequestContext.requireTenantId();
    const bvn = digitsOnly(input.bvn);
    this.assertWellFormed(bvn, KycIdentifierType.BVN);

    const suppliedDob = parseIsoDate(input.dateOfBirth);
    if (!suppliedDob) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: 'Date of birth must be a real date in YYYY-MM-DD format',
      });
    }

    const digest = hash(bvn);
    const last4 = bvn.slice(-4);
    const profile = await this.ensureProfile(tenantId, input.userId);

    if (profile.bvnHash === digest && profile.bvnVerifiedAt) {
      return toSnapshot(profile, await this.identityRecord(profile.id, KycIdentifierType.BVN));
    }

    await this.assertNotDuplicate(tenantId, input.userId, KycIdentifierType.BVN, digest);
    await this.assertAttemptsRemaining(tenantId, input.userId);

    const { result, verificationId } = await this.runCheck({
      tenantId,
      profileId: profile.id,
      userId: input.userId,
      type: KycIdentifierType.BVN,
      identifier: bvn,
      last4,
      requestedBy: input.requestedBy,
    });

    if (result.outcome !== VerificationOutcome.Matched || !result.identity) {
      return this.recordFailedLookup(profile, result.outcome, KycIdentifierType.BVN);
    }

    const registry = result.identity;
    const registryDob = parseIsoDate(registry.birthday);

    const detail: MatchDetail = {
      dateOfBirthMatch: dateOfBirthMatches(suppliedDob, registryDob),
      phoneMatch: phoneMatches(input.phoneNumber, [registry.phoneNumber, registry.phoneNumber2]),
    };

    await this.db.kycVerification.update({
      where: { id: verificationId },
      data: {
        status:
          detail.dateOfBirthMatch && detail.phoneMatch
            ? KycCheckStatus.MATCHED
            : KycCheckStatus.MISMATCH,
        matchResult: detail as never,
      },
    });

    if (!detail.dateOfBirthMatch || !detail.phoneMatch) {
      this.logger.warn(
        { userId: input.userId, ...detail },
        'BVN found but the supplied details did not match the record',
      );

      const updated = await this.db.kycProfile.update({
        where: { id: profile.id },
        data: {
          submittedAt: profile.submittedAt ?? new Date(),
          status: KycStatus.REJECTED,
          rejectionReason: TIER_1_MISMATCH,
        },
      });
      return toSnapshot(updated, null);
    }

    // Everything agreed. Store the registry's identity — it is the reference for
    // tier 2 and the name a partner bank will match an account against.
    const now = new Date();

    await this.saveIdentityRecord({
      tenantId,
      userId: input.userId,
      profileId: profile.id,
      source: KycIdentifierType.BVN,
      identifierLast4: last4,
      identity: registry,
    });

    // The user record carries the current profile; the identity record carries
    // the evidence. Both are written, because the paths that read a customer's
    // name — receipts, statements, account creation — have no business joining a
    // KYC table to do it.
    await this.applyToUserProfile(input.userId, registry, registryDob);

    const level = this.promote(profile, {
      bvnVerified: true,
      ninVerified: Boolean(profile.ninVerifiedAt),
    });

    const updated = await this.db.kycProfile.update({
      where: { id: profile.id },
      data: {
        bvnEncrypted: this.crypto.encrypt(bvn),
        bvnHash: digest,
        bvnLast4: last4,
        bvnVerifiedAt: now,
        level,
        status: KycStatus.VERIFIED,
        rejectionReason: null,
        submittedAt: profile.submittedAt ?? now,
        verifiedAt: now,
      },
    });

    this.logger.info({ userId: input.userId, level }, 'BVN verified; customer promoted');

    return toSnapshot(updated, await this.identityRecord(profile.id, KycIdentifierType.BVN));
  }

  // ===========================================================================
  //  Tier 2 — NIN, cross-matched against the BVN record
  // ===========================================================================

  /**
   * Verifies a NIN and checks that it describes the same person as the BVN.
   *
   * Only the number is collected. Name, gender and date of birth all come from
   * the registry and are compared against the stored BVN record: name at or
   * above the configured similarity floor, gender and date of birth exact.
   *
   * A mismatch does **not** demote the customer. They earned tier 1 with a BVN
   * that checked out, and a NIN that turns out to belong to somebody else says
   * nothing about that — it is recorded, flagged, and the tier-2 step simply
   * does not complete.
   */
  async verifyNin(input: VerifyNinInput): Promise<KycSnapshot> {
    const tenantId = RequestContext.requireTenantId();
    const nin = digitsOnly(input.nin);
    this.assertWellFormed(nin, KycIdentifierType.NIN);

    const profile = await this.ensureProfile(tenantId, input.userId);
    const bvnRecord = await this.identityRecord(profile.id, KycIdentifierType.BVN);

    if (!profile.bvnVerifiedAt || !bvnRecord) {
      // There is nothing to compare against. Stated plainly rather than
      // attempted and failed, because the customer's next action is different.
      throw new AppException(ErrorCode.PRECONDITION_FAILED, {
        message: 'Verify your BVN first — your NIN is checked against the details it holds.',
        retryable: false,
      });
    }

    const digest = hash(nin);
    const last4 = nin.slice(-4);

    if (profile.ninHash === digest && profile.ninVerifiedAt) {
      return toSnapshot(profile, bvnRecord);
    }

    await this.assertNotDuplicate(tenantId, input.userId, KycIdentifierType.NIN, digest);
    await this.assertAttemptsRemaining(tenantId, input.userId);

    const { result, verificationId } = await this.runCheck({
      tenantId,
      profileId: profile.id,
      userId: input.userId,
      type: KycIdentifierType.NIN,
      identifier: nin,
      last4,
      requestedBy: input.requestedBy,
    });

    if (result.outcome !== VerificationOutcome.Matched || !result.identity) {
      return this.recordFailedLookup(profile, result.outcome, KycIdentifierType.NIN);
    }

    const registry = result.identity;
    const registryDob = parseIsoDate(registry.birthday);

    const namePercent = nameSimilarity(joinName(registry), joinName(bvnRecord));
    const floor = this.config.kyc.crossMatchNameMinPercent;

    const detail: MatchDetail = {
      nameMatchPercent: namePercent,
      nameMatch: namePercent >= floor,
      genderMatch: genderMatches(registry.gender, bvnRecord.gender),
      dateOfBirthMatch: dateOfBirthMatches(registryDob, bvnRecord.dateOfBirth),
    };

    const consistent = Boolean(detail.nameMatch && detail.genderMatch && detail.dateOfBirthMatch);

    await this.db.kycVerification.update({
      where: { id: verificationId },
      data: {
        status: consistent ? KycCheckStatus.MATCHED : KycCheckStatus.MISMATCH,
        nameMatchPercent: namePercent,
        matchResult: detail as never,
      },
    });

    // The NIN snapshot is stored either way. When it disagrees, it *is* the
    // evidence — throwing it away would leave a "NIN rejected" row nobody can
    // audit.
    await this.saveIdentityRecord({
      tenantId,
      userId: input.userId,
      profileId: profile.id,
      source: KycIdentifierType.NIN,
      identifierLast4: last4,
      identity: registry,
      nameMatchPercent: namePercent,
    });

    if (!consistent) {
      // Two government identifiers describing different people is a strong fraud
      // signal, not a typo — the customer typed nothing but eleven digits.
      this.logger.warn(
        { userId: input.userId, ...detail },
        'NIN record does not agree with the BVN record; tier 2 refused',
      );

      throw new AppException(ErrorCode.PRECONDITION_FAILED, {
        message:
          'The details on that NIN do not match the ones on your BVN. ' +
          'Check the number, or contact support if you believe it is correct.',
        details: { nameMatchPercent: namePercent },
        retryable: false,
      });
    }

    const now = new Date();
    const level = this.promote(profile, { bvnVerified: true, ninVerified: true });

    const updated = await this.db.kycProfile.update({
      where: { id: profile.id },
      data: {
        ninEncrypted: this.crypto.encrypt(nin),
        ninHash: digest,
        ninLast4: last4,
        ninVerifiedAt: now,
        level,
        status: KycStatus.VERIFIED,
        rejectionReason: null,
        verifiedAt: now,
      },
    });

    this.logger.info(
      { userId: input.userId, level, nameMatchPercent: namePercent },
      'NIN verified and consistent with the BVN; customer promoted',
    );

    return toSnapshot(updated, bvnRecord);
  }

  // ===========================================================================
  //  Review
  // ===========================================================================

  /** Promotes a customer to TIER_3 after a human review. */
  async approveTier3(userId: string, reviewedBy: string): Promise<KycSnapshot> {
    const tenantId = RequestContext.requireTenantId();
    const profile = await this.ensureProfile(tenantId, userId);

    if (!atLeast(profile.level, KycLevel.TIER_2)) {
      throw new AppException(ErrorCode.PRECONDITION_FAILED, {
        message: 'TIER_3 requires both BVN and NIN to be verified first',
      });
    }

    const updated = await this.db.kycProfile.update({
      where: { id: profile.id },
      data: {
        level: KycLevel.TIER_3,
        status: KycStatus.VERIFIED,
        rejectionReason: null,
        reviewedBy,
        reviewedAt: new Date(),
      },
    });

    this.logger.info({ userId, reviewedBy }, 'Customer promoted to TIER_3 by review');
    return toSnapshot(updated, await this.identityRecord(profile.id, KycIdentifierType.BVN));
  }

  /** Rejects a profile. The reason is shown to the customer, so it must be safe. */
  async reject(userId: string, reason: string, reviewedBy: string): Promise<KycSnapshot> {
    const tenantId = RequestContext.requireTenantId();
    const profile = await this.ensureProfile(tenantId, userId);

    const updated = await this.db.kycProfile.update({
      where: { id: profile.id },
      data: {
        status: KycStatus.REJECTED,
        rejectionReason: reason.slice(0, 512),
        reviewedBy,
        reviewedAt: new Date(),
      },
    });

    this.logger.warn({ userId, reviewedBy }, 'KYC profile rejected');
    return toSnapshot(updated, null);
  }

  /**
   * Runs a *basic* provider check: do these supplied details agree with the
   * registry?
   *
   * Not on the tier path — tiers 1 and 2 use enhanced lookups because they need
   * the record itself, not a verdict. This is the staff tool for the separate
   * question of whether a specific set of details checks out, and for the fraud
   * signal of a name that nearly, but not quite, matches.
   */
  async crossCheck(input: {
    userId: string;
    type: KycIdentifierType;
    identifier: string;
    firstName: string;
    middleName?: string;
    lastName: string;
    gender: string;
    birthday: string;
    phoneNumber: string;
    requestedBy?: string;
  }): Promise<{ matched: boolean; nameMatchPercent?: number }> {
    const tenantId = RequestContext.requireTenantId();
    const identifier = digitsOnly(input.identifier);
    this.assertWellFormed(identifier, input.type);

    const result = await this.provider.verifyBasic(input.type, {
      identifier,
      firstName: input.firstName,
      middleName: input.middleName,
      lastName: input.lastName,
      gender: input.gender,
      birthday: input.birthday,
      phoneNumber: input.phoneNumber,
    });

    // A `MATCH` verdict with a similarity below our floor is treated as a
    // mismatch: the provider's threshold is theirs to change, ours is not.
    const matched =
      result.outcome === VerificationOutcome.Matched &&
      (result.nameMatchPercent ?? 100) >= this.config.kyc.nameMatchMinPercent;

    await this.db.kycVerification.create({
      data: {
        tenantId,
        userId: input.userId,
        provider: this.provider.name,
        identifierType: input.type,
        mode: KycCheckMode.BASIC,
        status: matched ? KycCheckStatus.MATCHED : checkStatusFor(result.outcome),
        identifierLast4: identifier.slice(-4),
        nameMatchPercent: result.nameMatchPercent,
        matchResult: result.raw as never,
        charged: result.charge.charged,
        chargedAmount: result.charge.amount,
        requestedBy: input.requestedBy,
        completedAt: new Date(),
      },
    });

    return { matched, nameMatchPercent: result.nameMatchPercent };
  }

  // ===========================================================================
  //  Internals
  // ===========================================================================

  /**
   * Opens an audit row, runs the enhanced lookup, and closes the row with what
   * came back — including the charge, which is levied even for "not found".
   */
  private async runCheck(args: {
    tenantId: string;
    profileId: string;
    userId: string;
    type: KycIdentifierType;
    identifier: string;
    last4: string;
    requestedBy?: string;
  }): Promise<{ result: EnhancedVerificationResult; verificationId: string }> {
    const verification = await this.db.kycVerification.create({
      data: {
        tenantId: args.tenantId,
        userId: args.userId,
        profileId: args.profileId,
        provider: this.provider.name,
        identifierType: args.type,
        mode: KycCheckMode.ENHANCED,
        status: KycCheckStatus.PENDING,
        identifierLast4: args.last4,
        requestedBy: args.requestedBy,
      },
      select: { id: true },
    });

    let result: EnhancedVerificationResult;
    try {
      result = await this.provider.verifyEnhanced(args.type, args.identifier);
    } catch (error) {
      // The check did not complete. Recorded as FAILED and re-thrown: a customer
      // must be told to try again, not silently left unverified.
      await this.db.kycVerification.update({
        where: { id: verification.id },
        data: {
          status: KycCheckStatus.FAILED,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 1024),
          completedAt: new Date(),
        },
      });
      throw error;
    }

    await this.db.kycVerification.update({
      where: { id: verification.id },
      data: {
        status: checkStatusFor(result.outcome),
        response: result.raw as never,
        charged: result.charge.charged,
        chargedAmount: result.charge.amount,
        completedAt: new Date(),
      },
    });

    return { result, verificationId: verification.id };
  }

  /** The profile state after a lookup that found nothing, or could not run. */
  private async recordFailedLookup(
    profile: KycProfile,
    outcome: VerificationOutcome,
    type: KycIdentifierType,
  ): Promise<KycSnapshot> {
    const notFound = outcome === VerificationOutcome.NotFound;

    const updated = await this.db.kycProfile.update({
      where: { id: profile.id },
      data: {
        submittedAt: profile.submittedAt ?? new Date(),
        // Only a definitive miss rejects. A provider outage leaves the customer
        // where they were, so a bad afternoon upstream does not mass-reject a
        // day's sign-ups — and never demotes a customer who already holds a tier.
        ...(notFound
          ? {
              status: KycStatus.REJECTED,
              rejectionReason: `We could not find that ${type}. Check the number and try again.`,
            }
          : profile.status === KycStatus.VERIFIED
            ? {}
            : { status: KycStatus.PENDING }),
      },
    });

    this.logger.warn({ userId: profile.userId, type, outcome }, 'Identity lookup did not succeed');
    return toSnapshot(updated, await this.identityRecord(profile.id, KycIdentifierType.BVN));
  }

  /**
   * Copies the verified identity onto the user record.
   *
   * Runs on tier 1 only. The BVN registry is the authority for who somebody is,
   * so it overwrites whatever the customer typed at sign-up — a self-reported
   * name that disagrees with the bank's is exactly the value that makes a
   * transfer bounce.
   *
   * `address` is deliberately untouched: neither the BVN nor the NIN enhanced
   * response carries one, so there is nothing to copy and overwriting a real
   * address with null would destroy data a human entered.
   */
  private async applyToUserProfile(
    userId: string,
    registry: RegistryIdentity,
    dateOfBirth: Date | null,
  ): Promise<void> {
    const fullName = joinName(registry);

    await this.db.user.update({
      where: { id: userId },
      data: {
        firstName: registry.firstName ?? null,
        middleName: registry.middleName ?? null,
        lastName: registry.lastName ?? null,
        gender: normaliseGender(registry.gender),
        dateOfBirth,
        // Only when the registry actually gave us the parts. A blank here would
        // wipe a name the customer supplied at sign-up in exchange for nothing.
        ...(fullName ? { fullName: fullName.slice(0, 160) } : {}),
      },
    });

    this.logger.info({ userId }, 'Copied verified identity onto the user record');
  }

  /** Writes (or replaces) the registry snapshot for one identifier. */
  private async saveIdentityRecord(args: {
    tenantId: string;
    userId: string;
    profileId: string;
    source: KycIdentifierType;
    identifierLast4: string;
    identity: RegistryIdentity;
    nameMatchPercent?: number;
  }): Promise<void> {
    const fields = {
      identifierLast4: args.identifierLast4,
      firstName: args.identity.firstName ?? null,
      middleName: args.identity.middleName ?? null,
      lastName: args.identity.lastName ?? null,
      nameOnCard: args.identity.nameOnCard ?? null,
      gender: args.identity.gender ?? null,
      dateOfBirth: parseIsoDate(args.identity.birthday),
      phoneNumber: args.identity.phoneNumber ?? null,
      phoneNumber2: args.identity.phoneNumber2 ?? null,
      nameMatchPercent: args.nameMatchPercent ?? null,
    };

    await this.db.kycIdentityRecord.upsert({
      where: { profileId_source: { profileId: args.profileId, source: args.source } },
      create: {
        tenantId: args.tenantId,
        userId: args.userId,
        profileId: args.profileId,
        source: args.source,
        ...fields,
      },
      update: fields,
    });
  }

  private async identityRecord(
    profileId: string,
    source: KycIdentifierType,
  ): Promise<KycIdentityRecord | null> {
    return this.db.kycIdentityRecord.findFirst({ where: { profileId, source } });
  }

  /** The new level, never below the one already held. */
  private promote(
    profile: KycProfile,
    evidence: { bvnVerified: boolean; ninVerified: boolean },
  ): KycLevel {
    const derived = levelFor(evidence);
    // TIER_3 is a human decision this function has no basis to reverse.
    return rank(derived) > rank(profile.level) ? derived : profile.level;
  }

  private assertWellFormed(identifier: string, type: KycIdentifierType): void {
    if (!IDENTIFIER_PATTERN.test(identifier)) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: `A ${type} is 11 digits`,
      });
    }
  }

  private async ensureProfile(tenantId: string, userId: string): Promise<KycProfile> {
    const existing = await this.db.kycProfile.findFirst({ where: { userId } });
    if (existing) return existing;

    return this.db.kycProfile.create({ data: { tenantId, userId } });
  }

  /**
   * Caps failed attempts per rolling day.
   *
   * Two things this protects. The obvious one is cost — every lookup is billed,
   * including the ones that find nothing. The important one is that tier 1
   * reveals whether a date of birth matches a BVN, and an unlimited retry budget
   * turns that into an oracle for guessing somebody else's.
   */
  private async assertAttemptsRemaining(tenantId: string, userId: string): Promise<void> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const failures = await this.db.kycVerification.count({
      where: {
        tenantId,
        userId,
        createdAt: { gte: since },
        status: { in: [KycCheckStatus.MISMATCH, KycCheckStatus.NOT_FOUND] },
      },
    });

    if (failures < this.config.kyc.maxFailedAttemptsPerDay) return;

    this.logger.warn({ userId, failures }, 'KYC attempt limit reached; refusing further lookups');

    throw new AppException(ErrorCode.RATE_LIMIT_EXCEEDED, {
      message: 'Too many failed verification attempts. Try again tomorrow or contact support.',
      retryable: false,
    });
  }

  /**
   * Refuses an identifier already verified on another customer.
   *
   * One BVN across many accounts is the standard shape of bonus farming and of
   * mule networks. Blocked at submission because unwinding it afterwards means
   * clawing back money that has already left.
   */
  private async assertNotDuplicate(
    tenantId: string,
    userId: string,
    type: KycIdentifierType,
    digest: string,
  ): Promise<void> {
    if (this.config.kyc.allowDuplicateIdentifiers) return;

    const clash = await this.db.kycProfile.findFirst({
      where: {
        tenantId,
        userId: { not: userId },
        ...(type === KycIdentifierType.BVN ? { bvnHash: digest } : { ninHash: digest }),
      },
      select: { userId: true },
    });

    if (!clash) return;

    this.logger.warn(
      { userId, existingUserId: clash.userId, type },
      'Identifier already verified on another account',
    );

    throw new AppException(ErrorCode.RESOURCE_ALREADY_EXISTS, {
      // Deliberately vague to the customer. Naming the other account would
      // confirm to a fraudster which identifiers are already in the system.
      message: `That ${type} is already registered. Contact support if this is yours.`,
      retryable: false,
    });
  }
}

/** SHA-256 of the digits. Lookup key only — never a substitute for encryption. */
function hash(identifier: string): string {
  return createHash('sha256').update(identifier).digest('hex');
}

function checkStatusFor(outcome: VerificationOutcome): KycCheckStatus {
  switch (outcome) {
    case VerificationOutcome.Matched:
      return KycCheckStatus.MATCHED;
    case VerificationOutcome.Mismatch:
      return KycCheckStatus.MISMATCH;
    case VerificationOutcome.NotFound:
      return KycCheckStatus.NOT_FOUND;
    default:
      return KycCheckStatus.FAILED;
  }
}

/** Strips formatting from an identifier. Registries hold digits only. */
function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

function toSnapshot(profile: KycProfile | null, bvnRecord: KycIdentityRecord | null): KycSnapshot {
  if (!profile) {
    return {
      level: KycLevel.TIER_0,
      status: KycStatus.UNVERIFIED,
      bvnVerified: false,
      ninVerified: false,
      bvnLast4: null,
      ninLast4: null,
      verifiedName: null,
      limits: limitsFor(KycLevel.TIER_0),
      canHoldPermanentAccount: false,
      rejectionReason: null,
      verifiedAt: null,
      nextStep: 'Verify your BVN to reach Tier 1.',
    };
  }

  const limits = limitsFor(profile.level);

  return {
    level: profile.level,
    status: profile.status,
    bvnVerified: Boolean(profile.bvnVerifiedAt),
    ninVerified: Boolean(profile.ninVerifiedAt),
    bvnLast4: profile.bvnLast4,
    ninLast4: profile.ninLast4,
    verifiedName: bvnRecord ? joinName(bvnRecord) || null : null,
    limits,
    canHoldPermanentAccount: limits.permanentAccount && profile.status === KycStatus.VERIFIED,
    rejectionReason: profile.rejectionReason,
    verifiedAt: profile.verifiedAt,
    nextStep: nextStepFor(profile),
  };
}

/** What the customer does next, in their own terms. Null once nothing is left. */
function nextStepFor(profile: KycProfile): string | null {
  if (!profile.bvnVerifiedAt) return 'Verify your BVN to reach Tier 1.';
  if (!profile.ninVerifiedAt) return 'Verify your NIN to reach Tier 2 and unlock a bank account.';
  return null;
}

import { createHash } from 'node:crypto';

import { KycCheckStatus, KycIdentifierType, KycLevel, KycStatus } from '@prisma/client';
import type { PinoLogger } from 'nestjs-pino';

import type { AppConfig } from '../../config/app.config';
import { KycTier } from '../../config/env.validation';
import { RequestContext } from '../../core/context/request-context';
import { ErrorCode } from '../../core/errors/error-code.enum';
import type { ExtendedPrismaClient } from '../../infrastructure/database/prisma.service';
import type { CryptoService } from '../../infrastructure/security/crypto.service';
import {
  type KycVerificationProvider,
  type RegistryIdentity,
  VerificationOutcome,
} from './kyc-provider.interface';
import { KycService } from './kyc.service';
import { atLeast, levelFor, limitsFor } from './kyc.tiers';

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const USER = '00000000-0000-0000-0000-0000000000bb';

const BVN = '22123456789';
const NIN = '12345678901';

/** Mirrors the service's lookup digest, so a test can seed an "already verified" row. */
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const logger = {
  setContext: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as PinoLogger;

/** Reversible stand-in: the real service is AES-GCM, which is not what we test here. */
const crypto = {
  encrypt: (value: string) => `enc(${value})`,
  decrypt: (value: string) => value.replace(/^enc\(|\)$/g, ''),
} as unknown as CryptoService;

const buildConfig = (overrides: Partial<AppConfig['kyc']> = {}) =>
  ({
    kyc: {
      provider: 'payvessel',
      staticAccountMinTier: KycTier.Tier2,
      nameMatchMinPercent: 70,
      crossMatchNameMinPercent: 80,
      maxFailedAttemptsPerDay: 5,
      allowDuplicateIdentifiers: false,
      ...overrides,
    },
  }) as AppConfig;

/** A profile row with everything nulled except what a test sets. */
const profileRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'profile-1',
  tenantId: TENANT,
  userId: USER,
  level: KycLevel.TIER_0,
  status: KycStatus.UNVERIFIED,
  bvnEncrypted: null,
  bvnHash: null,
  bvnLast4: null,
  bvnVerifiedAt: null,
  ninEncrypted: null,
  ninHash: null,
  ninLast4: null,
  ninVerifiedAt: null,
  submittedAt: null,
  verifiedAt: null,
  rejectionReason: null,
  reviewedBy: null,
  reviewedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

/** A stored registry snapshot. */
const identityRow = (source: KycIdentifierType, overrides: Record<string, unknown> = {}) => ({
  id: `identity-${source}`,
  tenantId: TENANT,
  userId: USER,
  profileId: 'profile-1',
  source,
  identifierLast4: '6789',
  firstName: 'JOHN',
  middleName: 'ADEBAYO',
  lastName: 'DOE',
  nameOnCard: 'JOHN A DOE',
  gender: 'MALE',
  dateOfBirth: new Date('1992-08-14T00:00:00.000Z'),
  phoneNumber: '08012345678',
  phoneNumber2: null,
  nameMatchPercent: null,
  capturedAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

/** What the BVN registry returns for our reference customer. */
const BVN_IDENTITY: RegistryIdentity = {
  firstName: 'JOHN',
  middleName: 'ADEBAYO',
  lastName: 'DOE',
  nameOnCard: 'JOHN A DOE',
  gender: 'MALE',
  birthday: '1992-08-14',
  phoneNumber: '08012345678',
  phoneNumber2: '08087654321',
};

const enhanced = (
  identity: RegistryIdentity | undefined,
  outcome = VerificationOutcome.Matched,
) => ({
  outcome,
  identity,
  raw: {},
  charge: { charged: true, amount: '25.00' },
});

/**
 * Prisma double.
 *
 * `update` echoes the merged row so assertions read the result, and identity
 * records live in a map keyed by source so a tier-2 test can seed the BVN row
 * that tier 2 compares against.
 */
const buildDb = (
  profile: ReturnType<typeof profileRow> | null,
  identities: Partial<Record<KycIdentifierType, ReturnType<typeof identityRow>>> = {},
  failedAttempts = 0,
) => {
  let current = profile;
  const records = { ...identities };

  return {
    kycProfile: {
      findFirst: jest.fn((args?: { where?: Record<string, unknown> }) => {
        // Duplicate lookups carry `userId: { not: ... }`; they must not match the
        // caller's own profile.
        if (args?.where && typeof args.where.userId === 'object') return Promise.resolve(null);
        return Promise.resolve(current);
      }),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        current = profileRow(data);
        return Promise.resolve(current);
      }),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        current = { ...(current ?? profileRow()), ...data };
        return Promise.resolve(current);
      }),
    },
    kycIdentityRecord: {
      findFirst: jest.fn((args: { where: { source: KycIdentifierType } }) =>
        Promise.resolve(records[args.where.source] ?? null),
      ),
      findMany: jest.fn(() => Promise.resolve(Object.values(records))),
      upsert: jest.fn(
        ({
          where,
          create,
        }: {
          where: { profileId_source: { source: KycIdentifierType } };
          create: Record<string, unknown>;
        }) => {
          const source = where.profileId_source.source;
          records[source] = identityRow(source, create);
          return Promise.resolve(records[source]);
        },
      ),
    },
    user: {
      update: jest.fn(() => Promise.resolve({ id: USER })),
    },
    kycVerification: {
      create: jest.fn(() => Promise.resolve({ id: 'verification-1' })),
      update: jest.fn(() => Promise.resolve({ id: 'verification-1' })),
      count: jest.fn(() => Promise.resolve(failedAttempts)),
    },
  } as unknown as ExtendedPrismaClient;
};

const buildProvider = (overrides: Partial<KycVerificationProvider> = {}): KycVerificationProvider =>
  ({
    name: 'PAYVESSEL',
    verifyEnhanced: jest.fn(() => Promise.resolve(enhanced(BVN_IDENTITY))),
    verifyBasic: jest.fn(),
    ...overrides,
  }) as unknown as KycVerificationProvider;

const inTenant = <T>(fn: () => Promise<T>): Promise<T> =>
  RequestContext.run({ tenantId: TENANT }, fn);

/** The tier-1 submission that matches {@link BVN_IDENTITY}. */
const goodBvnSubmission = {
  userId: USER,
  bvn: BVN,
  phoneNumber: '08012345678',
  dateOfBirth: '1992-08-14',
};

describe('kyc.tiers', () => {
  it('derives the level from the evidence on file', () => {
    expect(levelFor({ bvnVerified: false, ninVerified: false })).toBe(KycLevel.TIER_0);
    expect(levelFor({ bvnVerified: true, ninVerified: false })).toBe(KycLevel.TIER_1);
    expect(levelFor({ bvnVerified: true, ninVerified: true })).toBe(KycLevel.TIER_2);
  });

  it('does not credit a NIN with no BVN behind it', () => {
    // Tier 2 is defined as agreement between two registries. With no BVN there
    // is nothing to agree with, so a lone NIN proves nothing on this ladder.
    expect(levelFor({ bvnVerified: false, ninVerified: true })).toBe(KycLevel.TIER_0);
  });

  it('orders the ladder independently of the generated enum', () => {
    expect(atLeast(KycLevel.TIER_2, KycLevel.TIER_1)).toBe(true);
    expect(atLeast(KycLevel.TIER_1, KycLevel.TIER_2)).toBe(false);
    expect(atLeast(KycLevel.TIER_2, KycLevel.TIER_2)).toBe(true);
  });

  it('permits a permanent account only from TIER_2', () => {
    expect(limitsFor(KycLevel.TIER_0).permanentAccount).toBe(false);
    expect(limitsFor(KycLevel.TIER_1).permanentAccount).toBe(false);
    expect(limitsFor(KycLevel.TIER_2).permanentAccount).toBe(true);
    expect(limitsFor(KycLevel.TIER_3).permanentAccount).toBe(true);
  });
});

describe('KycService', () => {
  afterEach(() => jest.clearAllMocks());

  describe('verifyBvn — tier 1', () => {
    it('promotes to TIER_1 when the supplied phone and date of birth match', async () => {
      const db = buildDb(profileRow());
      const service = new KycService(db, buildProvider(), buildConfig(), crypto, logger);

      const snapshot = await inTenant(() => service.verifyBvn(goodBvnSubmission));

      expect(snapshot.level).toBe(KycLevel.TIER_1);
      expect(snapshot.status).toBe(KycStatus.VERIFIED);
      expect(snapshot.bvnLast4).toBe('6789');
      expect(snapshot.canHoldPermanentAccount).toBe(false);
      expect(snapshot.nextStep).toMatch(/NIN/);
    });

    it('stores the BVN encrypted, hashed and truncated — never in the clear', async () => {
      const db = buildDb(profileRow());
      const service = new KycService(db, buildProvider(), buildConfig(), crypto, logger);

      await inTenant(() => service.verifyBvn(goodBvnSubmission));

      const written = (db.kycProfile.update as jest.Mock).mock.calls[0]![0].data as Record<
        string,
        unknown
      >;
      expect(written.bvnEncrypted).toBe(`enc(${BVN})`);
      expect(written.bvnHash).toBe(sha256(BVN));
      expect(written.bvnLast4).toBe('6789');
      expect(JSON.stringify(written)).not.toContain(`"${BVN}"`);
    });

    it("saves the registry's identity as the reference for tier 2", async () => {
      const db = buildDb(profileRow());
      const service = new KycService(db, buildProvider(), buildConfig(), crypto, logger);

      await inTenant(() => service.verifyBvn(goodBvnSubmission));

      const upsert = (db.kycIdentityRecord.upsert as jest.Mock).mock.calls[0]![0] as {
        where: { profileId_source: { source: string } };
        create: Record<string, unknown>;
      };
      expect(upsert.where.profileId_source.source).toBe(KycIdentifierType.BVN);
      expect(upsert.create.firstName).toBe('JOHN');
      expect(upsert.create.lastName).toBe('DOE');
      expect(upsert.create.nameOnCard).toBe('JOHN A DOE');
      expect((upsert.create.dateOfBirth as Date).toISOString()).toBe('1992-08-14T00:00:00.000Z');
    });

    it('copies the verified identity onto the user record', async () => {
      const db = buildDb(profileRow());
      const service = new KycService(db, buildProvider(), buildConfig(), crypto, logger);

      await inTenant(() => service.verifyBvn(goodBvnSubmission));

      const written = (db.user.update as jest.Mock).mock.calls[0]![0].data as Record<
        string,
        unknown
      >;
      expect(written.firstName).toBe('JOHN');
      expect(written.middleName).toBe('ADEBAYO');
      expect(written.lastName).toBe('DOE');
      expect(written.gender).toBe('MALE');
      expect((written.dateOfBirth as Date).toISOString()).toBe('1992-08-14T00:00:00.000Z');
      expect(written.fullName).toBe('JOHN ADEBAYO DOE');
      // Neither registry returns an address, so there is nothing to copy — and
      // writing null would destroy one a human entered.
      expect(written).not.toHaveProperty('address');
    });

    it('does not touch the user record when the details did not match', async () => {
      const db = buildDb(profileRow());
      const service = new KycService(db, buildProvider(), buildConfig(), crypto, logger);

      await inTenant(() => service.verifyBvn({ ...goodBvnSubmission, dateOfBirth: '1990-01-01' }));

      expect(db.user.update).not.toHaveBeenCalled();
    });

    it('accepts the second phone number the BVN record carries', async () => {
      const service = new KycService(
        buildDb(profileRow()),
        buildProvider(),
        buildConfig(),
        crypto,
        logger,
      );

      const snapshot = await inTenant(() =>
        service.verifyBvn({ ...goodBvnSubmission, phoneNumber: '08087654321' }),
      );

      expect(snapshot.level).toBe(KycLevel.TIER_1);
    });

    it.each([
      ['+2348012345678', 'international form'],
      ['2348012345678', 'no plus'],
      ['080 1234 5678', 'spaced'],
    ])('accepts %s (%s) as the same number', async (phoneNumber) => {
      const service = new KycService(
        buildDb(profileRow()),
        buildProvider(),
        buildConfig(),
        crypto,
        logger,
      );

      const snapshot = await inTenant(() =>
        service.verifyBvn({ ...goodBvnSubmission, phoneNumber }),
      );

      expect(snapshot.level).toBe(KycLevel.TIER_1);
    });

    it('rejects when the supplied date of birth does not match', async () => {
      const db = buildDb(profileRow());
      const service = new KycService(db, buildProvider(), buildConfig(), crypto, logger);

      const snapshot = await inTenant(() =>
        service.verifyBvn({ ...goodBvnSubmission, dateOfBirth: '1990-01-01' }),
      );

      expect(snapshot.status).toBe(KycStatus.REJECTED);
      expect(snapshot.level).toBe(KycLevel.TIER_0);
      // Nothing is written to the identity table on a failed match.
      expect(db.kycIdentityRecord.upsert).not.toHaveBeenCalled();
    });

    it('rejects when the supplied phone number does not match', async () => {
      const service = new KycService(
        buildDb(profileRow()),
        buildProvider(),
        buildConfig(),
        crypto,
        logger,
      );

      const snapshot = await inTenant(() =>
        service.verifyBvn({ ...goodBvnSubmission, phoneNumber: '09099999999' }),
      );

      expect(snapshot.status).toBe(KycStatus.REJECTED);
    });

    it('does not tell the customer which field failed', async () => {
      // Otherwise tier 1 becomes an oracle for guessing somebody else's date of
      // birth against a BVN the attacker already holds.
      const service = new KycService(
        buildDb(profileRow()),
        buildProvider(),
        buildConfig(),
        crypto,
        logger,
      );

      const wrongDob = await inTenant(() =>
        service.verifyBvn({ ...goodBvnSubmission, dateOfBirth: '1990-01-01' }),
      );
      const wrongPhone = await inTenant(() =>
        service.verifyBvn({ ...goodBvnSubmission, phoneNumber: '09099999999' }),
      );

      expect(wrongDob.rejectionReason).toBe(wrongPhone.rejectionReason);
      expect(wrongDob.rejectionReason).not.toMatch(/date of birth does not|phone number does not/i);
    });

    it('records which fields failed on the audit row, where staff can see it', async () => {
      const db = buildDb(profileRow());
      const service = new KycService(db, buildProvider(), buildConfig(), crypto, logger);

      await inTenant(() => service.verifyBvn({ ...goodBvnSubmission, dateOfBirth: '1990-01-01' }));

      const updates = (db.kycVerification.update as jest.Mock).mock.calls;
      const match = updates[updates.length - 1]![0].data as {
        status: string;
        matchResult: Record<string, unknown>;
      };
      expect(match.status).toBe(KycCheckStatus.MISMATCH);
      expect(match.matchResult).toMatchObject({ dateOfBirthMatch: false, phoneMatch: true });
    });

    it('rejects the profile when the registry has no such BVN', async () => {
      const db = buildDb(profileRow());
      const service = new KycService(
        db,
        buildProvider({
          verifyEnhanced: jest.fn(() =>
            Promise.resolve(enhanced(undefined, VerificationOutcome.NotFound)),
          ),
        }),
        buildConfig(),
        crypto,
        logger,
      );

      const snapshot = await inTenant(() => service.verifyBvn(goodBvnSubmission));

      expect(snapshot.status).toBe(KycStatus.REJECTED);
      // The charge is recorded even though nothing was proven — providers bill
      // for a "not found" answer.
      const recorded = (db.kycVerification.update as jest.Mock).mock.calls[0]![0].data as Record<
        string,
        unknown
      >;
      expect(recorded.charged).toBe(true);
    });

    it('leaves the customer where they were when the provider is unavailable', async () => {
      // A bad afternoon upstream must not mass-reject a day's sign-ups.
      const service = new KycService(
        buildDb(profileRow()),
        buildProvider({
          verifyEnhanced: jest.fn(() =>
            Promise.resolve(enhanced(undefined, VerificationOutcome.Failed)),
          ),
        }),
        buildConfig(),
        crypto,
        logger,
      );

      const snapshot = await inTenant(() => service.verifyBvn(goodBvnSubmission));

      expect(snapshot.status).toBe(KycStatus.PENDING);
    });

    it('records a FAILED attempt and rethrows when the call itself throws', async () => {
      const db = buildDb(profileRow());
      const service = new KycService(
        db,
        buildProvider({
          verifyEnhanced: jest.fn(() => Promise.reject(new Error('upstream exploded'))),
        }),
        buildConfig(),
        crypto,
        logger,
      );

      await expect(inTenant(() => service.verifyBvn(goodBvnSubmission))).rejects.toThrow(
        'upstream exploded',
      );

      const recorded = (db.kycVerification.update as jest.Mock).mock.calls[0]![0].data as Record<
        string,
        unknown
      >;
      expect(recorded.status).toBe(KycCheckStatus.FAILED);
    });

    it('re-submitting an already-verified BVN costs no provider call', async () => {
      const provider = buildProvider();
      const service = new KycService(
        buildDb(
          profileRow({
            level: KycLevel.TIER_1,
            status: KycStatus.VERIFIED,
            bvnHash: sha256(BVN),
            bvnVerifiedAt: new Date(),
            bvnLast4: '6789',
          }),
          { [KycIdentifierType.BVN]: identityRow(KycIdentifierType.BVN) },
        ),
        provider,
        buildConfig(),
        crypto,
        logger,
      );

      // Same number, typed with the formatting a customer would use.
      const snapshot = await inTenant(() =>
        service.verifyBvn({ ...goodBvnSubmission, bvn: '221-2345 6789' }),
      );

      expect(provider.verifyEnhanced).not.toHaveBeenCalled();
      expect(snapshot.level).toBe(KycLevel.TIER_1);
    });

    it.each([
      ['123', 'too short'],
      ['2212345678a', 'not all digits'],
    ])('refuses a malformed BVN (%s) before spending a lookup', async (bvn) => {
      const provider = buildProvider();
      const service = new KycService(
        buildDb(profileRow()),
        provider,
        buildConfig(),
        crypto,
        logger,
      );

      await expect(
        inTenant(() => service.verifyBvn({ ...goodBvnSubmission, bvn })),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });

      expect(provider.verifyEnhanced).not.toHaveBeenCalled();
    });

    it('refuses a date that does not exist', async () => {
      const provider = buildProvider();
      const service = new KycService(
        buildDb(profileRow()),
        provider,
        buildConfig(),
        crypto,
        logger,
      );

      await expect(
        inTenant(() => service.verifyBvn({ ...goodBvnSubmission, dateOfBirth: '1992-02-31' })),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });

      expect(provider.verifyEnhanced).not.toHaveBeenCalled();
    });

    it('refuses a BVN already verified on another account', async () => {
      const db = buildDb(profileRow());
      (db.kycProfile.findFirst as jest.Mock).mockImplementation(
        (args?: { where?: Record<string, unknown> }) =>
          Promise.resolve(
            args?.where && typeof args.where.userId === 'object'
              ? { userId: 'someone-else' }
              : profileRow(),
          ),
      );

      const provider = buildProvider();
      const service = new KycService(db, provider, buildConfig(), crypto, logger);

      await expect(inTenant(() => service.verifyBvn(goodBvnSubmission))).rejects.toMatchObject({
        code: ErrorCode.RESOURCE_ALREADY_EXISTS,
      });

      expect(provider.verifyEnhanced).not.toHaveBeenCalled();
    });

    it('stops accepting attempts once the daily failure budget is spent', async () => {
      // The budget is what stops tier 1 being walked one date of birth at a time.
      const provider = buildProvider();
      const service = new KycService(
        buildDb(profileRow(), {}, 5),
        provider,
        buildConfig({ maxFailedAttemptsPerDay: 5 }),
        crypto,
        logger,
      );

      await expect(inTenant(() => service.verifyBvn(goodBvnSubmission))).rejects.toMatchObject({
        code: ErrorCode.RATE_LIMIT_EXCEEDED,
      });

      expect(provider.verifyEnhanced).not.toHaveBeenCalled();
    });
  });

  describe('verifyNin — tier 2', () => {
    /** A profile that has already cleared tier 1. */
    const tier1 = () =>
      buildDb(
        profileRow({
          level: KycLevel.TIER_1,
          status: KycStatus.VERIFIED,
          bvnHash: sha256(BVN),
          bvnVerifiedAt: new Date(),
          bvnLast4: '6789',
        }),
        { [KycIdentifierType.BVN]: identityRow(KycIdentifierType.BVN) },
      );

    it('promotes to TIER_2 when the NIN record agrees with the BVN record', async () => {
      const db = tier1();
      const service = new KycService(db, buildProvider(), buildConfig(), crypto, logger);

      const snapshot = await inTenant(() => service.verifyNin({ userId: USER, nin: NIN }));

      expect(snapshot.level).toBe(KycLevel.TIER_2);
      expect(snapshot.canHoldPermanentAccount).toBe(true);
      expect(snapshot.nextStep).toBeNull();
    });

    it('collects only the number — no name, gender or date of birth', async () => {
      const provider = buildProvider();
      const service = new KycService(tier1(), provider, buildConfig(), crypto, logger);

      await inTenant(() => service.verifyNin({ userId: USER, nin: NIN }));

      // The enhanced lookup takes the identifier alone; everything compared came
      // from the two registries.
      expect(provider.verifyEnhanced).toHaveBeenCalledWith(KycIdentifierType.NIN, NIN);
      expect(provider.verifyBasic).not.toHaveBeenCalled();
    });

    it('accepts a NIN missing the middle name the BVN carries', async () => {
      // The single most common shape of a legitimate disagreement between NIMC
      // and the BVN database.
      const service = new KycService(
        tier1(),
        buildProvider({
          verifyEnhanced: jest.fn(() =>
            Promise.resolve(
              enhanced({ ...BVN_IDENTITY, middleName: undefined, nameOnCard: undefined }),
            ),
          ),
        }),
        buildConfig(),
        crypto,
        logger,
      );

      const snapshot = await inTenant(() => service.verifyNin({ userId: USER, nin: NIN }));

      expect(snapshot.level).toBe(KycLevel.TIER_2);
    });

    it('accepts a NIN holding the names in a different order', async () => {
      const service = new KycService(
        tier1(),
        buildProvider({
          verifyEnhanced: jest.fn(() =>
            Promise.resolve(enhanced({ ...BVN_IDENTITY, firstName: 'DOE', lastName: 'JOHN' })),
          ),
        }),
        buildConfig(),
        crypto,
        logger,
      );

      const snapshot = await inTenant(() => service.verifyNin({ userId: USER, nin: NIN }));

      expect(snapshot.level).toBe(KycLevel.TIER_2);
    });

    it('refuses a NIN whose name is below the similarity floor', async () => {
      const service = new KycService(
        tier1(),
        buildProvider({
          verifyEnhanced: jest.fn(() =>
            Promise.resolve(
              enhanced({
                ...BVN_IDENTITY,
                firstName: 'MUSA',
                middleName: 'IBRAHIM',
                lastName: 'BELLO',
              }),
            ),
          ),
        }),
        buildConfig(),
        crypto,
        logger,
      );

      await expect(
        inTenant(() => service.verifyNin({ userId: USER, nin: NIN })),
      ).rejects.toMatchObject({ code: ErrorCode.PRECONDITION_FAILED });
    });

    it('refuses a NIN whose gender disagrees, however well the name matches', async () => {
      const service = new KycService(
        tier1(),
        buildProvider({
          verifyEnhanced: jest.fn(() =>
            Promise.resolve(enhanced({ ...BVN_IDENTITY, gender: 'FEMALE' })),
          ),
        }),
        buildConfig(),
        crypto,
        logger,
      );

      await expect(
        inTenant(() => service.verifyNin({ userId: USER, nin: NIN })),
      ).rejects.toMatchObject({ code: ErrorCode.PRECONDITION_FAILED });
    });

    it('refuses a NIN whose date of birth disagrees', async () => {
      const service = new KycService(
        tier1(),
        buildProvider({
          verifyEnhanced: jest.fn(() =>
            Promise.resolve(enhanced({ ...BVN_IDENTITY, birthday: '1985-03-02' })),
          ),
        }),
        buildConfig(),
        crypto,
        logger,
      );

      await expect(
        inTenant(() => service.verifyNin({ userId: USER, nin: NIN })),
      ).rejects.toMatchObject({ code: ErrorCode.PRECONDITION_FAILED });
    });

    it('stores the disagreeing NIN record as evidence rather than discarding it', async () => {
      const db = tier1();
      const service = new KycService(
        db,
        buildProvider({
          verifyEnhanced: jest.fn(() =>
            Promise.resolve(enhanced({ ...BVN_IDENTITY, gender: 'FEMALE' })),
          ),
        }),
        buildConfig(),
        crypto,
        logger,
      );

      await inTenant(() => service.verifyNin({ userId: USER, nin: NIN })).catch(() => undefined);

      const upserted = (db.kycIdentityRecord.upsert as jest.Mock).mock.calls[0]![0] as {
        where: { profileId_source: { source: string } };
        create: Record<string, unknown>;
      };
      expect(upserted.where.profileId_source.source).toBe(KycIdentifierType.NIN);
      expect(upserted.create.gender).toBe('FEMALE');
      expect(upserted.create.nameMatchPercent).toBe(100);
    });

    it('never demotes a customer whose NIN disagrees', async () => {
      // They earned tier 1 with a BVN that checked out; a bad NIN says nothing
      // about that.
      const db = tier1();
      const service = new KycService(
        db,
        buildProvider({
          verifyEnhanced: jest.fn(() =>
            Promise.resolve(enhanced({ ...BVN_IDENTITY, gender: 'FEMALE' })),
          ),
        }),
        buildConfig(),
        crypto,
        logger,
      );

      await inTenant(() => service.verifyNin({ userId: USER, nin: NIN })).catch(() => undefined);

      const snapshot = await service.getSnapshot(USER);
      expect(snapshot.level).toBe(KycLevel.TIER_1);
      expect(snapshot.status).toBe(KycStatus.VERIFIED);
    });

    it('refuses outright when there is no BVN to compare against', async () => {
      const provider = buildProvider();
      const service = new KycService(
        buildDb(profileRow()),
        provider,
        buildConfig(),
        crypto,
        logger,
      );

      await expect(
        inTenant(() => service.verifyNin({ userId: USER, nin: NIN })),
      ).rejects.toMatchObject({ code: ErrorCode.PRECONDITION_FAILED });

      // No lookup is bought for a check that could not have succeeded.
      expect(provider.verifyEnhanced).not.toHaveBeenCalled();
    });

    it('honours a raised similarity floor', async () => {
      const nearMiss = { ...BVN_IDENTITY, middleName: 'ADEBAYA' };

      const lenient = new KycService(
        tier1(),
        buildProvider({
          verifyEnhanced: jest.fn(() => Promise.resolve(enhanced(nearMiss))),
        }),
        buildConfig({ crossMatchNameMinPercent: 80 }),
        crypto,
        logger,
      );

      await expect(
        inTenant(() => lenient.verifyNin({ userId: USER, nin: NIN })),
      ).resolves.toMatchObject({ level: KycLevel.TIER_2 });

      const strict = new KycService(
        tier1(),
        buildProvider({
          verifyEnhanced: jest.fn(() => Promise.resolve(enhanced(nearMiss))),
        }),
        buildConfig({ crossMatchNameMinPercent: 100 }),
        crypto,
        logger,
      );

      await expect(
        inTenant(() => strict.verifyNin({ userId: USER, nin: NIN })),
      ).rejects.toMatchObject({ code: ErrorCode.PRECONDITION_FAILED });
    });
  });

  describe('canIssuePermanentAccount', () => {
    const cases: Array<[string, Record<string, unknown> | null, boolean]> = [
      ['no profile at all', null, false],
      ['TIER_0', { level: KycLevel.TIER_0, status: KycStatus.VERIFIED }, false],
      ['TIER_1, verified', { level: KycLevel.TIER_1, status: KycStatus.VERIFIED }, false],
      ['TIER_2, verified', { level: KycLevel.TIER_2, status: KycStatus.VERIFIED }, true],
      ['TIER_2, rejected', { level: KycLevel.TIER_2, status: KycStatus.REJECTED }, false],
      ['TIER_2, still pending', { level: KycLevel.TIER_2, status: KycStatus.PENDING }, false],
      ['TIER_3, verified', { level: KycLevel.TIER_3, status: KycStatus.VERIFIED }, true],
    ];

    it.each(cases)('%s → permanent account allowed: %j', async (_label, profile, expected) => {
      const service = new KycService(
        buildDb(profile ? profileRow(profile) : null),
        buildProvider(),
        buildConfig(),
        crypto,
        logger,
      );

      await expect(service.canIssuePermanentAccount(USER)).resolves.toBe(expected);
    });
  });

  describe('getVerifiedIdentifiers', () => {
    it('decrypts, and returns the name the BVN registry holds', async () => {
      const service = new KycService(
        buildDb(
          profileRow({
            status: KycStatus.VERIFIED,
            level: KycLevel.TIER_2,
            bvnEncrypted: `enc(${BVN})`,
            bvnVerifiedAt: new Date(),
            ninEncrypted: `enc(${NIN})`,
            ninVerifiedAt: new Date(),
          }),
          { [KycIdentifierType.BVN]: identityRow(KycIdentifierType.BVN) },
        ),
        buildProvider(),
        buildConfig(),
        crypto,
        logger,
      );

      await expect(service.getVerifiedIdentifiers(USER)).resolves.toEqual({
        bvn: BVN,
        nin: NIN,
        verifiedName: 'JOHN ADEBAYO DOE',
      });
    });

    it('returns nothing for an unverified profile, however populated', async () => {
      const service = new KycService(
        buildDb(
          profileRow({
            status: KycStatus.PENDING,
            bvnEncrypted: `enc(${BVN})`,
            bvnVerifiedAt: new Date(),
          }),
          { [KycIdentifierType.BVN]: identityRow(KycIdentifierType.BVN) },
        ),
        buildProvider(),
        buildConfig(),
        crypto,
        logger,
      );

      await expect(service.getVerifiedIdentifiers(USER)).resolves.toEqual({});
    });
  });

  describe('approveTier3', () => {
    it('refuses to promote a customer who has not reached TIER_2', async () => {
      const service = new KycService(
        buildDb(profileRow({ level: KycLevel.TIER_1, status: KycStatus.VERIFIED })),
        buildProvider(),
        buildConfig(),
        crypto,
        logger,
      );

      await expect(inTenant(() => service.approveTier3(USER, 'admin-1'))).rejects.toMatchObject({
        code: ErrorCode.PRECONDITION_FAILED,
      });
    });

    it('promotes from TIER_2 and records the reviewer', async () => {
      const db = buildDb(profileRow({ level: KycLevel.TIER_2, status: KycStatus.VERIFIED }));
      const service = new KycService(db, buildProvider(), buildConfig(), crypto, logger);

      const snapshot = await inTenant(() => service.approveTier3(USER, 'admin-1'));

      expect(snapshot.level).toBe(KycLevel.TIER_3);
      const written = (db.kycProfile.update as jest.Mock).mock.calls[0]![0].data as Record<
        string,
        unknown
      >;
      expect(written.reviewedBy).toBe('admin-1');
    });
  });
});

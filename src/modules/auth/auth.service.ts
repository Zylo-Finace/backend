import { Injectable } from '@nestjs/common';
import { UserStatus, UserType } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';

import { SYSTEM_ROLES } from '../../core/authorization/permission.enum';
import { ActorType, RequestContext } from '../../core/context/request-context';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { Phone } from '../../core/utils/phone.util';
import { InjectPrisma } from '../../infrastructure/database/prisma.module';
import type { ExtendedPrismaClient } from '../../infrastructure/database/prisma.service';
import { HashingService } from '../../infrastructure/security/hashing.service';
import { RewardsService } from '../rewards/rewards.service';
import {
  type AdminLoginDto,
  type ChangePinDto,
  type CustomerLoginDto,
  type CustomerRegisterDto,
  isWeakPin,
} from './dto/auth.dto';
import { TokenService, type TokenPair } from './token.service';

/** Failed attempts before an account is temporarily locked. */
const MAX_FAILED_ATTEMPTS = 10;
/** Lockout duration. Short enough for real users who mistype while testing. */
const LOCKOUT_MINUTES = 5;

/** Usernames that would collide with routes or impersonate the platform. */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  'admin',
  'administrator',
  'root',
  'system',
  'support',
  'help',
  'wabot',
  'api',
  'auth',
  'login',
  'register',
  'wallet',
  'wallets',
  'bank',
  'me',
  'settings',
  'billing',
  'null',
  'undefined',
  'official',
  'security',
]);

export interface DeviceContext {
  ip?: string;
  userAgent?: string;
  deviceId?: string;
  deviceName?: string;
}

export interface AuthenticatedUser {
  id: string;
  tenantId: string;
  type: UserType;
  fullName: string | null;
  username: string | null;
  phone: string | null;
  email: string | null;
  status: UserStatus;
}

export interface AuthResult {
  user: AuthenticatedUser;
  tokens: TokenPair;
}

/**
 * Authentication for both principal types.
 *
 * ## Two schemes, one service
 *
 * Customers authenticate with **phone + PIN** (they arrive via WhatsApp, where a
 * password is unusable). Admins authenticate with an **allowlisted phone + the
 * same transfer PIN**. The flows share session handling, lockout and token
 * issuance, so they live together; what differs is the allowlist check.
 *
 * ## Enumeration resistance
 *
 * Every failure path returns the same error (`INVALID_CREDENTIALS`) and burns
 * comparable CPU, whether or not the account exists. On this product the phone
 * number is the identity, so a "no such user" signal would let anyone test which
 * numbers hold accounts — and a list of a fintech's customers is itself valuable.
 */
@Injectable()
export class AuthService {
  constructor(
    @InjectPrisma() private readonly db: ExtendedPrismaClient,
    private readonly hashing: HashingService,
    private readonly tokens: TokenService,
    private readonly rewards: RewardsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AuthService.name);
  }

  // ===========================================================================
  //  Customer — phone + PIN
  // ===========================================================================

  /**
   * Registers a WhatsApp customer and provisions their wallet.
   *
   * User and wallet are created in **one transaction**. A customer without a
   * wallet is a broken account that fails at the first balance check, and a
   * partial failure here would leave exactly that. The bank account is *not*
   * created here: it is issued asynchronously by the payment provider, so it
   * arrives later via callback (phase 3).
   */
  async registerCustomer(dto: CustomerRegisterDto, device: DeviceContext): Promise<AuthResult> {
    const tenantId = RequestContext.requireTenantId();
    const phoneE164 = Phone.normalizeOrThrow(dto.phone);

    if (isWeakPin(dto.pin)) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: 'Choose a less predictable PIN',
        details: { field: 'pin' },
      });
    }

    if (RESERVED_USERNAMES.has(dto.username)) {
      throw new AppException(ErrorCode.RESOURCE_ALREADY_EXISTS, {
        message: 'That username is not available',
        details: { field: 'username' },
      });
    }

    // Resolved up front so a mistyped code is reported before an account exists.
    const referrerId = dto.referralCode
      ? await this.rewards.resolveReferrer(dto.referralCode)
      : undefined;

    // Hash before opening the transaction: Argon2id takes ~50ms, and holding a
    // database transaction open across it wastes a pooled connection.
    const pinHash = await this.hashing.hash(dto.pin);

    const user = await this.db.$transaction(async (tx) => {
      // The unique constraints are the real guard against a duplicate — this
      // check exists to return a helpful message for the common case, not to
      // prevent the race. The race is lost to the database, which is correct.
      const existing = await tx.user.findFirst({
        where: { OR: [{ phoneE164 }, { username: dto.username }] },
        select: { id: true, phoneE164: true, username: true },
      });

      if (existing) {
        throw new AppException(ErrorCode.RESOURCE_ALREADY_EXISTS, {
          message:
            existing.phoneE164 === phoneE164
              ? 'An account already exists for this phone number'
              : 'That username is not available',
          details: { field: existing.phoneE164 === phoneE164 ? 'phone' : 'username' },
        });
      }

      const created = await tx.user.create({
        data: {
          // Prisma's generated types require `tenantId` on a create even though
          // the tenant extension would inject it. Passing it explicitly keeps the
          // call type-safe, and the extension still verifies it matches the
          // active tenant — belt and braces rather than a cast.
          tenantId,
          type: UserType.CUSTOMER,
          phoneE164,
          fullName: dto.fullName,
          username: dto.username,
          email: dto.email ?? null,
          pinHash,
          pinSetAt: new Date(),
          // The customer proved control of this number by messaging us on
          // WhatsApp; the phone is the account and needs no separate verification
          // step before use.
          status: UserStatus.ACTIVE,
        },
      });

      await tx.wallet.create({
        data: {
          tenantId,
          userId: created.id,
          currency: 'NGN',
          // Explicit rather than relying on the column default: the starting
          // balance of a new account is a business rule, not a schema detail.
          balance: 0n,
        },
      });

      await tx.auditLog.create({
        data: {
          tenantId,
          action: 'customer.registered',
          resourceType: 'user',
          resourceId: created.id,
          actorType: ActorType.User,
          actorId: created.id,
          ip: device.ip,
          userAgent: device.userAgent,
          requestId: RequestContext.requestId,
          metadata: { username: dto.username, phone: Phone.mask(phoneE164) },
        },
      });

      return created;
    });

    this.logger.info(
      { userId: user.id, tenantId, phone: Phone.mask(phoneE164) },
      'Customer registered and wallet provisioned',
    );

    // Same PIN for WhatsApp transfers if they already have a ramp profile.
    await this.syncPinToRamp(phoneE164, dto.pin).catch(() => undefined);

    await this.rewards.onSignup({
      userId: user.id,
      username: user.username,
      referrerId,
      ip: device.ip,
    });

    const tokens = await this.startSession(user.id, tenantId, UserType.CUSTOMER, device);
    return { user: toAuthenticatedUser(user), tokens };
  }

  /**
   * Authenticates a customer by phone and PIN.
   *
   * The WhatsApp transfer PIN is the product PIN. Login accepts:
   * 1. Platform `User.pinHash` (Argon2) — set at web register / synced from WA
   * 2. Else ZyRampUser transfer PIN (bcrypt) — then syncs it onto the platform user
   *    so web and WhatsApp stay one credential.
   */
  async loginCustomer(dto: CustomerLoginDto, device: DeviceContext): Promise<AuthResult> {
    const tenantId = RequestContext.requireTenantId();
    const phoneE164 = Phone.normalize(dto.phone);

    // An unparseable number cannot match any account, but we still pay the hash
    // cost so that a malformed number is not measurably faster than a valid one.
    // Include ADMIN so ops accounts promoted for the console can still sign in
    // on the portal form (session type follows User.type).
    let user = phoneE164
      ? await this.db.user.findFirst({
          where: {
            phoneE164,
            type: { in: [UserType.CUSTOMER, UserType.ADMIN] },
          },
        })
      : null;

    // Verify PIN first. A correct PIN always clears lockout — otherwise a tester
    // (or user who just recovered via WhatsApp) stays blocked after dummy attempts.
    let valid = await this.hashing.verifyWithDummy(user?.pinHash, dto.pin);
    let authenticatedViaRampPin = false;

    if (!valid && phoneE164) {
      const rampOk = await this.verifyRampTransferPin(phoneE164, dto.pin);
      if (rampOk) {
        valid = true;
        authenticatedViaRampPin = true;
        if (!user) {
          await this.provisionPlatformUserFromRamp(phoneE164, dto.pin, tenantId);
          user = await this.db.user.findFirst({
            where: {
              phoneE164,
              type: { in: [UserType.CUSTOMER, UserType.ADMIN] },
            },
          });
        }
      }
    }

    if (!user || !valid) {
      // Still locked from earlier wrong tries → say so (don't burn another strike).
      if (user?.lockedUntil && user.lockedUntil > new Date()) {
        const retryAfterSeconds = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
        throw new AppException(ErrorCode.ACCOUNT_LOCKED, {
          message: 'Too many failed attempts. Try again shortly.',
          retryAfterSeconds,
        });
      }
      await this.recordFailedAttempt(user?.id, 'pin', device);
      throw new AppException(ErrorCode.INVALID_CREDENTIALS, {
        message: 'Incorrect phone number or PIN',
      });
    }

    this.assertUsable(user.status);

    if (user.pinResetRequired) {
      throw new AppException(ErrorCode.PRECONDITION_FAILED, {
        message: 'Your PIN must be reset before you can sign in',
        details: { action: 'pin_reset_required' },
      });
    }

    // Ramp PIN won → force-write Argon2 onto platform user (may have been null or stale).
    if (authenticatedViaRampPin) {
      const pinHash = await this.hashing.hash(dto.pin);
      user = await this.db.user.update({
        where: { id: user.id },
        data: {
          pinHash,
          pinSetAt: new Date(),
          failedPinAttempts: 0,
          lockedUntil: null,
          lastLoginAt: new Date(),
          lastLoginIp: device.ip,
        },
      });
      this.logger.info(
        { userId: user.id, phone: Phone.mask(phoneE164!) },
        'Portal login via WhatsApp transfer PIN; platform pinHash synced',
      );
    } else {
      await this.onSuccessfulLogin(user.id, dto.pin, user.pinHash, 'pin', device);
    }

    // Keep ramp PIN in sync when the portal hash was the match (same digits).
    if (!authenticatedViaRampPin && phoneE164) {
      await this.syncPinToRamp(phoneE164, dto.pin).catch(() => undefined);
    }

    const sessionType = user.type === UserType.ADMIN ? UserType.ADMIN : UserType.CUSTOMER;
    const tokens = await this.startSession(user.id, tenantId, sessionType, device);
    // Check-in and milestone sync run after the response; they never block sign-in.
    void this.rewards.onLogin(user.id);
    return { user: toAuthenticatedUser(user), tokens };
  }

  /** Phone keys ZyRampUser may use (WA id, E.164, local 08…). */
  /**
   * Confirms a money movement from the web portal with the customer's PIN.
   *
   * Accepts the WhatsApp transfer PIN — the same credential the chat uses to
   * confirm sends, sells and airtime — or the portal PIN, exactly as login does.
   * Unlike the chat, repeated failures count towards the account lockout, so a
   * stolen session cannot be used to guess the PIN.
   */
  async verifyTransactionPin(userId: string, pin: string, device: DeviceContext): Promise<void> {
    const user = await this.db.user.findFirst({ where: { id: userId } });
    if (!user) {
      throw new AppException(ErrorCode.UNAUTHENTICATED, { message: 'Sign in again to continue.' });
    }
    this.assertUsable(user.status);
    this.assertNotLocked(user);

    let valid = await this.hashing.verifyWithDummy(user.pinHash, pin);
    if (!valid && user.phoneE164) {
      valid = await this.verifyRampTransferPin(user.phoneE164, pin);
    }

    if (!valid) {
      await this.recordFailedAttempt(user.id, 'pin', device);
      throw new AppException(ErrorCode.INVALID_CREDENTIALS, { message: 'Incorrect PIN' });
    }

    if (user.failedPinAttempts > 0) {
      await this.db.user.update({
        where: { id: user.id },
        data: { failedPinAttempts: 0, lockedUntil: null },
      });
    }
  }

  private rampPhoneCandidates(phoneE164: string): string[] {
    const wa = Phone.toWhatsAppId(phoneE164);
    const local =
      phoneE164.startsWith('+234') && phoneE164.length >= 14 ? `0${phoneE164.slice(4)}` : undefined;
    return [...new Set([wa, phoneE164, `+${wa}`, local].filter(Boolean) as string[])];
  }

  private async verifyRampTransferPin(phoneE164: string, pin: string): Promise<boolean> {
    const bcrypt = await import('bcryptjs');
    for (const key of this.rampPhoneCandidates(phoneE164)) {
      const ramp = await this.db.zyRampUser.findUnique({
        where: { phone: key },
        select: { pinHash: true },
      });
      if (!ramp?.pinHash) continue;
      try {
        if (await bcrypt.compare(String(pin), ramp.pinHash)) return true;
      } catch {
        // malformed hash → treat as miss
      }
    }
    // Still burn Argon2 time so ramp-miss isn't faster than platform-miss.
    await this.hashing.verifyWithDummy(null, pin);
    return false;
  }

  /**
   * Creates the platform User for a WhatsApp identity that just proved their
   * transfer PIN. Mirrors ramp.naira ensurePlatformUser.
   */
  private async provisionPlatformUserFromRamp(
    phoneE164: string,
    pin: string,
    tenantId: string,
  ): Promise<void> {
    const { createHash } = await import('node:crypto');
    const ramp =
      (await this.db.zyRampUser.findFirst({
        where: { phone: { in: this.rampPhoneCandidates(phoneE164) } },
      })) ?? null;

    const usernameBase = (ramp?.username || `wa${phoneE164.replace(/\D/g, '').slice(-10)}`)
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .slice(0, 28);
    const username = `${usernameBase}_${createHash('sha256').update(phoneE164).digest('hex').slice(0, 4)}`;
    const pinHash = await this.hashing.hash(pin);

    const created = await this.db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          tenantId,
          type: UserType.CUSTOMER,
          phoneE164,
          email: ramp?.email || undefined,
          username,
          fullName: ramp?.whatsappName || ramp?.username || undefined,
          pinHash,
          pinSetAt: new Date(),
          status: UserStatus.ACTIVE,
          wallet: { create: { tenantId, currency: 'NGN' } },
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          action: 'customer.provisioned_from_whatsapp_login',
          resourceType: 'user',
          resourceId: user.id,
          actorType: ActorType.Anonymous,
          actorId: user.id,
          requestId: RequestContext.requestId,
          metadata: { phone: Phone.mask(phoneE164) },
        },
      });
      return user;
    });

    this.logger.info(
      { userId: created.id, phone: Phone.mask(phoneE164) },
      'Provisioned platform user from WhatsApp PIN login',
    );

    await this.rewards.onSignup({ userId: created.id, username: created.username });
  }

  private async syncPinToRamp(phoneE164: string, pin: string): Promise<void> {
    const bcrypt = await import('bcryptjs');
    const pinHash = await bcrypt.hash(String(pin), 10);
    for (const key of this.rampPhoneCandidates(phoneE164)) {
      const updated = await this.db.zyRampUser.updateMany({
        where: { phone: key },
        data: { pinHash, pinSetupHash: null },
      });
      if (updated.count > 0) return;
    }
  }

  /** Changes a customer's PIN and revokes every other session. */
  async changePin(userId: string, dto: ChangePinDto, device: DeviceContext): Promise<void> {
    if (dto.currentPin === dto.newPin) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: 'The new PIN must differ from the current one',
        details: { field: 'newPin' },
      });
    }

    if (isWeakPin(dto.newPin)) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: 'Choose a less predictable PIN',
        details: { field: 'newPin' },
      });
    }

    const user = await this.db.user.findFirst({ where: { id: userId } });
    if (!user) throw AppException.notFound('User', userId);

    this.assertNotLocked(user);

    if (!(await this.hashing.verifyWithDummy(user.pinHash, dto.currentPin))) {
      await this.recordFailedAttempt(user.id, 'pin', device);
      throw new AppException(ErrorCode.INVALID_CREDENTIALS, {
        message: 'Your current PIN is incorrect',
      });
    }

    const pinHash = await this.hashing.hash(dto.newPin);

    await this.db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          pinHash,
          pinSetAt: new Date(),
          pinResetRequired: false,
          failedPinAttempts: 0,
          lockedUntil: null,
        },
      });

      // A credential change invalidates every existing session. If the PIN was
      // changed because it was compromised, leaving the attacker's session alive
      // defeats the point of changing it.
      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'pin_changed' },
      });

      await tx.auditLog.create({
        data: {
          tenantId: RequestContext.requireTenantId(),
          action: 'auth.pin_changed',
          resourceType: 'user',
          resourceId: userId,
          actorType: ActorType.User,
          actorId: userId,
          ip: device.ip,
          userAgent: device.userAgent,
          requestId: RequestContext.requestId,
        },
      });
    });

    if (user.phoneE164) {
      await this.syncPinToRamp(user.phoneE164, dto.newPin).catch(() => undefined);
    }

    this.logger.info({ userId }, 'PIN changed; all sessions revoked');
  }

  // ===========================================================================
  //  Admin — allowlisted phone + WhatsApp transfer PIN
  // ===========================================================================

  /**
   * Ops console sign-in. Only phones in `ADMIN_PHONES` (default
   * `08060332714,08102950347`) may authenticate. Credential is the WhatsApp
   * transfer PIN (platform Argon2 and/or ZyRampUser bcrypt).
   *
   * On success the platform user is promoted to `ADMIN` so refresh tokens keep
   * admin privileges.
   */
  async loginAdmin(dto: AdminLoginDto, device: DeviceContext): Promise<AuthResult> {
    const tenantId = RequestContext.requireTenantId();
    const phoneE164 = Phone.normalize(dto.phone);

    if (!phoneE164 || !this.isAllowedAdminPhone(phoneE164)) {
      await this.hashing.verifyWithDummy(null, dto.pin);
      throw new AppException(ErrorCode.INVALID_CREDENTIALS, {
        message: 'Incorrect phone number or PIN',
      });
    }

    let user = await this.db.user.findFirst({
      where: {
        tenantId,
        phoneE164,
        type: { in: [UserType.CUSTOMER, UserType.ADMIN] },
      },
    });

    this.assertNotLocked(user);

    let valid = await this.hashing.verifyWithDummy(user?.pinHash, dto.pin);
    let authenticatedViaRampPin = false;

    if (!valid) {
      const rampOk = await this.verifyRampTransferPin(phoneE164, dto.pin);
      if (rampOk) {
        valid = true;
        authenticatedViaRampPin = true;
      }
    }

    if (!valid) {
      if (user?.lockedUntil && user.lockedUntil > new Date()) {
        const retryAfterSeconds = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
        throw new AppException(ErrorCode.ACCOUNT_LOCKED, {
          message: 'Too many failed attempts. Try again shortly.',
          retryAfterSeconds,
        });
      }
      await this.recordFailedAttempt(user?.id, 'pin', device);
      throw new AppException(ErrorCode.INVALID_CREDENTIALS, {
        message: 'Incorrect phone number or PIN',
      });
    }

    if (!user) {
      const ramp =
        (await this.db.zyRampUser.findFirst({
          where: { phone: { in: this.rampPhoneCandidates(phoneE164) } },
        })) ?? null;
      if (!ramp) {
        throw new AppException(ErrorCode.INVALID_CREDENTIALS, {
          message: 'Incorrect phone number or PIN',
        });
      }
      user = await this.provisionAdminUserFromRamp(ramp, phoneE164, dto.pin, tenantId);
      authenticatedViaRampPin = true;
    } else if (user.type !== UserType.ADMIN) {
      user = await this.db.user.update({
        where: { id: user.id },
        data: {
          type: UserType.ADMIN,
          ...(user.emailVerifiedAt ? {} : { emailVerifiedAt: new Date() }),
        },
      });
      this.logger.info(
        { userId: user.id, phone: Phone.mask(phoneE164) },
        'Promoted allowlisted phone to ADMIN',
      );
    }

    this.assertUsable(user.status);

    if (user.pinResetRequired) {
      throw new AppException(ErrorCode.PRECONDITION_FAILED, {
        message: 'Your PIN must be reset before you can sign in',
        details: { action: 'pin_reset_required' },
      });
    }

    if (authenticatedViaRampPin) {
      const pinHash = await this.hashing.hash(dto.pin);
      user = await this.db.user.update({
        where: { id: user.id },
        data: {
          pinHash,
          pinSetAt: new Date(),
          failedPinAttempts: 0,
          lockedUntil: null,
          lastLoginAt: new Date(),
          lastLoginIp: device.ip,
        },
      });
      this.logger.info(
        { userId: user.id, phone: Phone.mask(phoneE164) },
        'Admin login via WhatsApp transfer PIN; platform pinHash synced',
      );
    } else {
      await this.onSuccessfulLogin(user.id, dto.pin, user.pinHash, 'pin', device);
    }

    if (!authenticatedViaRampPin) {
      await this.syncPinToRamp(phoneE164, dto.pin).catch(() => undefined);
    }

    await this.ensureAdminMembership(tenantId, user.id);

    const tokens = await this.startSession(user.id, tenantId, UserType.ADMIN, device);
    return { user: toAuthenticatedUser(user), tokens };
  }

  /**
   * PIN-promoted admins need a workspace membership or every `@RequirePermissions`
   * admin route returns ROLE_REQUIRED / empty dashboards.
   */
  private async ensureAdminMembership(tenantId: string, userId: string): Promise<void> {
    const existing = await this.db.membership.findFirst({
      where: { tenantId, userId, deletedAt: null },
      select: { id: true },
    });
    if (existing) return;

    await this.db.role.createMany({
      data: SYSTEM_ROLES.map((role) => ({
        tenantId,
        key: role.key,
        name: role.name,
        description: role.description,
        permissions: [...role.permissions],
        isSystem: true,
        isDefault: role.isDefault,
      })),
      skipDuplicates: true,
    });

    const ownerRole = await this.db.role.findFirst({
      where: { tenantId, key: 'owner', deletedAt: null },
      select: { id: true },
    });
    if (!ownerRole) {
      this.logger.error(
        { tenantId, userId },
        'Owner role missing after seed; admin membership skipped',
      );
      return;
    }

    await this.db.membership.create({
      data: {
        tenantId,
        userId,
        roleId: ownerRole.id,
        isOwner: true,
      },
    });
    this.logger.info({ tenantId, userId }, 'Granted owner membership to allowlisted admin');
  }

  /**
   * Allowlist compared in E.164. Defaults to the two ops numbers.
   * Env may list local `08…`, `+234…`, or WhatsApp ids.
   */
  private isAllowedAdminPhone(phoneE164: string): boolean {
    const raw = process.env.ADMIN_PHONES?.trim() || '08060332714,08102950347';
    const allowed = new Set<string>();
    for (const part of raw.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const normalized = Phone.normalize(trimmed) ?? Phone.fromWhatsAppId(trimmed);
      if (normalized) allowed.add(normalized);
    }
    return allowed.has(phoneE164);
  }

  private async provisionAdminUserFromRamp(
    ramp: {
      email: string | null;
      whatsappName: string | null;
      username: string | null;
    },
    phoneE164: string,
    pin: string,
    tenantId: string,
  ) {
    const { createHash } = await import('node:crypto');
    const usernameBase = (ramp.username || `wa${phoneE164.replace(/\D/g, '').slice(-10)}`)
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .slice(0, 28);
    const username = `${usernameBase}_${createHash('sha256').update(phoneE164).digest('hex').slice(0, 4)}`;
    const pinHash = await this.hashing.hash(pin);

    const created = await this.db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          tenantId,
          type: UserType.ADMIN,
          phoneE164,
          email: ramp.email || undefined,
          username,
          fullName: ramp.whatsappName || ramp.username || undefined,
          pinHash,
          pinSetAt: new Date(),
          emailVerifiedAt: new Date(),
          status: UserStatus.ACTIVE,
          wallet: { create: { tenantId, currency: 'NGN' } },
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          action: 'admin.provisioned_from_whatsapp_login',
          resourceType: 'user',
          resourceId: user.id,
          actorType: ActorType.Anonymous,
          actorId: user.id,
          requestId: RequestContext.requestId,
          metadata: { phone: Phone.mask(phoneE164) },
        },
      });
      return user;
    });

    this.logger.info(
      { userId: created.id, phone: Phone.mask(phoneE164) },
      'Provisioned ADMIN platform user from WhatsApp PIN login',
    );
    return created;
  }

  // ===========================================================================
  //  Sessions
  // ===========================================================================

  /**
   * Exchanges a refresh token for a new pair, rotating the old one.
   *
   * ## Reuse detection
   *
   * Every refresh invalidates the token that was presented. If a token that has
   * already been rotated is presented again, exactly one of two things happened:
   * the token was stolen and the thief is now using it, or the legitimate client
   * is replaying. Both are indistinguishable from the server's side, so the safe
   * response is to revoke the **entire family** — every descendant of that login
   * — and force a fresh authentication. This is the OAuth 2.1 recommendation for
   * public clients and the reason rotated rows are retained rather than deleted.
   */
  async refresh(refreshToken: string, device: DeviceContext): Promise<TokenPair> {
    const payload = await this.tokens.verifyRefreshToken(refreshToken);
    const tokenHash = this.tokens.hashRefreshToken(refreshToken);

    const session = await this.db.session.findFirst({ where: { refreshTokenHash: tokenHash } });

    if (!session) {
      // A well-signed token with no session row: the row was pruned, or this is a
      // forgery against a leaked secret. Either way, refuse.
      throw new AppException(ErrorCode.TOKEN_INVALID, { message: 'Session not found' });
    }

    if (session.rotatedAt || session.revokedAt) {
      await this.revokeFamily(session.familyId, 'refresh_token_reuse_detected');

      this.logger.warn(
        {
          userId: session.userId,
          familyId: session.familyId,
          ip: device.ip,
          alreadyRotated: Boolean(session.rotatedAt),
        },
        'Refresh token reuse detected — revoking the entire token family',
      );

      throw new AppException(ErrorCode.REFRESH_TOKEN_REUSE_DETECTED, {
        message: 'This session has been invalidated. Please sign in again.',
      });
    }

    if (session.expiresAt <= new Date()) {
      throw new AppException(ErrorCode.SESSION_EXPIRED, { message: 'Your session has expired' });
    }

    const user = await this.db.user.findFirst({ where: { id: session.userId } });
    if (!user) throw new AppException(ErrorCode.TOKEN_INVALID, { message: 'Session not found' });
    this.assertUsable(user.status);

    const sessionId = this.tokens.newSessionId();
    const pair = await this.tokens.issuePair({
      userId: user.id,
      tenantId: payload.tid,
      userType: user.type,
      sessionId,
      familyId: session.familyId,
    });

    await this.db.$transaction([
      // Mark the presented token as spent. Retained (not deleted) precisely so a
      // later replay is detectable.
      this.db.session.update({
        where: { id: session.id },
        data: { rotatedAt: new Date(), lastUsedAt: new Date() },
      }),
      this.db.session.create({
        data: {
          id: sessionId,
          tenantId: payload.tid,
          userId: user.id,
          refreshTokenHash: this.tokens.hashRefreshToken(pair.refreshToken),
          familyId: session.familyId,
          deviceId: device.deviceId,
          deviceName: device.deviceName,
          userAgent: device.userAgent?.slice(0, 512),
          ip: device.ip,
          expiresAt: new Date(Date.now() + this.tokens.refreshTtlSeconds * 1000),
        },
      }),
    ]);

    return pair;
  }

  /** Revokes the current session. */
  async logout(sessionId: string): Promise<void> {
    await this.db.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'logout' },
    });
  }

  /** Revokes every session for a user — "sign out everywhere". */
  async logoutAll(userId: string): Promise<number> {
    const result = await this.db.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'logout_all' },
    });
    return result.count;
  }

  // ===========================================================================
  //  Internals
  // ===========================================================================

  private async startSession(
    userId: string,
    tenantId: string,
    userType: UserType,
    device: DeviceContext,
  ): Promise<TokenPair> {
    const sessionId = this.tokens.newSessionId();
    const familyId = this.tokens.newFamilyId();

    const pair = await this.tokens.issuePair({
      userId,
      tenantId,
      userType,
      sessionId,
      familyId,
    });

    await this.db.session.create({
      data: {
        id: sessionId,
        tenantId,
        userId,
        refreshTokenHash: this.tokens.hashRefreshToken(pair.refreshToken),
        familyId,
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        userAgent: device.userAgent?.slice(0, 512),
        ip: device.ip,
        expiresAt: new Date(Date.now() + this.tokens.refreshTtlSeconds * 1000),
      },
    });

    return pair;
  }

  private async revokeFamily(familyId: string, reason: string): Promise<void> {
    await this.db.session.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /**
   * Rejects a locked account **before** any hash comparison.
   *
   * Ordering matters twice over: it avoids spending 50ms of Argon2id on an
   * account that cannot log in anyway (which is otherwise a cheap way to burn
   * server CPU), and it keeps the lockout from being bypassable by timing.
   */
  private assertNotLocked(user: { lockedUntil: Date | null } | null): void {
    if (!user?.lockedUntil) return;

    if (user.lockedUntil > new Date()) {
      const retryAfterSeconds = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
      throw new AppException(ErrorCode.ACCOUNT_LOCKED, {
        message: 'Too many failed attempts. Try again shortly.',
        retryAfterSeconds,
      });
    }
  }

  private assertUsable(status: UserStatus): void {
    if (status === UserStatus.SUSPENDED) {
      throw new AppException(ErrorCode.ACCOUNT_SUSPENDED, {
        message: 'This account has been suspended',
      });
    }
    if (status === UserStatus.DEACTIVATED) {
      throw new AppException(ErrorCode.ACCOUNT_SUSPENDED, {
        message: 'This account is no longer active',
      });
    }
  }

  /**
   * Increments the failure counter and locks the account at the threshold.
   *
   * Called with `undefined` when the account does not exist, so that the code
   * path — and therefore the response time — is the same either way.
   */
  private async recordFailedAttempt(
    userId: string | undefined,
    credential: 'pin' | 'password',
    device: DeviceContext,
  ): Promise<void> {
    if (!userId) return;

    const field = credential === 'pin' ? 'failedPinAttempts' : 'failedLoginAttempts';

    const updated = await this.db.user.update({
      where: { id: userId },
      data: { [field]: { increment: 1 } },
      select: { failedPinAttempts: true, failedLoginAttempts: true },
    });

    const attempts = credential === 'pin' ? updated.failedPinAttempts : updated.failedLoginAttempts;

    if (attempts >= MAX_FAILED_ATTEMPTS) {
      await this.db.user.update({
        where: { id: userId },
        data: { lockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60_000) },
      });

      this.logger.warn(
        { userId, credential, attempts, ip: device.ip },
        'Account locked after repeated failed authentication attempts',
      );
    }

    await this.db.auditLog.create({
      data: {
        tenantId: RequestContext.requireTenantId(),
        action: 'auth.login_failed',
        resourceType: 'user',
        resourceId: userId,
        actorType: ActorType.Anonymous,
        actorId: userId,
        ip: device.ip,
        userAgent: device.userAgent,
        requestId: RequestContext.requestId,
        metadata: { credential, attempts },
      },
    });
  }

  /**
   * Clears failure state and transparently upgrades a stale hash.
   *
   * Re-hashing on login is how Argon2id parameters can be raised later without a
   * migration or a forced password reset: the only moment the plaintext is
   * available is right now.
   */
  private async onSuccessfulLogin(
    userId: string,
    plaintext: string,
    currentHash: string | null,
    credential: 'pin' | 'password',
    device: DeviceContext,
  ): Promise<void> {
    const data: Record<string, unknown> = {
      failedPinAttempts: 0,
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      lastLoginIp: device.ip,
    };

    if (currentHash && this.hashing.needsRehash(currentHash)) {
      const upgraded = await this.hashing.hash(plaintext);
      data[credential === 'pin' ? 'pinHash' : 'passwordHash'] = upgraded;
    }

    await this.db.user.update({ where: { id: userId }, data });
  }
}

function toAuthenticatedUser(user: {
  id: string;
  tenantId: string;
  type: UserType;
  fullName: string | null;
  username: string | null;
  phoneE164: string | null;
  email: string | null;
  status: UserStatus;
}): AuthenticatedUser {
  return {
    id: user.id,
    tenantId: user.tenantId,
    type: user.type,
    fullName: user.fullName,
    username: user.username,
    phone: user.phoneE164,
    email: user.email,
    status: user.status,
  };
}

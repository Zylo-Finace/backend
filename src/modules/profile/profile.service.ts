import { Injectable } from '@nestjs/common';
import { KycLevel, KycStatus, Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import sharp from 'sharp';

import { ActorType, RequestContext } from '../../core/context/request-context';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { Phone } from '../../core/utils/phone.util';
import { InjectPrisma } from '../../infrastructure/database/prisma.module';
import type { ExtendedPrismaClient } from '../../infrastructure/database/prisma.service';
import { RESERVED_USERNAMES } from '../auth/auth.service';
import type { UpdateProfileDto } from './profile.dto';

/** How long a customer must wait between username changes. */
export const USERNAME_COOLDOWN_DAYS = 30;

/**
 * Largest decoded upload accepted before re-encoding. The app downsizes photos
 * in the browser first; this also keeps the JSON body under the parser limit.
 */
const MAX_AVATAR_BYTES = 512 * 1024;
const AVATAR_SIZE = 256;
const DATA_URL = /^data:image\/(png|jpe?g|webp|heic|heif|gif);base64,([A-Za-z0-9+/=\s]+)$/;

const KYC_TIER: Record<KycLevel, 0 | 1 | 2 | 3> = {
  [KycLevel.TIER_0]: 0,
  [KycLevel.TIER_1]: 1,
  [KycLevel.TIER_2]: 2,
  [KycLevel.TIER_3]: 3,
};

export interface ProfileView {
  id: string;
  fullName: string | null;
  username: string | null;
  phone: string | null;
  email: string | null;
  /** `data:image/webp;base64,…` — small by construction (256×256 WebP). */
  avatarUrl: string | null;
  kycTier: 0 | 1 | 2 | 3;
  kycStatus: KycStatus;
  /** Once a BVN is verified the registry's name is the account name. */
  nameLocked: boolean;
  /** When the username may next be changed; null when it can be changed now. */
  usernameChangeAvailableAt: string | null;
  createdAt: string;
}

/** Self-service profile: name, username, email and photo. */
@Injectable()
export class ProfileService {
  constructor(
    @InjectPrisma() private readonly db: ExtendedPrismaClient,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ProfileService.name);
  }

  async get(userId: string): Promise<ProfileView> {
    const user = await this.db.user.findFirst({
      where: { id: userId },
      include: {
        avatar: { select: { contentType: true, data: true } },
        kycProfile: { select: { level: true, status: true } },
      },
    });
    if (!user) throw AppException.notFound('User', userId);

    const level = user.kycProfile?.level ?? KycLevel.TIER_0;
    const cooldownEnds = user.usernameChangedAt
      ? new Date(user.usernameChangedAt.getTime() + USERNAME_COOLDOWN_DAYS * 86_400_000)
      : null;

    return {
      id: user.id,
      fullName: user.fullName,
      username: user.username,
      phone: user.phoneE164,
      email: user.email,
      avatarUrl: user.avatar
        ? `data:${user.avatar.contentType};base64,${Buffer.from(user.avatar.data).toString('base64')}`
        : null,
      kycTier: KYC_TIER[level],
      kycStatus: user.kycProfile?.status ?? KycStatus.UNVERIFIED,
      nameLocked: KYC_TIER[level] >= 1,
      usernameChangeAvailableAt:
        cooldownEnds && cooldownEnds > new Date() ? cooldownEnds.toISOString() : null,
      createdAt: user.createdAt.toISOString(),
    };
  }

  async update(userId: string, dto: UpdateProfileDto): Promise<ProfileView> {
    const tenantId = RequestContext.requireTenantId();
    const current = await this.get(userId);
    const user = await this.db.user.findFirstOrThrow({
      where: { id: userId },
      select: { phoneE164: true },
    });

    const data: Prisma.UserUpdateInput = {};
    const changed: string[] = [];

    if (dto.fullName !== undefined && dto.fullName !== current.fullName) {
      if (current.nameLocked) {
        throw new AppException(ErrorCode.PRECONDITION_FAILED, {
          message: 'Your name comes from your verified BVN and can only be changed by support.',
          details: { field: 'fullName' },
        });
      }
      data.fullName = dto.fullName;
      changed.push('fullName');
    }

    const usernameChanged = dto.username !== undefined && dto.username !== current.username;
    if (usernameChanged) {
      await this.assertUsernameAvailable(dto.username!, current, user.phoneE164);
      data.username = dto.username;
      data.usernameChangedAt = new Date();
      changed.push('username');
    }

    const email = dto.email === '' ? null : dto.email;
    if (email !== undefined && email !== current.email) {
      if (email) {
        const clash = await this.db.user.findFirst({
          where: { email, id: { not: userId } },
          select: { id: true },
        });
        if (clash) {
          throw new AppException(ErrorCode.RESOURCE_ALREADY_EXISTS, {
            message: 'That email is already used by another account.',
            details: { field: 'email' },
          });
        }
      }
      data.email = email;
      data.emailVerifiedAt = null;
      changed.push('email');
    }

    if (!changed.length) return current;

    try {
      await this.db.$transaction(async (tx) => {
        await tx.user.update({ where: { id: userId }, data });
        await tx.auditLog.create({
          data: {
            tenantId,
            action: 'customer.profile_updated',
            resourceType: 'user',
            resourceId: userId,
            actorType: ActorType.User,
            actorId: userId,
            requestId: RequestContext.requestId,
            metadata: {
              changed,
              ...(usernameChanged ? { from: current.username, to: dto.username } : {}),
            },
          },
        });
      });
    } catch (err) {
      // Lost a race on the unique index between the check and the write.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AppException(ErrorCode.RESOURCE_ALREADY_EXISTS, {
          message: usernameChanged
            ? 'That username is not available'
            : 'That email is already used by another account.',
          details: { field: usernameChanged ? 'username' : 'email' },
        });
      }
      throw err;
    }

    // WhatsApp resolves @handles and receipts from the ramp profile: keep it in step.
    if (user.phoneE164 && (usernameChanged || changed.includes('email'))) {
      await this.db.zyRampUser
        .updateMany({
          where: { phone: { in: rampPhoneCandidates(user.phoneE164) } },
          data: {
            ...(usernameChanged ? { username: dto.username } : {}),
            ...(changed.includes('email') ? { email } : {}),
          },
        })
        .catch((err: unknown) =>
          this.logger.error({ err, userId }, 'Profile saved but WhatsApp profile sync failed'),
        );
    }

    this.logger.info({ userId, changed }, 'Profile updated');
    return this.get(userId);
  }

  async setAvatar(userId: string, image: string): Promise<ProfileView> {
    const tenantId = RequestContext.requireTenantId();
    const match = DATA_URL.exec(image);
    if (!match) {
      throw new AppException(ErrorCode.UNSUPPORTED_MEDIA_TYPE, {
        message: 'Upload a JPG, PNG, WebP or HEIC photo.',
      });
    }

    const raw = Buffer.from(match[2]!.replace(/\s/g, ''), 'base64');
    if (!raw.length || raw.length > MAX_AVATAR_BYTES) {
      throw new AppException(ErrorCode.PAYLOAD_TOO_LARGE, {
        message: 'That photo is too large. Try a smaller one.',
      });
    }

    let webp: Buffer;
    try {
      // Decoding is the validation: whatever the header claimed, only something
      // sharp can read as an image survives, and re-encoding drops EXIF (GPS).
      webp = await sharp(raw, { limitInputPixels: 40_000_000, failOn: 'error' })
        .rotate()
        .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'attention' })
        .webp({ quality: 80 })
        .toBuffer();
    } catch {
      throw new AppException(ErrorCode.UNSUPPORTED_MEDIA_TYPE, {
        message: "We couldn't read that photo. Try a different one.",
      });
    }

    await this.db.userAvatar.upsert({
      where: { userId },
      create: { userId, tenantId, contentType: 'image/webp', data: new Uint8Array(webp) },
      update: { contentType: 'image/webp', data: new Uint8Array(webp) },
    });

    this.logger.info({ userId, bytes: webp.length }, 'Avatar updated');
    return this.get(userId);
  }

  async removeAvatar(userId: string): Promise<ProfileView> {
    await this.db.userAvatar.deleteMany({ where: { userId } });
    return this.get(userId);
  }

  private async assertUsernameAvailable(
    username: string,
    current: ProfileView,
    phoneE164: string | null,
  ): Promise<void> {
    if (current.usernameChangeAvailableAt) {
      throw new AppException(ErrorCode.PRECONDITION_FAILED, {
        message: `You can change your username once every ${USERNAME_COOLDOWN_DAYS} days.`,
        details: { field: 'username', availableAt: current.usernameChangeAvailableAt },
      });
    }

    const unavailable = () =>
      new AppException(ErrorCode.RESOURCE_ALREADY_EXISTS, {
        message: 'That username is not available',
        details: { field: 'username' },
      });

    if (RESERVED_USERNAMES.has(username)) throw unavailable();

    const platformClash = await this.db.user.findFirst({
      where: { username, id: { not: current.id } },
      select: { id: true },
    });
    if (platformClash) throw unavailable();

    // WhatsApp-only customers hold handles too, in their own table.
    const rampClash = await this.db.zyRampUser.findFirst({
      where: {
        username: { equals: username, mode: 'insensitive' },
        ...(phoneE164 ? { phone: { notIn: rampPhoneCandidates(phoneE164) } } : {}),
      },
      select: { id: true },
    });
    if (rampClash) throw unavailable();
  }
}

function rampPhoneCandidates(phoneE164: string): string[] {
  const wa = Phone.toWhatsAppId(phoneE164);
  const local =
    phoneE164.startsWith('+234') && phoneE164.length >= 14 ? `0${phoneE164.slice(4)}` : undefined;
  return [...new Set([wa, phoneE164, `+${wa}`, local].filter(Boolean) as string[])];
}

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserType } from '@prisma/client';

import { Permission } from '../../core/authorization/permission.enum';
import { RequirePermissions } from '../admin/access/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireUserType } from '../auth/decorators/user-type.decorator';
import { CrossCheckDto, RejectKycDto, VerifyBvnDto, VerifyNinDto } from './dto/kyc.dto';
import { toIsoDate } from './kyc.matching';
import { KycService, type KycSnapshot } from './kyc.service';

/** A registry snapshot as staff see it. Dates flattened, identifier truncated. */
interface IdentityRecordView {
  source: string;
  identifierLast4: string | null;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  nameOnCard: string | null;
  gender: string | null;
  dateOfBirth: string | null;
  phoneNumber: string | null;
  phoneNumber2: string | null;
  nameMatchPercent: number | null;
  capturedAt: string;
}

/**
 * Customer-facing KYC.
 *
 * Every route resolves the profile from the **authenticated principal**. There
 * is deliberately no `GET /kyc/:userId` here: an identifier in the URL invites
 * enumeration, and what sits behind it is the most sensitive record a customer
 * has with us. Staff access goes through the admin routes below, which are
 * permission-gated and audited.
 */
@ApiTags('KYC')
@ApiBearerAuth('access-token')
@RequireUserType(UserType.CUSTOMER)
@Controller({ path: 'kyc', version: '1' })
export class KycController {
  constructor(private readonly kyc: KycService) {}

  @Get()
  @ApiOperation({
    summary: 'Current verification standing and limits',
    description:
      'Identifiers are returned as their last four digits only. The full number is never served over the API.',
  })
  async status(@CurrentUser('userId') userId: string): Promise<KycSnapshot> {
    return this.kyc.getSnapshot(userId);
  }

  @Post('bvn')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Tier 1 — verify a BVN',
    description:
      'Fetches the record the registry holds against the BVN and checks that the supplied phone ' +
      'number and date of birth match it. On success the customer reaches TIER_1 and the ' +
      "registry's identity is stored as the reference for the NIN check. Re-submitting an " +
      'already-verified BVN is free and returns the current standing.',
  })
  async verifyBvn(
    @CurrentUser('userId') userId: string,
    @Body() dto: VerifyBvnDto,
  ): Promise<KycSnapshot> {
    return this.kyc.verifyBvn({
      userId,
      bvn: dto.bvn,
      phoneNumber: dto.phoneNumber,
      dateOfBirth: dto.dateOfBirth,
    });
  }

  @Post('nin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Tier 2 — verify a NIN against the BVN on file',
    description:
      'Requires TIER_1. Fetches the NIN record and compares it with the stored BVN record: name ' +
      'similarity at or above the configured floor, gender and date of birth exact. Agreement ' +
      'reaches TIER_2, which is what permits a permanent bank account. A disagreement is recorded ' +
      'and refused, but never demotes the customer.',
  })
  async verifyNin(
    @CurrentUser('userId') userId: string,
    @Body() dto: VerifyNinDto,
  ): Promise<KycSnapshot> {
    return this.kyc.verifyNin({ userId, nin: dto.nin });
  }
}

/**
 * Back-office KYC.
 *
 * Split from the customer controller rather than mixed in with a role check per
 * route: the two have different authentication schemes, different permissions
 * and different audit expectations, and a single controller guarded by a
 * conditional is one missing decorator away from serving a customer somebody
 * else's identity.
 */
@ApiTags('Admin · KYC')
@ApiBearerAuth('access-token')
@RequireUserType(UserType.ADMIN)
@Controller({ path: 'admin/customers/:userId/kyc', version: '1' })
export class AdminKycController {
  constructor(private readonly kyc: KycService) {}

  @Get()
  @RequirePermissions(Permission.CustomersRead)
  @ApiOperation({ summary: "A customer's verification standing" })
  async status(@Param('userId', ParseUUIDPipe) userId: string): Promise<KycSnapshot> {
    return this.kyc.getSnapshot(userId);
  }

  @Get('records')
  @RequirePermissions(Permission.CustomersRead)
  @ApiOperation({
    summary: 'The identity details captured from each registry',
    description:
      'One record per registry (BVN, NIN), as the registry returned it. This is what tier 2 ' +
      'compared, and what answers a dispute without paying for the lookup again. Identifiers ' +
      'appear as their last four digits only.',
  })
  async records(@Param('userId', ParseUUIDPipe) userId: string): Promise<IdentityRecordView[]> {
    const records = await this.kyc.getIdentityRecords(userId);

    return records.map((record) => ({
      source: record.source,
      identifierLast4: record.identifierLast4,
      firstName: record.firstName,
      middleName: record.middleName,
      lastName: record.lastName,
      nameOnCard: record.nameOnCard,
      gender: record.gender,
      dateOfBirth: record.dateOfBirth ? toIsoDate(record.dateOfBirth) : null,
      phoneNumber: record.phoneNumber,
      phoneNumber2: record.phoneNumber2,
      nameMatchPercent: record.nameMatchPercent,
      capturedAt: record.capturedAt.toISOString(),
    }));
  }

  @Post('cross-check')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.CustomersWrite)
  @ApiOperation({
    summary: 'Check supplied details against the registry',
    description:
      'A basic check: does this name / date of birth / phone belong to this identifier? Records an ' +
      'audit row and a provider charge, but does not change the tier.',
  })
  async crossCheck(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser('userId') adminId: string,
    @Body() dto: CrossCheckDto,
  ): Promise<{ matched: boolean; nameMatchPercent?: number }> {
    return this.kyc.crossCheck({ ...dto, userId, requestedBy: adminId });
  }

  @Post('approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.CustomersWrite)
  @ApiOperation({
    summary: 'Promote to TIER_3 after review',
    description: 'Requires both BVN and NIN to already be verified.',
  })
  async approve(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser('userId') adminId: string,
  ): Promise<KycSnapshot> {
    return this.kyc.approveTier3(userId, adminId);
  }

  @Post('reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.CustomersSuspend)
  @ApiOperation({
    summary: 'Reject a profile',
    description:
      'Blocks tier upgrades until cleared. The reason is shown to the customer verbatim.',
  })
  async reject(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser('userId') adminId: string,
    @Body() dto: RejectKycDto,
  ): Promise<KycSnapshot> {
    return this.kyc.reject(userId, dto.reason, adminId);
  }
}

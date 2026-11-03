import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserStatus, UserType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { Response } from 'express';

import { Permission } from '../../../core/authorization/permission.enum';
import { ApiErrorResponse } from '../../../core/dto/api-response.dto';
import {
  buildCursorPage,
  CursorPaginationQueryDto,
  OffsetPaginationQueryDto,
  type CursorPage,
  type OffsetPage,
} from '../../../core/dto/pagination.dto';
import { Money } from '../../../core/money/money';
import { Cursor } from '../../../core/utils/cursor.util';
import { InjectPrisma } from '../../../infrastructure/database/prisma.module';
import type { ExtendedPrismaClient } from '../../../infrastructure/database/prisma.service';
import { RequireUserType } from '../../auth/decorators/user-type.decorator';
import { RampPortalService } from '../../ramp/ramp-portal.service';
import { RequirePermissions } from '../access/require-permissions.decorator';
import { CustomersService, type CustomerDetail, type CustomerListItem } from './customers.service';

export class CustomerQueryDto extends OffsetPaginationQueryDto {
  @ApiPropertyOptional({
    description:
      'Name, username, or phone number in any format — normalised to E.164 before matching.',
  })
  @IsString()
  @MaxLength(256)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : undefined,
  )
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ enum: UserStatus })
  @IsEnum(UserStatus)
  @IsOptional()
  status?: UserStatus;
}

export class SuspendCustomerDto {
  @ApiProperty({ description: 'Recorded in the audit trail.' })
  @IsString()
  @MinLength(3)
  @MaxLength(512)
  reason!: string;
}

interface LedgerEntryResponse {
  id: string;
  direction: string;
  type: string;
  status: string;
  amount: ReturnType<Money['toJSON']>;
  balanceAfter: ReturnType<Money['toJSON']>;
  narration: string | null;
  reference: string;
  createdAt: string;
}

@ApiTags('Admin · Customers')
@ApiBearerAuth('access-token')
@RequireUserType(UserType.ADMIN)
@ApiResponse({ status: 403, description: 'Insufficient permissions', type: ApiErrorResponse })
@Controller({ path: 'admin/customers', version: '1' })
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly portal: RampPortalService,
    @InjectPrisma() private readonly db: ExtendedPrismaClient,
  ) {}

  @Get()
  @RequirePermissions(Permission.CustomersRead)
  @ApiOperation({ summary: 'Customers, newest first' })
  async list(@Query() query: CustomerQueryDto): Promise<OffsetPage<CustomerListItem>> {
    return this.customers.list(query);
  }

  @Get(':id')
  @RequirePermissions(Permission.CustomersRead)
  @ApiOperation({ summary: 'One customer, with wallet and funding account' })
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<CustomerDetail> {
    return this.customers.get(id);
  }

  @Get(':id/statement')
  @RequirePermissions(Permission.WalletsRead)
  @ApiOperation({
    summary: 'A customer’s wallet statement',
    description:
      'Separately permissioned from the customer record: seeing who someone is and seeing what ' +
      'they spend are different disclosures.',
  })
  async statement(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CursorPaginationQueryDto,
  ): Promise<CursorPage<LedgerEntryResponse>> {
    // Resolves through the service so a missing or non-customer id is a 404
    // before any ledger row is read.
    await this.customers.get(id);

    const cursor = query.cursor ? Cursor.toDate(query.cursor) : undefined;

    const rows = await this.db.walletLedgerEntry.findMany({
      where: {
        userId: id,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.date } },
                { createdAt: cursor.date, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: {
        id: true,
        direction: true,
        type: true,
        status: true,
        amount: true,
        balanceAfter: true,
        currency: true,
        narration: true,
        reference: true,
        createdAt: true,
      },
    });

    const page = buildCursorPage(rows, query.limit, (row) =>
      Cursor.fromDate(row.createdAt, row.id),
    );

    return {
      items: page.items.map((row) => ({
        id: row.id,
        direction: row.direction,
        type: row.type,
        status: row.status,
        amount: Money.fromKobo(row.amount, row.currency).toJSON(),
        balanceAfter: Money.fromKobo(row.balanceAfter, row.currency).toJSON(),
        narration: row.narration,
        reference: row.reference,
        createdAt: row.createdAt.toISOString(),
      })),
      meta: page.meta,
    };
  }

  @Get(':id/ledger')
  @RequirePermissions(Permission.WalletsRead)
  @ApiOperation({
    summary: 'Unified per-user ledger (NGN + on-chain Stellar/Celo) with reconciliation',
  })
  async ledger(@Param('id', ParseUUIDPipe) id: string) {
    await this.customers.get(id);
    return this.portal.getActivityForAdmin(id, 100);
  }

  @Get(':id/statement/export')
  @RequirePermissions(Permission.WalletsRead)
  @ApiOperation({ summary: 'Generate customer statement PDF/CSV/JSON' })
  @ApiQuery({ name: 'from', required: true })
  @ApiQuery({ name: 'to', required: true })
  @ApiQuery({ name: 'format', required: false, enum: ['csv', 'pdf', 'json'] })
  async exportStatement(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('format') format: 'csv' | 'pdf' | 'json' = 'csv',
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile | Record<string, unknown>> {
    await this.customers.get(id);
    const fromDate = new Date(from);
    const toDate = new Date(to);
    const result = await this.portal.buildStatement(id, {
      from: fromDate,
      to: toDate,
      format: format === 'pdf' || format === 'json' ? format : 'csv',
    });
    if (format === 'json') {
      return JSON.parse(String(result.body)) as Record<string, unknown>;
    }
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    const buf = Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body, 'utf8');
    return new StreamableFile(buf);
  }

  @Post(':id/suspend')
  @RequirePermissions(Permission.CustomersSuspend)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Suspend a customer and end their sessions' })
  async suspend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SuspendCustomerDto,
  ): Promise<CustomerDetail> {
    return this.customers.suspend(id, dto);
  }

  @Post(':id/reinstate')
  @RequirePermissions(Permission.CustomersSuspend)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Return a suspended customer to active' })
  async reinstate(@Param('id', ParseUUIDPipe) id: string): Promise<CustomerDetail> {
    return this.customers.reinstate(id);
  }

  @Post(':id/unlock')
  @RequirePermissions(Permission.CustomersWrite)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Clear a PIN lockout',
    description: 'Resets the failed-attempt counter. Does not change the PIN.',
  })
  async unlock(@Param('id', ParseUUIDPipe) id: string): Promise<CustomerDetail> {
    return this.customers.unlock(id);
  }

  @Post(':id/require-pin-reset')
  @RequirePermissions(Permission.CustomersWrite)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Force a PIN change on next use',
    description:
      'Staff can require a new PIN but can never set one — a PIN staff can see is a PIN staff can spend.',
  })
  async requirePinReset(@Param('id', ParseUUIDPipe) id: string): Promise<CustomerDetail> {
    return this.customers.requirePinReset(id);
  }
}

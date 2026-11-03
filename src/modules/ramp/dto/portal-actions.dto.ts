import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';

/** Trims a string field, leaving non-strings for the type validator to reject. */
const trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

const PIN_PATTERN = /^\d{4,6}$/;
const USDC_AMOUNT = /^\d+(\.\d{1,6})?$/;
const NGN_WHOLE = /^\d+$/;

export const PORTAL_NETWORKS = ['stellar', 'celo'] as const;
export type PortalNetwork = (typeof PORTAL_NETWORKS)[number];

export const PORTAL_MOBILE_NETWORKS = ['mtn', 'airtel', 'glo', '9mobile'] as const;
export type PortalMobileNetwork = (typeof PORTAL_MOBILE_NETWORKS)[number];

class PinDto {
  @ApiProperty({ description: 'Transfer PIN — the one used to confirm transactions in WhatsApp.' })
  @IsString()
  @Matches(PIN_PATTERN, { message: 'PIN must be 4 to 6 digits' })
  pin!: string;
}

export class ResolveRecipientQueryDto {
  @ApiProperty({ description: '@username, saved contact name, Stellar G… or Celo 0x… address.' })
  @IsString()
  @trim()
  @MaxLength(80)
  query!: string;

  @ApiProperty({ enum: PORTAL_NETWORKS })
  @IsIn(PORTAL_NETWORKS)
  network!: PortalNetwork;
}

export class SendUsdcDto extends PinDto {
  @ApiProperty({ description: '@username, saved contact name, or wallet address.' })
  @IsString()
  @trim()
  @MaxLength(80)
  recipient!: string;

  @ApiProperty({ description: 'USDC amount as a decimal string.', example: '10.5' })
  @IsString()
  @trim()
  @Matches(USDC_AMOUNT, { message: 'amount must be a decimal USDC amount' })
  amount!: string;

  @ApiProperty({ enum: PORTAL_NETWORKS })
  @IsIn(PORTAL_NETWORKS)
  network!: PortalNetwork;
}

export class BankSendQuoteQueryDto {
  @ApiProperty({ description: 'Whole naira.', example: '5000' })
  @IsString()
  @trim()
  @Matches(NGN_WHOLE, { message: 'amountNgn must be whole naira' })
  amountNgn!: string;
}

export class BankSendDto extends PinDto {
  @ApiProperty({ example: '058' })
  @IsString()
  @trim()
  @Matches(/^\d{3,6}$/, { message: 'bankCode must be a numeric bank code' })
  bankCode!: string;

  @ApiProperty({ example: '0123456789' })
  @IsString()
  @trim()
  @Matches(/^\d{10}$/, { message: 'accountNumber must be a 10-digit NUBAN' })
  accountNumber!: string;

  @ApiProperty({ description: 'Whole naira the recipient should receive.', example: '5000' })
  @IsString()
  @trim()
  @Matches(NGN_WHOLE, { message: 'amountNgn must be whole naira' })
  amountNgn!: string;

  @ApiProperty({ enum: PORTAL_NETWORKS, description: 'Which USDC balance pays for it.' })
  @IsIn(PORTAL_NETWORKS)
  network!: PortalNetwork;
}

export class SellUsdcDto extends PinDto {
  @ApiProperty({ description: 'USDC to sell.', example: '25' })
  @IsString()
  @trim()
  @Matches(USDC_AMOUNT, { message: 'amountUsdc must be a decimal USDC amount' })
  amountUsdc!: string;

  @ApiProperty({ enum: PORTAL_NETWORKS })
  @IsIn(PORTAL_NETWORKS)
  network!: PortalNetwork;

  @ApiPropertyOptional({ description: 'Saved payout account id. Defaults to the default account.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  payoutAccountId?: number;

  @ApiProperty({
    description:
      'The sell rate the customer reviewed. The sale is refused if the live rate has changed.',
    example: 1384,
  })
  @IsInt()
  @Min(1)
  quotedRateNgn!: number;
}

export class DataPlansQueryDto {
  @ApiProperty({ enum: PORTAL_MOBILE_NETWORKS })
  @IsIn(PORTAL_MOBILE_NETWORKS)
  network!: PortalMobileNetwork;
}

export class AirtimeDto extends PinDto {
  @ApiProperty({ enum: PORTAL_MOBILE_NETWORKS })
  @IsIn(PORTAL_MOBILE_NETWORKS)
  mobileNetwork!: PortalMobileNetwork;

  @ApiProperty({ example: '08031234567' })
  @IsString()
  @trim()
  @Matches(/^0[789][01]\d{8}$/, { message: 'phone must be an 11-digit Nigerian mobile number' })
  phone!: string;

  @ApiProperty({ example: '1000' })
  @IsString()
  @trim()
  @Matches(NGN_WHOLE, { message: 'amountNgn must be whole naira' })
  amountNgn!: string;

  @ApiProperty({ enum: PORTAL_NETWORKS, description: 'Which USDC balance pays for it.' })
  @IsIn(PORTAL_NETWORKS)
  network!: PortalNetwork;
}

export class DataDto extends PinDto {
  @ApiProperty({ enum: PORTAL_MOBILE_NETWORKS })
  @IsIn(PORTAL_MOBILE_NETWORKS)
  mobileNetwork!: PortalMobileNetwork;

  @ApiProperty({ example: '08031234567' })
  @IsString()
  @trim()
  @Matches(/^0[789][01]\d{8}$/, { message: 'phone must be an 11-digit Nigerian mobile number' })
  phone!: string;

  @ApiProperty({ description: 'Plan code from GET /ramp-portal/data-plans.' })
  @IsString()
  @trim()
  @MaxLength(64)
  planCode!: string;

  @ApiProperty({ enum: PORTAL_NETWORKS, description: 'Which USDC balance pays for it.' })
  @IsIn(PORTAL_NETWORKS)
  network!: PortalNetwork;
}

// ── Utility bills ────────────────────────────────────────────────────────────

export const PORTAL_METER_TYPES = ['prepaid', 'postpaid'] as const;
export type PortalMeterType = (typeof PORTAL_METER_TYPES)[number];

export const PORTAL_CABLE_PROVIDERS = ['dstv', 'gotv', 'startimes', 'showmax'] as const;
export type PortalCableProvider = (typeof PORTAL_CABLE_PROVIDERS)[number];

export class CablePackagesQueryDto {
  @ApiProperty({ enum: PORTAL_CABLE_PROVIDERS })
  @IsIn(PORTAL_CABLE_PROVIDERS)
  provider!: PortalCableProvider;
}

export class VerifyMeterQueryDto {
  @ApiProperty({ description: 'Disco code from GET /ramp-portal/bills/electricity/discos.' })
  @IsString()
  @trim()
  @MaxLength(64)
  discoCode!: string;

  @ApiProperty({ enum: PORTAL_METER_TYPES })
  @IsIn(PORTAL_METER_TYPES)
  meterType!: PortalMeterType;

  @ApiProperty({ example: '45012345678' })
  @IsString()
  @trim()
  @Matches(/^\d{6,20}$/, { message: 'meterNumber must be 6 to 20 digits' })
  meterNumber!: string;
}

export class VerifySmartCardQueryDto {
  @ApiProperty({ enum: PORTAL_CABLE_PROVIDERS })
  @IsIn(PORTAL_CABLE_PROVIDERS)
  provider!: PortalCableProvider;

  @ApiProperty({ example: '7023456789' })
  @IsString()
  @trim()
  @Matches(/^\d{8,20}$/, { message: 'smartCardNumber must be 8 to 20 digits' })
  smartCardNumber!: string;
}

export class VerifyBettingQueryDto {
  @ApiProperty({ description: 'Company code from GET /ramp-portal/bills/betting/companies.' })
  @IsString()
  @trim()
  @MaxLength(64)
  companyCode!: string;

  @ApiProperty({ example: '1234567' })
  @IsString()
  @trim()
  @Matches(/^[A-Za-z0-9_-]{3,40}$/, { message: 'customerId must be 3 to 40 letters or digits' })
  customerId!: string;
}

export class ElectricityDto extends PinDto {
  @ApiProperty()
  @IsString()
  @trim()
  @MaxLength(64)
  discoCode!: string;

  @ApiProperty({ enum: PORTAL_METER_TYPES })
  @IsIn(PORTAL_METER_TYPES)
  meterType!: PortalMeterType;

  @ApiProperty({ example: '45012345678' })
  @IsString()
  @trim()
  @Matches(/^\d{6,20}$/, { message: 'meterNumber must be 6 to 20 digits' })
  meterNumber!: string;

  @ApiProperty({ example: '5000' })
  @IsString()
  @trim()
  @Matches(NGN_WHOLE, { message: 'amountNgn must be whole naira' })
  amountNgn!: string;

  @ApiProperty({ enum: PORTAL_NETWORKS, description: 'Which USDC balance pays for it.' })
  @IsIn(PORTAL_NETWORKS)
  network!: PortalNetwork;
}

export class CableDto extends PinDto {
  @ApiProperty({ enum: PORTAL_CABLE_PROVIDERS })
  @IsIn(PORTAL_CABLE_PROVIDERS)
  provider!: PortalCableProvider;

  @ApiProperty({ description: 'Package code from GET /ramp-portal/bills/cable/packages.' })
  @IsString()
  @trim()
  @MaxLength(64)
  packageCode!: string;

  @ApiProperty({ example: '7023456789' })
  @IsString()
  @trim()
  @Matches(/^\d{8,20}$/, { message: 'smartCardNumber must be 8 to 20 digits' })
  smartCardNumber!: string;

  @ApiProperty({ enum: PORTAL_NETWORKS, description: 'Which USDC balance pays for it.' })
  @IsIn(PORTAL_NETWORKS)
  network!: PortalNetwork;
}

export class BettingDto extends PinDto {
  @ApiProperty()
  @IsString()
  @trim()
  @MaxLength(64)
  companyCode!: string;

  @ApiProperty({ example: '1234567' })
  @IsString()
  @trim()
  @Matches(/^[A-Za-z0-9_-]{3,40}$/, { message: 'customerId must be 3 to 40 letters or digits' })
  customerId!: string;

  @ApiProperty({ example: '2000' })
  @IsString()
  @trim()
  @Matches(NGN_WHOLE, { message: 'amountNgn must be whole naira' })
  amountNgn!: string;

  @ApiProperty({ enum: PORTAL_NETWORKS, description: 'Which USDC balance pays for it.' })
  @IsIn(PORTAL_NETWORKS)
  network!: PortalNetwork;
}

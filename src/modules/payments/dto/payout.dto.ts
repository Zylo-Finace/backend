import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** Trims a string field, leaving non-strings for the type validator to reject. */
const trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

export class ResolveAccountQueryDto {
  @ApiProperty({ description: '10-digit NUBAN.', example: '0123456789' })
  @IsString()
  @trim()
  // Exactly ten digits. Loose validation here means a typo becomes a provider
  // round trip and a rate-limit consumed, rather than an immediate 400.
  @Matches(/^\d{10}$/, { message: 'accountNumber must be a 10-digit NUBAN' })
  accountNumber!: string;

  @ApiProperty({ description: 'Bank code from GET /payouts/banks.', example: '058' })
  @IsString()
  @trim()
  @Matches(/^\d{3,6}$/, { message: 'bankCode must be a numeric bank code' })
  bankCode!: string;
}

export class CreatePayoutDto {
  /**
   * A decimal string, never a JSON number.
   *
   * `{"amount": 1500.50}` parses to a float, and a float is exactly how a
   * withdrawal becomes ₦1,500.4999999. The string form is the only one that
   * survives the round trip intact — {@link Money.fromNaira} refuses fractional
   * numbers for the same reason.
   */
  @ApiProperty({
    description: 'Amount in naira as a decimal string. Whole naira only.',
    example: '5000',
  })
  @IsString()
  @trim()
  @Matches(/^\d+(\.\d{1,2})?$/, { message: 'amount must be a decimal amount in naira' })
  amount!: string;

  @ApiProperty({ description: 'Recipient 10-digit NUBAN.', example: '0123456789' })
  @IsString()
  @trim()
  @Matches(/^\d{10}$/, { message: 'accountNumber must be a 10-digit NUBAN' })
  accountNumber!: string;

  @ApiProperty({ description: 'Bank code from GET /payouts/banks.', example: '058' })
  @IsString()
  @trim()
  @Matches(/^\d{3,6}$/, { message: 'bankCode must be a numeric bank code' })
  bankCode!: string;

  @ApiPropertyOptional({
    description: 'Shown on the recipient’s bank statement.',
    example: 'Rent for March',
  })
  @IsString()
  @trim()
  @MaxLength(100)
  @IsOptional()
  narration?: string;

  /**
   * Sent instead of, or as well as, the `Idempotency-Key` header.
   *
   * Two submissions carrying the same key produce one transfer. Clients that
   * omit it get a new transfer per request, which is the only honest reading of
   * a request that gave the server no way to recognise it as a repeat.
   */
  @ApiProperty({
    description: 'Transfer PIN. The payout is refused without it.',
    example: '4829',
  })
  @IsString()
  @Matches(/^\d{4,6}$/, { message: 'PIN must be 4 to 6 digits' })
  pin!: string;

  @ApiPropertyOptional({
    description: 'Client-generated key that makes a resubmitted withdrawal idempotent.',
    example: 'a3f9c1e2-7b44-4f1a-9c2d-8e5b1f0a6d33',
  })
  @IsString()
  @trim()
  @MinLength(8)
  @MaxLength(255)
  @IsOptional()
  idempotencyKey?: string;
}

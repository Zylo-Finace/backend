import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { KycIdentifierType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** Trims a string field, leaving non-strings for the type validator to reject. */
const trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

/** Strips spaces and dashes people type into an 11-digit number. */
const digits = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/\D/g, '') : value,
  );

/**
 * Tier 1. Three fields, and only three.
 *
 * The customer's name is deliberately not collected: the BVN registry returns
 * it, and asking someone to type a name that we are about to look up anyway
 * tests nothing except their spelling.
 */
export class VerifyBvnDto {
  /**
   * Validated to exactly eleven digits before it leaves the process.
   *
   * Not politeness: every provider lookup is billed, including one that returns
   * "not found", so a client-side typo that reaches PayVessel costs money and
   * consumes an attempt for an answer we could have given for free.
   */
  @ApiProperty({ description: '11-digit Bank Verification Number.', example: '22123456789' })
  @IsString()
  @digits()
  @Matches(/^\d{11}$/, { message: 'bvn must be 11 digits' })
  bvn!: string;

  @ApiProperty({
    description: 'The phone number registered against the BVN. Any common Nigerian format.',
    example: '08012345678',
  })
  @IsString()
  @digits()
  @Matches(/^\d{10,14}$/, { message: 'phoneNumber must be a Nigerian phone number' })
  phoneNumber!: string;

  @ApiProperty({
    description: 'Date of birth as held against the BVN, YYYY-MM-DD.',
    example: '1992-08-14',
  })
  @IsString()
  @trim()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dateOfBirth must be in YYYY-MM-DD format' })
  dateOfBirth!: string;
}

/**
 * Tier 2. The number alone.
 *
 * Name, gender and date of birth all come from the NIN registry and are compared
 * against the BVN record already on file — so collecting them from the customer
 * would be worse than useless. Someone holding a stolen NIN can type the details
 * that go with it; they cannot make it agree with a BVN that is not theirs.
 */
export class VerifyNinDto {
  @ApiProperty({ description: '11-digit National Identification Number.', example: '12345678901' })
  @IsString()
  @digits()
  @Matches(/^\d{11}$/, { message: 'nin must be 11 digits' })
  nin!: string;
}

export class CrossCheckDto {
  @ApiProperty({
    enum: KycIdentifierType,
    description: 'Which government identifier to check against.',
    example: KycIdentifierType.BVN,
  })
  @IsEnum(KycIdentifierType)
  type!: KycIdentifierType;

  @ApiProperty({ description: '11-digit BVN or NIN.', example: '22123456789' })
  @IsString()
  @digits()
  @Matches(/^\d{11}$/, { message: 'identifier must be 11 digits' })
  identifier!: string;

  @ApiProperty({ example: 'John' })
  @IsString()
  @trim()
  @MinLength(1)
  @MaxLength(80)
  firstName!: string;

  @ApiPropertyOptional({ example: 'Adebayo' })
  @IsString()
  @trim()
  @MaxLength(80)
  @IsOptional()
  middleName?: string;

  @ApiProperty({ example: 'Doe' })
  @IsString()
  @trim()
  @MinLength(1)
  @MaxLength(80)
  lastName!: string;

  @ApiProperty({ enum: ['MALE', 'FEMALE'], example: 'MALE' })
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn(['MALE', 'FEMALE'], { message: 'gender must be MALE or FEMALE' })
  gender!: string;

  @ApiProperty({ description: 'Date of birth, YYYY-MM-DD.', example: '1992-08-14' })
  @IsString()
  @trim()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'birthday must be YYYY-MM-DD' })
  birthday!: string;

  @ApiProperty({
    description: 'Nigerian phone number in local format, as held by the registry.',
    example: '08012345678',
  })
  @IsString()
  @digits()
  @Matches(/^\d{10,11}$/, { message: 'phoneNumber must be a Nigerian number' })
  phoneNumber!: string;
}

export class RejectKycDto {
  /**
   * Shown to the customer verbatim, so it must be safe to display — never a raw
   * provider error and never an internal note about another account.
   */
  @ApiProperty({
    description: 'Customer-facing reason. Displayed as written.',
    example: 'The document supplied did not match the name on your BVN.',
  })
  @IsString()
  @trim()
  @MinLength(4)
  @MaxLength(512)
  reason!: string;
}

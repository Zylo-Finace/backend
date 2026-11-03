import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Trims and lowercases a string field. */
const Normalize = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  );

const Trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

/**
 * PIN policy.
 *
 * Every new PIN is exactly 4 digits — the same rule the WhatsApp onboarding
 * enforces. Entering an existing PIN still accepts 4–6 digits, because accounts
 * created on the web before this rule may have a longer one.
 * The short keyspace is compensated for by lockout and rate limiting, not by
 * demanding a longer PIN nobody remembers. Trivially weak PINs are rejected
 * outright: `1234` and `0000` are a large share of real-world choices, and an
 * attacker with three attempts will try exactly those first.
 */
const PIN_PATTERN = /^\d{4,6}$/;
const NEW_PIN_PATTERN = /^\d{4}$/;

/** Sequential or uniform digits — the PINs guessed first in any online attack. */
const WEAK_PINS = new Set([
  '0000',
  '1111',
  '2222',
  '3333',
  '4444',
  '5555',
  '6666',
  '7777',
  '8888',
  '9999',
  '1234',
  '4321',
  '2580',
  '1212',
  '0101',
  '1010',
  '000000',
  '111111',
  '123456',
  '654321',
  '121212',
  '112233',
]);

export function isWeakPin(pin: string): boolean {
  if (WEAK_PINS.has(pin)) return true;
  // All digits identical, e.g. "55555".
  if (new Set(pin).size === 1) return true;
  // Strictly ascending or descending runs, e.g. "3456", "8765".
  const ascending = [...pin].every(
    (digit, index) => index === 0 || Number(digit) === Number(pin[index - 1]) + 1,
  );
  const descending = [...pin].every(
    (digit, index) => index === 0 || Number(digit) === Number(pin[index - 1]) - 1,
  );
  return ascending || descending;
}

// =============================================================================
//  Customer (WhatsApp) authentication
// =============================================================================

export class CustomerRegisterDto {
  @ApiProperty({
    description: 'Phone number in any common format; normalised to E.164 server-side.',
    example: '08012345678',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(24)
  @Trim()
  phone!: string;

  @ApiProperty({ description: 'Full name as held by the bank.', example: 'Adaeze Okonkwo' })
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  @Trim()
  fullName!: string;

  @ApiProperty({ description: 'Unique handle.', example: 'adaeze' })
  @IsString()
  @Length(3, 32)
  // Letters, digits, underscore. No leading digit, so a username can never be
  // mistaken for an id in a URL, and no dots/hyphens to collide with routing.
  @Matches(/^[a-z][a-z0-9_]{2,31}$/, {
    message:
      'Username must start with a letter and contain only lowercase letters, numbers and underscores',
  })
  @Normalize()
  username!: string;

  @ApiPropertyOptional({ description: 'Optional for customers.', example: 'ada@example.com' })
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(320)
  @Normalize()
  @IsOptional()
  email?: string;

  @ApiProperty({ description: '4-digit PIN.', example: '7392' })
  @IsString()
  @Matches(NEW_PIN_PATTERN, { message: 'PIN must be exactly 4 digits' })
  pin!: string;

  @ApiPropertyOptional({ description: "A friend's BANJEE referral code.", example: 'ADA7K2QF' })
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toUpperCase().replace(/[\s-]/g, '') || undefined : value,
  )
  @Matches(/^[A-Z0-9]{4,16}$/, { message: 'Enter a valid referral code' })
  referralCode?: string;
}

export class CustomerLoginDto {
  @ApiProperty({ example: '08012345678' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(24)
  @Trim()
  phone!: string;

  @ApiProperty({ example: '739205' })
  @IsString()
  @Matches(PIN_PATTERN, { message: 'PIN must be 4 to 6 digits' })
  pin!: string;
}

export class ChangePinDto {
  @ApiProperty()
  @IsString()
  @Matches(PIN_PATTERN, { message: 'PIN must be 4 to 6 digits' })
  currentPin!: string;

  @ApiProperty({ description: '4-digit PIN.' })
  @IsString()
  @Matches(NEW_PIN_PATTERN, { message: 'PIN must be exactly 4 digits' })
  newPin!: string;
}

// =============================================================================
//  Admin authentication — allowlisted phones + transfer PIN
// =============================================================================

export class AdminLoginDto {
  @ApiProperty({ example: '08060332714' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(24)
  @Trim()
  phone!: string;

  @ApiProperty({ example: '482915', description: 'WhatsApp transfer PIN (4–6 digits)' })
  @IsString()
  @Matches(PIN_PATTERN, { message: 'PIN must be 4 to 6 digits' })
  pin!: string;
}

export class RefreshTokenDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  refreshToken!: string;
}

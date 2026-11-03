import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

const trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

const lower = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().replace(/^@/, '').toLowerCase() : value,
  );

/** Every field optional: send only what changed. */
export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Adaeze Okonkwo' })
  @IsOptional()
  @IsString()
  @trim()
  @MinLength(2)
  @MaxLength(160)
  fullName?: string;

  @ApiPropertyOptional({ example: 'adaeze' })
  @IsOptional()
  @IsString()
  @lower()
  @Matches(/^[a-z][a-z0-9_]{2,31}$/, {
    message:
      'Username must start with a letter and contain only lowercase letters, numbers and underscores',
  })
  username?: string;

  @ApiPropertyOptional({
    description: 'Empty string removes the email.',
    example: 'ada@example.com',
  })
  @IsOptional()
  @IsString()
  @lower()
  @ValidateIf((_, v) => v !== '')
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(320)
  email?: string;
}

export class SetAvatarDto {
  @ApiProperty({ description: 'A `data:image/...;base64,` URL. Resized server-side to 256×256.' })
  @IsString()
  @MaxLength(720_000)
  image!: string;
}

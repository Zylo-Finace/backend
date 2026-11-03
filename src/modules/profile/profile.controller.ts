import { Body, Controller, Delete, Get, Patch, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserType } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireUserType } from '../auth/decorators/user-type.decorator';
import { SetAvatarDto, UpdateProfileDto } from './profile.dto';
import { ProfileService, type ProfileView } from './profile.service';

@ApiTags('Profile')
@ApiBearerAuth('access-token')
@RequireUserType(UserType.CUSTOMER, UserType.ADMIN)
@Controller({ path: 'profile', version: '1' })
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Get()
  @ApiOperation({ summary: 'The signed-in customer’s profile, photo and KYC tier' })
  get(@CurrentUser('userId') userId: string): Promise<ProfileView> {
    return this.profile.get(userId);
  }

  @Patch()
  @ApiOperation({
    summary: 'Update name, username or email',
    description:
      'The name is locked once a BVN is verified. Usernames can change once every 30 days and are ' +
      'kept in step with WhatsApp.',
  })
  update(
    @CurrentUser('userId') userId: string,
    @Body() dto: UpdateProfileDto,
  ): Promise<ProfileView> {
    return this.profile.update(userId, dto);
  }

  @Put('avatar')
  @ApiOperation({ summary: 'Upload a profile photo' })
  setAvatar(
    @CurrentUser('userId') userId: string,
    @Body() dto: SetAvatarDto,
  ): Promise<ProfileView> {
    return this.profile.setAvatar(userId, dto.image);
  }

  @Delete('avatar')
  @ApiOperation({ summary: 'Remove the profile photo' })
  removeAvatar(@CurrentUser('userId') userId: string): Promise<ProfileView> {
    return this.profile.removeAvatar(userId);
  }
}

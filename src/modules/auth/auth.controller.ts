import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { UserType } from '@prisma/client';
import type { Request } from 'express';

import { ApiErrorResponse } from '../../core/dto/api-response.dto';
import { AuthService, type AuthResult, type DeviceContext } from './auth.service';
import { CurrentUser, type CurrentUserPayload } from './decorators/current-user.decorator';
import { Public } from '../../core/decorators/public.decorator';
import { RequireUserType } from './decorators/user-type.decorator';
import {
  AdminLoginDto,
  ChangePinDto,
  CustomerLoginDto,
  CustomerRegisterDto,
  RefreshTokenDto,
} from './dto/auth.dto';
import type { TokenPair } from './token.service';

@ApiTags('Authentication')
@ApiResponse({ status: 422, description: 'Validation failed', type: ApiErrorResponse })
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // ===========================================================================
  //  Customer — phone + PIN
  // ===========================================================================

  @Post('customer/register')
  @Public()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Register a WhatsApp customer',
    description:
      'Creates the customer and provisions their ₦ wallet in one transaction. ' +
      'The funding bank account is issued asynchronously by the payment provider.',
  })
  @ApiResponse({
    status: 409,
    description: 'Phone or username already taken',
    type: ApiErrorResponse,
  })
  async registerCustomer(
    @Body() dto: CustomerRegisterDto,
    @Req() request: Request,
  ): Promise<AuthResult> {
    return this.auth.registerCustomer(dto, deviceFrom(request));
  }

  @Post('customer/login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in with phone number and PIN' })
  @ApiResponse({ status: 401, description: 'Incorrect phone or PIN', type: ApiErrorResponse })
  @ApiResponse({ status: 403, description: 'Account locked or suspended', type: ApiErrorResponse })
  async loginCustomer(@Body() dto: CustomerLoginDto, @Req() request: Request): Promise<AuthResult> {
    return this.auth.loginCustomer(dto, deviceFrom(request));
  }

  @Post('customer/pin')
  @RequireUserType(UserType.CUSTOMER)
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Change PIN',
    description: 'Revokes every existing session, including the caller’s.',
  })
  async changePin(
    @CurrentUser('userId') userId: string,
    @Body() dto: ChangePinDto,
    @Req() request: Request,
  ): Promise<void> {
    await this.auth.changePin(userId, dto, deviceFrom(request));
  }

  // ===========================================================================
  //  Admin — allowlisted username + WhatsApp transfer PIN
  // ===========================================================================

  @Post('admin/login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in to the back office with phone and transfer PIN',
    description:
      'Only phones in ADMIN_PHONES (default: 08060332714, 08102950347) may sign in. ' +
      'Credential is the same WhatsApp transfer PIN used on the customer portal.',
  })
  @ApiResponse({
    status: 401,
    description: 'Incorrect phone number or PIN',
    type: ApiErrorResponse,
  })
  async loginAdmin(@Body() dto: AdminLoginDto, @Req() request: Request): Promise<AuthResult> {
    return this.auth.loginAdmin(dto, deviceFrom(request));
  }

  // ===========================================================================
  //  Sessions
  // ===========================================================================

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a refresh token for a new pair',
    description:
      'Rotates the refresh token. Presenting an already-rotated token revokes the ' +
      'entire session family, on the assumption that it was stolen.',
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid, expired or reused token',
    type: ApiErrorResponse,
  })
  async refresh(@Body() dto: RefreshTokenDto, @Req() request: Request): Promise<TokenPair> {
    return this.auth.refresh(dto.refreshToken, deviceFrom(request));
  }

  @Post('logout')
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke the current session' })
  async logout(@CurrentUser() user: CurrentUserPayload): Promise<void> {
    if (user.sessionId) {
      await this.auth.logout(user.sessionId);
    }
  }

  @Post('logout-all')
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign out on every device' })
  async logoutAll(@CurrentUser('userId') userId: string): Promise<{ revokedSessions: number }> {
    return { revokedSessions: await this.auth.logoutAll(userId) };
  }

  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'The currently authenticated principal' })
  me(@CurrentUser() user: CurrentUserPayload): CurrentUserPayload {
    return user;
  }
}

/**
 * Captures the device fingerprint recorded against a session.
 *
 * `req.ip` is only trustworthy because `trust proxy` is configured to a specific
 * hop count — see `bootstrap/configure-app.ts`.
 */
export function deviceFrom(request: Request): DeviceContext {
  return {
    ip: request.ip,
    userAgent: request.headers['user-agent']?.slice(0, 512),
    deviceId: headerValue(request, 'x-device-id')?.slice(0, 128),
    deviceName: headerValue(request, 'x-device-name')?.slice(0, 255),
  };
}

function headerValue(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { IsEmail, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

import { RequestContext } from '../src/core/context/request-context';
import { Public } from '../src/core/decorators/public.decorator';
import { SkipResponseEnvelope } from '../src/core/decorators/skip-response-envelope.decorator';
import { RequestTimeout } from '../src/core/decorators/request-timeout.decorator';
import { AppException } from '../src/core/errors/app.exception';
import { ErrorCode } from '../src/core/errors/error-code.enum';
import type { WithMeta } from '../src/core/interceptors/response-transform.interceptor';

class CreateProbeDto {
  @IsEmail()
  email!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(120)
  @IsOptional()
  age?: number;
}

/**
 * Test-only controller exercising the cross-cutting HTTP pipeline.
 *
 * Lives in `test/` rather than `src/` so it can never be mounted by the real
 * application — a debug endpoint that reaches production is a liability.
 */
// `@Public()` on the class: this controller exercises the HTTP pipeline, not
// authentication, which has its own suite. Marking it here keeps the pipeline
// assertions from becoming assertions about the auth guard.
@Public()
@Controller({ path: 'probe', version: '1' })
export class ProbeController {
  @Get()
  ok(): { message: string } {
    return { message: 'ok' };
  }

  @Get('with-meta')
  withMeta(): WithMeta<number[]> {
    return { data: [1, 2, 3], meta: { total: 3, hasNextPage: false } };
  }

  @Get('raw')
  @SkipResponseEnvelope()
  raw(): string {
    return 'plain-text-challenge';
  }

  @Get('null')
  nothing(): null {
    return null;
  }

  @Get('context')
  context(): { requestId?: string; correlationId?: string } {
    return {
      requestId: RequestContext.requestId,
      correlationId: RequestContext.correlationId,
    };
  }

  @Get('app-error')
  appError(): never {
    throw new AppException(ErrorCode.RESOURCE_NOT_FOUND, {
      message: 'Contact not found',
      details: { resource: 'contact', id: 'c-1' },
    });
  }

  @Get('rate-limited')
  rateLimited(): never {
    throw new AppException(ErrorCode.RATE_LIMIT_EXCEEDED, {
      message: 'Too many requests',
      retryAfterSeconds: 30,
    });
  }

  @Get('boom')
  boom(): never {
    // An unexpected failure carrying a would-be-sensitive message.
    throw new Error('connection string postgres://user:hunter2@db:5432 failed');
  }

  @Get('slow')
  @RequestTimeout(100)
  async slow(): Promise<{ done: boolean }> {
    // `unref` so the abandoned timer does not hold the event loop open after the
    // interceptor has already responded — which is precisely the point: the
    // timeout cancels the *response*, never the work behind it.
    await new Promise((resolve) => setTimeout(resolve, 2_000).unref());
    return { done: true };
  }

  @Get('query')
  query(@Query('limit') limit?: string): { limit?: string } {
    return { limit };
  }

  @Post()
  create(@Body() body: CreateProbeDto): CreateProbeDto {
    return body;
  }
}

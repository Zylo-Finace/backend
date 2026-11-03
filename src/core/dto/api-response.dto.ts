import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { ErrorCode } from '../errors/error-code.enum';

/**
 * Every response the API emits — success or failure — uses this envelope.
 *
 * Trade-off: an envelope costs a few bytes and one level of nesting versus returning
 * bare resources. It buys a single parse path in every client SDK, a place to put
 * pagination/meta without polluting the resource, and a `requestId` on every response
 * so a customer can quote one line of JSON and support can find the exact trace.
 */
export class ApiSuccessResponse<T> {
  @ApiProperty({ example: true })
  success!: true;

  @ApiProperty({ description: 'The requested resource or collection.' })
  data!: T;

  @ApiPropertyOptional({ description: 'Pagination or operation metadata.' })
  meta?: Record<string, unknown>;

  @ApiProperty({ description: 'Correlates this response with server logs and traces.' })
  requestId!: string;

  @ApiProperty({ format: 'date-time' })
  timestamp!: string;
}

export class ApiErrorBody {
  @ApiProperty({
    description: 'Stable machine-readable code. Branch on this, never on the message.',
    example: 'RESOURCE_NOT_FOUND',
  })
  code!: ErrorCode;

  @ApiProperty({ description: 'Human-readable summary. Safe to display.' })
  message!: string;

  @ApiPropertyOptional({
    description: 'Structured context — field violations, offending ids, upstream codes.',
  })
  details?: Record<string, unknown>;

  @ApiProperty({
    description: 'Whether replaying the identical request may succeed.',
    example: false,
  })
  retryable!: boolean;
}

export class ApiErrorResponse {
  @ApiProperty({ example: false })
  success!: false;

  @ApiProperty({ type: ApiErrorBody })
  error!: ApiErrorBody;

  @ApiProperty()
  requestId!: string;

  @ApiProperty({ format: 'date-time' })
  timestamp!: string;
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

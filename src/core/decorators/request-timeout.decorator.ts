import { SetMetadata } from '@nestjs/common';

export const REQUEST_TIMEOUT_MS = 'requestTimeoutMs';

/**
 * Overrides the default request-processing budget for a handler or controller.
 *
 * @param ms Budget in milliseconds, or `null` to disable the timeout entirely —
 *           only valid for streaming responses (SSE, file downloads).
 */
export const RequestTimeout = (ms: number | null) => SetMetadata(REQUEST_TIMEOUT_MS, ms);

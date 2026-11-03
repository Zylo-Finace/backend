import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import { RequestContext } from '../../../core/context/request-context';
import { AppException } from '../../../core/errors/app.exception';

export interface CurrentUserPayload {
  userId: string;
  tenantId: string;
  sessionId?: string;
}

/**
 * Injects the authenticated principal into a handler parameter.
 *
 * Reads from the request context rather than `request.user`, so the same identity
 * is available to services deeper in the call stack without being threaded
 * through every signature — and so it works identically inside queue jobs.
 *
 * Throws if used on a route that is not authenticated: a handler asking for the
 * current user on a `@Public()` route is a wiring bug, and failing loudly beats
 * silently handing it `undefined`.
 */
export const CurrentUser = createParamDecorator(
  (field: keyof CurrentUserPayload | undefined, _context: ExecutionContext) => {
    const context = RequestContext.get();

    if (!context?.userId || !context.tenantId) {
      throw AppException.unauthenticated('No authenticated user on this request');
    }

    const payload: CurrentUserPayload = {
      userId: context.userId,
      tenantId: context.tenantId,
      sessionId: context.sessionId,
    };

    return field ? payload[field] : payload;
  },
);

import { SetMetadata } from '@nestjs/common';

export const SKIP_RESPONSE_ENVELOPE = 'skipResponseEnvelope';

/**
 * Opts a handler out of the standard success envelope.
 *
 * Required where a third party dictates the response shape (Meta's webhook
 * verification echoes the raw challenge string) or where the body is not JSON
 * (file downloads, Prometheus exposition format).
 */
export const SkipResponseEnvelope = () => SetMetadata(SKIP_RESPONSE_ENVELOPE, true);

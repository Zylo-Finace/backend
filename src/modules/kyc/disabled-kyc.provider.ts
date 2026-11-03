import { Injectable } from '@nestjs/common';
import { KycProviderName } from '@prisma/client';

import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import type {
  BasicVerificationResult,
  EnhancedVerificationResult,
  KycVerificationProvider,
} from './kyc-provider.interface';

/**
 * The adapter used when no verification provider is configured.
 *
 * Fails closed on every call, loudly. The tempting alternative — returning
 * "matched" so the flow keeps working in environments without credentials — is
 * how an unverified customer ends up holding a bank account, and it would do so
 * without leaving a trace that anything was skipped.
 *
 * Reads still work: an operator can promote a customer manually through the
 * review endpoints, which is exactly what `KycProviderName.MANUAL` is for.
 */
@Injectable()
export class DisabledKycProvider implements KycVerificationProvider {
  readonly name = KycProviderName.MANUAL;

  verifyBasic(): Promise<BasicVerificationResult> {
    return Promise.reject(unavailable());
  }

  verifyEnhanced(): Promise<EnhancedVerificationResult> {
    return Promise.reject(unavailable());
  }
}

function unavailable(): AppException {
  return new AppException(ErrorCode.SERVICE_UNAVAILABLE, {
    message: 'Identity verification is not available right now',
    details: { providerMessage: 'KYC_PROVIDER is set to "disabled"' },
    retryable: false,
  });
}

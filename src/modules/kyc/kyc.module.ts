import { Module, type Provider } from '@nestjs/common';

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';
import { KycProvider as KycProviderName } from '../../config/env.validation';
import { PayVesselClient } from '../payments/payvessel.client';
import { DisabledKycProvider } from './disabled-kyc.provider';
import { AdminKycController, KycController } from './kyc.controller';
import { KYC_PROVIDER } from './kyc-provider.interface';
import { KycService } from './kyc.service';
import { PayVesselKycProvider } from './payvessel-kyc.provider';

/**
 * Resolves the configured verification provider at startup.
 *
 * A factory rather than a runtime `switch`: the choice is made once, and an
 * unsupported value fails at boot instead of on the first customer who tries to
 * verify their identity. `disabled` resolves to an adapter that rejects every
 * call — a KYC integration that quietly approves everybody is considerably
 * worse than one that is visibly turned off.
 */
const kycProviderFactory: Provider = {
  provide: KYC_PROVIDER,
  useFactory: (
    config: AppConfig,
    payvessel: PayVesselKycProvider,
    disabled: DisabledKycProvider,
  ) => {
    switch (config.kyc.provider) {
      case KycProviderName.PayVessel:
        return payvessel;
      case KycProviderName.Disabled:
        return disabled;
      default:
        // Unreachable while every enum member is handled — tsc narrows the
        // value to `never` here. Kept so that adding a member without an
        // adapter fails at boot rather than injecting `undefined`.
        throw new Error(
          `KYC_PROVIDER="${String(config.kyc.provider)}" has no adapter. ` +
            'Implement KycVerificationProvider and register it in KycModule.',
        );
    }
  },
  inject: [APP_CONFIG, PayVesselKycProvider, DisabledKycProvider],
};

/**
 * Identity verification and the tier ladder built on it.
 *
 * Owns `PayVesselClient` rather than importing it from `PaymentsModule`: the
 * client is stateless and configuration-only, and having the KYC module depend
 * on the payments module would make identity verification unavailable whenever
 * the collections integration is being reworked — a coupling with no upside.
 */
@Module({
  controllers: [KycController, AdminKycController],
  providers: [
    PayVesselClient,
    PayVesselKycProvider,
    DisabledKycProvider,
    kycProviderFactory,
    KycService,
  ],
  exports: [KycService],
})
export class KycModule {}

import { Module, type Provider, forwardRef } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';
import {
  PaymentProvider as PaymentProviderName,
  PayoutProvider as PayoutProviderName,
} from '../../config/env.validation';
import { AuthModule } from '../auth/auth.module';
import { KycModule } from '../kyc/kyc.module';
import { RampModule } from '../ramp/ramp.module';
import { WalletModule } from '../wallet/wallet.module';
import { AccountProvisioningService } from './account-provisioning.service';
import { FalconPayProvider } from './falconpay.provider';
import { FalconPayWebhookController } from './falconpay-webhook.controller';
import { FundingService } from './funding.service';
import { OnrampAccountService } from './onramp-account.service';
import { DYNAMIC_ACCOUNT_PROVIDER, PAYMENT_PROVIDER } from './payment-provider.interface';
import { PAYOUT_PROVIDER, type PayoutProvider } from './payout-provider.interface';
import { PayoutService } from './payout.service';
import { PayoutsController } from './payouts.controller';
import { PaystackProvider } from './paystack.provider';
import { PayVesselClient } from './payvessel.client';
import { PayVesselProvider } from './payvessel.provider';
import { PayVesselWebhookController } from './payvessel-webhook.controller';
import { PulseMfbClient } from './pulsemfb.client';
import { PulseMfbPayoutProvider } from './pulsemfb-payout.provider';
import { PulseMfbProvider } from './pulsemfb.provider';
import { PulseMfbWebhookController } from './pulsemfb-webhook.controller';
import { RoutedPayoutProvider } from './routed-payout.provider';
import { WebhookController } from './webhook.controller';

/**
 * Resolves the configured provider at startup.
 *
 * A factory rather than a runtime `switch` at each call site: the choice is made
 * once, and an unsupported value fails at boot instead of on the first customer
 * registration. Flutterwave and Monnify adapters slot in here by implementing
 * `PaymentProvider` — no other file changes.
 */
const paymentProviderFactory: Provider = {
  provide: PAYMENT_PROVIDER,
  useFactory: (
    config: AppConfig,
    paystack: PaystackProvider,
    payvessel: PayVesselProvider,
    pulsemfb: PulseMfbProvider,
  ) => {
    switch (config.payments.provider) {
      case PaymentProviderName.Paystack:
        return paystack;
      case PaymentProviderName.PayVessel:
        return payvessel;
      case PaymentProviderName.PulseMfb:
        return pulsemfb;
      default:
        throw new Error(
          `PAYMENT_PROVIDER="${config.payments.provider}" has no adapter. ` +
            'Implement PaymentProvider and register it in PaymentsModule.',
        );
    }
  },
  inject: [APP_CONFIG, PaystackProvider, PayVesselProvider, PulseMfbProvider],
};

/**
 * Resolves the provider that issues single-use accounts.
 *
 * Deliberately *not* tied to `PAYMENT_PROVIDER`. Single-use issuance is a
 * capability, not a provider choice: Paystack can hold the wallet-funding
 * integration while PayVessel handles on-ramp collection, and forcing both onto
 * one vendor would mean losing the on-ramp to switch funding providers. Today
 * only PayVessel offers it, so the resolution is direct — and a caller that
 * needs one when it is unconfigured fails at boot rather than at checkout.
 */
const dynamicAccountProviderFactory: Provider = {
  provide: DYNAMIC_ACCOUNT_PROVIDER,
  useFactory: (payvessel: PayVesselProvider) => payvessel,
  inject: [PayVesselProvider],
};

/**
 * Resolves the configured payout provider at startup.
 *
 * Separate from the factory above because the inbound and outbound legs are
 * independent choices: the provider that issues funding accounts and the one
 * that sends money out are different companies with different licences, and
 * either must be replaceable without touching the other.
 */
const payoutProviderFactory: Provider = {
  provide: PAYOUT_PROVIDER,
  useFactory: (
    config: AppConfig,
    falconpay: FalconPayProvider,
    pulsemfb: PulseMfbPayoutProvider,
    logger: PinoLogger,
  ) => {
    const resolve = (name: PayoutProviderName): PayoutProvider => {
      switch (name) {
        case PayoutProviderName.FalconPay:
          return falconpay;
        case PayoutProviderName.PulseMfb:
          return pulsemfb;
        default:
          throw new Error(
            `PAYOUT_PROVIDER="${name}" has no adapter. ` +
              'Implement PayoutProvider and register it in PaymentsModule.',
          );
      }
    };

    const primary = resolve(config.payouts.provider);

    // `manual` means no failover: the primary's refusal is the final answer, as
    // it was before a fallback existed. `validateEnv` has already rejected a
    // fallback that is the same provider as the primary.
    if (config.payouts.fallbackProvider === PayoutProviderName.Manual) return primary;

    return new RoutedPayoutProvider(primary, resolve(config.payouts.fallbackProvider), logger);
  },
  inject: [APP_CONFIG, FalconPayProvider, PulseMfbPayoutProvider, PinoLogger],
};

@Module({
  imports: [WalletModule, KycModule, AuthModule, forwardRef(() => RampModule)],
  controllers: [
    WebhookController,
    PayVesselWebhookController,
    FalconPayWebhookController,
    PulseMfbWebhookController,
    PayoutsController,
  ],
  providers: [
    PaystackProvider,
    PayVesselClient,
    PayVesselProvider,
    PulseMfbClient,
    PulseMfbProvider,
    PulseMfbPayoutProvider,
    paymentProviderFactory,
    dynamicAccountProviderFactory,
    FundingService,
    AccountProvisioningService,
    OnrampAccountService,
    FalconPayProvider,
    payoutProviderFactory,
    PayoutService,
  ],
  exports: [
    AccountProvisioningService,
    OnrampAccountService,
    PAYMENT_PROVIDER,
    DYNAMIC_ACCOUNT_PROVIDER,
    PAYOUT_PROVIDER,
    PayoutService,
  ],
})
export class PaymentsModule {}

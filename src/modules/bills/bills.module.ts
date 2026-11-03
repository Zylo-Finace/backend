import { Module, type Provider } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';
import { BillsProvider as BillsProviderName } from '../../config/env.validation';
import { AIRTIME_DATA_PROVIDER, BILLS_PROVIDER } from './bills-provider.interface';
import { BillsCatalogueService } from './bills.catalogue';
import { BillsService } from './bills.service';
import { ClubKonnectClient } from './clubkonnect.client';
import { ClubKonnectProvider } from './clubkonnect.provider';
import { FalconPayBillsProvider } from './falconpay-bills.provider';
import { PulseMfbClient } from '../payments/pulsemfb.client';
import { PulseMfbVasProvider } from './pulsemfb-vas.provider';
import { RoutedBillsProvider } from './routed-bills.provider';
import { SmePlugClient } from './smeplug.client';
import { SmePlugProvider } from './smeplug.provider';
import { SmePlugWebhookController } from './smeplug-webhook.controller';

/**
 * Resolves the configured bills provider at startup.
 *
 * Same reasoning as the payment and payout factories: the choice is made once,
 * and an unsupported value fails at boot rather than on the first customer's
 * airtime purchase.
 *
 * `smeplug` resolves to a **router** rather than to SMEPlug itself, because
 * SMEPlug sells only airtime and data. The router puts it in front for those two
 * verticals, sends the other three to ClubKonnect, and re-places an order
 * downstream when SMEPlug cannot serve it. Every layer above still sees one
 * `BillsProvider`.
 */
const billsProviderFactory: Provider = {
  provide: BILLS_PROVIDER,
  useFactory: (
    config: AppConfig,
    falconpay: FalconPayBillsProvider,
    clubkonnect: ClubKonnectProvider,
    smeplug: SmePlugProvider,
    pulsemfb: PulseMfbVasProvider,
    logger: PinoLogger,
  ) => {
    // The last airtime/data tier, when one is configured. Resolved here rather
    // than inside the router so that an unconfigured deployment constructs the
    // exact two-provider chain it had before this tier existed.
    const vas =
      config.bills.vasFallbackProvider === BillsProviderName.PulseMfb ? pulsemfb : undefined;

    switch (config.bills.provider) {
      case BillsProviderName.FalconPay:
        // Sells all five verticals itself. As with ClubKonnect, a configured
        // last tier sits behind it for airtime and data only.
        return vas ? new RoutedBillsProvider(undefined, falconpay, logger, vas) : falconpay;

      case BillsProviderName.ClubKonnect:
        // ClubKonnect alone sells all five verticals, so it needs no router —
        // unless a last tier is configured, which backs up only two of them.
        // Nothing leads here: the trailing tier sits *behind* ClubKonnect, so
        // the router is built with no primary rather than with ClubKonnect
        // listed twice.
        return vas ? new RoutedBillsProvider(undefined, clubkonnect, logger, vas) : clubkonnect;

      case BillsProviderName.SmePlug:
        // The pairing is checked in `validateEnv`, which refuses to boot with
        // `smeplug` and no fallback — three verticals would have no provider.
        return new RoutedBillsProvider(smeplug, clubkonnect, logger, vas);

      default:
        throw new Error(
          `BILLS_PROVIDER="${config.bills.provider}" has no adapter. ` +
            'Implement BillsProvider and register it in BillsModule.',
        );
    }
  },
  inject: [
    APP_CONFIG,
    FalconPayBillsProvider,
    ClubKonnectProvider,
    SmePlugProvider,
    PulseMfbVasProvider,
    PinoLogger,
  ],
};

/**
 * The leading airtime/data provider, exposed separately.
 *
 * Distinct from `BILLS_PROVIDER` because the webhook controller needs *SMEPlug's
 * own* callback parser, not the router's — the two providers' payloads share no
 * fields, and a parser that had to guess which one sent a body would be guessing
 * about money.
 */
const airtimeDataProviderFactory: Provider = {
  provide: AIRTIME_DATA_PROVIDER,
  useFactory: (smeplug: SmePlugProvider) => smeplug,
  inject: [SmePlugProvider],
};

@Module({
  controllers: [SmePlugWebhookController],
  providers: [
    FalconPayBillsProvider,
    ClubKonnectClient,
    ClubKonnectProvider,
    SmePlugClient,
    SmePlugProvider,
    // Registered here as well as in `PaymentsModule`. The client is stateless —
    // it holds config and a logger — so a second instance costs nothing, and it
    // avoids making the bills module depend on the payments module for a
    // transport that happens to be shared.
    PulseMfbClient,
    PulseMfbVasProvider,
    billsProviderFactory,
    airtimeDataProviderFactory,
    BillsCatalogueService,
    BillsService,
  ],
  exports: [BillsService, BillsCatalogueService, BILLS_PROVIDER, AIRTIME_DATA_PROVIDER],
})
export class BillsModule {}

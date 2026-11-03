import { Module, forwardRef } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BillsModule } from '../bills/bills.module';
import { PaymentsModule } from '../payments/payments.module';
import { RewardsModule } from '../rewards/rewards.module';
import { WalletModule } from '../wallet/wallet.module';
import { RampBankSendWatcher } from './ramp.bank-send-watcher';
import { RampBillsService } from './ramp.bills';
import { RampCeloWalletService } from './ramp.celo-wallet';
import { RampCeloWatcher } from './ramp.celo-watcher';
import { RampCommandsService } from './ramp.commands';
import { RampIntentService } from './ramp.intent';
import { RampNairaService } from './ramp.naira';
import { RampOnboardingService } from './ramp.onboarding';
import { RampStellarWalletService } from './ramp.stellar-wallet';
import { RampStellarWatcher } from './ramp.stellar-watcher';
import { RampStoreService } from './ramp.store';
import { RampTxNotifyDedupe } from './ramp.tx-notify-dedupe';
import { RampUtilityChatService } from './ramp.utility-chat';
import { RampWhatsAppService } from './ramp.whatsapp';
import { RampWebhookController } from './ramp-webhook.controller';
import { RampPortalController } from './ramp-portal.controller';
import { RampPortalService } from './ramp-portal.service';
import { RampPortalActionsController } from './ramp-portal-actions.controller';
import { RampPortalActionsService } from './ramp-portal-actions.service';
import { RampPortalIdempotency } from './ramp-portal.idempotency';
import { RampOnchainHistoryService } from './ramp.onchain-history';
import { RampRatesAdminController } from './ramp-rates.admin.controller';
import { RampRatesService } from './ramp-rates.service';

/**
 * BANJEE WhatsApp USDC ↔ NGN on/off-ramp + Naira pay (bank send) + bills.
 *
 * Platform-level (not tenant-scoped). Separate from the Phase-4 WhatsApp module.
 */
@Module({
  imports: [forwardRef(() => PaymentsModule), WalletModule, BillsModule, AuthModule, RewardsModule],
  controllers: [
    RampWebhookController,
    RampPortalController,
    RampPortalActionsController,
    RampRatesAdminController,
  ],
  providers: [
    RampStoreService,
    RampWhatsAppService,
    RampStellarWalletService,
    RampCeloWalletService,
    RampOnboardingService,
    RampNairaService,
    RampBillsService,
    RampUtilityChatService,
    RampIntentService,
    RampCommandsService,
    RampCeloWatcher,
    RampStellarWatcher,
    RampBankSendWatcher,
    RampTxNotifyDedupe,
    RampOnchainHistoryService,
    RampPortalService,
    RampPortalActionsService,
    RampPortalIdempotency,
    RampRatesService,
  ],
  exports: [
    RampNairaService,
    RampWhatsAppService,
    RampBillsService,
    RampPortalService,
    RampRatesService,
  ],
})
export class RampModule {}

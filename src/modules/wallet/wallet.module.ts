import { Module } from '@nestjs/common';

import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

/**
 * Customer balances and the ledger.
 *
 * `WalletService` is exported because the payments module credits wallets from
 * funding webhooks. That dependency points *into* this module through its public
 * service — the payments module never reaches for the ledger tables directly,
 * which is what keeps "money only moves through one code path" true.
 */
@Module({
  controllers: [WalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}

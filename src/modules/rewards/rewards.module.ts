import { Module } from '@nestjs/common';

import { RewardsController } from './rewards.controller';
import { RewardsService } from './rewards.service';

/**
 * BANJEE Points and referrals.
 *
 * Depends only on the database, so auth and the ramp can both import it
 * without a cycle.
 */
@Module({
  controllers: [RewardsController],
  providers: [RewardsService],
  exports: [RewardsService],
})
export class RewardsModule {}

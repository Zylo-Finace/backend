import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { HealthController } from './health.controller';

@Module({
  imports: [
    TerminusModule.forRoot({
      // Terminus logs a full stack trace per failed probe by default; at a 5s
      // probe interval a dependency outage buries every other log line.
      logger: false,
    }),
  ],
  controllers: [HealthController],
})
export class HealthModule {}

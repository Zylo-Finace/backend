import { Module } from '@nestjs/common';

import { RampModule } from '../ramp/ramp.module';
import { AccessService } from './access/access.service';
import { ApiKeysController } from './api-keys/api-keys.controller';
import { ApiKeysService } from './api-keys/api-keys.service';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { CustomersController } from './customers/customers.controller';
import { CustomersService } from './customers/customers.service';
import { DashboardController } from './dashboard/dashboard.controller';
import { InvitationsController } from './invitations/invitations.controller';
import { InvitationsService } from './invitations/invitations.service';
import { MembersController } from './members/members.controller';
import { MembersService } from './members/members.service';
import { RolesController } from './roles/roles.controller';
import { RolesService } from './roles/roles.service';
import { SessionsController } from './sessions/sessions.controller';
import { TeamsController } from './teams/teams.controller';
import { TeamsService } from './teams/teams.service';
import { TransactionsController } from './transactions/transactions.controller';
import { WorkspaceController } from './workspace/workspace.controller';

@Module({
  imports: [RampModule],
  controllers: [
    DashboardController,
    WorkspaceController,
    MembersController,
    RolesController,
    TeamsController,
    InvitationsController,
    ApiKeysController,
    SessionsController,
    CustomersController,
    TransactionsController,
    AuditController,
  ],
  providers: [
    AccessService,
    AuditService,
    MembersService,
    RolesService,
    TeamsService,
    InvitationsService,
    ApiKeysService,
    CustomersService,
  ],
  exports: [AccessService, AuditService],
})
export class AdminModule {}

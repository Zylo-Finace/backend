import { Injectable } from '@nestjs/common';
import { MessageDirection, MessageStatus, UserType } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';

import { ActorType, RequestContext } from '../../core/context/request-context';
import { Phone } from '../../core/utils/phone.util';
import { InjectPrisma } from '../../infrastructure/database/prisma.module';
import {
  PrismaService,
  type ExtendedPrismaClient,
} from '../../infrastructure/database/prisma.service';
import { MetricsService } from '../../infrastructure/observability/metrics.service';
import type { InboundMessage, ParsedWebhook, StatusUpdate } from './webhook-parser';

export interface IngestResult {
  messagesStored: number;
  messagesDuplicate: number;
  statusesApplied: number;
  unroutable: number;
}

/**
 * Ingests inbound messages and delivery statuses.
 *
 * ## Idempotency
 *
 * Meta redelivers a webhook whenever it does not get a 2xx quickly enough, and
 * duplicate delivery is routine rather than exceptional. Every write here is
 * therefore keyed on `wamid` and guarded by `@@unique([tenantId, wamid])`: a
 * redelivered batch updates nothing and reports itself as duplicate.
 *
 * ## Tenant resolution
 *
 * A webhook arrives with no tenant — only Meta's `phone_number_id`. That is
 * resolved to a registered business number with an unscoped query (there is no
 * tenant yet to scope by), and everything after that runs inside a normal
 * tenant-scoped context.
 *
 * ## Failure isolation
 *
 * One malformed message must not discard the whole batch. Each item is processed
 * independently and failures are logged and counted, because returning non-2xx
 * would make Meta redeliver *every* message in the batch, including the ones
 * already stored.
 */
@Injectable()
export class InboundService {
  constructor(
    @InjectPrisma() private readonly db: ExtendedPrismaClient,
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
    private readonly metrics: MetricsService,
  ) {
    this.logger.setContext(InboundService.name);
  }

  async ingest(parsed: ParsedWebhook): Promise<IngestResult> {
    const result: IngestResult = {
      messagesStored: 0,
      messagesDuplicate: 0,
      statusesApplied: 0,
      unroutable: 0,
    };

    for (const message of parsed.messages) {
      try {
        const stored = await this.storeMessage(message);
        if (stored === 'stored') result.messagesStored += 1;
        else if (stored === 'duplicate') result.messagesDuplicate += 1;
        else result.unroutable += 1;
      } catch (error) {
        // Swallowed deliberately: see the class note on failure isolation.
        result.unroutable += 1;
        this.logger.error(
          { err: error, wamid: message.wamid, phoneNumberId: message.phoneNumberId },
          'Failed to store an inbound message',
        );
      }
    }

    for (const status of parsed.statuses) {
      try {
        if (await this.applyStatus(status)) result.statusesApplied += 1;
      } catch (error) {
        this.logger.error({ err: error, wamid: status.wamid }, 'Failed to apply a delivery status');
      }
    }

    return result;
  }

  /** Stores one inbound message, creating or updating its conversation. */
  private async storeMessage(
    message: InboundMessage,
  ): Promise<'stored' | 'duplicate' | 'unroutable'> {
    const number = await this.resolveNumber(message.phoneNumberId);
    if (!number) {
      // A message for a number we do not manage. Almost always a stale webhook
      // subscription pointing at us after a number was moved.
      this.logger.warn(
        { phoneNumberId: message.phoneNumberId },
        'Inbound message for an unregistered business number',
      );
      return 'unroutable';
    }

    // The sender comes from Meta as digits with no `+`.
    const from = Phone.fromWhatsAppId(message.from);
    if (!from) {
      this.logger.warn({ wamid: message.wamid }, 'Inbound message from an unparseable number');
      return 'unroutable';
    }

    return RequestContext.run(
      {
        tenantId: number.tenantId,
        actorType: ActorType.Webhook,
        correlationId: RequestContext.correlationId,
      },
      async () => {
        const existing = await this.db.message.findFirst({
          where: { wamid: message.wamid },
          select: { id: true },
        });

        if (existing) return 'duplicate';

        // Link the thread to a registered customer when the number matches one.
        // Nullable by design: strangers message businesses all the time.
        const user = await this.db.user.findFirst({
          where: { phoneE164: from, type: UserType.CUSTOMER },
          select: { id: true },
        });

        const preview = (message.text ?? `[${message.type.toLowerCase()}]`).slice(0, 280);

        const conversation = await this.db.conversation.upsert({
          where: {
            phoneNumberId_contactPhoneE164: {
              phoneNumberId: number.id,
              contactPhoneE164: from,
            },
          },
          create: {
            tenantId: number.tenantId,
            phoneNumberId: number.id,
            contactPhoneE164: from,
            contactName: message.profileName,
            userId: user?.id,
            lastInboundAt: message.timestamp,
            lastMessageAt: message.timestamp,
            lastMessagePreview: preview,
            unreadCount: 1,
          },
          update: {
            // This is the field the 24-hour service window is measured from,
            // so it must be advanced on *every* inbound message.
            lastInboundAt: message.timestamp,
            lastMessageAt: message.timestamp,
            lastMessagePreview: preview,
            unreadCount: { increment: 1 },
            // Profile names change; keep the latest. Never used for identity.
            ...(message.profileName ? { contactName: message.profileName } : {}),
            ...(user?.id ? { userId: user.id } : {}),
          },
          select: { id: true },
        });

        await this.db.message.create({
          data: {
            tenantId: number.tenantId,
            conversationId: conversation.id,
            phoneNumberId: number.id,
            wamid: message.wamid,
            direction: MessageDirection.INBOUND,
            type: message.type,
            // Inbound messages are terminal on arrival: they are already delivered.
            status: MessageStatus.DELIVERED,
            text: message.text,
            replyToWamid: message.replyToWamid,
            payload: message.raw as never,
            createdAt: message.timestamp,
          },
        });

        this.metrics.messagesTotal.inc({
          direction: 'inbound',
          type: message.type.toLowerCase(),
          status: 'received',
        });

        return 'stored';
      },
    );
  }

  /**
   * Applies a delivery status to a message we sent.
   *
   * Statuses can arrive out of order — `read` before `delivered` is common — so
   * the update never regresses the lifecycle: a message already marked READ is
   * not walked back to DELIVERED by a late callback.
   */
  private async applyStatus(status: StatusUpdate): Promise<boolean> {
    const message = await RequestContext.runAsSystem({}, async () =>
      this.prisma.message.findFirst({
        where: { wamid: status.wamid },
        select: { id: true, tenantId: true, status: true },
      }),
    );

    if (!message) return false;

    if (RANK[status.status] <= RANK[message.status]) {
      return false;
    }

    return RequestContext.run(
      { tenantId: message.tenantId, actorType: ActorType.Webhook },
      async () => {
        await this.db.message.update({
          where: { id: message.id },
          data: {
            status: status.status,
            ...(status.status === MessageStatus.DELIVERED ? { deliveredAt: status.timestamp } : {}),
            ...(status.status === MessageStatus.READ ? { readAt: status.timestamp } : {}),
            ...(status.status === MessageStatus.FAILED
              ? {
                  failedAt: status.timestamp,
                  errorCode: status.errorCode,
                  errorTitle: status.errorTitle?.slice(0, 512),
                }
              : {}),
          },
        });

        this.metrics.messagesTotal.inc({
          direction: 'outbound',
          type: 'status',
          status: status.status.toLowerCase(),
        });

        return true;
      },
    );
  }

  /**
   * Maps Meta's phone number id to a registered business number.
   *
   * Unscoped by necessity — discovering the tenant is the point — and keyed on an
   * immutable identifier Meta assigns, not on anything a caller controls.
   */
  private async resolveNumber(
    metaPhoneNumberId: string,
  ): Promise<{ id: string; tenantId: string } | null> {
    return RequestContext.runAsSystem({}, async () =>
      this.prisma.whatsAppPhoneNumber.findFirst({
        where: { phoneNumberId: metaPhoneNumberId, deletedAt: null },
        select: { id: true, tenantId: true },
      }),
    );
  }
}

/**
 * Lifecycle ordering. A status only ever moves forward.
 *
 * Meta does not guarantee callback ordering, and without this a late `delivered`
 * arriving after `read` would make a message that the customer demonstrably read
 * appear merely delivered.
 */
const RANK: Record<MessageStatus, number> = {
  [MessageStatus.PENDING]: 0,
  [MessageStatus.SENT]: 1,
  [MessageStatus.DELIVERED]: 2,
  [MessageStatus.READ]: 3,
  // Terminal and never superseded — a failed message cannot later be delivered.
  [MessageStatus.FAILED]: 4,
};

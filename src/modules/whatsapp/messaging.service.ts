import { Inject, Injectable } from '@nestjs/common';
import { MessageDirection, MessageStatus, MessageType, TemplateStatus } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';
import { RequestContext } from '../../core/context/request-context';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { Phone } from '../../core/utils/phone.util';
import { InjectPrisma } from '../../infrastructure/database/prisma.module';
import type { ExtendedPrismaClient } from '../../infrastructure/database/prisma.service';
import { CryptoService } from '../../infrastructure/security/crypto.service';
import { MetricsService } from '../../infrastructure/observability/metrics.service';
import { CloudApiClient } from './cloud-api.client';

export interface SendTextParams {
  /** Our internal phone-number row id, or omitted to use the tenant's default. */
  phoneNumberId?: string;
  /** Recipient in any format; normalised to E.164 here. */
  to: string;
  text: string;
  /** wamid to quote. */
  replyToWamid?: string;
  /** Client idempotency key — a retried call resends nothing. */
  clientReference?: string;
}

export interface SendTemplateParams {
  phoneNumberId?: string;
  to: string;
  templateName: string;
  language?: string;
  /** Positional body variables, substituted into `{{1}}`, `{{2}}`, … */
  variables?: string[];
  clientReference?: string;
}

export interface SendResult {
  messageId: string;
  wamid?: string;
  status: MessageStatus;
  /** True when an existing message was returned instead of sending again. */
  duplicate: boolean;
}

/**
 * Sending messages, and the rules that govern when we may.
 *
 * ## The 24-hour service window
 *
 * Meta allows free-form messages only within 24 hours of the customer's last
 * message. Outside it, **only an approved template** may be sent.
 *
 * This is enforced *before* calling Meta rather than by reacting to their error.
 * Three reasons: a rejected send still costs a round trip and counts against
 * rate limits; the failure arrives too late to substitute a template cleanly;
 * and repeated policy violations degrade the number's quality rating, which
 * throttles throughput for every customer on it. Meta's rejection remains the
 * backstop — `WHATSAPP_OUTSIDE_SERVICE_WINDOW` is mapped in the client — but it
 * should never be the first line of defence.
 */
@Injectable()
export class MessagingService {
  constructor(
    @InjectPrisma() private readonly db: ExtendedPrismaClient,
    private readonly client: CloudApiClient,
    private readonly crypto: CryptoService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
    private readonly metrics: MetricsService,
  ) {
    this.logger.setContext(MessagingService.name);
  }

  /** Sends a free-form text message. Requires an open service window. */
  async sendText(params: SendTextParams): Promise<SendResult> {
    const to = Phone.normalizeOrThrow(params.to);
    const number = await this.resolveNumber(params.phoneNumberId);
    const conversation = await this.upsertConversation(number.id, to);

    if (!this.isWindowOpen(conversation.lastInboundAt)) {
      throw new AppException(ErrorCode.WHATSAPP_OUTSIDE_SERVICE_WINDOW, {
        message:
          'This customer has not messaged in the last 24 hours. Use an approved template instead.',
        details: {
          lastInboundAt: conversation.lastInboundAt?.toISOString() ?? null,
          windowHours: this.config.whatsapp.serviceWindowHours,
        },
      });
    }

    return this.dispatch({
      number,
      conversationId: conversation.id,
      to,
      type: MessageType.TEXT,
      text: params.text,
      clientReference: params.clientReference,
      body: {
        to: Phone.toWhatsAppId(to),
        type: 'text',
        text: { body: params.text, preview_url: false },
        ...(params.replyToWamid ? { context: { message_id: params.replyToWamid } } : {}),
      },
    });
  }

  /**
   * Sends an approved template. Valid at any time, inside the window or not.
   *
   * The template is validated against our local record first: variable count is
   * checked here so a mismatch is a clear 422 rather than an opaque Meta error,
   * and an unapproved template is refused without a wasted round trip.
   */
  async sendTemplate(params: SendTemplateParams): Promise<SendResult> {
    const to = Phone.normalizeOrThrow(params.to);
    const number = await this.resolveNumber(params.phoneNumberId);
    const language = params.language ?? 'en';
    const variables = params.variables ?? [];

    const template = await this.db.messageTemplate.findFirst({
      where: { phoneNumberId: number.id, name: params.templateName, language },
      select: { status: true, bodyVariableCount: true },
    });

    if (!template) {
      throw AppException.notFound('Template', `${params.templateName}/${language}`);
    }

    if (template.status !== TemplateStatus.APPROVED) {
      throw new AppException(ErrorCode.WHATSAPP_TEMPLATE_NOT_APPROVED, {
        message: `Template "${params.templateName}" is ${template.status.toLowerCase()}, not approved`,
        details: { template: params.templateName, language, status: template.status },
      });
    }

    if (template.bodyVariableCount !== variables.length) {
      throw new AppException(ErrorCode.WHATSAPP_TEMPLATE_PARAM_MISMATCH, {
        message: `Template "${params.templateName}" expects ${template.bodyVariableCount} variables, received ${variables.length}`,
        details: { expected: template.bodyVariableCount, received: variables.length },
      });
    }

    const conversation = await this.upsertConversation(number.id, to);

    return this.dispatch({
      number,
      conversationId: conversation.id,
      to,
      type: MessageType.TEMPLATE,
      text: `[template:${params.templateName}]`,
      templateName: params.templateName,
      clientReference: params.clientReference,
      body: {
        to: Phone.toWhatsAppId(to),
        type: 'template',
        template: {
          name: params.templateName,
          language: { code: language },
          ...(variables.length > 0
            ? {
                components: [
                  {
                    type: 'body',
                    parameters: variables.map((text) => ({ type: 'text', text })),
                  },
                ],
              }
            : {}),
        },
      },
    });
  }

  /** True when a free-form message is currently permitted. */
  isWindowOpen(lastInboundAt: Date | null): boolean {
    if (!lastInboundAt) return false;

    const windowMs = this.config.whatsapp.serviceWindowHours * 60 * 60 * 1000;
    return Date.now() - lastInboundAt.getTime() < windowMs;
  }

  /**
   * Persists the outbound message, calls Meta, then records the outcome.
   *
   * Written **before** the send so that a crash mid-flight leaves a PENDING row
   * to reconcile rather than a message that may or may not have gone out with no
   * trace. The reverse order loses the audit trail exactly when it matters.
   */
  private async dispatch(params: {
    number: { id: string; phoneNumberId: string; accessToken: string };
    conversationId: string;
    to: string;
    type: MessageType;
    text: string;
    templateName?: string;
    clientReference?: string;
    body: Record<string, unknown>;
  }): Promise<SendResult> {
    const tenantId = RequestContext.requireTenantId();

    // Client-side idempotency: a retried API call must not send a second message
    // to the customer.
    if (params.clientReference) {
      const existing = await this.db.message.findFirst({
        where: { clientReference: params.clientReference },
        select: { id: true, wamid: true, status: true },
      });

      if (existing) {
        return {
          messageId: existing.id,
          wamid: existing.wamid ?? undefined,
          status: existing.status,
          duplicate: true,
        };
      }
    }

    const message = await this.db.message.create({
      data: {
        tenantId,
        conversationId: params.conversationId,
        phoneNumberId: params.number.id,
        direction: MessageDirection.OUTBOUND,
        type: params.type,
        status: MessageStatus.PENDING,
        text: params.text,
        templateName: params.templateName,
        clientReference: params.clientReference,
        payload: params.body as never,
      },
      select: { id: true },
    });

    try {
      const response = await this.client.sendMessage(
        params.number.phoneNumberId,
        this.crypto.decrypt(params.number.accessToken),
        params.body,
      );

      const wamid = response.messages?.[0]?.id;

      await this.db.$transaction([
        this.db.message.update({
          where: { id: message.id },
          data: { wamid, status: MessageStatus.SENT, sentAt: new Date() },
        }),
        this.db.conversation.update({
          where: { id: params.conversationId },
          data: {
            lastOutboundAt: new Date(),
            lastMessageAt: new Date(),
            lastMessagePreview: params.text.slice(0, 280),
          },
        }),
      ]);

      this.metrics.messagesTotal.inc({
        direction: 'outbound',
        type: params.type.toLowerCase(),
        status: 'sent',
      });

      return { messageId: message.id, wamid, status: MessageStatus.SENT, duplicate: false };
    } catch (error) {
      const appError = error instanceof AppException ? error : undefined;

      await this.db.message.update({
        where: { id: message.id },
        data: {
          status: MessageStatus.FAILED,
          failedAt: new Date(),
          errorCode:
            typeof appError?.details?.metaCode === 'number' ? appError.details.metaCode : null,
          errorTitle: (appError?.message ?? String(error)).slice(0, 512),
        },
      });

      this.metrics.messagesTotal.inc({
        direction: 'outbound',
        type: params.type.toLowerCase(),
        status: 'failed',
      });

      throw error;
    }
  }

  /** Resolves the sending number, defaulting to the tenant's primary. */
  private async resolveNumber(id?: string): Promise<{
    id: string;
    phoneNumberId: string;
    accessToken: string;
  }> {
    const number = await this.db.whatsAppPhoneNumber.findFirst({
      where: id ? { id } : { isDefault: true, status: 'CONNECTED' },
      select: { id: true, phoneNumberId: true, accessToken: true, status: true },
      orderBy: { createdAt: 'asc' },
    });

    if (!number) {
      throw new AppException(ErrorCode.WHATSAPP_NUMBER_NOT_REGISTERED, {
        message: 'No connected WhatsApp number is available for this workspace',
      });
    }

    if (number.status !== 'CONNECTED') {
      throw new AppException(ErrorCode.WHATSAPP_NUMBER_NOT_REGISTERED, {
        message: 'This WhatsApp number is not connected',
        details: { status: number.status },
      });
    }

    return number;
  }

  /**
   * Finds or creates the thread for a (business number, customer) pair.
   *
   * An upsert rather than find-then-create: two messages arriving concurrently
   * for a new contact would otherwise race, and the unique constraint would fail
   * one of them.
   */
  private async upsertConversation(
    phoneNumberId: string,
    contactPhoneE164: string,
  ): Promise<{ id: string; lastInboundAt: Date | null }> {
    const tenantId = RequestContext.requireTenantId();

    return this.db.conversation.upsert({
      where: { phoneNumberId_contactPhoneE164: { phoneNumberId, contactPhoneE164 } },
      create: { tenantId, phoneNumberId, contactPhoneE164 },
      update: {},
      select: { id: true, lastInboundAt: true },
    });
  }
}

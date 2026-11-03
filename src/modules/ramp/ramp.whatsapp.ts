import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { getRampConfig, resolveWhatsAppPhoneNumberId } from './ramp.config';

const GRAPH = 'https://graph.facebook.com/v21.0';

export interface WhatsAppSendOpts {
  phoneNumberId?: string;
}

export interface InteractiveButtons {
  body: string;
  footer?: string;
  header?: string;
  buttons: { id: string; title: string }[];
}

export interface InteractiveList {
  body: string;
  footer?: string;
  header?: string;
  /** CTA on the message that opens the bottom sheet (max 20 chars). */
  button: string;
  sections: Array<{
    title?: string;
    rows: Array<{ id: string; title: string; description?: string }>;
  }>;
}

export type RampReply =
  | string
  | { type: 'text'; text: string }
  | ({ type: 'buttons' } & InteractiveButtons)
  | ({ type: 'list' } & InteractiveList)
  | {
      type: 'image';
      buffer: Buffer;
      mimeType: 'image/png' | 'image/jpeg';
      filename?: string;
      caption?: string;
    }
  | {
      type: 'flow';
      body: string;
      footer?: string;
      header?: string;
      /** Meta Flow id (numeric string). */
      flowId: string;
      flowToken: string;
      cta: string;
      screen?: string;
      /** First-screen data for the Flow (non-empty). */
      data?: Record<string, unknown>;
    };

export interface InboundMessage {
  from: string;
  id: string;
  timestamp: string;
  contactName: string | null;
  phoneNumberId: string | null;
  text: string;
  buttonId: string | null;
  /** PIN submitted via WhatsApp Flow (nfm_reply), if any. */
  flowPin: string | null;
  /** Onboarding fields from WhatsApp Flow complete payload. */
  flowOnboard: {
    username: string;
    email: string;
    pin: string;
    pinConfirm: string;
  } | null;
}

interface GraphErrorBody {
  error?: { message?: string };
}

@Injectable()
export class RampWhatsAppService {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(RampWhatsAppService.name);
  }

  private async postMessage(
    phoneNumberId: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    const { whatsapp } = getRampConfig();
    if (!whatsapp.token) {
      throw new Error('WHATSAPP_TOKEN is empty — cannot send WhatsApp messages');
    }
    if (!phoneNumberId) {
      throw new Error('phone_number_id missing — cannot send WhatsApp messages');
    }

    const url = `${GRAPH}/${phoneNumberId}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${whatsapp.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
    });

    const data = (await res.json().catch(() => ({}))) as GraphErrorBody;
    if (!res.ok) {
      this.logger.error(
        { status: res.status, data, phoneNumberId },
        '[zylo-ramp] WhatsApp send failed',
      );
      throw new Error(data?.error?.message || `WhatsApp send failed (${res.status})`);
    }
    return data;
  }

  async sendText(to: string, body: string, opts: WhatsAppSendOpts = {}): Promise<unknown> {
    const phoneNumberId = resolveWhatsAppPhoneNumberId(opts.phoneNumberId);
    return this.postMessage(phoneNumberId, {
      to,
      type: 'text',
      text: { preview_url: false, body },
    });
  }

  /**
   * Upload a PNG/JPEG buffer to WhatsApp media, then send as an image message.
   */
  async sendImage(
    to: string,
    image: {
      buffer: Buffer;
      mimeType: 'image/png' | 'image/jpeg';
      filename?: string;
      caption?: string;
    },
    opts: WhatsAppSendOpts = {},
  ): Promise<unknown> {
    const phoneNumberId = resolveWhatsAppPhoneNumberId(opts.phoneNumberId);
    const mediaId = await this.uploadMedia(phoneNumberId, image);
    return this.postMessage(phoneNumberId, {
      to,
      type: 'image',
      image: {
        id: mediaId,
        ...(image.caption ? { caption: image.caption.slice(0, 1024) } : {}),
      },
    });
  }

  private async uploadMedia(
    phoneNumberId: string,
    image: {
      buffer: Buffer;
      mimeType: 'image/png' | 'image/jpeg';
      filename?: string;
    },
  ): Promise<string> {
    const { whatsapp } = getRampConfig();
    if (!whatsapp.token) {
      throw new Error('WHATSAPP_TOKEN is empty — cannot upload media');
    }
    if (!phoneNumberId) {
      throw new Error('phone_number_id missing — cannot upload media');
    }
    if (!image.buffer?.length) {
      throw new Error('empty image buffer — cannot upload media');
    }

    const filename =
      image.filename || (image.mimeType === 'image/jpeg' ? 'image.jpg' : 'image.png');

    // Copy into a fresh Uint8Array — some runtimes reject Buffer views in Blob
    const bytes = new Uint8Array(image.buffer.byteLength);
    bytes.set(image.buffer);

    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', image.mimeType);
    form.append('file', new Blob([bytes], { type: image.mimeType }), filename);

    const url = `${GRAPH}/${phoneNumberId}/media`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${whatsapp.token}` },
      body: form,
    });
    const data = (await res.json().catch(() => ({}))) as GraphErrorBody & { id?: string };
    if (!res.ok || !data.id) {
      this.logger.error(
        { status: res.status, data, phoneNumberId, bytes: image.buffer.length },
        '[zylo-ramp] WhatsApp media upload failed',
      );
      throw new Error(data?.error?.message || `WhatsApp media upload failed (${res.status})`);
    }
    return data.id;
  }

  /**
   * Up to 3 reply buttons. title max 20 chars, id max 256.
   */
  async sendButtons(
    to: string,
    interactive: InteractiveButtons,
    opts: WhatsAppSendOpts = {},
  ): Promise<unknown> {
    const phoneNumberId = resolveWhatsAppPhoneNumberId(opts.phoneNumberId);
    const buttons = (interactive.buttons || []).slice(0, 3).map((b) => ({
      type: 'reply',
      reply: {
        id: String(b.id).slice(0, 256),
        title: String(b.title).slice(0, 20),
      },
    }));

    const payload: Record<string, unknown> = {
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: interactive.body },
        action: { buttons },
        ...(interactive.footer ? { footer: { text: interactive.footer.slice(0, 60) } } : {}),
        ...(interactive.header
          ? { header: { type: 'text', text: interactive.header.slice(0, 60) } }
          : {}),
      },
    };
    return this.postMessage(phoneNumberId, payload);
  }

  /**
   * List message — CTA opens a bottom-sheet picker (like Xara “Get started”).
   * Button max 20 chars; row title 24; description 72; up to 10 rows.
   */
  async sendList(to: string, list: InteractiveList, opts: WhatsAppSendOpts = {}): Promise<unknown> {
    const phoneNumberId = resolveWhatsAppPhoneNumberId(opts.phoneNumberId);
    const sections = (list.sections || []).slice(0, 10).map((section) => ({
      ...(section.title ? { title: String(section.title).slice(0, 24) } : {}),
      rows: (section.rows || []).slice(0, 10).map((row) => ({
        id: String(row.id).slice(0, 200),
        title: String(row.title).slice(0, 24),
        ...(row.description ? { description: String(row.description).slice(0, 72) } : {}),
      })),
    }));

    return this.postMessage(phoneNumberId, {
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: list.body.slice(0, 1024) },
        action: {
          button: String(list.button || 'Menu').slice(0, 20),
          sections,
        },
        ...(list.footer ? { footer: { text: list.footer.slice(0, 60) } } : {}),
        ...(list.header ? { header: { type: 'text', text: list.header.slice(0, 60) } } : {}),
      },
    });
  }

  /**
   * WhatsApp Flow (in-chat popup form). Requires a published Flow id in Meta.
   * Use TextInput input-type=passcode so PIN is hidden from chat summary.
   */
  async sendFlow(
    to: string,
    flow: {
      body: string;
      footer?: string;
      header?: string;
      flowId: string;
      flowToken: string;
      cta: string;
      screen?: string;
      /** Optional non-empty first-screen data. Empty objects are rejected by Meta (#131009). */
      data?: Record<string, unknown>;
    },
    opts: WhatsAppSendOpts = {},
  ): Promise<unknown> {
    const phoneNumberId = resolveWhatsAppPhoneNumberId(opts.phoneNumberId);
    const payload: Record<string, unknown> = {
      screen: flow.screen || 'PIN',
    };
    // Meta: data must be omitted or a non-empty object — `{}` → (#131009)
    if (flow.data && Object.keys(flow.data).length > 0) {
      payload.data = flow.data;
    }
    const parameters: Record<string, unknown> = {
      flow_message_version: '3',
      flow_token: flow.flowToken.slice(0, 200),
      flow_id: flow.flowId,
      flow_cta: flow.cta.slice(0, 30),
      flow_action: 'navigate',
      flow_action_payload: payload,
    };
    // Draft Flows (not published yet) need mode=draft for the owner to test
    if (process.env.WA_RAMP_FLOW_MODE === 'draft') {
      parameters.mode = 'draft';
    }
    return this.postMessage(phoneNumberId, {
      to,
      type: 'interactive',
      interactive: {
        type: 'flow',
        body: { text: flow.body.slice(0, 1024) },
        action: { name: 'flow', parameters },
        ...(flow.footer ? { footer: { text: flow.footer.slice(0, 60) } } : {}),
        ...(flow.header ? { header: { type: 'text', text: flow.header.slice(0, 60) } } : {}),
      },
    });
  }

  /** Dispatch text or button replies from the command layer. */
  async dispatchReplies(
    to: string,
    replies: RampReply | RampReply[] | null | undefined,
    opts: WhatsAppSendOpts = {},
  ): Promise<void> {
    const list = Array.isArray(replies) ? replies : replies ? [replies] : [];
    for (const reply of list) {
      if (!reply) continue;
      if (typeof reply === 'string') {
        await this.sendText(to, reply, opts);
        continue;
      }
      if (reply.type === 'text') {
        await this.sendText(to, reply.text, opts);
        continue;
      }
      if (reply.type === 'image') {
        try {
          await this.sendImage(to, reply, opts);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn({ err: message }, '[zylo-ramp] image send failed — skipping QR');
          if (reply.caption) {
            await this.sendText(to, reply.caption, opts);
          }
        }
        continue;
      }
      if (reply.type === 'buttons') {
        try {
          await this.sendButtons(to, reply, opts);
        } catch (err) {
          // Buttons sometimes fail (session / format); still answer the user.
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn({ err: message }, '[zylo-ramp] buttons failed — falling back to text');
          const titles = (reply.buttons || []).map((b) => b.title).join(' / ');
          await this.sendText(
            to,
            [reply.header, reply.body, reply.footer, titles ? `(${titles})` : '']
              .filter(Boolean)
              .join('\n'),
            opts,
          );
        }
        continue;
      }
      if (reply.type === 'list') {
        try {
          await this.sendList(to, reply, opts);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn({ err: message }, '[zylo-ramp] list failed — falling back to text');
          const rows = (reply.sections || [])
            .flatMap((s) => s.rows || [])
            .map((r) => `• ${r.title}`)
            .join('\n');
          await this.sendText(
            to,
            [reply.header, reply.body, reply.footer, rows].filter(Boolean).join('\n'),
            opts,
          );
        }
        continue;
      }
      if (reply.type === 'flow') {
        try {
          await this.sendFlow(to, reply, opts);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn({ err: message }, '[zylo-ramp] flow send failed — PIN via chat');
          await this.sendText(
            to,
            [reply.body, '', 'Enter your 4-digit PIN to confirm (or cancel):'].join('\n'),
            opts,
          );
        }
        continue;
      }
    }
  }

  extractInboundMessages(payload: unknown): InboundMessage[] {
    const out: InboundMessage[] = [];
    const root = payload as {
      entry?: Array<{
        changes?: Array<{
          value?: {
            messages?: Array<{
              from: string;
              id: string;
              timestamp: string;
              type?: string;
              text?: { body?: string };
              interactive?: {
                type?: string;
                button_reply?: { id?: string; title?: string };
                list_reply?: { id?: string; title?: string };
                nfm_reply?: {
                  response_json?: string;
                  body?: string;
                  name?: string;
                };
              };
            }>;
            metadata?: { phone_number_id?: string };
            contacts?: Array<{ profile?: { name?: string } }>;
          };
        }>;
      }>;
    };

    for (const entry of root?.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (!value?.messages) continue;
        const phoneNumberId = value.metadata?.phone_number_id || null;
        const contactName = value.contacts?.[0]?.profile?.name || null;

        for (const msg of value.messages) {
          const base = {
            from: msg.from,
            id: msg.id,
            timestamp: msg.timestamp,
            contactName,
            phoneNumberId,
            text: '',
            buttonId: null as string | null,
            flowPin: null as string | null,
            flowOnboard: null as InboundMessage['flowOnboard'],
          };

          if (msg.type === 'text') {
            out.push({ ...base, text: (msg.text?.body || '').trim() });
            continue;
          }

          if (msg.type === 'interactive') {
            const ir = msg.interactive;
            if (ir?.type === 'button_reply') {
              out.push({
                ...base,
                buttonId: ir.button_reply?.id || null,
                text: (ir.button_reply?.title || '').trim(),
              });
              continue;
            }
            if (ir?.type === 'list_reply') {
              out.push({
                ...base,
                buttonId: ir.list_reply?.id || null,
                text: (ir.list_reply?.title || '').trim(),
              });
              continue;
            }
            if (ir?.type === 'nfm_reply') {
              let flowPin: string | null = null;
              let flowOnboard: InboundMessage['flowOnboard'] = null;
              let buttonId: string | null = null;
              try {
                const parsed = JSON.parse(ir.nfm_reply?.response_json || '{}') as {
                  pin?: unknown;
                  pin_confirm?: unknown;
                  username?: unknown;
                  email?: unknown;
                  flow_token?: unknown;
                };
                const pin =
                  typeof parsed.pin === 'string' || typeof parsed.pin === 'number'
                    ? String(parsed.pin).trim()
                    : '';
                const pinConfirm =
                  typeof parsed.pin_confirm === 'string' || typeof parsed.pin_confirm === 'number'
                    ? String(parsed.pin_confirm).trim()
                    : '';
                const username = typeof parsed.username === 'string' ? parsed.username.trim() : '';
                const email = typeof parsed.email === 'string' ? parsed.email.trim() : '';
                const token = typeof parsed.flow_token === 'string' ? parsed.flow_token : '';

                if (username && email && pin) {
                  flowOnboard = { username, email, pin, pinConfirm: pinConfirm || pin };
                  buttonId = 'onboard_flow_done';
                } else if (pin) {
                  flowPin = pin;
                  buttonId = 'xfer_flow_pin';
                } else if (token.startsWith('zylo_onboard_')) {
                  buttonId = 'onboard_flow_done';
                }
              } catch {
                /* ignore */
              }
              out.push({
                ...base,
                flowPin,
                flowOnboard,
                text: flowOnboard?.username || flowPin || (ir.nfm_reply?.body || '').trim(),
                buttonId,
              });
              continue;
            }
          }
        }
      }
    }
    return out;
  }
}

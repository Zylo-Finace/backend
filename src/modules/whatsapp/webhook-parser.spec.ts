import { createHmac } from 'node:crypto';

import { MessageStatus, MessageType } from '@prisma/client';

import { parseWebhook, verifyMetaSignature } from './webhook-parser';

const APP_SECRET = 'meta-app-secret-value';

const sign = (body: string, secret = APP_SECRET) =>
  `sha256=${createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')}`;

/** A realistic inbound text message envelope. */
function textWebhook(overrides: { wamid?: string; body?: string } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '2348000000000',
                phone_number_id: 'PHONE_NUMBER_ID',
              },
              contacts: [{ profile: { name: 'Adaeze' }, wa_id: '2348012345678' }],
              messages: [
                {
                  from: '2348012345678',
                  id: overrides.wamid ?? 'wamid.HBgMMjM0ODAxMjM0NTY3OA==',
                  timestamp: '1786000000',
                  type: 'text',
                  text: { body: overrides.body ?? 'balance' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('verifyMetaSignature', () => {
  const body = JSON.stringify(textWebhook());

  it('accepts a correctly signed body', () => {
    expect(verifyMetaSignature(Buffer.from(body), sign(body), APP_SECRET)).toBe(true);
  });

  it('rejects a body modified after signing', () => {
    const tampered = body.replace('balance', 'transfer all');
    expect(verifyMetaSignature(Buffer.from(tampered), sign(body), APP_SECRET)).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifyMetaSignature(Buffer.from(body), sign(body, 'other'), APP_SECRET)).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['no algorithm prefix', createHmac('sha256', APP_SECRET).update(body).digest('hex')],
    ['wrong algorithm', `sha1=${createHmac('sha1', APP_SECRET).update(body).digest('hex')}`],
    ['garbage', 'sha256=nonsense'],
  ])('rejects a %s signature', (_label, header) => {
    expect(verifyMetaSignature(Buffer.from(body), header, APP_SECRET)).toBe(false);
  });

  it('fails closed when no app secret is configured', () => {
    // An unconfigured secret must never mean "accept everything".
    expect(verifyMetaSignature(Buffer.from(body), sign(body), '')).toBe(false);
  });

  it('is sensitive to byte-level formatting, proving raw bytes are required', () => {
    // Re-serialising parsed JSON reorders keys and changes whitespace. This is
    // why the controller must use `req.rawBody`.
    const reserialised = JSON.stringify(JSON.parse(body), null, 2);
    expect(verifyMetaSignature(Buffer.from(reserialised), sign(body), APP_SECRET)).toBe(false);
  });
});

describe('parseWebhook', () => {
  describe('inbound messages', () => {
    it('extracts a text message with its sender and profile name', () => {
      const { messages } = parseWebhook(textWebhook());

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        wamid: 'wamid.HBgMMjM0ODAxMjM0NTY3OA==',
        from: '2348012345678',
        phoneNumberId: 'PHONE_NUMBER_ID',
        profileName: 'Adaeze',
        type: MessageType.TEXT,
        text: 'balance',
      });
    });

    it('converts Meta’s Unix-seconds timestamp', () => {
      const { messages } = parseWebhook(textWebhook());
      expect(messages[0]?.timestamp.toISOString()).toBe(new Date(1786000000000).toISOString());
    });

    it('retains the verbatim payload so nothing is lost', () => {
      const { messages } = parseWebhook(textWebhook());
      expect(messages[0]?.raw).toMatchObject({ type: 'text' });
    });

    it('reads every entry and change, not just the first', () => {
      // Meta batches under load. Handling only entry[0].changes[0] silently
      // drops messages exactly when volume is highest.
      const batched = {
        entry: [
          textWebhook({ wamid: 'wamid.A' }).entry[0],
          textWebhook({ wamid: 'wamid.B' }).entry[0],
        ],
      };

      const { messages } = parseWebhook(batched);
      expect(messages.map((message) => message.wamid)).toEqual(['wamid.A', 'wamid.B']);
    });

    it('extracts the title of a tapped interactive reply', () => {
      const payload = {
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: 'PN' },
                  messages: [
                    {
                      from: '2348012345678',
                      id: 'wamid.INT',
                      timestamp: '1786000000',
                      type: 'interactive',
                      interactive: {
                        type: 'button_reply',
                        button_reply: { id: 'check_balance', title: 'Check balance' },
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const { messages } = parseWebhook(payload);
      expect(messages[0]?.type).toBe(MessageType.INTERACTIVE);
      expect(messages[0]?.text).toBe('Check balance');
    });

    it('captures a media caption as the message text', () => {
      const payload = {
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: 'PN' },
                  messages: [
                    {
                      from: '2348012345678',
                      id: 'wamid.IMG',
                      timestamp: '1786000000',
                      type: 'image',
                      image: { id: 'MEDIA_ID', caption: 'my receipt', mime_type: 'image/jpeg' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const { messages } = parseWebhook(payload);
      expect(messages[0]?.type).toBe(MessageType.IMAGE);
      expect(messages[0]?.text).toBe('my receipt');
    });

    it('preserves a message type it does not model', () => {
      // Meta adds types without notice. Dropping them would lose customer
      // messages; UNSUPPORTED keeps the payload for later interpretation.
      const payload = {
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: 'PN' },
                  messages: [
                    {
                      from: '2348012345678',
                      id: 'wamid.NEW',
                      timestamp: '1786000000',
                      type: 'some_future_type',
                      some_future_type: { data: 'x' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const { messages } = parseWebhook(payload);
      expect(messages[0]?.type).toBe(MessageType.UNSUPPORTED);
      expect(messages[0]?.raw).toMatchObject({ type: 'some_future_type' });
    });

    it('captures the quoted message id on a reply', () => {
      const payload = {
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: 'PN' },
                  messages: [
                    {
                      from: '2348012345678',
                      id: 'wamid.REPLY',
                      timestamp: '1786000000',
                      type: 'text',
                      text: { body: 'yes' },
                      context: { id: 'wamid.ORIGINAL' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      expect(parseWebhook(payload).messages[0]?.replyToWamid).toBe('wamid.ORIGINAL');
    });
  });

  describe('delivery statuses', () => {
    const statusWebhook = (status: string, errors?: unknown[]) => ({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'PN' },
                statuses: [
                  {
                    id: 'wamid.SENT',
                    status,
                    timestamp: '1786000100',
                    recipient_id: '2348012345678',
                    ...(errors ? { errors } : {}),
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    it.each([
      ['sent', MessageStatus.SENT],
      ['delivered', MessageStatus.DELIVERED],
      ['read', MessageStatus.READ],
      ['failed', MessageStatus.FAILED],
    ])('maps the %s callback', (raw, expected) => {
      const { statuses } = parseWebhook(statusWebhook(raw));
      expect(statuses[0]?.status).toBe(expected);
    });

    it('captures the error detail on a failure', () => {
      const { statuses } = parseWebhook(
        statusWebhook('failed', [{ code: 131047, title: 'Re-engagement message' }]),
      );

      expect(statuses[0]?.errorCode).toBe(131047);
      expect(statuses[0]?.errorTitle).toBe('Re-engagement message');
    });

    it('ignores a status value it does not recognise', () => {
      expect(parseWebhook(statusWebhook('deleted')).statuses).toHaveLength(0);
    });
  });

  describe('robustness', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['empty object', {}],
      ['a string', 'nonsense'],
      ['entry not an array', { entry: 'x' }],
      ['change with no value', { entry: [{ changes: [{}] }] }],
      ['value with no metadata', { entry: [{ changes: [{ value: {} }] }] }],
    ])('returns empty lists for %s rather than throwing', (_label, payload) => {
      // Throwing would mean a non-2xx, which makes Meta redeliver the batch
      // forever and eventually disable the subscription.
      expect(() => parseWebhook(payload)).not.toThrow();
      expect(parseWebhook(payload)).toEqual({ messages: [], statuses: [] });
    });

    it('skips a message missing its id or sender', () => {
      const payload = {
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: 'PN' },
                  messages: [{ type: 'text', text: { body: 'orphan' } }],
                },
              },
            ],
          },
        ],
      };

      expect(parseWebhook(payload).messages).toHaveLength(0);
    });

    it('falls back to the current time for a malformed timestamp', () => {
      const payload = {
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: 'PN' },
                  messages: [
                    { from: '2348012345678', id: 'wamid.X', timestamp: 'bad', type: 'text' },
                  ],
                },
              },
            ],
          },
        ],
      };

      const timestamp = parseWebhook(payload).messages[0]?.timestamp;
      // An Invalid Date would fail at the database insert instead.
      expect(timestamp?.getTime()).not.toBeNaN();
    });
  });
});

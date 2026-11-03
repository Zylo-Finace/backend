import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { parseNairaBankSendPhrase } from './ramp.bank-parse';
import { getRampConfig } from './ramp.config';

/** Actionable + conversational intents for free-text WhatsApp messages. */
export type RampIntentName =
  | 'send'
  | 'sell'
  | 'buy'
  | 'balance'
  | 'rates'
  | 'airtime'
  | 'data'
  | 'wallet'
  | 'history'
  | 'settings'
  | 'cancel'
  | 'general'
  | 'ambiguous'
  | 'unknown';

export type RampCurrency = 'usdc' | 'xlm' | 'ngn' | 'celo';

export type RampParsedIntent = {
  intent: RampIntentName;
  confidence: number;
  amount?: number | null;
  currency?: RampCurrency | null;
  recipient?: string | null;
  /** Network hint when user said stellar/celo explicitly */
  chain?: 'stellar' | 'celo' | null;
  /** For airtime: mtn / airtel / glo / 9mobile */
  network?: string | null;
  /** Naira bank send: 10-digit account when user named it in free text */
  bankAccount?: string | null;
  /** Naira bank send: bank name query (e.g. Opay) */
  bankQuery?: string | null;
  /** Clarifying options when intent === ambiguous */
  alternatives?: Array<{
    intent: RampIntentName;
    label: string;
    amount?: number | null;
    recipient?: string | null;
    currency?: RampCurrency | null;
  }>;
  /** Raw classifier source */
  source: 'llm' | 'regex' | 'none';
};

const STELLAR_ADDR = /\b([GC][A-Z0-9]{55})\b/i;
const CELO_ADDR = /\b(0x[a-fA-F0-9]{40})\b/;

function llmConfigured(): boolean {
  const key = (process.env.WA_RAMP_LLM_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  if (!key) return false;
  if (/^(0|false|no|off)$/i.test(String(process.env.WA_RAMP_INTENT_LLM || 'true'))) {
    return false;
  }
  return true;
}

function llmEndpoint(): { url: string; key: string; model: string } {
  const key = (process.env.WA_RAMP_LLM_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  const base = (
    process.env.WA_RAMP_LLM_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    'https://api.openai.com/v1'
  ).replace(/\/$/, '');
  const model = process.env.WA_RAMP_LLM_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  return { url: `${base}/chat/completions`, key, model };
}

function parseLooseAmount(raw: string): { amount: number; currency: RampCurrency | null } | null {
  const text = raw.trim();
  // ₦5,000 / 5000 naira / 5000 ngn
  const ngn = text.match(
    /(?:₦|ngn|naira)\s*([\d,]+(?:\.\d+)?)|([\d,]+(?:\.\d+)?)\s*(?:₦|ngn|naira)/i,
  );
  if (ngn) {
    const n = Number(String(ngn[1] || ngn[2] || '').replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) return { amount: Math.round(n * 100) / 100, currency: 'ngn' };
  }
  const usdc = text.match(
    /([\d,]+(?:\.\d+)?)\s*(usdc|usdt|usd|xlm|celo)\b|\b(usdc|usdt|usd|xlm|celo)\s*([\d,]+(?:\.\d+)?)/i,
  );
  if (usdc) {
    const n = Number(String(usdc[1] || usdc[4] || '').replace(/,/g, ''));
    const cur = String(usdc[2] || usdc[3] || 'usdc').toLowerCase();
    if (!Number.isFinite(n) || n <= 0) return null;
    const currency: RampCurrency = cur === 'xlm' ? 'xlm' : cur === 'celo' ? 'celo' : 'usdc';
    return { amount: Math.round(n * 1e6) / 1e6, currency };
  }
  const bare = text.match(/\b([\d,]+(?:\.\d+)?)\b/);
  if (bare) {
    const n = Number(String(bare[1]).replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) return { amount: Math.round(n * 1e6) / 1e6, currency: null };
  }
  return null;
}

function extractRecipient(raw: string): string | null {
  const stellar = raw.match(STELLAR_ADDR);
  if (stellar?.[1]) return stellar[1].toUpperCase();
  const celo = raw.match(CELO_ADDR);
  if (celo?.[1]) return celo[1];
  const toNamed = raw.match(
    /\b(?:to|for)\s+(@?[a-zA-Z][a-zA-Z0-9_]{1,19}|mum|mom|dad|daddy|mama|papa)\b/i,
  );
  if (toNamed?.[1]) return toNamed[1].replace(/^@/, '');
  // "send james 2 usdc" / "pay jaiboi 2usdc"
  const sendNamed = raw.match(
    /\b(?:send|pay|transfer)\s+(?:my\s+)?(@?[a-zA-Z][a-zA-Z0-9_]{1,19}|mum|mom|dad)\b/i,
  );
  if (sendNamed?.[1]) {
    const name = sendNamed[1];
    if (!/^(usdc|xlm|celo|ngn|naira)$/i.test(name)) return name.replace(/^@/, '');
  }
  // "2 usdc james" / "james 2 usdc"
  const afterAmt = raw.match(
    /\b[\d,]+(?:\.\d+)?\s*(?:usdc|xlm|celo)\s+(@?[a-zA-Z][a-zA-Z0-9_]{1,19})\b/i,
  );
  if (afterAmt?.[1] && !/^(usdc|xlm|celo|ngn|naira)$/i.test(afterAmt[1])) {
    return afterAmt[1].replace(/^@/, '');
  }
  const beforeAmt = raw.match(
    /\b(@?[a-zA-Z][a-zA-Z0-9_]{1,19})\s+[\d,]+(?:\.\d+)?\s*(?:usdc|xlm|celo)\b/i,
  );
  if (beforeAmt?.[1] && !/^(send|pay|transfer|sell|buy|usdc|xlm|celo)$/i.test(beforeAmt[1])) {
    return beforeAmt[1].replace(/^@/, '');
  }
  return null;
}

/**
 * Regex / NER hybrid — used when LLM is off or as a fast path / fallback.
 */
export function classifyIntentRegex(raw: string): RampParsedIntent {
  const text = String(raw || '').trim();
  const lower = text.toLowerCase().replace(/\s+/g, ' ');
  if (!lower) return { intent: 'unknown', confidence: 0, source: 'regex' };

  if (/^(cancel|stop|never\s*mind|nevermind|abort)$/i.test(lower)) {
    return { intent: 'cancel', confidence: 0.99, source: 'regex' };
  }

  const amt = parseLooseAmount(text);
  const recipient = extractRecipient(text);
  const chain = /\bcelo\b/i.test(text) ? 'celo' : /\bstellar\b/i.test(text) ? 'stellar' : null;

  // Ambiguous: "2 usdc james" / "james 2 usdc" without send/sell verb
  if (
    amt &&
    recipient &&
    !/\b(send|pay|transfer|sell|cash\s*out|withdraw|convert|buy)\b/i.test(lower)
  ) {
    return {
      intent: 'ambiguous',
      confidence: 0.55,
      amount: amt.amount,
      currency: amt.currency || 'usdc',
      recipient,
      source: 'regex',
      alternatives: [
        {
          intent: 'send',
          label: `Send to ${recipient}`,
          amount: amt.amount,
          recipient,
          currency: amt.currency || 'usdc',
        },
        {
          intent: 'sell',
          label: `Sell ${amt.amount} USDC`,
          amount: amt.amount,
          currency: 'usdc',
        },
      ],
    };
  }

  if (
    /\b(what'?s?\s+my\s+balance|how\s+much\s+do\s+i\s+have|check\s+balance|my\s+balance|how\s+much\s+usdc)\b/i.test(
      lower,
    ) ||
    lower === 'balance'
  ) {
    return { intent: 'balance', confidence: 0.95, source: 'regex' };
  }

  if (
    /\b(what'?s?\s+the\s+rate|usdc\s+to\s+naira|how\s+much\s+is\s+usdc|exchange\s+rate|rates?\b)/i.test(
      lower,
    ) ||
    lower === 'rate' ||
    lower === 'rates'
  ) {
    return { intent: 'rates', confidence: 0.93, source: 'regex' };
  }

  if (
    /\b(my\s+wallet\s+address|show\s+my\s+address|stellar\s+address|what'?s?\s+my\s+(stellar\s+)?address|wallet\s+address)\b/i.test(
      lower,
    )
  ) {
    return { intent: 'wallet', confidence: 0.93, chain, source: 'regex' };
  }

  if (
    /\b(show\s+my\s+transactions|last\s+transfer|transfer\s+status|did\s+my\s+transfer|transaction\s+history|history)\b/i.test(
      lower,
    ) ||
    lower === 'status'
  ) {
    return { intent: 'history', confidence: 0.9, source: 'regex' };
  }

  if (
    /\b(change\s+my\s+bank|update\s+pin|add\s+bank|save\s+\w+\s+as\s+contact|payout\s+account|settings)\b/i.test(
      lower,
    )
  ) {
    return { intent: 'settings', confidence: 0.88, recipient, source: 'regex' };
  }

  if (/\b(buy\s+data|1\s*gb|data\s+bundle|data\s+plan)\b/i.test(lower)) {
    return {
      intent: 'data',
      confidence: 0.9,
      amount: amt?.amount ?? null,
      currency: amt?.currency ?? 'ngn',
      network: /\b(mtn|airtel|glo|9mobile|etisalat)\b/i.exec(lower)?.[1]?.toLowerCase() || null,
      source: 'regex',
    };
  }

  if (/\b(buy\s+airtime|top\s*up\s+\d|topup|recharge(\s+my\s+phone)?|airtime)\b/i.test(lower)) {
    return {
      intent: 'airtime',
      confidence: 0.9,
      amount: amt?.amount ?? null,
      currency: amt?.currency ?? 'ngn',
      network: /\b(mtn|airtel|glo|9mobile|etisalat)\b/i.exec(lower)?.[1]?.toLowerCase() || null,
      source: 'regex',
    };
  }

  if (
    /\b(sell|cash\s*out|withdraw|convert)\b/i.test(lower) &&
    (/\b(usdc|usd|naira|ngn|bank)\b/i.test(lower) || amt)
  ) {
    const amount = amt?.amount ?? null;
    let currency: RampCurrency | null = amt?.currency ?? 'usdc';
    // "5000 naira worth of usdc" → treat as NGN notional for sell sizing later
    if (/\bworth\b/i.test(lower) && amt?.currency === 'ngn') {
      currency = 'ngn';
    }
    return {
      intent: 'sell',
      confidence: 0.92,
      amount,
      currency,
      chain,
      source: 'regex',
    };
  }

  if (
    /\b(buy|top\s*up\s+my\s+wallet|i\s+want\s+to\s+buy)\b/i.test(lower) &&
    /\b(usdc|usd|wallet)\b/i.test(lower)
  ) {
    return {
      intent: 'buy',
      confidence: 0.9,
      amount: amt?.amount ?? null,
      currency: amt?.currency ?? 'usdc',
      chain,
      source: 'regex',
    };
  }

  if (/\b(send|pay|transfer)\b/i.test(lower)) {
    // "send my mum 5000 naira worth of usdc" stays a crypto transfer (NGN notional).
    const amount = amt?.amount ?? null;
    let currency: RampCurrency | null = amt?.currency ?? 'usdc';
    if (/\bnaira\s+worth\b/i.test(lower) || /\bworth\s+of\s+usdc\b/i.test(lower)) {
      if (amt?.currency === 'ngn' || /\bnaira|ngn|₦/.test(lower)) currency = 'ngn';
      return {
        intent: 'send',
        confidence: recipient || amount ? 0.92 : 0.75,
        amount,
        currency,
        recipient,
        chain,
        source: 'regex',
      };
    }

    // "Send 300 naira to 9078426686 OPay" → Naira bank send, not USDC wallet send.
    const bankSend = parseNairaBankSendPhrase(text);
    if (
      bankSend &&
      (amt?.currency === 'ngn' || bankSend.amountNgn != null || bankSend.accountNumber)
    ) {
      return {
        intent: 'send',
        confidence: 0.94,
        amount: bankSend.amountNgn ?? amount,
        currency: 'ngn',
        recipient: null,
        bankAccount: bankSend.accountNumber,
        bankQuery: bankSend.bankQuery,
        chain,
        source: 'regex',
      };
    }

    return {
      intent: 'send',
      confidence: recipient || amount ? 0.92 : 0.75,
      amount,
      currency,
      recipient,
      chain,
      source: 'regex',
    };
  }

  // General Q&A heuristics
  if (
    /\b(what\s+is|what'?s|how\s+does|is\s+(this|my|zylo)|why\s+is|are\s+you|fees?|insured|safe|explain)\b/i.test(
      lower,
    )
  ) {
    return { intent: 'general', confidence: 0.7, source: 'regex' };
  }

  return { intent: 'unknown', confidence: 0.2, amount: amt?.amount, recipient, source: 'regex' };
}

function asStr(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function normalizeLlmIntent(data: Record<string, unknown>): RampParsedIntent {
  const intentRaw = asStr(data.intent, 'unknown').toLowerCase();
  const allowed: RampIntentName[] = [
    'send',
    'sell',
    'buy',
    'balance',
    'rates',
    'airtime',
    'data',
    'wallet',
    'history',
    'settings',
    'cancel',
    'general',
    'ambiguous',
    'unknown',
  ];
  const intent = (
    allowed.includes(intentRaw as RampIntentName) ? intentRaw : 'unknown'
  ) as RampIntentName;
  const amount = data.amount == null || data.amount === '' ? null : Number(data.amount);
  const currencyRaw = data.currency == null ? null : asStr(data.currency).toLowerCase();
  const currency = (
    ['usdc', 'xlm', 'ngn', 'celo'].includes(currencyRaw || '') ? currencyRaw : null
  ) as RampCurrency | null;
  const alternatives = Array.isArray(data.alternatives)
    ? data.alternatives
        .map((a) => {
          if (!a || typeof a !== 'object') return null;
          const o = a as Record<string, unknown>;
          const i = asStr(o.intent).toLowerCase() as RampIntentName;
          if (!allowed.includes(i) || i === 'ambiguous' || i === 'unknown') return null;
          return {
            intent: i,
            label: asStr(o.label, i).slice(0, 24),
            amount: o.amount == null ? null : Number(o.amount),
            recipient: o.recipient == null ? null : asStr(o.recipient),
            currency: (o.currency == null
              ? null
              : asStr(o.currency).toLowerCase()) as RampCurrency | null,
          };
        })
        .filter((x): x is NonNullable<typeof x> => Boolean(x))
        .slice(0, 3)
    : undefined;

  const recipientStr = asStr(data.recipient);
  const networkStr = asStr(data.network);
  return {
    intent,
    confidence: Math.max(0, Math.min(1, Number(data.confidence) || 0.7)),
    amount: Number.isFinite(amount) && (amount as number) > 0 ? amount : null,
    currency,
    recipient: recipientStr || null,
    chain: data.chain === 'celo' || data.chain === 'stellar' ? data.chain : null,
    network: networkStr ? networkStr.toLowerCase() : null,
    alternatives,
    source: 'llm',
  };
}

@Injectable()
export class RampIntentService {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(RampIntentService.name);
  }

  /**
   * Classify free text. Prefers LLM when configured; always merges with regex
   * for amount/recipient extraction robustness.
   */
  async classify(raw: string): Promise<RampParsedIntent> {
    const regex = classifyIntentRegex(raw);
    if (!llmConfigured()) return regex;

    // Free-text Naira→bank (account + bank name) is unambiguous — don't let the LLM
    // reclassify it as a USDC wallet send to a "username".
    if (regex.currency === 'ngn' && (regex.bankAccount || regex.bankQuery)) {
      return regex;
    }

    try {
      const llm = await this.classifyWithLlm(raw);
      // Prefer LLM intent; keep regex amount/recipient if LLM omitted them
      return {
        ...llm,
        amount: llm.amount ?? regex.amount ?? null,
        currency: llm.currency ?? regex.currency ?? null,
        recipient: llm.recipient ?? regex.recipient ?? null,
        chain: llm.chain ?? regex.chain ?? null,
        network: llm.network ?? regex.network ?? null,
        bankAccount: llm.bankAccount ?? regex.bankAccount ?? null,
        bankQuery: llm.bankQuery ?? regex.bankQuery ?? null,
        alternatives: llm.alternatives?.length ? llm.alternatives : regex.alternatives,
        confidence: Math.max(llm.confidence, regex.confidence * 0.5),
      };
    } catch (e) {
      this.logger.warn(
        { err: e instanceof Error ? e.message : String(e) },
        '[zylo-ramp] intent LLM failed — using regex',
      );
      return regex;
    }
  }

  private async classifyWithLlm(raw: string): Promise<RampParsedIntent> {
    const { url, key, model } = llmEndpoint();
    const system = `You classify WhatsApp messages for BANJEE, a Nigerian WhatsApp USDC↔NGN finance bot on Stellar/Celo.
Return ONLY compact JSON:
{"intent":"send|sell|buy|balance|rates|airtime|data|wallet|history|settings|cancel|general|ambiguous|unknown","confidence":0-1,"amount":number|null,"currency":"usdc|xlm|ngn|celo"|null,"recipient":string|null,"chain":"stellar|celo"|null,"network":"mtn|airtel|glo|9mobile"|null,"alternatives":[{"intent":"...","label":"...","amount":n,"recipient":"s","currency":"usdc"}]|null}

Rules:
- send: pay/transfer crypto to a person or address
- sell: cash out USDC to NGN bank
- buy: buy USDC with NGN
- general: questions about BANJEE/USDC/fees/safety — NOT an action
- ambiguous: could be send OR sell (e.g. "2 usdc james") — fill alternatives
- recipient: username, contact nickname, or G…/0x… address only
- amount: number only; currency separate (naira/ngn/₦ → ngn)
- Do not invent recipients`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: raw.slice(0, 500) },
        ],
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return normalizeLlmIntent(parsed);
  }

  /** Conversational Q&A — no flow entry. */
  async answerGeneral(question: string): Promise<string> {
    const config = getRampConfig();
    const footer = '\n\nWant me to do something? Reply with what you’d like to do.';

    if (!llmConfigured()) {
      return (
        [
          `${config.brandName} lets you hold USDC on Stellar (and optional Celo), send to friends, sell to Naira, buy airtime/data, and check rates — all in WhatsApp.`,
          'USDC is a US-dollar stablecoin. Transfers need your PIN. Bank payouts use your saved account.',
          'Fees: sell fee is shown on the quote; network fees on Stellar sends are covered by BANJEE when possible.',
        ].join(' ') + footer
      );
    }

    try {
      const { url, key, model } = llmEndpoint();
      const system = `You are BANJEE's helpful WhatsApp assistant for a Nigerian USDC↔NGN finance product on Stellar (primary) and Celo.
Answer briefly (2–5 short sentences), plainly, no markdown tables.
Facts you may use: custodial WhatsApp wallets; PIN before sends/sells; sell USDC→NGN to saved bank; buy USDC; airtime/data; rates shown in-app; not a bank; funds are crypto custody not NDIC-insured bank deposits; never ask for seed phrases.
If unsure, say so. Do not invent balances or tx status.
End EXACTLY with: Want me to do something? Reply with what you'd like to do.`;

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          temperature: 0.4,
          max_tokens: 280,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: question.slice(0, 600) },
          ],
        }),
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      let answer = (data.choices?.[0]?.message?.content || '').trim();
      if (!answer) throw new Error('empty answer');
      if (!/want me to do something/i.test(answer)) {
        answer = `${answer}${footer}`;
      }
      return answer.slice(0, 3500);
    } catch (e) {
      this.logger.warn(
        { err: e instanceof Error ? e.message : String(e) },
        '[zylo-ramp] general Q&A LLM failed',
      );
      return (
        `${config.brandName} is a WhatsApp USDC wallet for sending, selling to Naira, and top-ups. Ask about a balance, send, sell, or rates — or say what you want to do.` +
        footer
      );
    }
  }
}

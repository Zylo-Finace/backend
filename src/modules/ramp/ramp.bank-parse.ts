/**
 * Parse free-text NGN payout details for WhatsApp.
 * Accepts:
 *   bank Opay 0123456789 Jane Doe
 *   Opay 0123456789 Jane Doe
 */

export type ParsedBankDetails = {
  bankQuery: string;
  accountNumber: string;
  /** Name the user typed (may differ from name-enquiry). */
  accountNameHint: string;
};

export type ParseBankDetailsResult =
  { ok: true; value: ParsedBankDetails } | { ok: false; error: string };

/** Free-text “send ₦X to &lt;account&gt; &lt;bank&gt;” from chat. */
export type ParsedNairaBankSend = {
  amountNgn: number | null;
  accountNumber: string | null;
  bankQuery: string | null;
};

/**
 * Detect a Naira→bank send in free text (not “naira worth of USDC” crypto).
 * Examples:
 *   Send 300 naira to 9078426686 OPay
 *   transfer 5000 ngn to Opay 9078426686
 *   pay ₦2,000 to 0123456789 GTBank
 */
export function parseNairaBankSendPhrase(raw: string): ParsedNairaBankSend | null {
  const text = String(raw || '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!text) return null;
  if (/\bnaira\s+worth\b|\bworth\s+of\s+usdc\b/i.test(text)) return null;
  if (!/\b(send|pay|transfer)\b/i.test(text)) return null;

  const looksNaira =
    /\b(naira|ngn)\b/i.test(text) ||
    /₦/.test(text) ||
    /\b(to\s+bank|bank\s+transfer|to\s+opay|to\s+palmpay)\b/i.test(text);
  if (!looksNaira) return null;

  const amountMatch = text.match(/(?:₦|ngn|naira)\s*([\d,]+)|([\d,]+)\s*(?:₦|ngn|naira)/i);
  const amountRaw = amountMatch?.[1] || amountMatch?.[2];
  const amountNgn = amountRaw ? Math.round(Number(String(amountRaw).replace(/,/g, ''))) : null;
  const amount =
    amountNgn != null && Number.isFinite(amountNgn) && amountNgn > 0 ? amountNgn : null;

  // … to 9078426686 OPay   OR   … to OPay 9078426686
  const acctThenBank = text.match(/\bto\s+(\d{10})\s+([A-Za-z][A-Za-z0-9 .&'-]{1,40})\s*$/i);
  const bankThenAcct = text.match(/\bto\s+([A-Za-z][A-Za-z0-9 .&'-]{1,40}?)\s+(\d{10})\s*$/i);

  let accountNumber: string | null = null;
  let bankQuery: string | null = null;
  if (acctThenBank?.[1] && acctThenBank[2]) {
    accountNumber = acctThenBank[1];
    bankQuery = acctThenBank[2].trim().replace(/[.,]+$/, '');
  } else if (bankThenAcct?.[1] && bankThenAcct[2]) {
    bankQuery = bankThenAcct[1].trim().replace(/[.,]+$/, '');
    accountNumber = bankThenAcct[2];
  } else {
    const looseAcct = text.match(/\b(\d{10})\b/);
    if (looseAcct?.[1]) accountNumber = looseAcct[1];
    const afterTo = text.match(/\bto\s+(.+)$/i)?.[1]?.trim();
    if (afterTo) {
      const withoutDigits = afterTo.replace(/\d{10}/, '').trim();
      if (withoutDigits.length >= 2) bankQuery = withoutDigits.replace(/[.,]+$/, '');
    }
  }

  if (bankQuery && /^(naira|ngn|usdc|usd)$/i.test(bankQuery)) bankQuery = null;

  return { amountNgn: amount, accountNumber, bankQuery };
}

export function parseBankDetailsInput(raw: string): ParseBankDetailsResult {
  let text = String(raw || '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!text) {
    return {
      ok: false,
      error:
        'No bank details received. Send: bank <bank> <10-digit account> <account name>\ne.g. bank Opay 0123456789 Jane Doe',
    };
  }

  // Optional leading "bank" keyword
  text = text.replace(/^bank\s+/i, '');

  // bank name … account digits … account name
  const m = text.match(/^(.+?)\s+(\d{6,14})\s+(.+)$/);
  if (!m?.[1] || !m[2] || !m[3]) {
    return {
      ok: false,
      error:
        'Couldn’t read that format. Send: bank <bank> <10-digit account> <account name>\ne.g. bank Opay 0123456789 Jane Doe',
    };
  }

  const bankQuery = m[1].trim();
  const digits = m[2].replace(/\D/g, '');
  const accountNameHint = m[3].trim();

  if (!bankQuery) {
    return {
      ok: false,
      error: 'Missing bank name. Example: bank Opay 0123456789 Jane Doe',
    };
  }
  if (!/^\d{10}$/.test(digits)) {
    return {
      ok: false,
      error: `Account number must be 10 digits — got ${digits.length}. Please resend as: bank <bank> <account_number> <account_name>`,
    };
  }
  if (accountNameHint.length < 2) {
    return {
      ok: false,
      error: 'Missing account name. Example: bank Opay 0123456789 Jane Doe',
    };
  }

  return {
    ok: true,
    value: {
      bankQuery,
      accountNumber: digits,
      accountNameHint,
    },
  };
}

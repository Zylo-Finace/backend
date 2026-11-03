import { BillOrderStatus } from './bills-provider.interface';

/**
 * ClubKonnect's status codes, mapped to our vocabulary.
 *
 * ## Why this is an explicit table rather than a range check
 *
 * The obvious implementation — "2xx means done, 5xx means cancelled" — is wrong
 * in exactly the cases that cost money. `299` sits in the completed band but
 * means *unspecified error after the completion stage*; `412` sits in the error
 * band but means the order was put on hold and will be retried. Reading either
 * by its leading digit produces a confident, incorrect answer: the first refunds
 * a customer who may have been served, the second refunds one whose order is
 * still live and about to be.
 *
 * So every code the provider documents is listed, and anything unlisted becomes
 * {@link BillOrderStatus.Unknown} — the status that forces a reconciliation
 * rather than a guess.
 *
 * Source: ClubKonnect "Status Codes / Dispute Resolution" reference.
 */
const STATUS_BY_CODE: Readonly<Record<string, BillOrderStatus>> = {
  // -- Received --------------------------------------------------------------
  '100': BillOrderStatus.Pending,
  // "Unspecified error while receiving the order" — the order may or may not
  // exist upstream. Not a failure we can act on.
  '199': BillOrderStatus.Unknown,

  // -- Completed -------------------------------------------------------------
  '200': BillOrderStatus.Completed,
  // Delivered, but the network never acknowledged within 60s. ClubKonnect keeps
  // retrying for an hour before cancelling, so this is not yet terminal.
  '201': BillOrderStatus.Processing,
  '299': BillOrderStatus.Unknown,

  // -- Processing ------------------------------------------------------------
  '300': BillOrderStatus.Processing,
  '399': BillOrderStatus.Unknown,

  // -- Errors ----------------------------------------------------------------
  // 400-411, 413-418 are rejections before delivery: nothing was sent, so a
  // refund is safe and immediate.
  '400': BillOrderStatus.Failed, // INVALID_CREDENTIALS
  '401': BillOrderStatus.Failed, // MISSING_CREDENTIALS
  '402': BillOrderStatus.Failed, // MISSING_USERID
  '403': BillOrderStatus.Failed, // MISSING_APIKEY
  '404': BillOrderStatus.Failed, // MISSING_MOBILENETWORK
  '405': BillOrderStatus.Failed, // MISSING_AMOUNT
  '406': BillOrderStatus.Failed, // INVALID_AMOUNT
  '407': BillOrderStatus.Failed, // MINIMUM_100
  '408': BillOrderStatus.Failed, // MINIMUM_50000
  '409': BillOrderStatus.Failed, // INVALID_RECIPIENT
  '410': BillOrderStatus.Failed, // INVALID_API_ERROR1
  '411': BillOrderStatus.Failed, // INVALID_API_ERROR2
  // The exception in this band: "unsuccessful and placed on hold; will be
  // retried periodically". Live, not failed.
  '412': BillOrderStatus.OnHold, // INSUFFICIENT_APIAMOUNT
  '413': BillOrderStatus.Failed, // INVALID_API
  '414': BillOrderStatus.Failed, // INVALID_PAYMENT_OPTION
  '415': BillOrderStatus.Failed, // INSUFFICIENT_APISTOREDEALERAMOUNT
  '416': BillOrderStatus.Failed, // INSUFFICIENT_APISTOREAMOUNT
  '417': BillOrderStatus.Failed, // INSUFFICIENT_BALANCE
  '418': BillOrderStatus.Failed, // INVALID_MOBILENETWORK
  '499': BillOrderStatus.Unknown,

  // -- Cancelled -------------------------------------------------------------
  '500': BillOrderStatus.Cancelled,
  '501': BillOrderStatus.Cancelled,
  '506': BillOrderStatus.Cancelled,
  '507': BillOrderStatus.Cancelled,
  '508': BillOrderStatus.Cancelled,
  '509': BillOrderStatus.Cancelled,
  '510': BillOrderStatus.Cancelled,
  '511': BillOrderStatus.Cancelled,
  '512': BillOrderStatus.Cancelled,
  '513': BillOrderStatus.Cancelled,
  '514': BillOrderStatus.Cancelled,
  '515': BillOrderStatus.Cancelled,
  '516': BillOrderStatus.Cancelled,
  '517': BillOrderStatus.Cancelled,
  '518': BillOrderStatus.Cancelled,
  '519': BillOrderStatus.Cancelled,
  '520': BillOrderStatus.Cancelled,
  '521': BillOrderStatus.Cancelled,
  '599': BillOrderStatus.Unknown,

  // -- On hold ---------------------------------------------------------------
  // The provider retries these itself. Refunding here would double-serve the
  // customer when the retry lands.
  '600': BillOrderStatus.OnHold,
  '601': BillOrderStatus.OnHold,
  '602': BillOrderStatus.OnHold,
  '603': BillOrderStatus.OnHold,
  '604': BillOrderStatus.OnHold,
  '605': BillOrderStatus.OnHold,
  '606': BillOrderStatus.OnHold,
  '699': BillOrderStatus.Unknown,
};

/** Human-readable remarks for the codes a customer or an operator will actually see. */
const REMARK_BY_CODE: Readonly<Record<string, string>> = {
  '100': 'Order received and awaiting processing',
  '200': 'Transaction completed successfully',
  '201': 'Completed, awaiting network confirmation',
  '300': 'Awaiting a response from the network',
  '400': 'Invalid provider credentials',
  '406': 'The amount is not valid for this product',
  '409': 'The recipient details were rejected',
  '412': 'Placed on hold upstream and will be retried',
  '417': 'The provider account has insufficient balance',
  '418': 'Invalid mobile network',
  '508': 'The provider could not process this request',
  '511': 'The transaction failed at the network',
  '516': 'The recipient is not a valid subscriber',
  '517': 'The recipient is not eligible for this offer',
  '518': 'The subscriber is not eligible for this data plan',
  '519': 'An existing plan is still awaiting activation',
  '520': 'The recipient is not on the selected network',
  '521': 'The order is already completed, cancelled or refunded',
};

/**
 * Maps a provider status code to ours.
 *
 * An unrecognised code is {@link BillOrderStatus.Unknown}, never a guess. A code
 * we have not seen is precisely the case where guessing is least defensible.
 */
export function toBillOrderStatus(code: string | undefined): BillOrderStatus {
  if (!code) return BillOrderStatus.Unknown;
  return STATUS_BY_CODE[code.trim()] ?? BillOrderStatus.Unknown;
}

/** A presentable explanation for a code, when we have one. */
export function remarkForCode(code: string | undefined): string | undefined {
  return code ? REMARK_BY_CODE[code.trim()] : undefined;
}

/**
 * Error strings ClubKonnect returns as a bare body instead of JSON, typically
 * when the credentials themselves are wrong. Recognising them turns an
 * unparseable response into a specific, actionable error.
 */
export const CREDENTIAL_ERROR_BODIES: ReadonlySet<string> = new Set([
  'INVALID_CREDENTIALS',
  'MISSING_CREDENTIALS',
  'MISSING_USERID',
  'MISSING_APIKEY',
]);

/**
 * Sentinel values the verification endpoints return in the `customer_name`
 * field, where a *failed* lookup still arrives with a 200 and a success-shaped
 * body. Treating these as a name would print "INVALID_METERNO" to a customer as
 * though it were theirs, and let the order proceed.
 */
export function isVerificationFailure(customerName: string): boolean {
  const normalised = customerName.trim().toUpperCase();
  return (
    normalised === '' ||
    normalised.startsWith('INVALID') ||
    normalised.startsWith('ERROR') ||
    normalised.includes('NOT_FOUND') ||
    normalised.includes('NOT FOUND')
  );
}

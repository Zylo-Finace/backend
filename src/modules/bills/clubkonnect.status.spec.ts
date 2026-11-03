import { BillOrderStatus, isRefundableBillStatus } from './bills-provider.interface';
import { isVerificationFailure, remarkForCode, toBillOrderStatus } from './clubkonnect.status';

describe('ClubKonnect status mapping', () => {
  describe('the codes a naive range check gets wrong', () => {
    // These four are the entire reason the mapping is a table. Each one sits in a
    // band whose leading digit implies the opposite of what it means.
    it('does not treat 299 as completed, despite the 2xx band', () => {
      // "Unspecified error after completion stage" — we do not know if the
      // customer was served, so we must not settle *or* refund.
      expect(toBillOrderStatus('299')).toBe(BillOrderStatus.Unknown);
      expect(isRefundableBillStatus(toBillOrderStatus('299'))).toBe(false);
    });

    it('does not treat 412 as failed, despite the 4xx band', () => {
      // Placed on hold and retried upstream. Refunding here double-serves the
      // customer when the retry lands.
      expect(toBillOrderStatus('412')).toBe(BillOrderStatus.OnHold);
      expect(isRefundableBillStatus(toBillOrderStatus('412'))).toBe(false);
    });

    it('does not treat 201 as terminal, despite meaning ORDER_COMPLETED', () => {
      // No network response after 60s; ClubKonnect retries for an hour before
      // cancelling. The outcome can still change.
      expect(toBillOrderStatus('201')).toBe(BillOrderStatus.Processing);
    });

    it('treats every 6xx hold as non-refundable', () => {
      for (const code of ['600', '601', '602', '603', '604', '605', '606']) {
        expect(toBillOrderStatus(code)).toBe(BillOrderStatus.OnHold);
        expect(isRefundableBillStatus(toBillOrderStatus(code))).toBe(false);
      }
    });
  });

  describe('the ordinary cases', () => {
    it('maps 100 to pending and 200 to completed', () => {
      expect(toBillOrderStatus('100')).toBe(BillOrderStatus.Pending);
      expect(toBillOrderStatus('200')).toBe(BillOrderStatus.Completed);
    });

    it('maps pre-delivery rejections to failed, which is safe to refund', () => {
      for (const code of ['400', '406', '409', '417', '418']) {
        expect(toBillOrderStatus(code)).toBe(BillOrderStatus.Failed);
        expect(isRefundableBillStatus(toBillOrderStatus(code))).toBe(true);
      }
    });

    it('maps the cancellation band to cancelled', () => {
      for (const code of ['500', '511', '516', '521']) {
        expect(toBillOrderStatus(code)).toBe(BillOrderStatus.Cancelled);
        expect(isRefundableBillStatus(toBillOrderStatus(code))).toBe(true);
      }
    });

    it('tolerates surrounding whitespace, which the provider sometimes sends', () => {
      expect(toBillOrderStatus(' 200 ')).toBe(BillOrderStatus.Completed);
    });
  });

  describe('codes we have never seen', () => {
    it.each([['777'], ['abc'], [''], [undefined]])(
      'maps %p to Unknown rather than guessing',
      (code) => {
        expect(toBillOrderStatus(code)).toBe(BillOrderStatus.Unknown);
      },
    );

    it('never reports an unmapped code as refundable', () => {
      // A provider that adds a code must not be able to trigger refunds by
      // accident.
      expect(isRefundableBillStatus(toBillOrderStatus('987'))).toBe(false);
    });
  });

  it('supplies presentable wording for the codes a customer will see', () => {
    expect(remarkForCode('200')).toMatch(/completed/i);
    expect(remarkForCode('520')).toMatch(/network/i);
    expect(remarkForCode('999')).toBeUndefined();
  });
});

describe('verification failure detection', () => {
  // The trap: these all arrive as HTTP 200 in the `customer_name` field, exactly
  // where a real name would be.
  it.each([
    ['INVALID_METERNO'],
    ['INVALID_SMARTCARDNO'],
    ['Error, Invalid Customer ID'],
    ['invalid_meterno'],
    [''],
    ['   '],
    ['ACCOUNT_NOT_FOUND'],
  ])('treats %p as a failed lookup, not a name', (value) => {
    expect(isVerificationFailure(value)).toBe(true);
  });

  it.each([['BALOGUN SUNDAY'], ['BALOGUN SUNDAY (BKwise)'], ['ADAEZE OKONKWO LIV LADORITE']])(
    'treats %p as a real customer name',
    (value) => {
      expect(isVerificationFailure(value)).toBe(false);
    },
  );
});

import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-code.enum';

/**
 * A keyset cursor: the sort key of the last row plus its id as a tiebreaker.
 * The id is required — sort keys like `createdAt` are not unique, and without a
 * tiebreaker rows sharing a timestamp are skipped or repeated across pages.
 */
export interface CursorPayload {
  /** Serialised sort-key value (ISO timestamp, numeric string, …). */
  readonly k: string;
  /** Row id — the unique tiebreaker. */
  readonly i: string;
}

/**
 * Encodes/decodes opaque pagination cursors.
 *
 * base64url of a compact JSON object. Deliberately opaque so clients cannot build
 * cursors by hand and pin us to today's sort key; we can change the internal shape
 * without breaking them. It is *encoded, not encrypted* — the cursor is never a
 * security boundary, and every query it feeds is still tenant-scoped server-side.
 */
export const Cursor = {
  encode(payload: CursorPayload): string {
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  },

  decode(cursor: string): CursorPayload {
    try {
      const json = Buffer.from(cursor, 'base64url').toString('utf8');
      const parsed: unknown = JSON.parse(json);

      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof (parsed as CursorPayload).k !== 'string' ||
        typeof (parsed as CursorPayload).i !== 'string'
      ) {
        throw new Error('Malformed cursor payload');
      }
      return parsed as CursorPayload;
    } catch (cause) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: 'Invalid pagination cursor',
        details: { field: 'cursor' },
        cause,
      });
    }
  },

  /** Convenience for the common `(createdAt, id)` keyset. */
  fromDate(date: Date, id: string): string {
    return Cursor.encode({ k: date.toISOString(), i: id });
  },

  toDate(cursor: string): { date: Date; id: string } {
    const { k, i } = Cursor.decode(cursor);
    const date = new Date(k);
    if (Number.isNaN(date.getTime())) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: 'Invalid pagination cursor',
        details: { field: 'cursor' },
      });
    }
    return { date, id: i };
  },
} as const;

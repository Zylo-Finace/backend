import { Injectable } from '@nestjs/common';
import { KycIdentifierType, KycProviderName } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';

import { PayVesselApi, PayVesselClient } from '../payments/payvessel.client';
import {
  type BasicVerificationRequest,
  type BasicVerificationResult,
  type EnhancedVerificationResult,
  type KycVerificationProvider,
  type VerificationCharge,
  VerificationOutcome,
} from './kyc-provider.interface';

/** Every KYC response carries this envelope. */
interface KycEnvelope<T> {
  success?: boolean;
  message?: string;
  data?: T | null;
  charges?: { charged?: boolean; charged_amount?: string };
  /** Present on a 402 instead of `data`. */
  details?: string[];
}

interface BasicData {
  name_match_rlt?: string;
  names_match_percentage?: string;
  birthday_match_rlt?: string;
  gender_match_rlt?: string;
  phone_number_match_rlt?: string;
}

/**
 * Enhanced payloads. BVN and NIN disagree on field names for the same three
 * facts — surname/last_name, birth_date/birthday, telephone_no/phone_number —
 * so both spellings are read and the difference stops here.
 */
interface EnhancedData {
  first_name?: string;
  middle_name?: string;
  last_name?: string;
  surname?: string;
  name_on_card?: string;
  gender?: string;
  birthday?: string;
  birth_date?: string;
  phone_number?: string;
  phone_number_2?: string;
  telephone_no?: string;
  /** Base64 face image. Read only so it can be deliberately dropped. */
  photo?: string;
  error_message?: string;
}

/** Insufficient PayVessel wallet balance. An answer, not a transport failure. */
const PAYMENT_REQUIRED = 402;

/**
 * PayVessel identity verification.
 *
 * ## Two calls, two purposes
 *
 * `verifyBasic` asks "do these details belong to this number?" and returns
 * per-field verdicts. `verifyEnhanced` asks "whose number is this?" and returns
 * the registry record. The KYC service runs enhanced first — the registry's own
 * spelling of a name is what the partner bank will match a permanent account
 * against, so accepting the customer's spelling would mean issuing accounts that
 * the bank later rejects.
 *
 * ## Charging
 *
 * PayVessel bills per lookup **including for a "not found" answer**, which is
 * why the charge is returned rather than swallowed: a customer retrying a typo
 * five times costs real money, and the audit rows are what makes that visible
 * before the invoice does.
 */
@Injectable()
export class PayVesselKycProvider implements KycVerificationProvider {
  readonly name = KycProviderName.PAYVESSEL;

  constructor(
    private readonly client: PayVesselClient,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PayVesselKycProvider.name);
  }

  async verifyBasic(
    type: KycIdentifierType,
    request: BasicVerificationRequest,
  ): Promise<BasicVerificationResult> {
    const field = type === KycIdentifierType.BVN ? 'bvn' : 'nin';

    const response = await this.client.request<KycEnvelope<BasicData>>({
      method: 'POST',
      api: PayVesselApi.Kyc,
      path: `/api/v1/merchant/${field}/basic`,
      body: {
        [field]: request.identifier,
        first_name: request.firstName,
        // Required by the API even when the customer has no middle name. An
        // empty string is the honest encoding of "none"; omitting the key is a
        // 400.
        middle_name: request.middleName ?? '',
        last_name: request.lastName,
        gender: request.gender.toUpperCase(),
        birthday: request.birthday,
        phone_number: request.phoneNumber,
      },
      allowStatuses: [PAYMENT_REQUIRED],
    });

    const charge = readCharge(response.body);

    if (response.status === PAYMENT_REQUIRED) {
      return this.exhausted(response.body, charge, {
        nameMatch: false,
        birthdayMatch: false,
        genderMatch: false,
        phoneMatch: false,
      });
    }

    const data = response.body.data;
    if (response.body.success !== true || !data) {
      return {
        outcome: VerificationOutcome.NotFound,
        nameMatch: false,
        birthdayMatch: false,
        genderMatch: false,
        phoneMatch: false,
        raw: { message: response.body.message ?? null },
        charge,
      };
    }

    const nameMatch = isMatch(data.name_match_rlt);
    const birthdayMatch = isMatch(data.birthday_match_rlt);
    const genderMatch = isMatch(data.gender_match_rlt);
    const phoneMatch = isMatch(data.phone_number_match_rlt);

    return {
      // The *identity* fields decide the outcome. A phone mismatch is common and
      // harmless — people change numbers far more often than they change their
      // date of birth — so it is recorded but does not fail the check on its own.
      outcome:
        nameMatch && birthdayMatch ? VerificationOutcome.Matched : VerificationOutcome.Mismatch,
      nameMatch,
      nameMatchPercent: percent(data.names_match_percentage),
      birthdayMatch,
      genderMatch,
      phoneMatch,
      raw: data as unknown as Record<string, unknown>,
      charge,
    };
  }

  async verifyEnhanced(
    type: KycIdentifierType,
    identifier: string,
  ): Promise<EnhancedVerificationResult> {
    const field = type === KycIdentifierType.BVN ? 'bvn' : 'nin';

    const response = await this.client.request<KycEnvelope<EnhancedData>>({
      method: 'POST',
      api: PayVesselApi.Kyc,
      path: `/api/v1/merchant/${field}/enhanced`,
      body: { [field]: identifier },
      allowStatuses: [PAYMENT_REQUIRED],
    });

    const charge = readCharge(response.body);

    if (response.status === PAYMENT_REQUIRED) {
      this.logger.error(
        { message: response.body.message },
        'PayVessel KYC wallet is empty; verifications are failing',
      );
      return {
        outcome: VerificationOutcome.Failed,
        raw: { message: response.body.message ?? 'insufficient provider balance' },
        charge,
      };
    }

    const data = response.body.data;
    if (response.body.success !== true || !data) {
      return {
        outcome: VerificationOutcome.NotFound,
        raw: { message: response.body.message ?? null },
        charge,
      };
    }

    // NIN enhanced reports a per-record failure in-band rather than by flipping
    // `success`, so an `error_message` with no name is a miss, not a match.
    const lastName = data.last_name ?? data.surname;
    if (!lastName && data.error_message) {
      return {
        outcome: VerificationOutcome.NotFound,
        raw: { message: data.error_message },
        charge,
      };
    }

    // `photo` is dropped here, at the boundary, so no downstream caller can
    // choose to persist it.
    const { photo: _photo, ...safe } = data;

    return {
      outcome: VerificationOutcome.Matched,
      identity: {
        firstName: data.first_name,
        middleName: data.middle_name,
        lastName,
        nameOnCard: data.name_on_card,
        gender: data.gender,
        birthday: data.birthday ?? data.birth_date,
        phoneNumber: data.phone_number ?? data.telephone_no,
        phoneNumber2: data.phone_number_2,
      },
      raw: safe as unknown as Record<string, unknown>,
      charge,
    };
  }

  private exhausted(
    body: KycEnvelope<unknown>,
    charge: VerificationCharge,
    fields: Omit<BasicVerificationResult, 'outcome' | 'raw' | 'charge' | 'nameMatchPercent'>,
  ): BasicVerificationResult {
    this.logger.error(
      { message: body.message },
      'PayVessel KYC wallet is empty; verifications are failing',
    );
    return {
      outcome: VerificationOutcome.Failed,
      ...fields,
      raw: { message: body.message ?? 'insufficient provider balance' },
      charge,
    };
  }
}

/** Provider vocabulary is `MATCH` / `NO_MATCH`, upper-case. */
function isMatch(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().toUpperCase() === 'MATCH';
}

function percent(value: string | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : undefined;
}

function readCharge(body: KycEnvelope<unknown>): VerificationCharge {
  return {
    charged: body.charges?.charged === true,
    amount: typeof body.charges?.charged_amount === 'string' ? body.charges.charged_amount : '0.00',
  };
}

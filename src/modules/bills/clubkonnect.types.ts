/**
 * Verbatim shapes of ClubKonnect's responses.
 *
 * Every field is optional and typed `string` even where it reads as a number.
 * That is not defensiveness for its own sake: this API returns amounts as
 * strings (`"4400.00"`), status codes as strings (`"200"`), omits fields
 * depending on the vertical, and occasionally answers with a bare error word
 * instead of JSON. Typing it as it actually arrives keeps the parsing honest and
 * confines the coercion to one adapter.
 *
 * Nothing outside this module should import these types.
 */

// -- Wallet -------------------------------------------------------------------

export interface CkWalletBalance {
  date?: string;
  id?: string;
  phoneno?: string;
  /** Naira, as a decimal string. */
  balance?: string;
}

// -- Orders -------------------------------------------------------------------

/**
 * The response to placing an order, and to querying one.
 *
 * The two share a shape but not a field set: acceptance returns `status`, while
 * a query returns the richer set including `remark` and `walletbalance`.
 */
export interface CkOrderResponse {
  date?: string;
  orderid?: string;
  requestid?: string;
  statuscode?: string;
  status?: string;
  remark?: string;
  ordertype?: string;
  mobilenetwork?: string;
  mobilenumber?: string;
  customerid?: string;
  amountcharged?: string;
  walletbalance?: string;
  /** Electricity only. */
  meterno?: string;
  /** Electricity only — the prepaid token the customer keys into the meter. */
  metertoken?: string;
}

/** The callback ClubKonnect posts to `CallBackURL`. */
export interface CkCallbackPayload {
  orderdate?: string;
  orderid?: string;
  requestid?: string;
  statuscode?: string;
  orderstatus?: string;
  orderremark?: string;
}

// -- Verification -------------------------------------------------------------

/**
 * Meter, smartcard and betting lookups all answer with this one field — and use
 * it for failures too, carrying values like `INVALID_METERNO`.
 */
export interface CkVerifyResponse {
  customer_name?: string;
}

// -- Catalogues ---------------------------------------------------------------

export interface CkDataProduct {
  PRODUCT_SNO?: string;
  PRODUCT_CODE?: string;
  /** The value to send as `DataPlan`. */
  PRODUCT_ID?: string;
  PRODUCT_NAME?: string;
  /** Naira, as a decimal string. What our float is charged. */
  PRODUCT_AMOUNT?: string;
}

export interface CkNetworkEntry {
  /** Matches the `MobileNetwork` code, e.g. `"01"`. */
  ID?: string;
  PRODUCT?: CkDataProduct[];
}

/** Keyed by network display name: `{ MOBILE_NETWORK: { MTN: [...], Glo: [...] } }`. */
export interface CkDataPlansResponse {
  MOBILE_NETWORK?: Record<string, CkNetworkEntry[]>;
}

export interface CkCablePackage {
  /** The value to send as `Package`. */
  PACKAGE_ID?: string;
  PACKAGE_NAME?: string;
  /** Bouquet list price, naira decimal string. */
  PACKAGE_AMOUNT?: string;
  /** Price after the reseller discount — what the float is actually charged. */
  PRODUCT_DISCOUNT_AMOUNT?: string;
  PRODUCT_DISCOUNT?: string;
  MINAMOUNT?: number | string;
  MAXAMOUNT?: number | string;
}

export interface CkCableEntry {
  /** Matches the `CableTV` code, e.g. `"dstv"`. */
  ID?: string;
  PRODUCT?: CkCablePackage[];
}

/** Keyed by provider display name: `{ TV_ID: { DStv: [...], GOtv: [...] } }`. */
export interface CkCablePackagesResponse {
  TV_ID?: Record<string, CkCableEntry[]>;
}

export interface CkElectricityProduct {
  /** `"01"` prepaid, `"02"` postpaid — the `MeterType` value. */
  PRODUCT_ID?: string;
  PRODUCT_TYPE?: string;
  PRODUCT_DISCOUNT_AMOUNT?: string;
  PRODUCT_DISCOUNT?: string;
  MINAMOUNT?: number | string;
  MAXAMOUNT?: number | string;
}

export interface CkDiscoEntry {
  /** The value to send as `ElectricCompany`, e.g. `"02"`. */
  ID?: string;
  NAME?: string;
  PRODUCT?: CkElectricityProduct[];
}

/** Keyed by disco slug: `{ ELECTRIC_COMPANY: { IKEJA_ELECTRIC: [...] } }`. */
export interface CkDiscosResponse {
  ELECTRIC_COMPANY?: Record<string, CkDiscoEntry[]>;
}

export interface CkBettingCompany {
  /** The value to send as `BettingCompany`, e.g. `"product-bet-king"`. */
  PRODUCT_CODE?: string;
  PRODUCT_NAME?: string;
  DISCOUNT_AMOUNT?: string;
  DISCOUNT?: string;
  MINAMOUNT?: number | string;
  MAXAMOUNT?: number | string;
}

export interface CkBettingResponse {
  BETTING_COMPANY?: CkBettingCompany[];
}

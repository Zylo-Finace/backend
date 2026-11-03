/**
 * Comparing identity records to each other.
 *
 * Two separate jobs live here, and they have different tolerances on purpose:
 *
 *  - **Tier 1** compares what the customer *typed* (phone, date of birth)
 *    against what the BVN registry holds. Both are single, unambiguous values,
 *    so the comparison is exact once formatting is normalised.
 *  - **Tier 2** compares two *registries* against each other. Names are the hard
 *    part: NIMC and the BVN database frequently disagree about middle names,
 *    hyphenation and which name is the surname, for the same person. An exact
 *    rule there rejects a large fraction of genuine customers, so names are
 *    scored and thresholded while gender and date of birth stay exact.
 */

/** A name split into comparable tokens. */
export interface NameParts {
  firstName?: string | null;
  middleName?: string | null;
  lastName?: string | null;
}

/**
 * Similarity between two full names, 0–100.
 *
 * ## The algorithm and why this one
 *
 * Tokens are compared as a *set*, not as an ordered string. Nigerian registries
 * disagree about field order often enough that "DOE JOHN" and "JOHN DOE" must
 * score 100 — a positional comparison would call that a 0% match and reject a
 * genuine customer.
 *
 * Each token from the **shorter** name is greedily paired with its best unused
 * match in the longer one, using an edit-distance ratio so that "ADEBAYO" and
 * "ADEBAYO" score 1.0 while "ADEBAYO" and "ADEBAYOO" still score 0.875. The mean
 * of those pairings is the result.
 *
 * Scoring against the shorter name is the deliberate choice: a NIN record
 * holding "JOHN DOE" where the BVN holds "JOHN ADEBAYO DOE" is the single most
 * common shape of a legitimate mismatch, and dividing by the longer name would
 * cap it at 67% and fail it. The looseness that admits is bounded — the extra
 * tokens are the *registry's*, not the customer's, and gender and date of birth
 * must still match exactly for the comparison to pass at all.
 *
 * A name whose shorter side has two or more tokens cannot reach the threshold on
 * a first-name match alone: one perfect and one failed pairing averages 50%.
 */
export function nameSimilarity(a: string, b: string): number {
  const left = tokenise(a);
  const right = tokenise(b);

  if (left.length === 0 || right.length === 0) return 0;

  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  const available = [...longer];

  let total = 0;
  for (const token of shorter) {
    let bestRatio = 0;
    let bestIndex = -1;

    for (const [index, candidate] of available.entries()) {
      const ratio = similarityRatio(token, candidate);
      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestIndex = index;
      }
    }

    // Consumed, so two tokens of the same name cannot both match one token of
    // the other — "JOHN JOHN" vs "JOHN DOE" must not score 100.
    if (bestIndex >= 0) available.splice(bestIndex, 1);
    total += bestRatio;
  }

  return Math.round((total / shorter.length) * 100);
}

/** Joins the parts of a registry record into one comparable name. */
export function joinName(parts: NameParts): string {
  return [parts.firstName, parts.middleName, parts.lastName]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(' ');
}

/**
 * Whether two registry genders agree.
 *
 * Exact after normalisation. Registries hold `MALE`/`FEMALE`, occasionally
 * abbreviated to a single letter. A record missing the field entirely is treated
 * as *not* matching: an absent value is not agreement, and quietly passing on
 * missing data is how a comparison stops comparing anything.
 */
export function genderMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normaliseGender(a);
  const right = normaliseGender(b);
  return left !== null && right !== null && left === right;
}

/** Whether two dates of birth are the same calendar day, UTC. */
export function dateOfBirthMatches(
  a: Date | null | undefined,
  b: Date | null | undefined,
): boolean {
  if (!a || !b) return false;
  return toIsoDate(a) === toIsoDate(b);
}

/**
 * Whether a supplied phone number is one of the numbers on the registry record.
 *
 * Compared on the last nine digits: `08012345678`, `2348012345678` and
 * `+234 801 234 5678` are the same line, and a customer typing any of the three
 * is not making a mistake. Nine rather than ten because the national trunk `0`
 * is dropped in the international form, leaving `8012345678` against
 * `8012345678` — taking the last nine keeps the comparison stable whichever way
 * either side stored it.
 */
export function phoneMatches(
  supplied: string,
  candidates: Array<string | null | undefined>,
): boolean {
  const target = phoneKey(supplied);
  if (!target) return false;

  return candidates.some((candidate) => {
    const key = phoneKey(candidate);
    return key !== null && key === target;
  });
}

/** `YYYY-MM-DD` → `Date` at UTC midnight. Anything else is rejected, not guessed. */
export function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Rejects `2024-02-31`, which `Date` would silently roll forward to March.
  return toIsoDate(parsed) === value ? parsed : null;
}

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ===========================================================================
//  Internals
// ===========================================================================

/** Uppercase alphabetic tokens. Punctuation, titles and initials-only noise go. */
function tokenise(name: string): string[] {
  return (
    name
      .toUpperCase()
      // Hyphens and apostrophes join name parts rather than separating them:
      // "OLU-SEGUN" and "OLUSEGUN" should be one token, and identical.
      .replace(/['’-]/g, '')
      .replace(/[^A-Z\s]/g, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      // Single letters are initials. They carry almost no signal and would drag a
      // mean down or prop it up depending on which side has them, so they are
      // dropped from both sides rather than matched.
      .filter((token) => token.length > 1)
  );
}

/** 0–1 edit-distance ratio between two tokens. */
function similarityRatio(a: string, b: string): number {
  if (a === b) return 1;
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return Math.max(0, 1 - levenshtein(a, b) / longest);
}

/**
 * Levenshtein distance, two rows rather than a full matrix.
 *
 * Names are short, so the saving is not the point — bounded allocation on a
 * request path is.
 */
function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, substitution);
    }
    [previous, current] = [current, previous];
  }

  return previous[b.length]!;
}

export function normaliseGender(value: string | null | undefined): string | null {
  const text = (value ?? '').trim().toUpperCase();
  if (text.startsWith('M')) return 'MALE';
  if (text.startsWith('F')) return 'FEMALE';
  return null;
}

/** Last nine digits, or null when there are not enough to be a phone number. */
function phoneKey(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : null;
}

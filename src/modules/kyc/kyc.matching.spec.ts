import {
  dateOfBirthMatches,
  genderMatches,
  joinName,
  nameSimilarity,
  parseIsoDate,
  phoneMatches,
} from './kyc.matching';

describe('nameSimilarity', () => {
  it('scores an identical name 100', () => {
    expect(nameSimilarity('JOHN ADEBAYO DOE', 'JOHN ADEBAYO DOE')).toBe(100);
  });

  it('ignores case and punctuation', () => {
    expect(nameSimilarity("john o'brien-doe", 'JOHN OBRIENDOE')).toBe(100);
  });

  it('ignores field order', () => {
    // Registries disagree about which column holds the surname often enough that
    // a positional comparison would reject genuine customers.
    expect(nameSimilarity('DOE JOHN', 'JOHN DOE')).toBe(100);
  });

  it('tolerates a missing middle name', () => {
    // NIMC frequently holds two names where the BVN database holds three. This
    // is the single most common legitimate disagreement.
    expect(nameSimilarity('JOHN DOE', 'JOHN ADEBAYO DOE')).toBe(100);
  });

  it('tolerates a small spelling difference', () => {
    // One transposed letter in a seven-letter name is ~86% of that token, and
    // averages well above the floor across the whole name.
    expect(nameSimilarity('JOHN ADEBAYA DOE', 'JOHN ADEBAYO DOE')).toBeGreaterThanOrEqual(90);
  });

  it('scores an unrelated name far below any usable floor', () => {
    expect(nameSimilarity('MUSA IBRAHIM BELLO', 'JOHN ADEBAYO DOE')).toBeLessThan(40);
  });

  it('fails a name that shares only its first name', () => {
    // Two tokens, one perfect pairing and one failure, averages ~50 — under the
    // 80 floor, which is the property that matters.
    expect(nameSimilarity('JOHN OKAFOR', 'JOHN DOE')).toBeLessThan(80);
  });

  it('does not let one token satisfy two', () => {
    // Without consuming the matched token, "JOHN JOHN" would pair both of its
    // tokens with the single "JOHN" and score 100 against an unrelated surname.
    expect(nameSimilarity('JOHN JOHN', 'JOHN DOE')).toBeLessThan(80);
  });

  it('drops single-letter initials rather than scoring them', () => {
    expect(nameSimilarity('JOHN A DOE', 'JOHN ADEBAYO DOE')).toBe(100);
  });

  it('scores an empty name 0 rather than throwing', () => {
    expect(nameSimilarity('', 'JOHN DOE')).toBe(0);
    expect(nameSimilarity('JOHN DOE', '   ')).toBe(0);
  });
});

describe('joinName', () => {
  it('joins the parts that are present', () => {
    expect(joinName({ firstName: 'JOHN', middleName: null, lastName: 'DOE' })).toBe('JOHN DOE');
  });

  it('returns an empty string when nothing is present', () => {
    expect(joinName({ firstName: null, middleName: null, lastName: null })).toBe('');
  });
});

describe('genderMatches', () => {
  it('matches on the same value', () => {
    expect(genderMatches('MALE', 'MALE')).toBe(true);
  });

  it('normalises abbreviations and case', () => {
    expect(genderMatches('m', 'MALE')).toBe(true);
    expect(genderMatches('F', 'female')).toBe(true);
  });

  it('does not match different genders', () => {
    expect(genderMatches('MALE', 'FEMALE')).toBe(false);
  });

  it('treats a missing value as not matching', () => {
    // An absent value is not agreement. Passing on missing data is how a
    // comparison quietly stops comparing anything.
    expect(genderMatches(null, 'MALE')).toBe(false);
    expect(genderMatches('MALE', undefined)).toBe(false);
    expect(genderMatches('', '')).toBe(false);
  });
});

describe('dateOfBirthMatches', () => {
  it('matches the same calendar day', () => {
    expect(
      dateOfBirthMatches(new Date('1992-08-14T00:00:00Z'), new Date('1992-08-14T00:00:00Z')),
    ).toBe(true);
  });

  it('does not match a different day', () => {
    expect(
      dateOfBirthMatches(new Date('1992-08-14T00:00:00Z'), new Date('1992-08-15T00:00:00Z')),
    ).toBe(false);
  });

  it('treats a missing date as not matching', () => {
    expect(dateOfBirthMatches(null, new Date('1992-08-14T00:00:00Z'))).toBe(false);
  });
});

describe('phoneMatches', () => {
  it.each([
    ['08012345678', 'local'],
    ['2348012345678', 'country code, no plus'],
    ['+2348012345678', 'international'],
    ['080 1234 5678', 'spaced'],
    ['080-1234-5678', 'hyphenated'],
  ])('matches %s (%s) against the stored local form', (supplied) => {
    expect(phoneMatches(supplied, ['08012345678'])).toBe(true);
  });

  it('matches against the second number on the record', () => {
    expect(phoneMatches('08087654321', ['08012345678', '08087654321'])).toBe(true);
  });

  it('does not match a different number', () => {
    expect(phoneMatches('09099999999', ['08012345678'])).toBe(false);
  });

  it('does not match against nulls or too-short values', () => {
    expect(phoneMatches('08012345678', [null, undefined, '123'])).toBe(false);
    expect(phoneMatches('123', ['08012345678'])).toBe(false);
  });
});

describe('parseIsoDate', () => {
  it('parses a well-formed date at UTC midnight', () => {
    expect(parseIsoDate('1992-08-14')?.toISOString()).toBe('1992-08-14T00:00:00.000Z');
  });

  it('rejects a date that does not exist', () => {
    // `new Date('1992-02-31')` silently rolls forward to 2 March, which would
    // store a date of birth the customer never entered.
    expect(parseIsoDate('1992-02-31')).toBeNull();
  });

  it.each([['14/08/1992'], ['1992-8-14'], [''], [null], [undefined]])(
    'rejects %s rather than guessing',
    (value) => {
      expect(parseIsoDate(value)).toBeNull();
    },
  );
});

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadContent } from '../../src/content';
import {
  add,
  clampToZero,
  convert,
  currencyToken,
  format,
  fraction,
  percentage,
  present,
  resolveCurrencyTokens,
  roundForDisplay,
  shareOf,
  subtract,
  sum,
  tokenGap,
  type RateSet,
} from '../../src/domain/money';
import { money, MoneyError } from '../../src/types/money';

/**
 * The money domain, pure.
 *
 * **The display strings are contract, not presentation.** iOS ADR-0003 removed the client's formatter, so
 * `"₹5,539"` is a server deliverable and every rule below is asserted against the client's own fixture
 * corpus rather than against taste.
 */

loadContent();

const seed = JSON.parse(
  readFileSync(path.join(import.meta.dirname, '..', '..', 'content', 'fx-seed.json'), 'utf8'),
) as { base: 'USD'; rates: Record<string, number> };

const rates: RateSet = { dateKey: '2026-08-13', base: 'USD', rates: seed.rates };

describe('the rounding ladder', () => {
  /**
   * Product Spec §4.1, transcribed from the prototype's own `HWMoney.round` — because the numbers a user
   * sees have to agree with the design the product was signed off against.
   */
  it('rounds to the nearest whole unit below 10,000', () => {
    expect(roundForDisplay(5_539.49)).toBe(5_539);
    expect(roundForDisplay(5_539.5)).toBe(5_540);
    expect(roundForDisplay(9_999.6)).toBe(10_000);
  });

  it('rounds to the nearest 10 from 10,000', () => {
    expect(roundForDisplay(10_000)).toBe(10_000);
    expect(roundForDisplay(12_344)).toBe(12_340);
    expect(roundForDisplay(12_345)).toBe(12_350);
    expect(roundForDisplay(65_000)).toBe(65_000);
  });

  it('rounds to the nearest 100 from 100,000', () => {
    expect(roundForDisplay(100_000)).toBe(100_000);
    expect(roundForDisplay(1_247_893)).toBe(1_247_900);
    expect(roundForDisplay(680_000)).toBe(680_000);
  });

  it('applies the ladder by magnitude, so a negative figure rounds the same way', () => {
    // `net` is the one figure that goes below zero, and an overspending user's number must not round
    // differently from a saving user's.
    expect(roundForDisplay(-12_344)).toBe(-12_340);
    expect(roundForDisplay(-1_247_893)).toBe(-1_247_900);
  });
});

describe('the currency token', () => {
  /**
   * Product Spec §4.1 says "multi-letter codes get a space (`AED 500`); single-symbol currencies don't
   * (`₹500`)". The corpus adds two cases that sentence alone gets wrong, and one rule explains all of
   * them: **use the symbol when it is a single character *and* unique across the currency list.**
   */
  it('uses a unique single glyph', () => {
    expect(currencyToken('INR')).toBe('₹');
    expect(currencyToken('EUR')).toBe('€');
    expect(currencyToken('PHP')).toBe('₱');
    expect(currencyToken('THB')).toBe('฿');
    expect(currencyToken('VND')).toBe('₫');
    expect(currencyToken('BDT')).toBe('৳');
  });

  it('uses the code when the symbol is multi-character', () => {
    // AED's symbol is `د.إ.`, which is four characters and reads as a word.
    expect(currencyToken('AED')).toBe('AED');
    expect(currencyToken('KWD')).toBe('KWD');
    expect(currencyToken('SAR')).toBe('SAR');
  });

  it('uses the code when a single glyph is shared by more than one currency', () => {
    // `¥` is CNY *and* JPY; `₩` is KPW *and* KRW. A shared glyph on a salary figure is worse than a
    // three-letter code, and this is what `money-exponents.json` carries.
    expect(currencyToken('JPY')).toBe('JPY');
    expect(currencyToken('CNY')).toBe('CNY');
    expect(currencyToken('KRW')).toBe('KRW');
    expect(currencyToken('KPW')).toBe('KPW');
  });

  it('uses the code for the dollar and the pound, which 25 and 6 currencies share', () => {
    // The rule earns its keep here rather than in the JPY case. A reader who picked AUD, CAD, SGD or HKD
    // would otherwise see `$8,000` with nothing to say which dollar — on a salary, in a market of
    // expatriates who are paid in one currency and remit in another.
    expect(currencyToken('USD')).toBe('USD');
    expect(currencyToken('AUD')).toBe('AUD');
    expect(currencyToken('SGD')).toBe('SGD');
    expect(currencyToken('GBP')).toBe('GBP');
  });

  it('uses the code for Rs, which three currencies in this market share', () => {
    // Pakistani, Nepali and Sri Lankan expatriates are squarely in the target market, so `Rs` is exactly
    // the ambiguity you would least want in a salary figure.
    expect(currencyToken('PKR')).toBe('PKR');
    expect(currencyToken('NPR')).toBe('NPR');
    expect(currencyToken('LKR')).toBe('LKR');
  });

  it('gives a word air and binds a glyph', () => {
    expect(tokenGap('AED')).toBe(' ');
    expect(tokenGap('₹')).toBe('');
  });
});

describe('format', () => {
  /**
   * Every entry in `money-exponents.json`, which exists to pin the display for each exponent. This is the
   * test that would catch an exponent regression: 500000 is `KWD 500` at exponent 3 and `KWD 5,000` at 2.
   */
  const corpus = JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, '..', 'contract', 'corpus', 'money-exponents.json'),
      'utf8',
    ),
  ) as { minor: number; currency: string; exponent: number; display: string }[];

  it.each(corpus)('renders $minor $currency as $display', ({ minor, currency, display }) => {
    expect(format(money(minor, currency))).toBe(display);
  });

  it('renders the figures the budget and home fixtures carry', () => {
    expect(format(money(6_500_000, 'INR'))).toBe('₹65,000');
    expect(format(money(553_900, 'INR'))).toBe('₹5,539');
    expect(format(money(86_000, 'INR'))).toBe('₹860');
    expect(format(money(800_000, 'AED'))).toBe('AED 8,000');
    expect(format(money(0, 'INR'))).toBe('₹0');
  });

  it('never shows minor units, however small the value', () => {
    // `AED 500`, never `AED 500.00` — Product Spec §4.1.
    expect(format(money(50_050, 'AED'))).toBe('AED 501');
    expect(format(money(1, 'AED'))).toBe('AED 0');
  });

  it('groups thousands', () => {
    expect(format(money(123_456_700, 'AED'))).toBe('AED 1,234,600');
  });

  it('carries a sign for a negative value, because net is allowed to be one', () => {
    expect(format(money(-150_000, 'AED'))).toBe('AED -1,500');
  });
});

describe('present', () => {
  it('adds a display string without touching the stored figure', () => {
    const value = present(money(553_900, 'INR'));

    expect(value.minor).toBe(553_900);
    expect(value.currency).toBe('INR');
    expect(value.exponent).toBe(2);
    expect(value.display).toBe('₹5,539');
  });

  /** iOS ADR-0027: a blank `display` is a decode failure, which is what `budget-drifted.json` describes. */
  it('never produces a blank display string', () => {
    for (const currency of ['INR', 'AED', 'KWD', 'JPY', 'KRW', 'USD']) {
      for (const minor of [0, 1, 1_000, 553_900, 123_456_789]) {
        expect(present(money(minor, currency)).display.trim(), `${currency} ${String(minor)}`).not.toBe('');
      }
    }
  });
});

describe('convert', () => {
  it('is a no-op in the same currency, and needs no rate set at all', () => {
    // This is what lets Home work for a reader whose display currency is the one they authored in, before
    // any FX provider exists.
    expect(convert(money(800_000, 'AED'), 'AED', undefined)).toEqual(money(800_000, 'AED'));
  });

  it('converts through the USD pivot', () => {
    // AED 3.6725 and INR 84.2 per USD: 8,000 AED → 8,000 × 84.2 / 3.6725 ≈ 183,443 INR.
    const converted = convert(money(800_000, 'AED'), 'INR', rates);

    expect(converted.currency).toBe('INR');
    expect(converted.exponent).toBe(2);
    expect(converted.minor / 100).toBeCloseTo((8_000 * 84.2) / 3.6725, 0);
  });

  it('rescales across a change of exponent', () => {
    // AED (2) → KWD (3). Getting this wrong is a factor-of-ten error in somebody's salary.
    const converted = convert(money(800_000, 'AED'), 'KWD', rates);

    expect(converted.exponent).toBe(3);
    expect(converted.minor / 1_000).toBeCloseTo((8_000 * 0.307) / 3.6725, 0);
  });

  it('rescales down to a zero-exponent currency', () => {
    const converted = convert(money(800_000, 'AED'), 'JPY', rates);

    expect(converted.exponent).toBe(0);
    expect(converted.minor).toBeCloseTo((8_000 * 151.5) / 3.6725, 0);
  });

  it('round-trips within a rounding unit', () => {
    const there = convert(money(800_000, 'AED'), 'INR', rates);
    const back = convert(there, 'AED', rates);

    expect(Math.abs(back.minor - 800_000)).toBeLessThanOrEqual(1);
  });

  /** Defect D15: the prototype fell back to rate 1.0, reporting a foreign amount as though it were USD. */
  it('refuses an unknown currency rather than assuming a rate of 1', () => {
    const partial: RateSet = { dateKey: '2026-08-13', base: 'USD', rates: { USD: 1, AED: 3.6725 } };

    expect(() => convert(money(800_000, 'AED'), 'INR', partial)).toThrow(/no usable rate/);
  });

  it('refuses to convert with no rate set at all', () => {
    expect(() => convert(money(800_000, 'AED'), 'INR', undefined)).toThrow(/no FX rate set/);
  });

  /**
   * The rule that makes a donut's segments add up to the number above it (Product Spec §4.1): totals are
   * derived from unrounded values, and only the leaves round.
   */
  it('leaves values exact, so a total is not the sum of rounded parts', () => {
    const parts = [money(33_333, 'AED'), money(33_333, 'AED'), money(33_334, 'AED')];
    const total = sum(parts, 'AED');

    // Each part displays as AED 333; three of those would suggest AED 999. The real total is AED 1,000.
    expect(parts.map((part) => format(part))).toEqual(['AED 333', 'AED 333', 'AED 333']);
    expect(format(total)).toBe('AED 1,000');
  });
});

describe('arithmetic', () => {
  it('adds and subtracts in one currency', () => {
    expect(add(money(100, 'AED'), money(250, 'AED')).minor).toBe(350);
    expect(subtract(money(100, 'AED'), money(250, 'AED')).minor).toBe(-150);
  });

  it('refuses a mixed-currency sum rather than guessing', () => {
    // Silently adding rupees to dirhams is the class of bug invariant 1 exists to make impossible.
    expect(() => add(money(100, 'AED'), money(250, 'INR'))).toThrow(/cannot add/);
    expect(() => subtract(money(100, 'AED'), money(250, 'INR'))).toThrow(/cannot subtract/);
  });

  it('sums an empty list to zero in the stated currency', () => {
    expect(sum([], 'INR')).toEqual(money(0, 'INR'));
  });

  it('clamps at zero without losing the currency', () => {
    expect(clampToZero(money(-500, 'AED'))).toEqual(money(0, 'AED'));
    expect(clampToZero(money(500, 'AED'))).toEqual(money(500, 'AED'));
  });

  it('takes an exact integer fraction', () => {
    expect(fraction(money(6_500_000, 'INR'), 30, 100).minor).toBe(1_950_000);
    expect(fraction(money(6_500_000, 'INR'), 20, 100).minor).toBe(1_300_000);
    // Rounds rather than truncating, so an allowance is never a fil short for no reason.
    expect(fraction(money(101, 'AED'), 1, 2).minor).toBe(51);
  });
});

describe('percentages and shares', () => {
  it('rounds a percentage to a whole number', () => {
    // 5,539 of 65,000 is 8.52%, and `home-inr.json` carries "9% of pay".
    expect(percentage(money(553_900, 'INR'), money(6_500_000, 'INR'))).toBe(9);
    // 23,000 of 13,000 is 176.9%, and the fixture carries "177% of goal".
    expect(percentage(money(2_300_000, 'INR'), money(1_300_000, 'INR'))).toBe(177);
  });

  /** A savings goal of zero is met by definition — there is nothing to miss (Product Spec §4.2). */
  it('treats a zero denominator as 100%', () => {
    expect(percentage(money(0, 'INR'), money(0, 'INR'))).toBe(100);
    expect(percentage(money(500, 'INR'), money(0, 'INR'))).toBe(100);
  });

  it('gives a share to four places, as the corpus carries it', () => {
    expect(shareOf(money(300_000, 'INR'), money(553_900, 'INR'))).toBe(0.5416);
    expect(shareOf(money(41_000, 'INR'), money(553_900, 'INR'))).toBe(0.074);
    expect(shareOf(money(44_000, 'INR'), money(553_900, 'INR'))).toBe(0.0794);
    expect(shareOf(money(52_900, 'INR'), money(553_900, 'INR'))).toBe(0.0955);
    // 86,000 of 553,900 is 0.155263…, which rounds to 0.1553. `home-inr.json` carries 0.1552 — the one
    // place the hand-written fixture truncated instead of rounding. Rounding is kept: it is the more
    // accurate of the two, `share` drives a chart rather than a figure, and the contract harness asserts
    // types rather than values for exactly this reason (ADR-0017).
    expect(shareOf(money(86_000, 'INR'), money(553_900, 'INR'))).toBe(0.1553);
  });

  it('gives a zero share against a zero total rather than dividing by zero', () => {
    expect(shareOf(money(0, 'INR'), money(0, 'INR'))).toBe(0);
  });
});

describe('resolveCurrencyTokens', () => {
  it('substitutes the token with its gap, so a code does not run into the digits', () => {
    expect(resolveCurrencyTokens('{c}6,400 becomes {c}640', 'INR')).toBe('₹6,400 becomes ₹640');
    expect(resolveCurrencyTokens('{c}6,400 becomes {c}640', 'AED')).toBe('AED 6,400 becomes AED 640');
  });

  it('leaves a string with no tokens alone', () => {
    expect(resolveCurrencyTokens('Save first, spend after.', 'INR')).toBe('Save first, spend after.');
  });
});

describe('the Money constructor', () => {
  it('resolves the exponent from the currency list rather than taking one', () => {
    expect(money(50_000, 'AED').exponent).toBe(2);
    expect(money(500_000, 'KWD').exponent).toBe(3);
    expect(money(75_000, 'JPY').exponent).toBe(0);
  });

  it('accepts a lowercase code and stores it uppercase', () => {
    expect(money(50_000, 'aed')).toEqual({ minor: 50_000, currency: 'AED', exponent: 2 });
  });

  it('refuses a fractional minor unit, which means a float leaked into a monetary path', () => {
    expect(() => money(500.5, 'AED')).toThrow(MoneyError);
  });

  it('refuses an unknown currency rather than defaulting the exponent to 2', () => {
    // A default would make `minor` mean something different by a factor of ten.
    expect(() => money(50_000, 'ZZZ')).toThrow(/unknown currency/);
  });
});

import { getContent } from '../content';
import { ApiError } from '../errors';
import { money, type Money } from '../types/money';

/**
 * The money domain: conversion through the USD pivot, the rounding ladder, and the display strings.
 *
 * **The server owns formatting, not just calculation.** iOS ADR-0003 removed the client's formatter
 * entirely and ADR-0027 made a blank `display` string a decode failure, so `"₹5,539"` is a server
 * deliverable and every rule below is part of the contract rather than a presentation detail.
 *
 * Three rules, all from Product Spec §4.1, and each one exists because the prototype got it wrong:
 *
 *  1. **Convert once, at read.** A value is stored in the currency it was authored in and is never
 *     rewritten — not on write, and not when the display currency changes. The prototype quantised
 *     income by round-tripping salary through its display formatter before the budget engine saw it
 *     (defect D16), so conversion here is exact in minor units and rounding happens only in `present`.
 *  2. **Round at the leaves, derive totals from unrounded values.** A grand total is never the sum of
 *     rounded parts, so a donut's segments always add up to the number above it.
 *  3. **An unknown currency code is an error, never rate 1.0.** The prototype's fallback reported a
 *     foreign amount as though it were dollars (defect D15).
 *
 * Pure — no database, no request context — and tested as such (ADR-0014).
 */

// ── Rate sets ─────────────────────────────────────────────────────────────────────────────────

/**
 * One day's rates: units per 1 USD, for every code in the currency list.
 *
 * **USD is the pivot, not a storage currency** (ADR-0001). Conversion is always `from → USD → to`,
 * which means one rate per currency rather than a matrix, and it means a value's stored currency is
 * never privileged over any other.
 */
export interface RateSet {
  readonly dateKey: string;
  readonly base: 'USD';
  readonly rates: Readonly<Record<string, number>>;
}

/**
 * The rate for one code.
 *
 * @throws {ApiError} `INTERNAL` for a code the set does not carry. A rate set is written only if it
 * covers every listed currency (DATA_MODEL §3.6), so a gap here is a data-integrity failure — and
 * defaulting to 1.0 would report, say, 500 rupees as 500 dirhams.
 */
function rateFor(rates: RateSet, currency: string): number {
  const rate = rates.rates[currency];
  if (rate === undefined || !(rate > 0)) {
    throw new ApiError(
      'INTERNAL',
      `no usable rate for ${currency} in rate set ${rates.dateKey}`,
      {
        currency,
        rateSet: rates.dateKey,
        why: 'a rate set must cover every currency in content/reference/currencies.json; an unknown code is never rate 1.0 (defect D15)',
      },
    );
  }
  return rate;
}

/**
 * Convert a value into another currency, **exactly** — no display rounding.
 *
 * The only rounding is to a whole minor unit of the target currency, which is unavoidable: a value has
 * to be an integer count of something. Crucially it is *not* the ladder in `roundForDisplay`, so
 * summing converted values and then formatting the sum gives a different (and correct) answer from
 * formatting each and adding the strings.
 *
 * Same-currency conversion is a no-op and needs no rate set at all — which is why Home works for a
 * user whose display currency is the one they authored in, even before an FX feed exists.
 */
export function convert(amount: Money, to: string, rates: RateSet | undefined): Money {
  const target = to.toUpperCase();
  if (amount.currency === target) return amount;

  if (rates === undefined) {
    throw new ApiError(
      'INTERNAL',
      `no FX rate set is available to convert ${amount.currency} to ${target}`,
      { from: amount.currency, to: target, why: 'run `npm run seed:fx`, or wait for fx:refresh to write one' },
    );
  }

  const targetExponent = getContent().currencyByCode.get(target)?.exponent;
  if (targetExponent === undefined) {
    throw new ApiError('INTERNAL', `${target} is not a known currency`, { currency: target });
  }

  const major = amount.minor / 10 ** amount.exponent;
  const converted = (major * rateFor(rates, target)) / rateFor(rates, amount.currency);
  return money(Math.round(converted * 10 ** targetExponent), target);
}

/** Add two values already in the same currency. Refuses a mixed-currency sum rather than guessing. */
export function add(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new ApiError('INTERNAL', `cannot add ${b.currency} to ${a.currency} — convert both to one currency first`);
  }
  return { ...a, minor: a.minor + b.minor };
}

/** Sum values already in one currency. `currency` is passed so an empty list still has one. */
export function sum(amounts: readonly Money[], currency: string): Money {
  return amounts.reduce((total, amount) => add(total, amount), money(0, currency));
}

/** `a − b`, which may be negative: `net` is exactly this, and its whole job is to go below zero. */
export function subtract(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new ApiError('INTERNAL', `cannot subtract ${b.currency} from ${a.currency} — convert both to one currency first`);
  }
  return { ...a, minor: a.minor - b.minor };
}

/** A value clamped at zero. `saved` is `clampToZero(net)`. */
export const clampToZero = (amount: Money): Money =>
  amount.minor < 0 ? { ...amount, minor: 0 } : amount;

/** A fraction of a value, as exact integer minor units. Used for the 30/20 allowances. */
export const fraction = (amount: Money, numerator: number, denominator: number): Money => ({
  ...amount,
  minor: Math.round((amount.minor * numerator) / denominator),
});

export const isZero = (amount: Money): boolean => amount.minor === 0;

// ── Display ───────────────────────────────────────────────────────────────────────────────────

/**
 * The magnitude-aware rounding ladder, in **major** units (Product Spec §4.1):
 *
 * ```
 * |n| ≥ 100,000 → nearest 100
 * |n| ≥  10,000 → nearest 10
 * otherwise     → nearest whole unit
 * ```
 *
 * So `AED 500`, never `AED 500.00`, and a six-figure salary reads `₹1,250,000` rather than
 * `₹1,247,893`. Applied at **display only** — storage stays exact to the minor unit.
 *
 * Transcribed from the prototype's own `HWMoney.round`, because the numbers a user sees have to agree
 * with the design they were signed off against.
 */
export function roundForDisplay(major: number): number {
  const magnitude = Math.abs(major);
  if (magnitude >= 100_000) return Math.round(major / 100) * 100;
  if (magnitude >= 10_000) return Math.round(major / 10) * 10;
  return Math.round(major);
}

/**
 * The token a currency is shown with: its symbol, or its ISO code.
 *
 * **Product Spec §4.1 says "multi-letter codes get a space (`AED 500`); single-symbol currencies don't
 * (`₹500`)", and the fixture corpus adds two cases that sentence alone gets wrong** — `money-exponents.json`
 * carries `JPY 75,000` and `KRW 680,000`, not `¥75,000` and `₩680,000`, even though both symbols are
 * single characters. One rule explains every entry in the corpus:
 *
 *   **use the symbol when it is a single character *and* unique across the currency list; otherwise use
 *   the ISO code.**
 *
 * `¥` is shared by CNY and JPY; `₩` by KPW and KRW — so both are ambiguous and fall back to the code.
 * `₹` belongs to INR alone, so it is used. And the rule pays for itself beyond those two: `Rs` is shared
 * by PKR, NPR and LKR, which in a market of Pakistani, Nepali and Sri Lankan expatriates is exactly the
 * ambiguity you would least want in a salary figure.
 *
 * The prototype had none of this — it took whatever `currencySymbol` the user record happened to hold,
 * which for its default user was the string `AED`.
 */
/**
 * How many characters a currency token is, for the "single glyph?" and "needs a space?" decisions.
 *
 * **Code points, not UTF-16 units and not grapheme clusters.** A currency symbol is never an emoji and
 * never a combining sequence — the widest thing in the list is `د.إ.`, four separate Arabic characters —
 * so code points are exactly the right unit here. `Intl.Segmenter` would be the correct tool for user
 * text and is the wrong tool for this: it would treat `د.إ.` as four segments too, at a much higher cost.
 */
function characterCount(token: string): number {
  // eslint-disable-next-line @typescript-eslint/no-misused-spread -- code points are the intended unit; see above
  return [...token].length;
}

export function currencyToken(currency: string): string {
  const known = getContent().currencyByCode.get(currency.toUpperCase());
  if (known === undefined) {
    throw new ApiError('INTERNAL', `${currency} is not a known currency`, { currency });
  }

  const symbol = known.symbol;
  return characterCount(symbol) === 1 && isUnambiguous(symbol) ? symbol : known.code;
}

/** Symbols used by exactly one currency. Computed once from the content, not hand-listed. */
let unambiguousSymbols: Set<string> | undefined;

function isUnambiguous(symbol: string): boolean {
  if (unambiguousSymbols === undefined) {
    const counts = new Map<string, number>();
    for (const currency of getContent().currencies.value.currencies) {
      counts.set(currency.symbol, (counts.get(currency.symbol) ?? 0) + 1);
    }
    unambiguousSymbols = new Set([...counts].filter(([, count]) => count === 1).map(([s]) => s));
  }
  return unambiguousSymbols.has(symbol);
}

/**
 * The separator between the token and the digits.
 *
 * A multi-character token is a word and needs air; a single glyph binds to the number. The prototype's
 * rule exactly, and the reason `AED 500` and `₹500` are both correct.
 */
export const tokenGap = (token: string): string => (characterCount(token) > 1 ? ' ' : '');

/** Grouped digits, `en-US` style. One formatter, because constructing one per figure is not free. */
const digits = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** A value as the client renders it: `₹5,539`, `AED 8,000`, `KWD 500`, `JPY 75,000`. */
export function format(amount: Money): string {
  const token = currencyToken(amount.currency);
  const major = roundForDisplay(amount.minor / 10 ** amount.exponent);
  return `${token}${tokenGap(token)}${digits.format(major)}`;
}

/**
 * A `Money` with its `display` string — the shape every monetary field in every payload has.
 *
 * The name is deliberate: this is the **presentation** step, and it is the last thing that happens to a
 * figure. Nothing downstream may do arithmetic on the result, because `display` has been through the
 * ladder and no longer equals `minor`.
 */
export interface DisplayMoney extends Money {
  readonly display: string;
}

export const present = (amount: Money): DisplayMoney => ({ ...amount, display: format(amount) });

/** Convert into the reader's currency and present it — the two steps every payload figure takes. */
export const presentIn = (amount: Money, displayCurrency: string, rates: RateSet | undefined): DisplayMoney =>
  present(convert(amount, displayCurrency, rates));

// ── Labels ────────────────────────────────────────────────────────────────────────────────────

/**
 * A percentage, rounded to a whole number.
 *
 * A zero denominator yields 100 rather than dividing by zero, and that is a product decision rather
 * than a defensive one: a savings goal of zero is met by definition, because there is nothing to miss
 * (Product Spec §4.2). Callers that need a different answer for a zero denominator say so.
 */
export function percentage(part: Money, whole: Money): number {
  if (whole.minor === 0) return 100;
  return Math.round((part.minor / whole.minor) * 100);
}

/** `"9% of pay"`, `"177% of goal"` — the labels the client prints verbatim (iOS ADR-0003). */
export const percentageLabel = (part: Money, whole: Money, suffix: string): string =>
  `${String(percentage(part, whole))}% ${suffix}`;

/**
 * Whole-number percentages for a set of parts that **add up to the total the reader can see**.
 *
 * Rounding each share on its own is what printed `50 · 14 · 16 · 9 · 5 · 7` — 101% — down the legend of a
 * donut labelled with the whole. Largest remainder gives every slice its floor first and then hands the
 * leftover points to the slices that lost the most to flooring, so the column totals what it should and no
 * slice sits more than one point from its own honest rounding.
 *
 * The target is the rounded sum of the exact shares rather than a hardcoded 100, so this is still correct
 * for a set of parts that deliberately does not cover the whole.
 *
 * **A zero part stays zero.** Handing a leftover point to a category with nothing in it would print `1%`
 * beside `AED 0`, which is worse than the error being corrected.
 */
export function wholePercentages(parts: readonly Money[], whole: Money): number[] {
  if (whole.minor === 0) return parts.map(() => 0);

  const exact = parts.map((part) => (part.minor / whole.minor) * 100);
  const floors = exact.map((value) => Math.floor(value));
  const target = Math.round(exact.reduce((running, value) => running + value, 0));
  let leftover = target - floors.reduce((running, value) => running + value, 0);

  const shares = [...floors];
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .filter(({ index }) => (parts[index]?.minor ?? 0) > 0)
    .sort((a, b) => b.remainder - a.remainder);

  for (const { index } of byRemainder) {
    if (leftover <= 0) break;
    shares[index] = (shares[index] ?? 0) + 1;
    leftover -= 1;
  }

  return shares;
}

/**
 * A fraction rounded to four decimal places, for the donut and the bars.
 *
 * Four places because that is what the corpus carries (`0.5416`), and because it is enough precision
 * for a chart on a phone while staying stable under a re-render. The *label* beside it rounds
 * independently to a whole percent from the unrounded value, so a 54.16% slice reads `54%` — rounding
 * the label from the rounded share would compound the error.
 */
export const shareOf = (part: Money, whole: Money): number =>
  whole.minor === 0 ? 0 : Math.round((part.minor / whole.minor) * 10_000) / 10_000;

/**
 * Resolve `{c}` tokens in an editorial string.
 *
 * The token stands in for the reader's currency, so a tip about "{c}6,400" reads `₹6,400` for one user
 * and `AED 6,400` for another. **The gap is part of the substitution**, exactly as the prototype's
 * `HWMoney.tag` does it — otherwise `AED6,400` for half the market.
 *
 * The client also does this (`CurrencyToken.resolve`), which is not duplication: the payload carries the
 * raw text *and* the token so that "Show me another" can cycle tips in memory without a request per tap
 * (iOS ADR-0016).
 */
export function resolveCurrencyTokens(text: string, currency: string): string {
  const token = currencyToken(currency);
  return text.replaceAll('{c}', `${token}${tokenGap(token)}`);
}

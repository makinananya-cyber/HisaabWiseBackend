import { z } from 'zod';

import { getContent } from '../content';

/**
 * The one monetary representation in this system (invariant 1, ADR-0001).
 *
 * ```js
 * { minor: 553900, currency: "INR", exponent: 2 }
 * ```
 *
 * `minor` is an **integer count of the currency's smallest unit**, stored in the currency it was
 * authored in. Never a float — a salary typed as `8000.5` and rounded differently on two sides is a
 * figure nobody can reconcile. Never normalised to a base on write: USD is the conversion *pivot*,
 * not a storage currency, and rewriting a value into it on the way in would make the stored figure a
 * lossy function of whatever rate was in force that day.
 *
 * `exponent` comes from `content/reference/currencies.json` and is **never guessed**. It is what
 * makes `minor` meaningful: 553900 is ₹5,539 at exponent 2 and ₹553,900 at exponent 0.
 *
 * **`display` is not here, and its absence is the point.** The fixtures carry `"₹5,539"`, and the
 * client has no formatter to produce one (iOS ADR-0003) — so it is a *render-time* function of the
 * reader's display currency and the rate set in force. Storing it would be defect D16: a salary
 * round-tripping through display rounding until it no longer matches what was typed. The formatting
 * layer lives in `src/domain/money.ts` and builds a display string on the way out.
 */
export interface Money {
  readonly minor: number;
  readonly currency: string;
  readonly exponent: number;
}

/** Raised when a monetary value cannot be constructed from what was given. */
export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

/**
 * A `Money` from minor units and a currency code, with the exponent read from the currency list.
 *
 * **The only constructor.** Building the object literally elsewhere would be the one place a wrong
 * exponent could enter the system, and a wrong exponent is a factor-of-ten error in somebody's pay.
 *
 * @throws {MoneyError} for an unknown currency code. Never a default of 2, and never rate 1.0's
 * equivalent — an unknown code is a bug in the caller or a gap in the content, and both are worth
 * failing on (defect D15).
 */
export function money(minor: number, currency: string): Money {
  if (!Number.isInteger(minor)) {
    throw new MoneyError(
      `minor must be an integer count of the smallest unit, got ${String(minor)}. A fractional ` +
        'minor unit means a float leaked into a monetary path.',
    );
  }

  const code = currency.toUpperCase();
  const known = getContent().currencyByCode.get(code);
  if (known === undefined) {
    throw new MoneyError(
      `unknown currency code "${currency}". Exponents come from content/reference/currencies.json ` +
        'and are never guessed — a default would make `minor` mean something different by a factor of ten.',
    );
  }

  return { minor, currency: code, exponent: known.exponent };
}

/** Whether a currency code is one the content knows about. For validating a request field. */
export const isKnownCurrency = (currency: string): boolean =>
  getContent().currencyByCode.has(currency.toUpperCase());

/**
 * A monetary value arriving from the client: `{minor, currency}`, with no exponent and no display.
 *
 * The client does not send an exponent, and should not — that would make it a second owner of a fact
 * the currency list already settles. It is resolved here, at the boundary, by `money()`.
 *
 * The bound on `minor` is `Number.MAX_SAFE_INTEGER` rather than a business figure: a salary cap is a
 * product decision and does not belong in a type, but a value that cannot survive integer arithmetic
 * is a broken value in any currency.
 */
export const moneyInputSchema = z
  .object({
    minor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    currency: z
      .string()
      .length(3)
      .refine(isKnownCurrency, { message: 'not a currency in content/reference/currencies.json' }),
  })
  .transform(({ minor, currency }) => money(minor, currency));

/**
 * A monetary value read back out of MongoDB.
 *
 * **Parsed on read as well as on write** (ADR-0002). A bare number written by a seed script or an
 * older deploy would otherwise flow straight into the budget engine and out onto a screen; here it
 * throws at the boundary, naming the field. That is invariant 1's second gate — the first is the lint
 * rule keeping collection access inside `src/repositories/`.
 */
export const storedMoneySchema = z.object({
  minor: z.number().int(),
  currency: z.string().length(3),
  exponent: z.number().int().min(0).max(3),
});

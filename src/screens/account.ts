import { getContent, type Language } from '../content';
import { convert, currencyToken, present, type DisplayMoney, type RateSet } from '../domain/money';
import { daysBetween, dayKey } from '../domain/time';
import type { User } from '../repositories/users';
import { money } from '../types/money';

/**
 * `GET /v1/screens/account` — **the single read Account makes** (ADR-0020, iOS ADR-0038).
 *
 * The profile header with its initials and summary chip, the four rows in the order they are drawn with each
 * one's subtitle and value, the personal card's four lines, the stored language and display currency, and the
 * two security questions the password flow asks.
 *
 * **The row subtitles are why this is a screen endpoint rather than a projection of `/v1/me`.** "Changed 3
 * months ago" is computed against a day boundary in the user's stored timezone (invariant 6); the design
 * carries it as a literal and rewrites it to "just now" in the browser, which is the same defect the expense
 * date labels fixed one screen earlier (D5).
 */

/** The four rows, in the order the screen draws them. */
export type AccountSection = 'personal' | 'language' | 'currency' | 'password';

export interface AccountPayload {
  readonly profile: {
    initials: string;
    displayName: string;
    email: string;
    summaryLabel: string;
  };
  readonly rows: { section: AccountSection; name: string; hint: string; value?: string }[];
  readonly personal: {
    displayName: string;
    email: string;
    isEmailVerified: boolean;
    salary: DisplayMoney;
    salaryCurrency: { code: string; symbol: string; displayCode: string; exponent: number };
    phone: { country: string; dialCode: string; national: string; display: string } | null;
  };
  readonly language: string;
  readonly currency: string;
  readonly password: { questions: { id: string; text: string }[] };
}

/**
 * The initials in the avatar.
 *
 * First letters of the first two words, so "Neeraj" is `N` and "Ananya Makin" is `AM`.
 *
 * **By grapheme, via `Intl.Segmenter`, not by code point.** This is a *person's name* in a market of
 * expatriates from South Asia, the Philippines and the Arab world — the first "letter" of a Devanagari or
 * Tamil name is routinely a base character plus a combining mark, and taking the code point alone would draw
 * half a letter in the avatar. This is precisely the case where the more expensive tool is the correct one,
 * and the opposite of `currencyToken`'s, where a code point is right.
 */
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

export function initialsOf(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter((word) => word.length > 0);
  return words
    .slice(0, 2)
    .map((word) => [...graphemes.segment(word)][0]?.segment.toUpperCase() ?? '')
    .join('');
}

/**
 * `"Changed 3 months ago"`, `"Changed just now"`, or `"Set when you created your account"`.
 *
 * **Computed against the reader's day boundary**, not against a wall-clock difference, so a password changed
 * at 23:50 yesterday reads "yesterday" rather than "13 hours ago". Months are approximated at 30 days, which
 * is what a human means by "3 months ago" and what the design's own copy implies.
 *
 * **A password that has never been changed does not say "Changed just now".** Registration stamps
 * `passwordChangedAt` with the creation time, so every brand-new account read as though its owner had just
 * changed their password minutes ago — which is a confusing thing to tell somebody who has never changed it and
 * would make a real "somebody changed your password" impossible to notice. When the two timestamps are the same
 * instant, the password has only ever been *set*, and the row says so.
 */
export function passwordChangedLabel(
  changedAt: Date,
  now: Date,
  timezone: string,
  createdAt?: Date,
): string {
  if (changedAt.getTime() === createdAt?.getTime()) {
    return 'Set when you created your account';
  }

  const days = daysBetween(dayKey(changedAt, timezone), dayKey(now, timezone));

  if (days <= 0) return 'Changed just now';
  if (days === 1) return 'Changed yesterday';
  if (days < 30) return `Changed ${String(days)} days ago`;

  const months = Math.round(days / 30);
  if (months < 12) return `Changed ${String(months)} month${months === 1 ? '' : 's'} ago`;

  const years = Math.round(days / 365);
  return `Changed ${String(years)} year${years === 1 ? '' : 's'} ago`;
}

/**
 * A phone number as the screen shows it: `+91 98765 43210`.
 *
 * Grouped in fives from the left after the dial code, which is not a real numbering plan and is not trying to
 * be — a correct per-country formatter is a library, and this is a readability aid on a field the user typed
 * themselves. The **parts** are what the client redraws the field from; this string is for display only.
 */
export function phoneDisplay(dialCode: string, national: string): string {
  const groups = national.match(/.{1,5}/g) ?? [national];
  return `${dialCode} ${groups.join(' ')}`;
}

/** The English name of a language code, from the reference list the picker is built from. */
function languageName(code: string, language: Language): string {
  const match = getContent(language).languages.value.languages.find((entry) => entry.code === code);
  return match?.name ?? code;
}

export interface AccountInput {
  readonly user: User;
  readonly now: Date;
  /**
   * Accepted and deliberately unused by the builder.
   *
   * **The Account screen converts nothing.** The salary it shows is the one the user *authored* and edits —
   * converting it would mean typing a figure and seeing a different one back — and every other figure on the
   * screen belongs to another screen. The parameter stays because the route holds a rate set for
   * `assertConvertible`, and because a future field that did need converting should find it here rather than
   * threading it through again.
   */
  readonly rates?: RateSet | undefined;
  readonly language: Language;
}

export function buildAccount(input: AccountInput): AccountPayload {
  const { user, now, language } = input;
  const currency = user.displayCurrency;
  const content = getContent(language);

  // The salary is shown in the currency it was **authored** in, not the display currency: this is the field
  // the user edits, and converting it would mean typing a figure and seeing a different one back.
  const salary = present(user.salary);
  const salaryToken = currencyToken(user.salary.currency);

  const questions = user.securityQuestions.map(({ questionId }) => {
    const question = content.securityQuestions.value.questions.find((entry) => entry.id === questionId);
    return { id: questionId, text: question?.text ?? '' };
  });

  return {
    profile: {
      initials: initialsOf(user.displayName),
      displayName: user.displayName,
      // Locked, and shown so the reader can see which account they are in (invariant 4).
      email: user.email,
      summaryLabel: `${currency} · ${languageName(user.language, language)}`,
    },

    rows: [
      { section: 'personal', name: 'Personal Information', hint: 'Username, salary, phone' },
      {
        section: 'language',
        name: 'Language',
        hint: 'How the app is written',
        value: languageName(user.language, language),
      },
      { section: 'currency', name: 'Currency', hint: 'How your money is shown', value: currency },
      {
        section: 'password',
        name: 'Password',
        hint: passwordChangedLabel(user.passwordChangedAt, now, user.timezone, user.createdAt),
      },
    ],

    personal: {
      displayName: user.displayName,
      // Always true: nothing is verified out of band (BACKEND_PLAN §4.2.2). The field stays so the client's
      // banner and its two fixtures remain valid shapes.
      email: user.email,
      isEmailVerified: true,
      salary,
      salaryCurrency: {
        code: user.salary.currency,
        symbol: salaryToken,
        displayCode: user.salary.currency,
        exponent: user.salary.exponent,
      },
      phone:
        user.phone === null
          ? null
          : {
              country: user.phone.country,
              dialCode: user.phone.dialCode,
              national: user.phone.national,
              display: phoneDisplay(user.phone.dialCode, user.phone.national),
            },
    },

    language: user.language,
    currency,
    password: { questions },
  };
}

/**
 * The reader's display currency converted into a zero, purely to prove the rate set works.
 *
 * Exported so the currency route can fail *before* it stores a preference the reader's figures cannot be
 * shown in — a currency change that stores successfully and then breaks every screen is the worst ordering.
 */
export function assertConvertible(user: User, currency: string, rates: RateSet | undefined): void {
  convert(user.salary, currency, rates);
  convert(user.savingsGoal, currency, rates);
  convert(money(0, currency), currency, rates);
}

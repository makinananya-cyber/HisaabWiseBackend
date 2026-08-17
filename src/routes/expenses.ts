import { randomUUID } from 'node:crypto';

import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { getContent } from '../content';
import { monthKey } from '../domain/time';
import { ApiError } from '../errors';
import { requireSession } from '../middleware/auth';
import * as entries from '../repositories/expenseEntries';
import * as fixedCosts from '../repositories/fixedCosts';
import { latestRateSet } from '../repositories/fxRates';
import { archivedMonthKeys } from '../repositories/monthArchives';
import {
  buildExpenses,
  categoryById,
  monthTotals,
  utilityIconFor,
  type ExpensesPayload,
} from '../screens/expenses';
import { monthLabelFor } from '../screens/home';
import { moneyInputSchema } from '../types/money';
import type { AppEnv } from '../types/hono';
import type { User } from '../repositories/users';

/**
 * Expenses — the writes, and the one read they all answer with.
 *
 * **Every write returns the updated screen payload** (ADR-0020). The client never patches its own copy,
 * which is how a per-category total and a monthly summary come to disagree — the prototype's Home and
 * Expenses did exactly that. One read shape, produced by one function, after every mutation.
 *
 * **`monthKey` is server-derived and frozen.** It comes from the entry date in the user's stored timezone at
 * write time (invariant 6), and a client-supplied month is never trusted — a client that could choose one
 * could write into a closed month.
 *
 * **A write into a closed month is refused `MONTH_CLOSED`.** Archives are immutable with no exceptions;
 * amending one reopens defect D6. The client offers to re-file into the live month, showing the real date
 * rather than lying about it.
 */

export const expenseRoutes = new Hono<AppEnv>();

// ── Reading the screen ────────────────────────────────────────────────────────────────────────

/**
 * The live month for a user.
 *
 * **`max(current local month, latest archived month + 1)`** — it only ever moves forward (Product Spec
 * §4.5). Without that, a user flying east-to-west across a month boundary would find their local clock back
 * inside a month that is already sealed, and every write would be refused with no way out. The unique
 * `(userId, monthKey)` index covers the double-archive direction; this rule covers the other one.
 */
export async function liveMonthFor(user: User, now: Date): Promise<string> {
  const current = monthKey(now, user.timezone);
  const archived = await archivedMonthKeys(user._id);
  const latest = archived.at(-1);
  if (latest === undefined || latest < current) return current;

  const [year, month] = latest.split('-').map(Number);
  return month === 12
    ? `${String((year ?? 0) + 1)}-01`
    : `${String(year)}-${String((month ?? 0) + 1).padStart(2, '0')}`;
}

/** Read everything the Expenses screen needs and build it. One place, so every write can reuse it. */
export async function currentExpenses(user: User, now: Date): Promise<ExpensesPayload> {
  const live = await liveMonthFor(user, now);
  const rates = await latestRateSet();

  const [monthEntries, fixed] = await Promise.all([
    entries.entriesForMonth(user._id, live),
    fixedCosts.forUser(user._id, user.displayCurrency),
  ]);

  return buildExpenses({
    user,
    now,
    monthLabel: monthLabelFor(now, user.timezone),
    totals: monthTotals(monthEntries, fixed, user.displayCurrency, rates),
    rates,
  });
}

expenseRoutes.get('/v1/screens/expenses', requireSession(), async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(await currentExpenses(c.var.user, new Date()));
});

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────

async function body<Schema extends z.ZodType>(c: Context<AppEnv>, schema: Schema): Promise<z.infer<Schema>> {
  const raw: unknown = await c.req.json().catch(() => undefined);
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ApiError('VALIDATION_FAILED', 'the request body was not valid', {
      issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  return result.data;
}

/**
 * The id a created entry is stored under.
 *
 * **The `Idempotency-Key` header *is* the document `_id`** (ADR-0011). The client mints a key per user
 * *intent* and reuses it across retries, so a write that reached the server and lost its response is not
 * filed twice — the unique `_id` index refuses the second insert, and the route reports the current screen
 * rather than an error.
 *
 * A missing key falls back to a fresh UUID, which makes the write non-idempotent. That is the honest
 * behaviour: a caller that sent no key has not asked for idempotency, and inventing a key from the body
 * would silently collapse two genuinely separate ₹100 coffees into one.
 */
function entryIdFrom(c: Context<AppEnv>): string {
  const key = c.req.header('idempotency-key')?.trim() ?? '';
  return key === '' ? randomUUID() : key.slice(0, 200);
}

/**
 * Refuse a write into a month that has been archived.
 *
 * Checked against the live month rather than by looking for an archive, because the live month already
 * accounts for the "only ever moves forward" rule — so a user whose clock has gone backwards over a
 * boundary is refused here rather than silently writing into sealed history.
 */
function assertLiveMonth(target: string, live: string): void {
  if (target !== live) {
    throw new ApiError('MONTH_CLOSED', 'that month has been closed and can no longer be changed', {
      target,
      live,
    });
  }
}

// ── Creating an entry ─────────────────────────────────────────────────────────────────────────

const newExpenseSchema = z.object({
  categoryId: z.enum(entries.LOG_CATEGORIES),
  amount: moneyInputSchema,
  /** A pick-list option id, resolved server-side into the label — never the displayed name. */
  optionId: z.string().min(1).max(100).nullish(),
  /** Free text, for the categories whose field is a text box. */
  label: z.string().trim().max(200).nullish(),
});

/**
 * `POST /v1/expenses`.
 *
 * **The label is resolved from the option id, not taken from the client** (iOS `Picklists.Option`). Sending
 * the displayed name would mean an Arabic-reading user filing an entry labelled in Arabic and an
 * English-reading one filing the same entry labelled in English, with nothing to reconcile them. The id is
 * the identity; the name is content in whatever language the reader asks for.
 */
expenseRoutes.post('/v1/expenses', requireSession(), async (c) => {
  const input = await body(c, newExpenseSchema);
  const user = c.var.user;
  const now = new Date();

  const category = categoryById.get(input.categoryId);
  if (category?.kind !== 'log') {
    throw new ApiError('VALIDATION_FAILED', `${input.categoryId} is not a category entries are logged in`);
  }

  if (input.amount.minor <= 0) {
    throw new ApiError('VALIDATION_FAILED', 'an entry must have a positive amount');
  }

  // The entry date is **now**, in the user's zone. The design's add form has no date picker, and Product
  // Spec §4.5 caps entry dates to the live month anyway — so there is nothing for a client to choose.
  const live = await liveMonthFor(user, now);
  assertLiveMonth(monthKey(now, user.timezone), live);

  const label = resolveLabel(category.field, input.optionId ?? null, input.label ?? null, category.name);

  try {
    await entries.insertEntry(
      {
        id: entryIdFrom(c),
        userId: user._id,
        monthKey: live,
        category: input.categoryId,
        amount: input.amount,
        label,
        entryDate: now,
      },
      now,
    );
  } catch (err) {
    // A replayed create is a **success**, not a failure: the entry the caller asked for exists. Answering
    // 409 would make a client that merely lost a response show an error for a write that worked.
    if (!(err instanceof ApiError) || err.code !== 'ALREADY_RECORDED') throw err;
    c.var.log.info({ userId: user._id.toHexString() }, 'replayed expense create, already recorded');
  }

  c.header('Cache-Control', 'no-store');
  return c.json(await currentExpenses(user, now), 201);
});

/**
 * The label an entry is stored with.
 *
 * For a pick-list field the option id is looked up in the content and its **name** stored, because that is
 * what the entry row shows and what an archived month keeps forever. For the "Other" list's free-text
 * option the reader's own words win — that is the whole purpose of `opensFreeText`.
 */
function resolveLabel(
  field: string | undefined,
  optionId: string | null,
  freeText: string | null,
  categoryName: string,
): string {
  const picklists = getContent().picklists.value;

  if (field === 'transportMode' || field === 'otherType') {
    const options = field === 'transportMode' ? picklists.transport : picklists.other;
    const option = options.find((candidate) => candidate.id === optionId);
    if (option === undefined) {
      throw new ApiError('VALIDATION_FAILED', `optionId "${optionId ?? ''}" is not in the ${field} list`);
    }
    // The one option that asks the reader to type what it actually was.
    if (option.opensFreeText === true && freeText !== null && freeText !== '') return freeText;
    return option.name;
  }

  // A text field. Empty is allowed — `source` is optional — and falls back to the category's own name,
  // which is what the design's rows show for an unlabelled entry.
  return freeText !== null && freeText !== '' ? freeText : categoryName;
}

// ── Deleting an entry ─────────────────────────────────────────────────────────────────────────

expenseRoutes.delete('/v1/expenses/:id', requireSession(), async (c) => {
  const user = c.var.user;
  const now = new Date();
  const id = c.req.param('id');

  const existing = await entries.findEntry(user._id, id);
  if (existing === null) throw new ApiError('NOT_FOUND', 'no such entry');

  // Deleting from a closed month would mutate immutable history just as surely as writing to it.
  assertLiveMonth(existing.monthKey, await liveMonthFor(user, now));

  await entries.deleteEntry(user._id, id);

  c.header('Cache-Control', 'no-store');
  return c.json(await currentExpenses(user, now));
});

// ── Fixed costs ───────────────────────────────────────────────────────────────────────────────

/**
 * `GET /v1/expenses/fixed` and `GET /v1/expenses/lines`.
 *
 * Both answer with the whole screen rather than a fragment. The client reads these paths as collections it
 * can address (`Endpoint.fixedCosts`, `Endpoint.billLines`) and has no separate model for either — so a
 * fragment would be a shape nothing decodes.
 */
expenseRoutes.get('/v1/expenses/fixed', requireSession(), async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(await currentExpenses(c.var.user, new Date()));
});

expenseRoutes.get('/v1/expenses/lines', requireSession(), async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(await currentExpenses(c.var.user, new Date()));
});

/**
 * `PUT /v1/expenses/fixed/:categoryId` — a `fixed` category's monthly amount. Rent, today.
 *
 * Keyed by **category** rather than named `rent`, so a second fixed cost is a payload change rather than a
 * new route.
 */
expenseRoutes.put('/v1/expenses/fixed/:categoryId', requireSession(), async (c) => {
  const categoryId = c.req.param('categoryId');
  const category = categoryById.get(categoryId as never);
  if (category?.kind !== 'fixed') {
    throw new ApiError('VALIDATION_FAILED', `${categoryId} is not a fixed-cost category`);
  }

  const input = await body(c, z.object({ amount: moneyInputSchema }));
  const user = c.var.user;
  const now = new Date();

  await fixedCosts.setRent(user._id, input.amount, now);

  c.header('Cache-Control', 'no-store');
  return c.json(await currentExpenses(user, now));
});

/**
 * `PUT /v1/expenses/lines/:categoryId` — a `lines` category's whole set of bills, replaced.
 *
 * One request for the whole set, because that is the gesture the design has: the reader edits a card of
 * bills and saves it. Replacing rather than merging is also what makes a *deleted* line expressible.
 *
 * A line arrives with an optional id — absent for a new one. Ids are minted here rather than by the client
 * so that a line's identity is server-owned and survives a rename, which is what lets the archive carry it
 * forward.
 */
expenseRoutes.put('/v1/expenses/lines/:categoryId', requireSession(), async (c) => {
  const categoryId = c.req.param('categoryId');
  const category = categoryById.get(categoryId as never);
  if (category?.kind !== 'lines') {
    throw new ApiError('VALIDATION_FAILED', `${categoryId} is not a bill-lines category`);
  }

  const input = await body(
    c,
    z.object({
      lines: z
        .array(
          z.object({
            id: z.string().min(1).max(100).nullish(),
            name: z.string().trim().min(1).max(100),
            amount: moneyInputSchema,
          }),
        )
        // A bound, because this replaces the whole set and an unbounded array is an unbounded document.
        .max(50),
    }),
  );

  const user = c.var.user;
  const now = new Date();

  const seen = new Set<string>();
  const lines = input.lines.map((line) => {
    // A repeated id would make two lines share an identity, so a duplicate is treated as a new line.
    const id = line.id !== null && line.id !== undefined && !seen.has(line.id) ? line.id : randomUUID();
    seen.add(id);
    return { id, name: line.name, amount: line.amount };
  });

  await fixedCosts.setUtilityLines(user._id, lines, user.displayCurrency, now);

  c.header('Cache-Control', 'no-store');
  return c.json(await currentExpenses(user, now));
});

/** Re-exported so the seed script and the rollover job share one icon rule. */
export { utilityIconFor };

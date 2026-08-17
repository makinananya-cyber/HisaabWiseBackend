#!/usr/bin/env node
/**
 * Seeds the Feb–Jul 2026 archive months for one account, so Reports has something to render in dev.
 *
 * **Dev and staging only.** These months are seed data (workspace content rules), and the script refuses a
 * URI that looks like production — it writes into `month_archives`, which is immutable history and the one
 * collection where fabricated data would be indistinguishable from real.
 *
 *   npm run seed:archives -- someone@example.ae
 *
 * The figures are the design's own archive, converted to the account's authored currency at seed time so the
 * numbers look like a plausible six months rather than a repeated constant.
 */

import { MongoClient, ObjectId } from 'mongodb';

const email = process.argv[2];
if (!email) {
  console.error('Usage: npm run seed:archives -- someone@example.ae');
  process.exit(1);
}

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI is not set. Put it in .env (gitignored) and re-run.');
  process.exit(1);
}

const marker = ['prod', 'production', 'live'].find((candidate) => uri.toLowerCase().includes(candidate));
if (marker) {
  console.error(
    `Refusing to run: MONGODB_URI contains "${marker}", so it may address production. This writes into ` +
      'month_archives — immutable history, and the one collection where fabricated data would be ' +
      'indistinguishable from real (workspace Rule 4).',
  );
  process.exit(1);
}

/**
 * Six months of plausible spending, as fractions of salary.
 *
 * Read off the design's `ARCHIVE` constant: rent steady, groceries and transport varying, one good month in
 * June and two weak ones. Expressed as fractions so the seed works at any salary.
 */
const MONTHS = [
  { monthKey: '2026-02', rent: 0.41, groceries: 0.23, transport: 0.05, utilities: 0.09, fun: 0.01, other: 0.02, extra: 0 },
  { monthKey: '2026-03', rent: 0.41, groceries: 0.26, transport: 0.07, utilities: 0.10, fun: 0.03, other: 0.04, extra: 0 },
  { monthKey: '2026-04', rent: 0.41, groceries: 0.20, transport: 0.04, utilities: 0.08, fun: 0.02, other: 0.03, extra: 0.02 },
  { monthKey: '2026-05', rent: 0.41, groceries: 0.24, transport: 0.06, utilities: 0.09, fun: 0.02, other: 0.03, extra: 0 },
  { monthKey: '2026-06', rent: 0.41, groceries: 0.18, transport: 0.03, utilities: 0.08, fun: 0.01, other: 0.01, extra: 0.05 },
  { monthKey: '2026-07', rent: 0.41, groceries: 0.26, transport: 0.07, utilities: 0.10, fun: 0.04, other: 0.05, extra: 0 },
];

const client = new MongoClient(uri);
try {
  await client.connect();
  const database = client.db();

  const user = await database.collection('users').findOne({ email: email.trim().toLowerCase() });
  if (!user) {
    console.error(`No account for ${email}. Register one first, then seed its archive.`);
    process.exit(1);
  }

  const salary = user.salary;
  const goal = user.savingsGoal;
  const rateSet = await database.collection('fx_rates').findOne({}, { sort: { dateKey: -1 } });
  if (!rateSet) {
    console.error('No FX rate set. Run `npm run seed:fx` first — an archive pins the set it closed with.');
    process.exit(1);
  }

  const at = (fraction) => ({
    minor: Math.round(salary.minor * fraction),
    currency: salary.currency,
    exponent: salary.exponent,
  });

  let written = 0;
  let skipped = 0;

  for (const month of MONTHS) {
    const rent = at(month.rent);
    const utilities = at(month.utilities);
    const groceries = at(month.groceries);
    const transport = at(month.transport);
    const fun = at(month.fun);
    const other = at(month.other);
    const extra = at(month.extra);

    const income = salary.minor + extra.minor;
    const needs = rent.minor + utilities.minor + groceries.minor;
    const wants = transport.minor + fun.minor + other.minor;

    const net = income - needs - wants;
    const saved = Math.max(0, net);
    // The same threshold table the engine uses: hit ≥ 100%, near ≥ 70%, miss otherwise.
    const achieved = goal.minor === 0 ? 100 : Math.round((saved / goal.minor) * 100);
    const verdict = achieved >= 100 ? 'hit' : achieved >= 70 ? 'near' : 'miss';

    // A day inside the month, so the entry timestamps look like a real month rather than all at midnight.
    const dayIn = (day) => new Date(`${month.monthKey}-${String(day).padStart(2, '0')}T09:30:00Z`);
    const entry = (id, category, amount, label, day) => ({
      id: `${month.monthKey}-${id}`,
      category,
      amount,
      label,
      entryDate: dayIn(day),
    });

    const document = {
      userId: new ObjectId(user._id),
      monthKey: month.monthKey,
      salary,
      goal,
      saved: { ...salary, minor: saved },
      net: { ...salary, minor: net },
      verdict,
      adapted: needs * 2 > income,
      entries: [
        entry('g1', 'groceries', at(month.groceries / 2), 'Groceries', 4),
        entry('g2', 'groceries', at(month.groceries / 2), 'Groceries', 18),
        entry('t1', 'transport', transport, 'Metro / subway', 7),
        entry('e1', 'entertainment', fun, 'Cinema', 12),
        entry('o1', 'other', other, 'Medical & pharmacy', 21),
        ...(month.extra > 0 ? [entry('i1', 'income', extra, 'Freelance design work', 9)] : []),
      ].filter((candidate) => candidate.amount.minor > 0),
      fixed: {
        rent,
        utilityLines: [
          { id: `${month.monthKey}-u1`, name: 'Electricity', amount: at(month.utilities * 0.64) },
          { id: `${month.monthKey}-u2`, name: 'Water', amount: at(month.utilities * 0.09) },
          { id: `${month.monthKey}-u3`, name: 'Phone / data', amount: at(month.utilities * 0.27) },
        ],
      },
      fxRateSetId: rateSet._id,
      // The 1st of the following month, which is when the job would have closed it.
      closedAt: new Date(`${month.monthKey}-28T21:00:00Z`),
    };

    try {
      await database.collection('month_archives').insertOne(document);
      written++;
      console.log(`seeded ${month.monthKey} — ${verdict}, ${String(achieved)}% of goal`);
    } catch (err) {
      // The unique `(userId, monthKey)` index. Re-running is a no-op, exactly as the job's own re-run is.
      if (err && err.code === 11000) {
        skipped++;
        console.log(`${month.monthKey} already archived, left alone`);
      } else {
        throw err;
      }
    }
  }

  console.log(`\n${String(written)} month(s) seeded, ${String(skipped)} already present, for ${email}`);
} finally {
  await client.close();
}

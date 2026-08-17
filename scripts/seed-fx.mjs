#!/usr/bin/env node
/**
 * Seeds today's `fx_rates` document from `content/fx-seed.json`.
 *
 * **A seed, not a fallback.** Nothing reads `fx-seed.json` at request time: an unknown code at conversion
 * time is an error and never rate 1.0 (defect D15), and a missing rate set fails loudly rather than being
 * quietly substituted — which is what a code-level fallback becomes the first time a provider outage
 * lasts a day. This exists so slice 3 is not blocked on procuring an FX provider (BACKEND_PLAN §7), and
 * the live `fx:refresh` job replaces it in slice 8 without anything else changing.
 *
 * **Guarded against production** (Rule 4). It writes, so it refuses a URI that looks like production. The
 * rates are the prototype's indicative snapshot, not market data, and putting them in front of real users
 * would show them wrong conversions with full confidence.
 *
 *   npm run seed:fx
 *   npm run seed:fx -- --force    # overwrite today's set
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { MongoClient } from 'mongodb';

const force = process.argv.includes('--force');

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI is not set. Put it in .env (gitignored) and re-run.');
  process.exit(1);
}

// The same guard the test harness uses, for the same reason: this script writes, and the indicative rates
// it writes must never reach real users.
const marker = ['prod', 'production', 'live'].find((candidate) => uri.toLowerCase().includes(candidate));
if (marker) {
  console.error(
    `Refusing to run: MONGODB_URI contains "${marker}", so it may address production. These are the ` +
      'prototype\'s indicative rates, not market data — seeding them into production would show real ' +
      'users wrong conversions with full confidence (workspace Rule 4).',
  );
  process.exit(1);
}

const contentDir = path.join(import.meta.dirname, '..', 'content');
const seed = JSON.parse(readFileSync(path.join(contentDir, 'fx-seed.json'), 'utf8'));
const currencies = JSON.parse(readFileSync(path.join(contentDir, 'reference', 'currencies.json'), 'utf8'));

const required = currencies.currencies.map((currency) => currency.code);
const missing = required.filter((code) => !(seed.rates[code] > 0));
if (missing.length > 0) {
  console.error(`content/fx-seed.json is incomplete — no rate for: ${missing.join(', ')}`);
  process.exit(1);
}

// The seed is dated **today**, so `latestRateSet()` finds it. Dating it in the past would leave every
// conversion reading a set that a real `fx:refresh` would immediately supersede.
const dateKey = new Date().toISOString().slice(0, 10);

const client = new MongoClient(uri);
try {
  await client.connect();
  const rates = client.db().collection('fx_rates');

  const existing = await rates.findOne({ dateKey });
  if (existing && !force) {
    console.log(`fx_rates already has ${dateKey} (${String(Object.keys(existing.rates).length)} codes). Pass --force to overwrite.`);
  } else {
    await rates.replaceOne(
      { dateKey },
      { dateKey, base: 'USD', rates: seed.rates, fetchedAt: new Date() },
      { upsert: true },
    );
    console.log(`seeded fx_rates for ${dateKey} with ${String(required.length)} codes`);
  }

  const total = await rates.countDocuments();
  console.log(`fx_rates now holds ${String(total)} rate set(s)`);
} finally {
  await client.close();
}

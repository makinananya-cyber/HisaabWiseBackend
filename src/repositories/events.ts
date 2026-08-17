import { ObjectId, type OptionalId } from 'mongodb';
import { z } from 'zod';

import { collection, COLLECTIONS } from './collections';

/**
 * The `events` collection — product metrics, in place of a third-party analytics SDK.
 *
 * Third-party analytics is explicitly out of scope, so this is where activation and funnel questions get
 * answered. It exists in slice 7 rather than slice 8 for one reason: **activation metrics cannot be
 * backfilled.** A funnel that starts collecting the week after launch has no launch week in it.
 *
 * **Writes are unauthenticated**, because the events worth having start before there is an account —
 * "opened the app", "reached step 2 of registration". That makes the allowlist load-bearing rather than
 * tidy: without it this is an unauthenticated write endpoint into an unbounded collection.
 *
 * `installId` is what stitches a pre-account session to the account it becomes, so activation is measurable
 * across the registration boundary without a login.
 */

/**
 * The events this build accepts, with the prop keys each may carry.
 *
 * **A closed set, with declared props.** An unknown name is refused rather than stored: an unauthenticated
 * writer must not be able to choose collection contents, and an event nobody declared is one nobody will
 * query. Props are filtered to the declared keys for the same reason — an arbitrary object on an
 * unauthenticated write is a place to put anything at all.
 */
export const EVENT_ALLOWLIST: Record<string, readonly string[]> = {
  app_opened: [],
  landing_viewed: [],
  registration_started: [],
  registration_step_completed: ['step'],
  registration_completed: [],
  signed_in: [],
  expense_logged: ['categoryId'],
  lesson_started: ['lessonId'],
  lesson_completed: ['lessonId', 'correct', 'total'],
  curriculum_pdf_downloaded: [],
  report_month_opened: ['monthKey'],
  currency_changed: ['currency'],
  language_changed: ['language'],
  account_deletion_requested: [],
};

export const isAllowedEvent = (name: string): boolean => name in EVENT_ALLOWLIST;

const eventSchema = z.object({
  _id: z.instanceof(ObjectId),
  userId: z.instanceof(ObjectId).nullable(),
  installId: z.string().nullable(),
  name: z.string(),
  props: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  clientTs: z.date().nullable(),
  receivedAt: z.date(),
});

export type StoredEvent = z.infer<typeof eventSchema>;

const events = () => collection<OptionalId<StoredEvent>>(COLLECTIONS.events);

export interface NewEvent {
  readonly userId: ObjectId | null;
  readonly installId: string | null;
  readonly name: string;
  readonly props: Record<string, string | number | boolean>;
  readonly clientTs: Date | null;
}

/**
 * Record a batch of events.
 *
 * Props are narrowed to the declared keys here rather than at the route, so there is one place the allowlist
 * is enforced and no path around it. An unknown name is dropped rather than throwing: a batch is
 * fire-and-forget from the client's point of view, and refusing the whole batch for one bad name would lose
 * the good ones.
 *
 * @returns how many were stored, so the route can report it and a caller can notice silent drops.
 */
export async function recordEvents(batch: readonly NewEvent[], now: Date): Promise<number> {
  const documents = batch
    .filter((event) => isAllowedEvent(event.name))
    .map((event) => {
      const declared = EVENT_ALLOWLIST[event.name] ?? [];
      const props: Record<string, string | number | boolean> = {};
      for (const key of declared) {
        const value = event.props[key];
        if (value !== undefined) props[key] = value;
      }

      return {
        userId: event.userId,
        installId: event.installId,
        name: event.name,
        props,
        clientTs: event.clientTs,
        receivedAt: now,
      };
    });

  if (documents.length === 0) return 0;
  await events().insertMany(documents);
  return documents.length;
}

/**
 * Attach a user id to the events an install recorded before registering.
 *
 * This is what makes activation measurable across the registration boundary: the funnel from "opened the
 * app" to "completed registration" is one install's events, and half of them predate the account.
 */
export async function stitchInstall(installId: string, userId: ObjectId): Promise<number> {
  const { modifiedCount } = await events().updateMany(
    { installId, userId: null },
    { $set: { userId } },
  );
  return modifiedCount;
}

/** Erase a user's events. For the hard purge. */
export async function deleteAllForUser(userId: ObjectId): Promise<number> {
  const { deletedCount } = await events().deleteMany({ userId });
  return deletedCount;
}

/** Every event for a user, oldest first — for the data export. */
export async function forUser(userId: ObjectId): Promise<StoredEvent[]> {
  const documents = await events().find({ userId }).sort({ receivedAt: 1 }).toArray();
  return documents.map((document) => eventSchema.parse(document));
}

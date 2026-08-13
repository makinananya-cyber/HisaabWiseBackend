import type { OptionalId } from 'mongodb';
import { z } from 'zod';

import { collection, COLLECTIONS } from './collections';

/**
 * The `deletion_tombstones` collection — proof that an account was erased.
 *
 * **A hash of the user id and a timestamp, and nothing else.** That is the whole design: an operator asked
 * "was this account erased?" can answer, and the answer keeps nothing about the person. Erasure is
 * *evidenced* rather than merely invisible, which is the difference between a system that can demonstrate
 * compliance and one that can only assert it.
 *
 * The Technical Spec requires this in §6.4 and then omitted it from its own collection count; DATA_MODEL
 * §3.10 counts it honestly as the tenth collection beside the nine.
 */

/**
 * Two fields, so there is no read boundary to parse: nothing above this layer reads a tombstone's contents,
 * only whether one exists. The schema is here as the written shape.
 */
export const tombstoneSchema = z.object({
  userIdHash: z.string().length(64),
  purgedAt: z.date(),
});

export type Tombstone = z.infer<typeof tombstoneSchema>;

const tombstones = () => collection<OptionalId<Tombstone>>(COLLECTIONS.deletionTombstones);

/** Record an erasure. Idempotent by upsert: a re-run of a partial purge must not add a second stone. */
export async function record(userIdHash: string, purgedAt: Date): Promise<void> {
  await tombstones().updateOne({ userIdHash }, { $setOnInsert: { userIdHash, purgedAt } }, { upsert: true });
}

/** Whether an id was erased. The question the collection exists to answer. */
export const wasPurged = async (userIdHash: string): Promise<boolean> =>
  (await tombstones().countDocuments({ userIdHash }, { limit: 1 })) > 0;

export const count = async (): Promise<number> => tombstones().countDocuments();

import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * One fixture from the synced contract corpus.
 *
 * The corpus is the client's own decoded payloads (ADR-0017), so a fixture is the definition of done for
 * the endpoint that produces it. Read from disk per call rather than cached: they are small, tests read a
 * handful each, and a cached mutable object shared across suites is a way for one test to corrupt
 * another's expectation.
 */
export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'contract', 'corpus', name), 'utf8'));

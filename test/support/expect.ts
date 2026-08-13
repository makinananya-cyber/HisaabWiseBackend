/**
 * Narrow an optional to its value, failing the test if it is absent.
 *
 * Tests read headers and look ids up in maps, both of which are optional at the type level and
 * neither of which is optional at the point the test cares. A non-null assertion would say so and
 * is banned by lint for good reason — it hides a real `undefined` behind a crash three lines later.
 * This says the same thing and, when it is wrong, names what was missing.
 */
export function required<Value>(value: Value | null | undefined, what: string): Value {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what} to be present, got ${String(value)}`);
  }
  return value;
}

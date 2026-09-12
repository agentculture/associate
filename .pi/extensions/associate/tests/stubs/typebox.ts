/**
 * A minimal stand-in for pi's `typebox`.
 *
 * `typebox` is provided by the pi runtime and is not resolvable from a bare
 * `node --test` in this repo (the extension declares no npm dependency, spec
 * c44). `tests/load-extension.ts` rewrites `index.ts`'s `"typebox"` specifier
 * to this file so the entry point can be exercised — its tool *registrations*
 * and its hook wiring — without installing anything.
 *
 * TypeBox schemas are plain JSON Schema objects, so these builders return the
 * same shape TypeBox would. They validate nothing; the tests that use them
 * assert on registration, not on schema behaviour.
 */

type Options = Record<string, unknown>;

export const Type = {
  Object(properties: Record<string, unknown>, options: Options = {}) {
    const required = Object.entries(properties)
      .filter(([, value]) => !(value as { __optional?: boolean })?.__optional)
      .map(([key]) => key);
    return { type: "object", properties, required, ...options };
  },
  String(options: Options = {}) {
    return { type: "string", ...options };
  },
  Number(options: Options = {}) {
    return { type: "number", ...options };
  },
  Boolean(options: Options = {}) {
    return { type: "boolean", ...options };
  },
  Array(items: unknown, options: Options = {}) {
    return { type: "array", items, ...options };
  },
  Optional(schema: unknown) {
    return { ...(schema as Options), __optional: true };
  },
};

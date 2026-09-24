// Small reusable type-guard primitives shared across server, web, and daemon.

/**
 * Build a type guard for membership in a fixed set of string literals.
 *
 * `Set.has(x)` and `Array.includes(x)` accept the element type, so TypeScript
 * cannot use them to narrow a `string` (or `unknown`) down to the literal
 * union — call sites end up validating and then casting (`x as Foo`). This
 * factory returns a user-defined type guard, so the narrowing is sound and the
 * cast disappears:
 *
 *   const KINDS = ["turn", "step", "observation"] as const;
 *   type Kind = (typeof KINDS)[number];
 *   const isKind = makeIsMember(KINDS); // (x: unknown) => x is Kind
 *
 *   if (isKind(raw)) {
 *     // raw is now `Kind` here — no `raw as Kind` needed.
 *   }
 *
 * The `const` type parameter preserves the exact literal tuple, so the guarded
 * type is the precise union and adding/removing a member updates it for free.
 */
export function makeIsMember<const T extends readonly string[]>(
  members: T,
): (value: unknown) => value is T[number] {
  const set = new Set<string>(members);
  return (value: unknown): value is T[number] => typeof value === "string" && set.has(value);
}

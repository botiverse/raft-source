export type ScopeDbPersistenceTier =
  | "authoritative_durable"
  | "decision_support"
  | "best_effort";

export type ScopeDbIntegerUse = "bounded_count" | "unbounded_i64";

export function scopeDbReadOptionsFor(
  use: ScopeDbIntegerUse,
): { integerMode: "number" | "string" } {
  switch (use) {
    case "bounded_count":
      return { integerMode: "number" };
    case "unbounded_i64":
      return { integerMode: "string" };
  }
}

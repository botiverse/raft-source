/**
 * Minimum length for a NEWLY chosen server slug. Historical servers may carry
 * shorter slugs, so this floor applies only when a slug is being created —
 * never when an existing slug is referenced (lookups, invites, routing).
 */
export const SERVER_SLUG_MIN_LENGTH = 5;

/** Most characters a server name may have (trimmed), on create and on rename. */
export const SERVER_NAME_MAX_LENGTH = 100;

const SERVER_SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;

export type ServerSlugReferenceValidationReason =
  | { code: "required" }
  | { code: "pattern" };

export type ServerSlugValidationReason =
  | ServerSlugReferenceValidationReason
  | { code: "too_short"; minLength: number };

/**
 * Format validation for a slug that REFERENCES an existing server (joint
 * channel invites, lookups, routing). Server slugs start with a lowercase
 * ASCII letter and then contain only lowercase ASCII letters, digits, or
 * hyphens. Deliberately no minimum length: existing servers created before
 * the creation-time floor may have slugs shorter than
 * {@link SERVER_SLUG_MIN_LENGTH}, and they must stay addressable.
 */
export function validateServerSlugReferenceReason(
  slug: unknown,
): ServerSlugReferenceValidationReason | null {
  if (typeof slug !== "string" || slug.length === 0) {
    return { code: "required" };
  }
  if (!SERVER_SLUG_PATTERN.test(slug)) {
    return { code: "pattern" };
  }
  return null;
}

/**
 * Validation for a slug being CREATED (new server). Adds the
 * {@link SERVER_SLUG_MIN_LENGTH} floor on top of the reference format rules.
 * Any future "change slug to a new value" path must use this too.
 */
export function validateNewServerSlugReason(slug: unknown): ServerSlugValidationReason | null {
  if (typeof slug !== "string" || slug.length === 0) {
    return { code: "required" };
  }
  if (slug.length < SERVER_SLUG_MIN_LENGTH) {
    return { code: "too_short", minLength: SERVER_SLUG_MIN_LENGTH };
  }
  return validateServerSlugReferenceReason(slug);
}

/** API error copy for {@link validateNewServerSlugReason}. */
export function validateNewServerSlug(slug: unknown): string | null {
  const reason = validateNewServerSlugReason(slug);
  switch (reason?.code) {
    case "required":
      return "Slug is required";
    case "too_short":
      return `Slug must be at least ${reason.minLength} characters`;
    case "pattern":
      return "Slug must start with a letter and contain only lowercase letters, numbers, and hyphens";
    default:
      return null;
  }
}

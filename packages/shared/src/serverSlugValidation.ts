export const SERVER_SLUG_MIN_LENGTH = 5;

export type ServerSlugValidationReason =
  | { code: "required" }
  | { code: "too_short"; minLength: number }
  | { code: "pattern" };

/**
 * Canonical server-slug validation shared by the create-server API and every
 * client surface that accepts an existing server slug.
 *
 * Keep this intentionally narrower than a generic URL-slug helper: server
 * slugs start with a lowercase ASCII letter and then contain only lowercase
 * ASCII letters, digits, or hyphens.
 */
export function validateServerSlugReason(slug: unknown): ServerSlugValidationReason | null {
  if (typeof slug !== "string" || slug.length === 0) {
    return { code: "required" };
  }
  if (slug.length < SERVER_SLUG_MIN_LENGTH) {
    return { code: "too_short", minLength: SERVER_SLUG_MIN_LENGTH };
  }
  if (!/^[a-z][a-z0-9-]*$/.test(slug)) {
    return { code: "pattern" };
  }
  return null;
}

export function validateServerSlug(slug: unknown): string | null {
  const reason = validateServerSlugReason(slug);
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

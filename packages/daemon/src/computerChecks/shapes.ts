// Per-key shape validators. Every value a check reads from a file or a
// command passes one of these before it may appear in a report; a value of the
// wrong shape is dropped, never truncated or guessed at.
import { maskRuntimeAccountEmail, plainActionCardText } from "@botiverse/raft-shared";
import type { ValueShape } from "./types";

/** Every CLI here prints its version within its first line or two. */
export const VERSION_OUTPUT_MAX_CHARS = 512;
// Digit groups are bounded and must be whole numbers (no digit on either
// side), so a run of digits matches nothing rather than a giant "version".
const VERSION = /(?<!\d)\d{1,6}\.\d{1,6}(?:\.\d{1,6})?(?!\d)(?:[-+][0-9A-Za-z.-]{1,30})?/;

/** The first `x.y[.z][-pre][+build]` in the start of a command's output. */
export const versionShape: ValueShape = (raw) => VERSION.exec(raw.slice(0, VERSION_OUTPUT_MAX_CHARS))?.[0];

/** The origin (scheme, host, port) of an http(s) URL; path, userinfo, query and fragment never kept. */
export const registryUrlShape: ValueShape = (raw) => {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const out = url.origin;
  return out.length <= 120 ? out : undefined;
};

/** `us-east-1`, `us-gov-west-1`, `ap-southeast-2`. */
export const awsRegionShape: ValueShape = (raw) => (/^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(raw) ? raw : undefined);

/** `default` or `profile <name>` → the profile name; other sections (`sso-session`, `services`) dropped. */
export const awsProfileSectionShape: ValueShape = (raw) => {
  if (raw === "default") return raw;
  const name = /^profile\s+([A-Za-z0-9_.-]{1,64})$/.exec(raw)?.[1];
  return name;
};

/** GitHub username: alphanumerics and single inner hyphens, at most 39. */
export const githubLoginShape: ValueShape = (raw) =>
  /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(raw) ? raw : undefined;

export const hostnameShape: ValueShape = (raw) =>
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(raw)
    ? raw.toLowerCase()
    : undefined;

/** gcloud configuration names: lowercase letters, digits and hyphens. */
export const gcloudConfigNameShape: ValueShape = (raw) => (/^[a-z][a-z0-9-]{0,62}$/.test(raw) ? raw : undefined);

/** Only ever the masked form (`abc****fghij@example.com`). */
export const maskedEmailShape: ValueShape = (raw) => maskRuntimeAccountEmail(raw);

/**
 * A person's display name (git `user.name`): short, and nothing the shared
 * plain-text rule (`plainActionCardText`) would remove or change: no C0/C1
 * control, tab, line or paragraph separator, or format character (bidi
 * marks, overrides and isolates, zero-width characters, the BOM, tag
 * characters). Such a name is dropped, not cleaned, like every other shape.
 * A name holding an email is reported masked, or not at all. The row carries
 * `displayText` (see `CheckItem`).
 */
export const displayNameShape: ValueShape = (raw) => {
  const value = raw.trim();
  if (value.length === 0 || value.length > 80) return undefined;
  if (plainActionCardText(value, 80) !== value) return undefined;
  return value.includes("@") ? maskRuntimeAccountEmail(value) : value;
};

/** Records only that the key exists; its value is never kept. */
export const presenceShape: ValueShape = () => "present";

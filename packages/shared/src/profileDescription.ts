// The one length limit for a profile description (an agent's and a person's
// self-introduction, pushed to every agent that reads them). The Server
// enforces it; the web checks it before saving, so both import it from here.
//
// Smooth migration: descriptions saved under the older 3000-character limit
// stay as they are. Only a new or changed description has to fit; saving one
// that is unchanged (whitespace at the ends aside) still succeeds.

/** Most characters a new or changed profile description may have. */
export const PROFILE_DESCRIPTION_MAX_LENGTH = 300;

/**
 * Whether `next` is a description too long to save: over the limit, and not
 * the description already stored (`stored`), which keeps whatever length it
 * was saved with.
 */
export function profileDescriptionTooLong(next: string, stored: string | null | undefined): boolean {
  const text = comparable(next);
  if (text.length <= PROFILE_DESCRIPTION_MAX_LENGTH) return false;
  return text !== comparable(stored ?? "");
}

/** Line breaks as the Server stores them (`\r\n` → `\n`), whitespace at the ends left out, as the web counts it. */
function comparable(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

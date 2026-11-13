/**
 * How the message box sends (#triage:#210). Stored on the person's account
 * (`users.composer_send_key`), so it is the same on every device; server and
 * web both read it through here.
 *
 * - "enter" (the default; stored as null): Enter sends, Shift+Enter is a new line.
 * - "mod_enter": ⌘Enter (Apple platforms) / Ctrl+Enter (elsewhere) sends;
 *   Enter alone and Shift+Enter are new lines.
 */

export const COMPOSER_SEND_KEYS = ["enter", "mod_enter"] as const;
export type ComposerSendKey = typeof COMPOSER_SEND_KEYS[number];
export const COMPOSER_SEND_KEY_DEFAULT = "enter" satisfies ComposerSendKey;
/** What `users.composer_send_key` holds, and the profile carries: null is the default. */
export type StoredComposerSendKey = Exclude<ComposerSendKey, typeof COMPOSER_SEND_KEY_DEFAULT> | null;

/** What the account stores, read: null, absent or anything unknown is the default. */
export function normalizeComposerSendKey(value: unknown): ComposerSendKey {
  return value === "mod_enter" ? "mod_enter" : COMPOSER_SEND_KEY_DEFAULT;
}

/**
 * PATCH /auth/me's `composerSendKey`: undefined = unchanged, null or "enter"
 * = the default (stored as null, so a later default reaches everyone who
 * never chose), "mod_enter" = stored. Anything else throws.
 */
export function parseComposerSendKeyPreference(raw: unknown): StoredComposerSendKey | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "enter") return null;
  if (raw === "mod_enter") return "mod_enter";
  throw new Error("composerSendKey must be \"enter\", \"mod_enter\", or null");
}

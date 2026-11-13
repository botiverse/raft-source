// A form sheet's local draft (question-card spec §5.3, D10): what the person
// has filled in so far and the page they were on, kept in this tab's
// sessionStorage under the person, the card's message and its form, so
// closing the sheet and
// opening it again picks up where they stopped. Only on this device: nothing
// is sent, nobody else sees it: the key names the signed-in person (no one
// signed in, no draft), and signing out or another account signing in on
// another tab drops every draft (authStore, forgetActionCardFormDrafts). Kept for a form with steps and for a question
// card's form; cleared on a successful submit and once the card has ended.
// sessionStorage can be missing or throw (private modes, a full quota, a
// sandboxed frame): every access is guarded, and a draft that can't be kept
// is simply not kept.

import type { ActionCardFormValue } from "@botiverse/raft-shared";

const PREFIX = "raft.actionCardFormDraft.v1.";

export interface ActionCardFormDraft {
  /** The page the person was on (0-based). */
  page: number;
  values: Record<string, ActionCardFormValue>;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The storage key of one person's draft of one form of one card; null when nobody is signed in (no draft). */
export function actionCardFormDraftKey(userId: string | null | undefined, messageId: string, formId: string): string | null {
  return userId ? `${PREFIX}${userId}.${messageId}.${formId}` : null;
}

/** The draft under `key`, or null (none, unreadable, or not a draft's shape). */
export function readActionCardFormDraft(key: string): ActionCardFormDraft | null {
  try {
    const raw = storage()?.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { page, values } = parsed as { page?: unknown; values?: unknown };
    if (typeof page !== "number" || !Number.isInteger(page) || page < 0) return null;
    if (typeof values !== "object" || values === null || Array.isArray(values)) return null;
    return { page, values: values as Record<string, ActionCardFormValue> };
  } catch {
    return null;
  }
}

/** Keeps the draft; false when it could not be kept (no storage, or it threw). */
export function writeActionCardFormDraft(key: string, draft: ActionCardFormDraft): boolean {
  try {
    const store = storage();
    if (!store) return false;
    store.setItem(key, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function removeActionCardFormDraft(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    // Nothing to do: the draft goes with the tab.
  }
}

/** Removes every form draft of a card, whoever's (it ended: answered, expired, withdrawn). */
export function clearActionCardFormDrafts(messageId: string): void {
  removeWhere((rest) => rest.split(".")[1] === messageId);
}

/** Removes every form draft in this tab: signing out, or another account signed in. */
export function forgetActionCardFormDrafts(): void {
  removeWhere(() => true);
}

/** Removes the drafts whose key, past the prefix (`<userId>.<messageId>.<formId>`), matches. */
function removeWhere(matches: (rest: string) => boolean): void {
  try {
    const store = storage();
    if (!store) return;
    const keys: string[] = [];
    for (let index = 0; index < store.length; index++) {
      const key = store.key(index);
      if (key?.startsWith(PREFIX) && matches(key.slice(PREFIX.length))) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    // As removeActionCardFormDraft.
  }
}

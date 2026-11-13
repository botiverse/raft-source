import type { IntlShape } from "react-intl";
import type { KbdKeyName, KeyboardPlatform } from "@botiverse/raft-ui/wip";
import type { MessageId } from "../i18n/messages/en";
import { matchCombo } from "../features/shortcuts/match";

export interface KeyboardShortcutEvent {
  key: string;
  /** The physical key: ⌥ changes `key` on macOS (⌥M types "µ"), not `code`. */
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

export function isApplePlatform(platform: string | null | undefined): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform ?? "");
}

/**
 * The keyboard raft-ui's KbdShortcut draws for, from the same `navigator.platform`
 * the app's matchers read, so a cap never says ⌘ where the app listens for Ctrl.
 * Passed to KbdShortcut explicitly rather than its own detection
 * (`useKeyboardPlatform`), which reads Client Hints first.
 */
export function keyboardPlatform(
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): KeyboardPlatform {
  return isApplePlatform(platform) ? "mac" : "other";
}

/**
 * One shortcut as the app writes it. `mod` is ⌘ on Apple platforms and Ctrl
 * elsewhere; `key` is the key as KbdShortcut names it and `KeyboardEvent.key`
 * reports it (K, Enter, ArrowUp, F10).
 */
export interface ShortcutCombo {
  key: string;
  mod?: boolean;
  /** The Control key on Apple platforms (⌃), which a person may record there; elsewhere Ctrl is `mod`. */
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

/** The modifiers of a combo, the same for every key they go with. */
export type ShortcutModifiers = Pick<ShortcutCombo, "mod" | "ctrl" | "alt" | "shift">;

/** The combo as KbdShortcut's key names, one cap each: `["mod", "shift", "Enter"]`. */
export function shortcutKeyNames(combo: ShortcutCombo): KbdKeyName[] {
  const names: KbdKeyName[] = [];
  if (combo.mod) names.push("mod");
  if (combo.ctrl) names.push("ctrl");
  if (combo.alt) names.push("alt");
  if (combo.shift) names.push("shift");
  names.push(combo.key);
  return names;
}

/**
 * A shortcut as one string, for the current platform only: Apple platforms
 * join the symbols (⌘⌥M, ⇧Enter), other platforms spell the modifiers with a
 * plus (Ctrl+Alt+M, Shift+Enter; the words come from `common.shortcut.*`).
 * For the places that take a string: a menu's shortcut (Raft DS › Kbd, Menus:
 * no caps, written the platform's way) and the search trigger. Anywhere caps
 * are drawn, use KbdShortcut with `shortcutKeyNames`.
 */
export function formatShortcut(
  combo: ShortcutCombo,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
  formatMessage?: IntlShape["formatMessage"],
): string {
  if (isApplePlatform(platform)) {
    return `${combo.mod ? "⌘" : ""}${combo.ctrl ? "⌃" : ""}${combo.alt ? "⌥" : ""}${combo.shift ? "⇧" : ""}${combo.key}`;
  }
  const words: string[] = [];
  if (combo.mod || combo.ctrl) words.push(formatMessage ? formatMessage({ id: "common.shortcut.ctrl" }) : "Ctrl");
  if (combo.alt) words.push(formatMessage ? formatMessage({ id: "common.shortcut.alt" }) : "Alt");
  if (combo.shift) words.push(formatMessage ? formatMessage({ id: "common.shortcut.shift" }) : "Shift");
  return [...words, combo.key].join("+");
}

/** The words a screen reader says for a named key or a punctuation key (raft-ui KbdShortcut's own are English). */
const SPOKEN_KEYS: Readonly<Record<string, MessageId>> = {
  ArrowUp: "keyboardShortcuts.key.arrowUp",
  ArrowDown: "keyboardShortcuts.key.arrowDown",
  ArrowLeft: "keyboardShortcuts.key.arrowLeft",
  ArrowRight: "keyboardShortcuts.key.arrowRight",
  "/": "keyboardShortcuts.key.slash",
  "\\": "keyboardShortcuts.key.backslash",
  ".": "keyboardShortcuts.key.period",
  ",": "keyboardShortcuts.key.comma",
  "[": "keyboardShortcuts.key.leftBracket",
  "]": "keyboardShortcuts.key.rightBracket",
  "-": "keyboardShortcuts.key.minus",
  "=": "keyboardShortcuts.key.equals",
  ";": "keyboardShortcuts.key.semicolon",
  "'": "keyboardShortcuts.key.singleQuote",
  "`": "keyboardShortcuts.key.backtick",
};

/**
 * A shortcut in words, in the reader's language, for KbdShortcut's `label` (Raft DS › Kbd: its own words are
 * English; "pass `label` with the product's own words in another language"). The keys in the order KbdShortcut draws
 * them: on Apple platforms Option, Shift, Command (⌥⇧⌘), elsewhere Control, Alt, Shift; Return on a Mac, Enter
 * elsewhere; a letter, digit or F-key as written.
 */
export function shortcutSpokenLabel(
  combo: ShortcutCombo,
  formatMessage: IntlShape["formatMessage"],
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): string {
  const apple = isApplePlatform(platform);
  const words: string[] = [];
  const say = (id: MessageId) => words.push(formatMessage({ id }));
  if (apple) {
    if (combo.ctrl) say("keyboardShortcuts.key.control");
    if (combo.alt) say("keyboardShortcuts.key.option");
    if (combo.shift) say("common.shortcut.shift");
    if (combo.mod) say("keyboardShortcuts.key.command");
  } else {
    if (combo.mod || combo.ctrl) say("keyboardShortcuts.key.control");
    if (combo.alt) say("common.shortcut.alt");
    if (combo.shift) say("common.shortcut.shift");
  }
  if (combo.key === "Enter") say(apple ? "keyboardShortcuts.key.return" : "keyboardShortcuts.key.enter");
  else if (SPOKEN_KEYS[combo.key]) say(SPOKEN_KEYS[combo.key]!);
  else words.push(combo.key);
  return words.join(" ");
}

export const GLOBAL_SEARCH_SHORTCUT: ShortcutCombo = { mod: true, key: "K" };
export const COMMENT_SHORTCUT: ShortcutCombo = { mod: true, alt: true, key: "M" };
export const SIDEBAR_TOGGLE_SHORTCUT: ShortcutCombo = { mod: true, key: "\\" };
export const SHORTCUT_HELP_SHORTCUT: ShortcutCombo = { mod: true, key: "/" };
/** Send as task from the composer (MessageInput handles it, with ⌘ or Ctrl on any platform). */
export const SEND_AS_TASK_SHORTCUT: ShortcutCombo = { mod: true, shift: true, key: "Enter" };

/** ⌘K / Ctrl+K, through the registry's one matcher (features/shortcuts/match.ts): ⌘K on a Russian layout too. */
export function isGlobalSearchShortcut(
  event: KeyboardShortcutEvent,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  return matchCombo(event, GLOBAL_SEARCH_SHORTCUT, keyboardPlatform(platform));
}

export function getGlobalSearchShortcutLabel(
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
  formatMessage?: IntlShape["formatMessage"],
): string {
  return formatShortcut(GLOBAL_SEARCH_SHORTCUT, platform, formatMessage);
}

/**
 * Find (⌘F on Apple platforms, Ctrl+F elsewhere): Search in this thread, an Artifact's find in
 * page. Not with ⌥ or ⇧.
 */
export function isFindShortcut(
  event: KeyboardShortcutEvent,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  if (event.key.toLowerCase() !== "f") return false;
  if (event.altKey || event.shiftKey) return false;
  return isApplePlatform(platform) ? !!event.metaKey && !event.ctrlKey : !!event.ctrlKey && !event.metaKey;
}

/**
 * Undo in an Artifact's comment drafts (ArtifactReviewParts): ⌘Z / Ctrl+Z, either
 * modifier on any platform, not with ⌥ or ⇧.
 */
export function isDraftUndoShortcut(event: KeyboardShortcutEvent): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return false;
  return event.key.toLowerCase() === "z" && !event.shiftKey;
}

/**
 * Redo in an Artifact's comment drafts (ArtifactReviewParts): ⇧⌘Z / Ctrl+Shift+Z, or
 * ⌘Y / Ctrl+Y; either modifier on any platform, not with ⌥.
 */
export function isDraftRedoShortcut(event: KeyboardShortcutEvent): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return false;
  const key = event.key.toLowerCase();
  return (key === "z" && !!event.shiftKey) || (key === "y" && !event.shiftKey);
}

/**
 * An Artifact comment box that also keeps drafts (ArtifactCommentBox): Enter does
 * one of Send and Save Draft, ⌘Enter / Ctrl+Enter (either modifier) the other.
 * Not with ⇧, which is a new line.
 */
export function isCommentOtherActionShortcut(event: KeyboardShortcutEvent): boolean {
  return event.key === "Enter" && !event.shiftKey && !!(event.metaKey || event.ctrlKey);
}

/**
 * Comment on the selected text in a file viewer: ⌘⌥M on Apple platforms,
 * Ctrl+Alt+M elsewhere (Google Docs' shortcut, raft-design patterns/comments.md).
 */
export function isCommentShortcut(
  event: KeyboardShortcutEvent,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  if (event.code !== "KeyM" && event.key.toLowerCase() !== "m") return false;
  if (!event.altKey || event.shiftKey) return false;
  return isApplePlatform(platform) ? !!event.metaKey && !event.ctrlKey : !!event.ctrlKey && !event.metaKey;
}

/** The same shortcut for `aria-keyshortcuts`. */
export function getCommentShortcutKeys(
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): string {
  return isApplePlatform(platform) ? "Meta+Alt+M" : "Control+Alt+M";
}

/**
 * Collapse or expand the desktop sidebar: ⌘\ on Apple platforms, Ctrl+\
 * elsewhere. Matched on the physical key too, so a keyboard layout that types
 * another character on that key still toggles.
 */
export function isSidebarToggleShortcut(
  event: KeyboardShortcutEvent,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  if (event.code !== "Backslash" && event.key !== "\\") return false;
  if (event.altKey || event.shiftKey) return false;
  return isApplePlatform(platform) ? !!event.metaKey && !event.ctrlKey : !!event.ctrlKey && !event.metaKey;
}

/** The same shortcut for `aria-keyshortcuts`. */
export function getSidebarToggleShortcutKeys(
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): string {
  return isApplePlatform(platform) ? "Meta+\\" : "Control+\\";
}

/**
 * Open or close the keyboard shortcuts panel: ⌘/ on Apple platforms, Ctrl+/
 * elsewhere. Matched on the character first, with the Shift that types it
 * (German, Spanish, Nordic layouts: Shift+7). The physical key is only the
 * fallback for a layout that types neither `/`, a zoom key, nor a Latin letter
 * or digit there (Russian types `.`): on German, Spanish, Italian, Portuguese and Nordic layouts that
 * key is `-`, and ⌘− / Ctrl+− must stay the browser's zoom out. Shift+/ on US
 * types `?`, which isn't this shortcut. The registry's one matcher (features/shortcuts/match.ts) applies this
 * rule to every dispatched shortcut.
 */
export function isShortcutHelpShortcut(
  event: KeyboardShortcutEvent,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  return matchCombo(event, SHORTCUT_HELP_SHORTCUT, keyboardPlatform(platform));
}

export function isSystemScreenshotShortcut(
  event: KeyboardShortcutEvent,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  const key = event.key.toLowerCase();
  if (isApplePlatform(platform)) {
    return !!event.metaKey
      && !!event.shiftKey
      && !event.altKey
      && (key === "3" || key === "4" || key === "5");
  }
  return key === "printscreen";
}

function isMacScreenshotModifierPrelude(
  event: KeyboardShortcutEvent,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  if (!isApplePlatform(platform) || !event.metaKey || !event.shiftKey || event.altKey) return false;
  const key = event.key.toLowerCase();
  return key === "meta" || key === "shift" || key === "control";
}

const TEXT_EDITABLE_INPUT_TYPES = new Set([
  "",
  "date",
  "datetime-local",
  "email",
  "month",
  "number",
  "password",
  "search",
  "tel",
  "text",
  "time",
  "url",
  "week",
]);

/** A field the person types in: a textarea, a text-like input, or contenteditable. */
export function isTextEditableElement(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  if (view && element instanceof view.HTMLTextAreaElement) return true;
  if (view && element instanceof view.HTMLInputElement) {
    return TEXT_EDITABLE_INPUT_TYPES.has(element.type.toLowerCase());
  }
  return !!view && element instanceof view.HTMLElement && element.isContentEditable;
}

export function blurFocusedControlForScreenshotShortcut(
  event: KeyboardShortcutEvent,
  doc = typeof document === "undefined" ? undefined : document,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  if (!doc || (!isSystemScreenshotShortcut(event, platform) && !isMacScreenshotModifierPrelude(event, platform))) return false;
  const active = doc.activeElement;
  const view = doc.defaultView;
  if (!view || !(active instanceof view.HTMLElement) || active === doc.body) return false;
  if (isTextEditableElement(active)) return false;
  active.blur();
  return true;
}

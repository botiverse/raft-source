/**
 * The keyboard shortcut that hides and shows the personal assistant's otter
 * for a while (#proj-assistant:#21). Stored on the person's account, so it is
 * the same on every device; server and web both read it through here.
 *
 * A shortcut is a canonical string: modifiers in a fixed order, then the
 * physical key's `KeyboardEvent.code`, joined by "+", e.g. "Mod+Shift+Period".
 * `Mod` is ⌘ on Apple platforms and Ctrl elsewhere; matching on `code` keeps
 * it working where ⌥ or a keyboard layout changes the character a key types.
 *
 * What the account stores (`users.assistant_otter_shortcut`):
 * - null: the default, ASSISTANT_OTTER_SHORTCUT_DEFAULT (so a later default
 *   reaches everyone who never chose one);
 * - "off": the person turned the shortcut off;
 * - a shortcut they chose.
 *
 * The default, ⌘⇧. / Ctrl+Shift+. (#proj-assistant:#21): no browser (Chrome,
 * Safari, Firefox, Edge), macOS, Windows or Raft shortcut uses it, and "."
 * sits under the same hand as ⌘/⇧. Alternates considered: ⌘⇧\ (next to
 * Raft's ⌘\ sidebar toggle, but reads as a second sidebar key) and ⌘⇧, (Edge
 * uses Ctrl+Shift+, for vertical tabs).
 */

export const ASSISTANT_OTTER_SHORTCUT_DEFAULT = "Mod+Shift+Period";
export const ASSISTANT_OTTER_SHORTCUT_OFF = "off";
/** Longest stored value ("Mod+Alt+Shift+BracketRight" is 26). */
export const ASSISTANT_OTTER_SHORTCUT_MAX_LENGTH = 40;

export type AssistantOtterShortcutModifier = "Mod" | "Alt" | "Shift";
const MODIFIER_ORDER: readonly AssistantOtterShortcutModifier[] = ["Mod", "Alt", "Shift"];

const PUNCTUATION_CODES = [
  "Period", "Comma", "Slash", "Backslash", "Semicolon", "Quote",
  "BracketLeft", "BracketRight", "Minus", "Equal", "Backquote",
] as const;

const LETTER_CODES = Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`);
const DIGIT_CODES = Array.from({ length: 10 }, (_, i) => `Digit${i}`);
const KEY_CODES: ReadonlySet<string> = new Set<string>([...LETTER_CODES, ...DIGIT_CODES, ...PUNCTUATION_CODES]);

export type AssistantOtterShortcut = {
  modifiers: readonly AssistantOtterShortcutModifier[];
  /** `KeyboardEvent.code` of the key. */
  code: string;
};

/**
 * Combos a browser, the OS or Raft already uses, with Mod and the given
 * extras. Mod with a letter or digit alone is refused as a class (browsers
 * claim nearly all of them), so this lists the ⇧ and ⌥ ones and punctuation.
 */
const RESERVED: ReadonlySet<string> = new Set([
  // Raft: ⌘\ sidebar, ⌘/ shortcut panel (#12637), ⌘, settings (desktop), ⌘[ ⌘] history, ⌘⇧[ ⌘⇧] servers (desktop), ⌘⌥M comment, ⌘⌥I devtools (desktop)
  "Mod+Backslash", "Mod+Slash", "Mod+Comma", "Mod+BracketLeft", "Mod+BracketRight",
  "Mod+Shift+BracketLeft", "Mod+Shift+BracketRight", "Mod+Alt+KeyM", "Mod+Alt+KeyI",
  // Zoom, and ⌘. (cancel on macOS)
  "Mod+Minus", "Mod+Equal", "Mod+Shift+Equal", "Mod+Period",
  // Browsers with ⇧: reopen tab, new incognito/private window, close window, quit/log out, hard reload,
  // devtools, console, inspect, bookmarks bar/manager/all tabs, tab search, profiles, downloads,
  // history, find previous, full screen, paste plain, redo, screenshots, help search
  "Mod+Shift+KeyT", "Mod+Shift+KeyN", "Mod+Shift+KeyP", "Mod+Shift+KeyW", "Mod+Shift+KeyQ", "Mod+Shift+KeyR",
  "Mod+Shift+KeyI", "Mod+Shift+KeyJ", "Mod+Shift+KeyK", "Mod+Shift+KeyC", "Mod+Shift+KeyE",
  "Mod+Shift+KeyB", "Mod+Shift+KeyO", "Mod+Shift+KeyD", "Mod+Shift+KeyA", "Mod+Shift+KeyM",
  "Mod+Shift+KeyY", "Mod+Shift+KeyH", "Mod+Shift+KeyG", "Mod+Shift+KeyF", "Mod+Shift+KeyV",
  "Mod+Shift+KeyZ", "Mod+Shift+KeyS", "Mod+Shift+KeyU", "Mod+Shift+KeyX", "Mod+Shift+KeyL",
  "Mod+Shift+Digit3", "Mod+Shift+Digit4", "Mod+Shift+Digit5", "Mod+Shift+Digit6",
  "Mod+Shift+Slash", "Mod+Shift+Semicolon", "Mod+Shift+Comma", "Mod+Shift+Delete",
  // ⌥ with ⌘: devtools, bookmark manager, view source, hide others, force quit
  "Mod+Alt+KeyJ", "Mod+Alt+KeyC", "Mod+Alt+KeyB", "Mod+Alt+KeyU", "Mod+Alt+KeyH", "Mod+Alt+KeyF",
  "Mod+Alt+KeyN", "Mod+Alt+KeyD", "Mod+Alt+KeyL", "Mod+Alt+KeyW", "Mod+Alt+KeyV", "Mod+Alt+KeyT",
]);

/** A stored or requested shortcut as its parts; null when it isn't one. */
export function parseAssistantOtterShortcut(value: unknown): AssistantOtterShortcut | null {
  if (typeof value !== "string" || value.length === 0 || value.length > ASSISTANT_OTTER_SHORTCUT_MAX_LENGTH) return null;
  const parts = value.split("+");
  const code = parts.pop()!;
  if (!KEY_CODES.has(code)) return null;
  const modifiers = parts as AssistantOtterShortcutModifier[];
  // Each modifier once, in the canonical order.
  const expected = MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier));
  if (modifiers.length !== expected.length || modifiers.some((modifier, i) => modifier !== expected[i])) return null;
  return { modifiers: expected, code };
}

export function formatAssistantOtterShortcut(shortcut: AssistantOtterShortcut): string {
  return [...MODIFIER_ORDER.filter((modifier) => shortcut.modifiers.includes(modifier)), shortcut.code].join("+");
}

export type AssistantOtterShortcutProblem = "invalid" | "needs_mod" | "alt_gr" | "reserved";

/**
 * Why a shortcut can't be the otter's, or null when it can. It must use Mod
 * (⌘ / Ctrl) with ⇧ or ⌥ (Mod with a letter or digit alone is a browser's),
 * not Ctrl+Alt off Apple platforms (AltGr types characters there), and not a
 * combo something else already uses.
 */
export function assistantOtterShortcutProblem(value: string, apple: boolean): AssistantOtterShortcutProblem | null {
  const shortcut = parseAssistantOtterShortcut(value);
  if (!shortcut) return "invalid";
  if (!shortcut.modifiers.includes("Mod")) return "needs_mod";
  const extras = shortcut.modifiers.filter((modifier) => modifier !== "Mod");
  if (!apple && extras.includes("Alt")) return "alt_gr";
  const canonical = formatAssistantOtterShortcut(shortcut);
  if (RESERVED.has(canonical)) return "reserved";
  if (extras.length === 0 && /^(Key|Digit)/.test(shortcut.code)) return "reserved";
  return null;
}

/**
 * What the account stores, as the server accepts it from a request:
 * undefined when absent, null (back to the default), "off", or a shortcut
 * that isn't reserved on any platform. Throws with the reason otherwise.
 */
export function parseAssistantOtterShortcutPreference(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (raw === ASSISTANT_OTTER_SHORTCUT_OFF) return ASSISTANT_OTTER_SHORTCUT_OFF;
  if (typeof raw !== "string") throw new Error("assistantOtterShortcut must be a shortcut like \"Mod+Shift+Period\", \"off\", or null");
  // Stored once for every device: refused if it is reserved anywhere.
  const problem = assistantOtterShortcutProblem(raw, true) ?? assistantOtterShortcutProblem(raw, false);
  if (problem === "invalid") throw new Error("assistantOtterShortcut must be a shortcut like \"Mod+Shift+Period\", \"off\", or null");
  if (problem) throw new Error(`assistantOtterShortcut ${raw} can't be used (${problem})`);
  return formatAssistantOtterShortcut(parseAssistantOtterShortcut(raw)!);
}

/** The shortcut in effect for a stored value: null when it is off. */
export function effectiveAssistantOtterShortcut(stored: string | null | undefined): AssistantOtterShortcut | null {
  if (stored === ASSISTANT_OTTER_SHORTCUT_OFF) return null;
  return parseAssistantOtterShortcut(stored ?? ASSISTANT_OTTER_SHORTCUT_DEFAULT) ?? parseAssistantOtterShortcut(ASSISTANT_OTTER_SHORTCUT_DEFAULT);
}

export type AssistantOtterShortcutEvent = {
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

/** Whether a keydown is exactly this shortcut (Mod = ⌘ on Apple platforms, Ctrl elsewhere, never both). */
export function matchesAssistantOtterShortcut(event: AssistantOtterShortcutEvent, shortcut: AssistantOtterShortcut, apple: boolean): boolean {
  if (event.code !== shortcut.code) return false;
  const mod = apple ? !!event.metaKey && !event.ctrlKey : !!event.ctrlKey && !event.metaKey;
  return mod === shortcut.modifiers.includes("Mod")
    && !!event.altKey === shortcut.modifiers.includes("Alt")
    && !!event.shiftKey === shortcut.modifiers.includes("Shift");
}

/**
 * A keydown as a shortcut string, for capturing a new one: null while only
 * modifiers are down or the key isn't one a shortcut may use.
 */
export function assistantOtterShortcutFromEvent(event: AssistantOtterShortcutEvent, apple: boolean): string | null {
  if (!event.code || !KEY_CODES.has(event.code)) return null;
  const modifiers: AssistantOtterShortcutModifier[] = [];
  if (apple ? event.metaKey : event.ctrlKey) modifiers.push("Mod");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  return formatAssistantOtterShortcut({ modifiers, code: event.code });
}

const KEY_LABELS: Record<string, string> = {
  Period: ".", Comma: ",", Slash: "/", Backslash: "\\", Semicolon: ";", Quote: "'",
  BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=", Backquote: "`",
};

function keyLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return KEY_LABELS[code] ?? code;
}

/** The keys to show, one per `Kbd`: ⌘ ⌥ ⇧ on Apple platforms, Ctrl Alt Shift elsewhere. */
export function assistantOtterShortcutKeys(shortcut: AssistantOtterShortcut, apple: boolean): string[] {
  const names: Record<AssistantOtterShortcutModifier, string> = apple
    ? { Mod: "⌘", Alt: "⌥", Shift: "⇧" }
    : { Mod: "Ctrl", Alt: "Alt", Shift: "Shift" };
  return [...shortcut.modifiers.map((modifier) => names[modifier]), keyLabel(shortcut.code)];
}

/** One string for a hint or a toast: "⌘⇧." on Apple platforms, "Ctrl+Shift+." elsewhere. */
export function assistantOtterShortcutLabel(shortcut: AssistantOtterShortcut, apple: boolean): string {
  const keys = assistantOtterShortcutKeys(shortcut, apple);
  return apple ? keys.join("") : keys.join("+");
}

/** The same shortcut for `aria-keyshortcuts`. */
export function assistantOtterShortcutAriaKeys(shortcut: AssistantOtterShortcut, apple: boolean): string {
  const names: Record<AssistantOtterShortcutModifier, string> = { Mod: apple ? "Meta" : "Control", Alt: "Alt", Shift: "Shift" };
  return [...shortcut.modifiers.map((modifier) => names[modifier]), keyLabel(shortcut.code)].join("+");
}

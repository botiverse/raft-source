import type { KeyboardPlatform } from "@botiverse/raft-ui/wip";
import { isTextEditableElement, keyboardPlatform } from "../../utils/keyboardShortcuts";
import type { KeyboardShortcutEvent, ShortcutCombo } from "../../utils/keyboardShortcuts";
import { isImeComposing, matchCombo, matchComboEitherMod, matchComboPhysical } from "./match";
import { getShortcutCommand } from "./registry";
import type { ShortcutCommand, ShortcutScope } from "./registry";
import { currentShortcutOverrides, isShortcutOverridden, resolvedCombos } from "./overrides";
import type { ShortcutOverrides } from "./overrides";

/** A handler returns false for "not mine": the key goes on to the next scope out, and its default stays. */
export type ShortcutHandler = (event: KeyboardEvent) => boolean | void;

export interface RegistrationOptions {
  enabled?: () => boolean;
  /**
   * The element this registration's scope is: of two surfaces with the same scope (two conversations), only the one
   * the key is pressed in (or was last clicked) runs. Without it, the one registered last does.
   */
  node?: () => Element | null;
  /**
   * Offered the key wherever the focus is while enabled, after the focus path and before global: a page with no
   * element of its own to focus (Settings), a text selection, which never holds the focus.
   */
  ambient?: boolean;
}

interface Registration {
  command: ShortcutCommand;
  handler: () => ShortcutHandler;
  enabled: () => boolean;
  node?: () => Element | null;
  ambient: boolean;
}

export interface LayerOptions {
  /** A modal layer hides the scopes under it (global included) from commands, and the layers under it from keys, Esc included. */
  modal?: boolean;
  /** Esc while this is the innermost open layer that takes it; return false for "not mine" (the next layer out gets it). */
  onEscape?: () => ShortcutHandler;
  /** Every other key while open, innermost layer first; return true when it took the key (it calls preventDefault itself). */
  onKey?: () => (event: KeyboardEvent) => boolean | void;
  /**
   * "capture": before the page's own handlers see the key (window, capture phase), for a surface that must close
   * before the one under the focus hears Esc. Default "bubble": after them, so a focused field or menu that takes
   * Esc itself (preventDefault) keeps it.
   */
  phase?: "capture" | "bubble";
  /** Takes Esc even when something under the focus already took it (defaultPrevented). */
  ignoreDefaultPrevented?: boolean;
  /** Also stops the Esc it takes from reaching listeners outside the registry (stopPropagation). */
  stopPropagation?: boolean;
}

interface Layer extends LayerOptions {
  scope: ShortcutScope;
}

/** The DOM attribute that puts focus inside a scope: `<div data-shortcut-scope="thread">`. */
export const SHORTCUT_SCOPE_ATTRIBUTE = "data-shortcut-scope";

const registrations = new Set<Registration>();
const layers: Layer[] = [];
/** Keys a layer already took, so the other phase's layers leave them. */
const takenByLayer = new WeakSet<Event>();
let installed = false;
let recording = false;
/** The element last pressed or focused: where a key on <body> (the focus fell there) is offered. */
let lastInteraction: Element | null = null;
/** The last first press (not a repeat) a command matched, and who took it (null: a handler said "not mine"). */
let lastPress: { key: string; taken: Registration | null } | null = null;

if (typeof window !== "undefined") {
  const track = (event: Event) => {
    if (event.target instanceof Element) lastInteraction = event.target;
  };
  window.addEventListener("pointerdown", track, { capture: true, passive: true });
  window.addEventListener("focusin", track, true);
}

/** While the panel records a new shortcut every key is the recorder's: nothing dispatches. */
export function setShortcutRecording(next: boolean): void {
  recording = next;
}

interface ChainEntry {
  scope: ShortcutScope | "ambient";
  /** The element marked with the scope, for a focus-path entry. */
  element: Element | null;
}

function isBodyTarget(target: EventTarget | null): boolean {
  return typeof document !== "undefined" && (target === document.body || target === document.documentElement || target === document);
}

/** The scopes this key is offered to, most specific first: open layers (to the first modal one), the focus path, ambient registrations, then global. */
function activeChain(target: EventTarget | null): ChainEntry[] {
  const chain: ChainEntry[] = [];
  for (let index = layers.length - 1; index >= 0; index--) {
    const layer = layers[index]!;
    chain.push({ scope: layer.scope, element: null });
    if (layer.modal) return chain;
  }
  let node = target instanceof Element && !isBodyTarget(target) ? target : null;
  // The focus fell to the body: the element last clicked or focused stands in for it (ChatPanel's and the thread's
  // ⌘F before the registry).
  if (!node && isBodyTarget(target) && lastInteraction?.isConnected) node = lastInteraction;
  for (; node; node = node.parentElement) {
    const scope = node.getAttribute(SHORTCUT_SCOPE_ATTRIBUTE) as ShortcutScope | null;
    if (scope && !chain.some((entry) => entry.scope === scope)) chain.push({ scope, element: node });
  }
  chain.push({ scope: "ambient", element: null });
  chain.push({ scope: "global", element: null });
  return chain;
}

function offeredTo(entry: ChainEntry, registration: Registration): boolean {
  if (entry.scope === "ambient") return registration.ambient;
  if (registration.command.scope !== entry.scope) return false;
  if (!entry.element || !registration.node) return true;
  const node = registration.node();
  return !!node && (node === entry.element || node.contains(entry.element));
}

/**
 * The combo of `command` this keydown is, with the person's change applied; undefined when it is none. A command
 * marked `eitherMod` takes ⌘ or Ctrl on any platform while at its defaults.
 */
export function matchedCombo(
  command: ShortcutCommand,
  event: KeyboardShortcutEvent,
  platform: KeyboardPlatform = keyboardPlatform(),
  overrides: ShortcutOverrides = currentShortcutOverrides(),
): ShortcutCombo | undefined {
  const combos = resolvedCombos(command, platform, overrides);
  const either = !!command.eitherMod && !isShortcutOverridden(command.id, overrides);
  return combos.find((combo) => (command.physical ? matchComboPhysical(event, combo, platform)
    : either ? matchComboEitherMod(event, combo) : matchCombo(event, combo, platform)));
}

/**
 * Whether a keydown is command `id`, with the person's change: for an element's own handler (the composer, a
 * comment box), where a document listener is the wrong place. It doesn't check scopes, text fields or IME.
 */
export function matchesShortcut(event: KeyboardShortcutEvent, id: string): boolean {
  return matchedCombo(getShortcutCommand(id), event) !== undefined;
}

function allowedInField(command: ShortcutCommand, combo: ShortcutCombo): boolean {
  if (command.textField === "always") return true;
  if (command.textField === "never") return false;
  // A bare key (or ⇧ with one) is typing.
  return !!(combo.mod || combo.ctrl || combo.alt);
}

/**
 * Offers the key to the open layers of `phase`, innermost first, down to the first modal one; true when one took it.
 * The layers under a modal layer hear nothing, in either phase: a modal with no Esc of its own (a raft-ui Dialog,
 * useOverlayLayer) closes on Esc itself, and the Esc is left unprevented for it.
 */
function dispatchToLayers(event: KeyboardEvent, phase: "capture" | "bubble"): boolean {
  if (takenByLayer.has(event)) return true;
  const escape = event.key === "Escape";
  for (let index = layers.length - 1; index >= 0; index--) {
    const layer = layers[index]!;
    if ((layer.phase ?? "bubble") === phase) {
      if (!escape) {
        if (layer.onKey?.()(event) === true) {
          takenByLayer.add(event);
          return true;
        }
      } else if (layer.onEscape) {
        // Something inside took this Esc (a field cancelling an edit, a mention menu): it was theirs, and nothing
        // further out closes on it either.
        if (event.defaultPrevented && !layer.ignoreDefaultPrevented) return true;
        if (layer.onEscape()(event) !== false) {
          event.preventDefault();
          if (layer.stopPropagation) event.stopPropagation();
          takenByLayer.add(event);
          return true;
        }
      }
    }
    if (layer.modal) return false;
  }
  return false;
}

/** The registry's capture-phase pass (window): layers that must hear their key before the page does. */
function dispatchShortcutCapture(event: KeyboardEvent): void {
  if (recording || isImeComposing(event)) return;
  dispatchToLayers(event, "capture");
}

/**
 * The one keydown listener behind `useShortcut` and the layers. Bubble phase, so a focused widget that handles the
 * key itself (a menu, a field's own Escape) marks it defaultPrevented first. The IME guard runs before anything
 * else.
 */
export function dispatchShortcutEvent(event: KeyboardEvent): void {
  if (recording || isImeComposing(event)) return;
  if (dispatchToLayers(event, "bubble") || registrations.size === 0) return;
  const platform = keyboardPlatform();
  const overrides = currentShortcutOverrides();
  const target = event.target instanceof Element ? event.target : null;
  const inField = !!target && isTextEditableElement(target);
  const pressKey = event.code || event.key;
  const heldFromBefore = event.repeat && lastPress?.key !== pressKey;
  let taken: Registration | null = null;
  let matched = false;
  // Latest registration first, so the surface mounted last wins within one scope.
  const mounted = Array.from(registrations).reverse();
  outer: for (const entry of activeChain(event.target)) {
    for (const registration of mounted) {
      const { command } = registration;
      if (!offeredTo(entry, registration) || !registration.enabled()) continue;
      const combo = matchedCombo(command, event, platform, overrides);
      if (!combo || (inField && !allowedInField(command, combo))) continue;
      matched = true;
      if (event.defaultPrevented && !command.ignoreDefaultPrevented) return;
      if (event.repeat && !command.repeat) {
        // Held down: the command that took the first press takes the rest and runs once; a key a handler declined
        // (returned false) stays declined, so its default (the browser's find) repeats as it should.
        if (heldFromBefore || lastPress?.taken === registration) {
          event.preventDefault();
          return;
        }
        continue;
      }
      if (registration.handler()(event) === false) continue;
      event.preventDefault();
      taken = registration;
      break outer;
    }
  }
  if (!event.repeat && matched) lastPress = { key: pressKey, taken };
}

/** A key sent to the window itself (no element: a synthetic event) never reaches the document's listener. */
function dispatchWindowTargeted(event: KeyboardEvent): void {
  if (event.target === window) dispatchShortcutEvent(event);
}

function install() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  // keydown-global-exempt: the shortcut registry's single dispatcher; each command's handler moves focus itself
  document.addEventListener("keydown", dispatchShortcutEvent);
  // keydown-global-exempt: the registry's capture pass, for layers whose Esc must come before the page's own handlers
  window.addEventListener("keydown", dispatchShortcutCapture, true);
  // keydown-global-exempt: the registry's bubble pass for a key sent to the window itself, which the document never sees
  window.addEventListener("keydown", dispatchWindowTargeted);
}

function uninstallIfIdle() {
  if (!installed || registrations.size > 0 || layers.length > 0) return;
  installed = false;
  document.removeEventListener("keydown", dispatchShortcutEvent);
  window.removeEventListener("keydown", dispatchShortcutCapture, true);
  window.removeEventListener("keydown", dispatchWindowTargeted);
}

/** Handle command `id` (or a command object, for tests) while registered; returns the unregister. `useShortcut` is the React way in. */
export function registerShortcutHandler(
  id: string | ShortcutCommand,
  handler: () => ShortcutHandler,
  enabledOrOptions: (() => boolean) | RegistrationOptions = {},
): () => void {
  const command = typeof id === "string" ? getShortcutCommand(id) : id;
  const options = typeof enabledOrOptions === "function" ? { enabled: enabledOrOptions } : enabledOrOptions;
  const registration: Registration = {
    command,
    handler,
    enabled: options.enabled ?? (() => true),
    node: options.node,
    ambient: !!options.ambient,
  };
  registrations.add(registration);
  install();
  return () => {
    registrations.delete(registration);
    if (lastPress?.taken === registration) lastPress = null;
    uninstallIfIdle();
  };
}

/**
 * Whether a modal layer is open (a raft-ui Dialog or Drawer, useOverlayLayer): for an Esc handler outside the registry
 * (a surface's own onKeyDown) that would otherwise act on the key a modal over it closes on.
 */
export function isModalLayerOpen(): boolean {
  return layers.some((layer) => layer.modal);
}

/**
 * Open an overlay, menu or docked panel layer: its scope is offered the key before the focus path, and its Esc
 * (`onEscape`) runs if it is the innermost open layer that takes it. Returns the close.
 */
export function pushShortcutLayer(scope: ShortcutScope, options: LayerOptions = {}): () => void {
  const layer: Layer = { scope, ...options };
  layers.push(layer);
  install();
  return () => {
    const index = layers.lastIndexOf(layer);
    if (index >= 0) layers.splice(index, 1);
    uninstallIfIdle();
  };
}

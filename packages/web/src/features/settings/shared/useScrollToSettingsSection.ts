import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { focusJumpTarget, lastInputWasKeyboard } from "../../../hooks/useKeyboardJumpFocus";
import { locateElement } from "../../../utils/locateElement";

/** How long a `#section` link waits for a section that renders after its data loads. */
const WAIT_MS = 5_000;

/** The router state of a jump the keyboard started (Enter in Search settings). */
const KEYBOARD_JUMP_STATE = "settingsJumpFromKeyboard";

/**
 * The router state for a jump to a setting that says whether the keyboard
 * started it. Enter in a text field (Search settings) is not something
 * raft-ui's input modality counts, so the opener says it.
 */
export function settingsJumpState(fromKeyboard: boolean): Record<string, boolean> {
  return { [KEYBOARD_JUMP_STATE]: fromKeyboard };
}

function jumpStateSaysKeyboard(state: unknown): boolean {
  return typeof state === "object" && state !== null && (state as Record<string, unknown>)[KEYBOARD_JUMP_STATE] === true;
}

/**
 * `/settings/<tab>#<id>` opens the tab scrolled to the section with that id, so a link
 * (an announcement CTA, a doc) can point at one block instead of the top of the tab
 * (cindyz, #raft-operations:27208521). Sections render after their data loads, so this
 * waits for the element to appear, then scrolls once per jump, and marks it
 * located (design/foundations/states.md#located) once it is on screen: a
 * Settings search result opens its setting this way. A jump started from the
 * keyboard also moves focus to it.
 */
export function useScrollToSettingsSection(): void {
  // key: opening the same result again is a new jump, which locates it again.
  const { pathname, hash, key, state } = useLocation();
  useEffect(() => {
    const id = sectionId(hash);
    if (!id) return;
    // The input that started the jump, read when it is asked for, not when
    // the section shows (useKeyboardJumpFocus): a click while it loads
    // doesn't make it a keyboard jump, nor the other way round.
    const fromKeyboard = jumpStateSaysKeyboard(state) || lastInputWasKeyboard();
    const scrollTo = () => {
      // Only a section of Settings itself: an id elsewhere in the app is never a target.
      const element = document.getElementById(id);
      if (!element?.closest(SETTINGS_FRAME)) return false;
      element.scrollIntoView({ block: "start" });
      locateElement(element);
      if (fromKeyboard) focusJumpTarget(element);
      return true;
    };
    if (scrollTo()) return;
    // The DOM is the external system here: the section may mount at any point while loading.
    const observer = new MutationObserver(() => {
      if (scrollTo()) stop();
    });
    // Give up after WAIT_MS so a missing section never leaves an observer on the page.
    const timer = window.setTimeout(() => stop(), WAIT_MS);
    function stop() {
      observer.disconnect();
      window.clearTimeout(timer);
    }
    observer.observe(document.body, { childList: true, subtree: true });
    return stop;
    // pathname too: the same #id on another tab is another section.
  }, [pathname, hash, key, state]);
}

const SETTINGS_FRAME = '[data-testid="settings-panel-frame"]';

/** A malformed escape (`#%E0`) is no section rather than a crash. */
function sectionId(hash: string): string | null {
  try {
    return decodeURIComponent(hash.slice(1)) || null;
  } catch {
    return null;
  }
}

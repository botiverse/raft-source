/**
 * Pins the #root element to the visual viewport WHEN the software keyboard
 * is up, by writing #root's own inline `height` and `top`. When the keyboard
 * is down, they are cleared and CSS falls back to `100dvh` (the dynamic
 * viewport unit) — which on iOS PWA standalone is the *real* visible area,
 * including/excluding the home-indicator inset correctly. An earlier version
 * always pinned the height to `visualViewport.height` even with no keyboard,
 * which on real iPhones in PWA mode reported a value smaller than the true
 * visible area, leaving a visible cream gap below #root.
 *
 * Why this exists:
 *   - Mobile Safari: when an input is focused and the software keyboard
 *     rises, Safari translates `position: fixed` content upward so the
 *     focused input lands above the keyboard. With `#root { position: fixed;
 *     inset: 0 }` and `overflow: hidden` html/body, this leaves the top of
 *     the UI scrolled off-screen. By shrinking #root to the visual viewport
 *     height *only when the keyboard is up*, flex layout naturally reflows
 *     above the keyboard — no scroll trick needed.
 *   - iOS PWA standalone: 100dvh on its own already gives the correct
 *     visible height, so the no-keyboard path just clears the override.
 *
 * Keyboard detection: we treat the keyboard as "up" only when a text-editable
 * element is focused and the visual viewport is more than 100px shorter than
 * the layout viewport. iOS standalone can briefly report a stale, smaller
 * visualViewport.height after relaunch from the home screen while no keyboard
 * is present; requiring editable focus prevents pinning #root to that stale
 * half-height viewport. We also re-measure on pageshow / visibilitychange so
 * any stale value latched during a background/resume transition is cleared
 * once the app becomes visible again.
 *
 * While the keyboard is up #root also carries `data-soft-keyboard="open"`,
 * so chrome that must not ride above the keyboard (the phone tab bar,
 * `in-data-[soft-keyboard=open]:hidden`) can hide without its own listener.
 * When the keyboard goes down it reads `"closed"` for
 * SOFT_KEYBOARD_CLOSED_MS, long enough for that chrome to animate back in
 * (`.mobile-tab-bar-return` in index.css), then the attribute is removed so
 * a later mount (a Back to a tab root) does not replay the animation.
 *
 * Safe to call multiple times — idempotent.
 */

function isTextEditableElement(element: Element | null): boolean {
  if (!element) return false;
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) {
    const type = element.type.toLowerCase();
    return ![
      "button",
      "checkbox",
      "color",
      "file",
      "hidden",
      "image",
      "radio",
      "range",
      "reset",
      "submit",
    ].includes(type);
  }
  return element instanceof HTMLElement && element.isContentEditable;
}

type ShellViewportOverride = { height: string; top: string };

/** How long #root reads `data-soft-keyboard="closed"`: the 200ms return
 *  animation plus a frame of slack. */
export const SOFT_KEYBOARD_CLOSED_MS = 250;

export function trackVisualViewport(): void {
  if (typeof window === "undefined") return;

  // The override goes on #root itself, as its own (non-inherited) height and
  // top. It used to be custom properties on <html>, which every element
  // inherits: each change restyled the whole document (hundreds of ms on a
  // long chat in WebKit), and on iOS the visual viewport changes while the
  // reader scrolls with the keyboard up.
  const shell = document.getElementById("root");
  if (!shell) return;
  const vv = window.visualViewport;
  // What is written now: unchanged values are never rewritten.
  let applied: ShellViewportOverride | null = null;
  let closedTimer: ReturnType<typeof setTimeout> | undefined;

  const apply = (next: ShellViewportOverride | null) => {
    if (next === null) {
      if (applied === null) return;
      shell.style.removeProperty("height");
      shell.style.removeProperty("top");
      shell.dataset.softKeyboard = "closed";
      clearTimeout(closedTimer);
      closedTimer = setTimeout(() => {
        if (shell.dataset.softKeyboard === "closed") delete shell.dataset.softKeyboard;
      }, SOFT_KEYBOARD_CLOSED_MS);
    } else {
      if (applied === null) {
        clearTimeout(closedTimer);
        shell.dataset.softKeyboard = "open";
      }
      if (applied?.height !== next.height) shell.style.setProperty("height", next.height);
      if (applied?.top !== next.top) shell.style.setProperty("top", next.top);
    }
    applied = next;
  };

  const update = () => {
    if (!vv) {
      // No VisualViewport API: no override, CSS uses the 100dvh fallback.
      apply(null);
      return;
    }
    const layoutHeight = window.innerHeight;
    const visualHeight = vv.height;
    // The height check first: it reads no style. `isContentEditable` needs the
    // focused element's computed style, and focusin/focusout fire mid-commit
    // when React removes or moves the focused element (switching server
    // unmounts the old sidebar): reading it there forced the whole pending
    // style recalc inside the event, 117ms after unmounting 300 sidebar rows
    // (InNOut, #proj-frontend:57f32c96). On a desktop the gap is 0, so the
    // focused element is never inspected.
    const keyboardUp = layoutHeight - visualHeight > 100 && isTextEditableElement(document.activeElement);
    // Keyboard-only override (#5888 / #725): shrink #root to the visual
    // viewport so fixed layout reflows above the soft keyboard. When the
    // keyboard is down, clear it and let CSS 100dvh / task #15 fixed inset
    // handle PWA standalone — never pin to a stale short visualHeight with
    // no editable focus.
    apply(keyboardUp ? { height: `${visualHeight}px`, top: `${vv.offsetTop}px` } : null);
  };

  // Viewport scroll/resize events can fire many times a frame while the
  // reader scrolls (the iOS toolbars collapse) or the keyboard animates:
  // measure once per frame.
  let pendingFrame: number | null = null;
  const scheduleUpdate = () => {
    if (typeof window.requestAnimationFrame !== "function") {
      update();
      return;
    }
    if (pendingFrame !== null) return;
    pendingFrame = window.requestAnimationFrame(() => {
      pendingFrame = null;
      update();
    });
  };

  update();

  if (vv) {
    vv.addEventListener("resize", scheduleUpdate);
    vv.addEventListener("scroll", scheduleUpdate, { passive: true });
  }
  // Also listen on window for browsers without VisualViewport support.
  window.addEventListener("resize", scheduleUpdate);
  window.addEventListener("orientationchange", update);
  window.addEventListener("pageshow", update);
  // Focus moves during React commits: measure on the next frame, not inside
  // the commit, where any read forces the commit's pending style and layout.
  window.addEventListener("focusin", scheduleUpdate);
  window.addEventListener("focusout", scheduleUpdate);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) update();
  });
}

/**
 * Whether the on-screen keyboard is up, from #root's `data-soft-keyboard`
 * (written by trackVisualViewport). For overlays portaled outside #root that
 * need to move only while it is up (a phone's raised dialog card).
 */
export function readSoftKeyboardOpen(): boolean {
  if (typeof document === "undefined") return false;
  return document.getElementById("root")?.dataset.softKeyboard === "open";
}

export function subscribeSoftKeyboard(onChange: () => void): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => {};
  const shell = document.getElementById("root");
  if (!shell) return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(shell, { attributes: true, attributeFilter: ["data-soft-keyboard"] });
  return () => observer.disconnect();
}

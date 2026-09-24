/**
 * Pins the #root element to the visual viewport WHEN the software keyboard
 * is up, by writing `--vv-height` and `--vv-offset-top` CSS variables on
 * the :root element. When the keyboard is down, the variables are cleared
 * and CSS falls back to `100dvh` (the dynamic viewport unit) — which on
 * iOS PWA standalone is the *real* visible area, including/excluding the
 * home-indicator inset correctly. The previous version always set
 * `--vv-height = visualViewport.height` even with no keyboard, which on
 * real iPhones in PWA mode reported a value smaller than the true visible
 * area, leaving a visible cream gap below #root.
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

export function trackVisualViewport(): void {
  if (typeof window === "undefined") return;

  const root = document.documentElement;
  const vv = window.visualViewport;

  const update = () => {
    if (!vv) {
      // No VisualViewport API: clear overrides, let CSS use 100dvh fallback.
      root.style.removeProperty("--vv-height");
      root.style.removeProperty("--vv-offset-top");
      return;
    }
    const layoutHeight = window.innerHeight;
    const visualHeight = vv.height;
    const keyboardUp = isTextEditableElement(document.activeElement) && layoutHeight - visualHeight > 100;
    if (keyboardUp) {
      // Keyboard-only override (#5888 / #725): shrink #root to the visual
      // viewport so fixed layout reflows above the soft keyboard. When the
      // keyboard is down, clear overrides and let CSS 100dvh / task #15
      // fixed inset handle PWA standalone — never pin to a stale short
      // visualHeight with no editable focus.
      root.style.setProperty("--vv-height", `${visualHeight}px`);
      root.style.setProperty("--vv-offset-top", `${vv.offsetTop}px`);
    } else {
      root.style.removeProperty("--vv-height");
      root.style.removeProperty("--vv-offset-top");
    }
  };

  update();

  if (vv) {
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update, { passive: true });
  }
  // Also listen on window for browsers without VisualViewport support.
  window.addEventListener("resize", update);
  window.addEventListener("orientationchange", update);
  window.addEventListener("pageshow", update);
  window.addEventListener("focusin", update);
  window.addEventListener("focusout", update);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) update();
  });
}

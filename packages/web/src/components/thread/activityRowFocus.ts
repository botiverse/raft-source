/**
 * Closed beside the list (Esc, its ×): focus goes back to the Activity row
 * the detail was opened from (`key`: its data-inbox-key), as to the card
 * that opens a viewer in a channel. The list may remount as the detail
 * closes, so the row is looked up once that has rendered (the next frame),
 * and only if focus went nowhere. No such row (Search): nothing.
 */
export function focusActivityRowAfterClose(key: string): void {
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const row = [...document.querySelectorAll<HTMLElement>("[data-inbox-key]")].find((element) => element.dataset.inboxKey === key);
    row?.querySelector<HTMLElement>("[data-slot=inbox-item-open]")?.focus();
  });
}

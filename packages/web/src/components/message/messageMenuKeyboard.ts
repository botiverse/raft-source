/**
 * Where an arrow key, Home or End moves focus in the message menu: the same
 * movement raft-ui's ContextMenu gives (raft-design dropdown-menu.md,
 * Accessibility), for slock's own menu popup.
 *
 * The quick reactions are one row: Down and Up treat the row as one stop
 * (entering it at its first reaction) and Left and Right move along it. Up
 * and Down loop around the menu. With focus outside the menu, the first key
 * focuses the first item (End and Up the last). Returns null for any other
 * key, or for Left and Right outside the row.
 */
const ITEM_SELECTOR = "[role='menuitem']:not([disabled]):not([aria-disabled='true'])";
const ROW_SELECTOR = "[data-message-affordance='reaction-quick-row']";

export function nextMessageMenuItem(
  menu: HTMLElement,
  active: Element | null,
  key: string,
): HTMLElement | null {
  if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return null;
  const items = [...menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR)];
  if (items.length === 0) return null;
  const inRow = (el: Element) => Boolean(el.closest(ROW_SELECTOR));
  // One stop per row: the row is represented by its first reaction.
  const stops = items.filter((el, i) => !inRow(el) || i === 0 || !inRow(items[i - 1]!));
  const current = active instanceof HTMLElement ? items.indexOf(active) : -1;

  if (key === "Home") return stops[0]!;
  if (key === "End") return stops[stops.length - 1]!;
  if (current < 0) {
    if (key === "ArrowUp") return stops[stops.length - 1]!;
    return stops[0]!;
  }
  const el = items[current]!;
  if (key === "ArrowLeft" || key === "ArrowRight") {
    if (!inRow(el)) return null;
    const row = items.filter((item) => inRow(item));
    const at = row.indexOf(el);
    const next = key === "ArrowRight" ? at + 1 : at - 1;
    return next >= 0 && next < row.length ? row[next]! : el;
  }
  const stop = inRow(el) ? stops.findIndex((s) => inRow(s)) : stops.indexOf(el);
  const step = key === "ArrowDown" ? 1 : -1;
  return stops[(stop + step + stops.length) % stops.length]!;
}

import { requestFocus } from "../../utils/focusRequest";

/**
 * The comment list opened without a place to start from: focus its region, so Esc and Tab start there. Focus
 * already in the region stays: the list was opened to write in its foot box (the header's Comment button,
 * artifactListCompose `writeInList`), and the box, mounted first, has focused its field (ArtifactCommentBox `insert`,
 * the phone sheet's `initialFocus`). mayTakeFocus lets a request for the region take focus from inside it, so the
 * check is here.
 */
export function focusListOnOpen(getRegion: () => HTMLElement | null): void {
  const region = getRegion();
  const active = region?.ownerDocument.activeElement ?? null;
  if (region && active && active !== region && region.contains(active)) return;
  requestFocus(getRegion, { reason: "mount" });
}

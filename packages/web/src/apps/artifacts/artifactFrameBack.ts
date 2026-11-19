/** The slice of the Navigation API (`window.navigation`) a Back past a frame's entries reads. */
interface TraversableNavigation {
  readonly currentEntry: { readonly index: number } | null;
  entries(): readonly { readonly key: string }[];
  traverseTo(key: string): { committed: Promise<unknown>; finished: Promise<unknown> };
}

function traversableNavigation(): TraversableNavigation | null {
  if (typeof window === "undefined") return null;
  const navigation = (window as { navigation?: Partial<TraversableNavigation> }).navigation;
  return navigation && typeof navigation.entries === "function" && typeof navigation.traverseTo === "function"
    ? navigation as TraversableNavigation
    : null;
}

/**
 * Back from a page that frames an Artifact, to the app's entry before it.
 *
 * The Artifact's page runs in an iframe, and its own navigation (a `#section`
 * link, pushState) adds entries to the tab's joint history above the app's
 * one. `history.back()` (react-router's `navigate(-1)`) steps through those
 * first: the page's Back went to the Artifact's last section, not to the chat,
 * and with enough of them it seemed never to close. The Navigation API lists
 * only the app's own entries (`navigation.entries()`), so traversing to the
 * one before the current entry leaves the Artifact in one step, whatever the
 * page did inside. Where there is no such API or entry: `fallback` (the
 * history step it always was).
 */
export function backPastArtifactFrame(fallback: () => void): void {
  const navigation = traversableNavigation();
  const index = navigation?.currentEntry?.index ?? -1;
  const before = navigation && index > 0 ? navigation.entries()[index - 1] : undefined;
  if (!navigation || !before) {
    fallback();
    return;
  }
  const traversal = navigation.traverseTo(before.key);
  // A traversal superseded by another (a second click) rejects: nothing to report.
  traversal.committed.catch(() => {});
  traversal.finished.catch(() => {});
}

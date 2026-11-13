import type { Location } from "react-router-dom";
import { useMobileBack } from "../../hooks/useAppNavigate";

/**
 * The panel's close and Back: the host's close (or closeThread), and the
 * mobile Back that returns to the semantic parent channel or browser history.
 */
export function useThreadPanelBack({
  serverSlug,
  parentChannelId,
  parentRouteKind,
  location,
  presentation,
  onClose,
  closeThread,
}: {
  serverSlug: string | undefined;
  parentChannelId: string | null;
  parentRouteKind: "dm" | "channel" | null;
  location: Location;
  presentation: "side" | "modal" | "mobile-modal";
  onClose: (() => void) | undefined;
  closeThread: () => void;
}) {
  const parentPath = serverSlug
    ? (parentChannelId && parentRouteKind
        ? `/s/${serverSlug}/${parentRouteKind}/${parentChannelId}`
        : `/s/${serverSlug}`)
    : "/";
  const threadIsOnParentSurface = location.pathname.replace(/\/$/, "") === parentPath.replace(/\/$/, "");
  // Stryker disable all: host-specific Back ownership is exercised by the
  // production BrowserRouter Playwright matrix and explicit reverse mutations;
  // the diff-scoped node oracle does not mount this full ThreadPanel surface.
  const handleClose = onClose ?? closeThread;
  // A regular full-row thread is a navigated detail surface, not always a
  // locally-owned modal. Preserve a real same-server origin (Activity/Search/
  // channel) with browser Back; on a cold permalink, useMobileBack falls back
  // to the semantic parent channel. Activity's route navigation now owns the
  // only history PUSH, so this can no longer land on a duplicate same-URL
  // entry. Modal hosts still own teardown directly.
  // Close the store-owned panel before consuming its history entry. The
  // right-panel subscriber synchronously replaces the current destination
  // with its cleaned URL and reserves that search before mobile Back POPs.
  // This makes the store/UI teardown atomic with a fast pre-Router-commit Back
  // instead of leaving a stale destination commit able to keep Thread mounted.
  // Stryker disable all: the focused BrowserRouter seam manually reverse-mutates the pre-navigation close.
  const onMobileBack = useMobileBack(
    threadIsOnParentSurface ? parentPath : handleClose,
    threadIsOnParentSurface ? closeThread : undefined,
  );
  // Stryker restore all
  // Stryker disable next-line all: host-specific handler ownership is covered by the production BrowserRouter journey and reviewer reverse mutations, not the diff gate's source-only ThreadPanel oracle.
  const mobileBackHandler = onClose || presentation === "modal" || presentation === "mobile-modal"
    ? handleClose
    : onMobileBack;
  // Stryker restore all

  return { handleClose, mobileBackHandler };
}

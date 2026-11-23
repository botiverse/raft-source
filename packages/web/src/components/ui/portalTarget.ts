// Where the web's own portals go (a dismiss backdrop): the body of the window
// the subtree is drawn in. An object window (features/objectWindows) sets its
// body with raft-ui's PortalContainerProvider, which raft-ui's own overlays
// follow; a portal of the web's own follows the same provider here.

import { usePortalContainer } from "@botiverse/raft-ui";

/**
 * Where to createPortal: the nearest PortalContainerProvider's container (an
 * object window's body), else document.body. Null while that container does
 * not exist yet: render nothing then, as raft-ui's overlays wait.
 */
export function usePortalTarget(): HTMLElement | null {
  const container = usePortalContainer();
  return container === undefined ? document.body : container;
}

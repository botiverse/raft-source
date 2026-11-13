/**
 * Moving a live node into another container (a side area's section between its places, ChannelSideArea), so
 * that what it holds survives the move. A move with `appendChild` takes the node out of the document and puts it
 * back: an iframe in it reloads the address it was first given (its `src`), not where it is now. For a frame
 * whose first address is good once (an Artifact's ticket, Porthole's door: "This link has been used"), that is
 * a page that can't open.
 *
 * moveNodeInto moves with `moveBefore` where the browser has it (the node stays in the document: iframes keep
 * their page, focus and scroll stay), else with `appendChild`, and then tells each element in the node that
 * asked to know (`FRAME_MOVED_ATTRIBUTE`) with a `FRAME_MOVED_EVENT`, so it opens its frame again (ArtifactFrame).
 */

/** An element that opens its frame again when the node it is in was moved and its iframes reloaded. */
export const FRAME_MOVED_ATTRIBUTE = "data-reopens-when-moved";
/** Sent to each FRAME_MOVED_ATTRIBUTE element after a move that reloaded its iframes. */
export const FRAME_MOVED_EVENT = "raft:frame-moved";

type MovableParent = Element & { moveBefore?: (node: Node, child: Node | null) => void };

/** Move `node` to the end of `container`, keeping its iframes' pages where the browser can (see above). */
export function moveNodeInto(container: Element, node: Element): void {
  const parent = container as MovableParent;
  if (typeof parent.moveBefore === "function" && node.isConnected && container.isConnected) {
    try {
      parent.moveBefore(node, null);
      return;
    } catch {
      // A move the browser refuses (another document, a parent it can't take a state-preserving move into): as below.
    }
  }
  container.appendChild(node);
  const reopen = node.matches(`[${FRAME_MOVED_ATTRIBUTE}]`) ? [node] : [];
  // The node's own window's Event (another realm's isn't one to its dispatchEvent).
  const EventOf = node.ownerDocument.defaultView?.Event ?? Event;
  for (const element of [...reopen, ...node.querySelectorAll(`[${FRAME_MOVED_ATTRIBUTE}]`)]) element.dispatchEvent(new EventOf(FRAME_MOVED_EVENT));
}

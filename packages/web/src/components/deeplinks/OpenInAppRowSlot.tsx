import { useOpenInAppRowSlotRef } from "./openInAppRowSlots";

/**
 * The first thing in a conversation's or a thread's footer: where a phone's
 * "Open in the Raft app" row is drawn, in flow above the composer and
 * anything stacked over it (openInAppRowSlots.ts). Empty, and so nothing,
 * everywhere else.
 */
export function OpenInAppRowSlot() {
  const ref = useOpenInAppRowSlotRef();
  return <div ref={ref} className="order-first empty:hidden" data-open-in-app-row-slot="" />;
}

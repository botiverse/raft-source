import { useCallback } from "react";
import { useThreadStore } from "../../store/threadStore";
import { ThreadPanel } from "../../features/thread/DeferredThreadPanel";

export function ContentSlotThreadPanel({ closeSlot }: { closeSlot: () => void }) {
  const handleClose = useCallback(() => {
    useThreadStore.getState().closeThread();
    closeSlot();
  }, [closeSlot]);
  // The search list on the left draws the column divider (task #110).
  return <ThreadPanel presentation="side" edge="inset" onClose={handleClose} />;
}

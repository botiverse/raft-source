import type { ReactNode, RefObject } from "react";
import DialogCard from "../../components/ui/DialogCard";

/**
 * The runtime editor's frame: the agent detail's Edit runtime dialog, a
 * raft-ui Dialog (DialogCard): the centred card on a desktop, the phone's
 * sheet (NarrowDialog) below 768px. Base UI owns Esc, the focus trap and
 * focus return; global shortcuts stop under it. At layer 1, over the agent
 * detail surface it opens from, as before.
 *
 * `surfaceRef` is where its selects open, inside the dialog (its focus trap
 * and its layer).
 */
export function RuntimeConfigEditorFrame({
  title,
  onClose,
  surfaceRef,
  children,
}: {
  title: string;
  onClose: () => void;
  surfaceRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  return (
    <DialogCard title={title} onClose={onClose} layer={1} narrow="sheet" testId="agent-runtime-config-dialog">
      <div ref={surfaceRef}>{children}</div>
    </DialogCard>
  );
}

import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import DialogCard from "../ui/DialogCard";
import HandoffCreateFlow from "./HandoffCreateFlow";
import type { HandoffFlowState } from "./HandoffCreateFlow";

// Task #110 (@WAWQAQ): "Take over a local session" is its own entry in the
// sidebar's Agents "+" menu (next to Create Agent / Create external agent) and
// its own dialog — not a mode buried inside Create Agent (task #104's
// placement, reverted here). The host owns the close constraint: while the
// flow is creating, X / Esc / backdrop must not tear it down mid-request.
export default function HandoffDialog({ onClose }: { onClose: () => void }) {
  const { formatMessage } = useIntl();
  const [flowState, setFlowState] = useState<HandoffFlowState>({ creating: false, retryPending: false });
  const closeDialog = useCallback(() => {
    if (flowState.creating) return;
    onClose();
  }, [flowState.creating, onClose]);
  return (
    <DialogCard
      title={formatMessage({ id: "handoff.dialog.title" })}
      onClose={closeDialog}
      maxWidthClass="max-w-2xl"
      testId="handoff-dialog"
      narrow="sheet"
    >
      <p className="mb-4 text-subhead text-foreground-muted">{formatMessage({ id: "handoff.dialog.subtitle" })}</p>
      <HandoffCreateFlow onClose={closeDialog} onStateChange={setFlowState} />
    </DialogCard>
  );
}

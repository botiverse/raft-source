import { useCallback } from "react";
import type { ReactNode, RefObject } from "react";
import { useIntl } from "react-intl";
import { Dialog, DialogSurface } from "@botiverse/raft-ui";
import { NarrowDialogContent } from "../../components/ui/NarrowDialog";

/**
 * The frame of onboarding Screen C (Create Cindy). In the setup gate ("step",
 * "page") it is the bare surface the gate places. Opened on its own ("modal":
 * from the members panel, or a hosted Cindy's DM banner) it is a raft-ui
 * Dialog: Base UI's Esc, focus trap and focus return, no scrim press (as the
 * old Modal), and focus starting on the dialog itself rather than its ×. The
 * frame is the runtime selects' portal target either way, so in the dialog
 * they open inside its focus trap.
 */
export function CreateCindyFrame({
  modal,
  onClose,
  portalRef,
  className,
  children,
}: {
  modal: boolean;
  onClose: () => void;
  portalRef: RefObject<HTMLElement | null>;
  className: string;
  children: ReactNode;
}) {
  const { formatMessage } = useIntl();
  const setPopup = useCallback((node: HTMLDivElement | null) => { portalRef.current = node; }, [portalRef]);
  const handleOpenChange = useCallback((open: boolean) => { if (!open) onClose(); }, [onClose]);
  if (!modal) {
    return (
      <DialogSurface render={<section ref={portalRef} />} className={className} data-testid="create-cindy-screen-c">
        {children}
      </DialogSurface>
    );
  }
  const title = formatMessage({ id: "agent.create.meetCindy" });
  return (
    <Dialog open disablePointerDismissal onOpenChange={handleOpenChange}>
      <NarrowDialogContent
        ref={setPopup}
        narrow="centered"
        initialFocus={portalRef}
        className={className}
        aria-label={title}
        data-testid="create-cindy-screen-c"
        header={null}
        title={title}
        closeLabel={formatMessage({ id: "common.close" })}
      >
        {children}
      </NarrowDialogContent>
    </Dialog>
  );
}

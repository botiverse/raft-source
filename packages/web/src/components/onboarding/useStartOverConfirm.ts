import { useCallback, useRef, useState } from "react";
import { trackServerSetupAction } from "../../analytics/serverSetup";

/**
 * The gate's "Start over?" confirm: whether it shows, and the Start over links
 * that open it. Start over again while it shows (a double click, a held Enter:
 * raft-ui's TextLink repeats it, as a native button does) neither reopens it
 * nor records start_over twice; a ref, as the state is only read after a render.
 */
export function useStartOverConfirm(serverId: string) {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const show = useCallback((step: "computer_runtime" | "create_agent") => {
    if (openRef.current) return;
    openRef.current = true;
    trackServerSetupAction(serverId, step, "start_over");
    setOpen(true);
  }, [serverId]);
  const close = useCallback(() => {
    openRef.current = false;
    setOpen(false);
  }, []);
  const fromComputer = useCallback(() => show("computer_runtime"), [show]);
  const fromCreateAgent = useCallback(() => show("create_agent"), [show]);
  return { open, close, fromComputer, fromCreateAgent };
}

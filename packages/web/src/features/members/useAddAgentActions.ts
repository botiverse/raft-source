import { useCallback, useMemo } from "react";
import { trackAgentCreateOpened } from "../../analytics/journey";
import { isHandoffAvailable } from "../../components/handoff/handoffSessions";

/** Which add-agent dialog the Members page has open. */
export type AddAgentStep = "create" | "external" | "handoff" | null;

/** The ways to add an agent, for MembersCreateAgentButton: `openHandoff` is null where it doesn't apply. */
export interface AddAgentActions {
  openCreate: () => void;
  openHandoff: (() => void) | null;
  openExternal: () => void;
}

/**
 * The ways to add an agent from the Members page: Create agent, and the two the
 * Members sidebar's + menu also held, Take over a local session (the desktop
 * app only, isHandoffAvailable) and Connect an external agent, behind the
 * header's split button (MembersCreateAgentButton).
 */
export function useAddAgentActions(onStep: (step: AddAgentStep) => void): AddAgentActions {
  const openCreate = useCallback(() => {
    trackAgentCreateOpened("members_page");
    onStep("create");
  }, [onStep]);
  const openHandoff = useCallback(() => onStep("handoff"), [onStep]);
  const openExternal = useCallback(() => {
    trackAgentCreateOpened("members_page_external");
    onStep("external");
  }, [onStep]);
  return useMemo(
    () => ({ openCreate, openHandoff: isHandoffAvailable() ? openHandoff : null, openExternal }),
    [openCreate, openExternal, openHandoff],
  );
}

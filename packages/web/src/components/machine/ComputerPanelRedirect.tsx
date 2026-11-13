import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useProfileStore } from "../../store/profileStore";

/**
 * MainLayout's MachineRoute redirect from /computer/<id> to the computer's
 * side panel, `to` (/computers?profile=computer:<id>). It opens the panel in
 * the profile store as well as in the address: the store → URL sync writes
 * the address from the store when the path changes, and on a cold load that
 * runs before the address's `profile=` has been read into the store, so a
 * redirect by address alone lost the panel (the page landed on a bare
 * /computers).
 */
export function ComputerPanelRedirect({ to, machineId }: { to: string; machineId: string }) {
  const navigate = useNavigate();
  useEffect(() => {
    navigate(to, { replace: true });
    const { profileType, profileId } = useProfileStore.getState();
    // A redirect on mount, as <Navigate> is, not an event handler: no event triggers it.
    // oxlint-disable-next-line react-doctor/no-event-handler
    if (profileType !== "computer" || profileId !== machineId) useProfileStore.getState().openProfile("computer", machineId);
  }, [navigate, to, machineId]);
  return null;
}

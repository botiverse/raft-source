import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { trackAgentCreateOpened } from "../../analytics/journey";
import { deferredDialog } from "../../boot/deferredUi";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useServerStore } from "../../store/serverStore";

const CreateExternalAgentDialog = deferredDialog(() => import("./CreateExternalAgentDialog").then((module) => ({ default: module.CreateExternalAgentDialog })));

/** Analytics on display: the dialog opened from a URL, not from a click on this page. Mounted with it, once per opening. */
function LinkOpened() {
  useEffect(() => {
    trackAgentCreateOpened("link_external");
  }, []);
  return null;
}

/**
 * Link intent, as JointChannelLinkIntent: `?dialog=connect-external-agent` on
 * any page opens the same dialog as Members › Create agent › Connect an
 * external agent, for the Server open now. The query is removed at once, so a
 * reload or Back doesn't open it again; someone who can't create agents there
 * gets nothing (the menu isn't offered to them either). Recorded as
 * agent_create_opened with entry `link_external`, once per opening.
 */
export function ExternalAgentLinkIntent() {
  const location = useLocation();
  const navigate = useNavigate();
  const serverId = useServerStore((state) => state.current?.id);
  const { capabilities } = useServerPermissions();
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const close = useCallback(() => setOpenedFor(null), []);
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    if (query.get("dialog") !== "connect-external-agent") return;
    query.delete("dialog");
    navigate({ pathname: location.pathname, search: query.toString(), hash: location.hash }, { replace: true });
    if (serverId) setOpenedFor(serverId);
  }, [location.search, location.pathname, location.hash, navigate, serverId]);
  const open = openedFor !== null && openedFor === serverId && capabilities.createAgents;
  if (!open) return null;
  return (
    <>
      <LinkOpened />
      <CreateExternalAgentDialog onClose={close} />
    </>
  );
}

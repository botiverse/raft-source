import { useEffect, useMemo } from "react";
import type { ReactElement } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { isHostShell } from "../../embed";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { useProfileStore } from "../../store/profileStore";
import { useServerStore } from "../../store/serverStore";
import { COMPUTER_PANEL_QUERY } from "../../utils/computerPanel";

/** Router state the redirect leaves for the Members page: the profile it opened, to scroll into view (#702). */
export interface MembersLocateState {
  membersLocate: { type: "agent" | "human"; id: string };
}

/** Whether a profile opens in the side panel here (desktop, outside the host app's WebView), read at click time. */
export function opensProfileInPanel(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  if (isHostShell()) return false;
  const server = useServerStore.getState().current;
  if (!server?.slug || server.role === "guest") return false;
  return window.matchMedia(COMPUTER_PANEL_QUERY).matches;
}

/**
 * /agent/<id>, /agent/<id>/activity and /human/<id> from 768px, outside the
 * host app's WebView: the Members page with that profile open in the side
 * panel (raft-design products/raft-chat/members.md; the Computers pattern,
 * MainLayout's MachineRoute), on `agentTab` when the URL names one, so a link,
 * a bookmark or Create agent landing on a profile shows the Members page
 * beside it, never the old Members sidebar. The query (agentTab=, …) and hash
 * ride along, and the page scrolls the member into view (MembersLocateState).
 * The profile is opened in its store before the move: the right panel's
 * store→URL sync writes `profile=` from the store, so a URL that arrived
 * ahead of the store was rewritten without it, and the panel stayed shut.
 * A phone keeps the profile as its own page with Back, and a Guest, who has
 * no Members page, keeps it as before.
 */
export function useMembersProfileRedirect(
  type: "agent" | "human",
  id: string | undefined,
  agentTab?: string,
): ReactElement | null {
  const location = useLocation();
  const server = useServerStore((s) => s.current);
  const wide = useMediaQuery(COMPUTER_PANEL_QUERY);
  if (!id || !wide || isHostShell() || !server?.slug || server.role === "guest") return null;
  const params = new URLSearchParams(location.search);
  params.set("profile", `${type}:${id}`);
  const tab = agentTab ?? params.get("agentTab");
  if (tab) params.set("agentTab", tab);
  return (
    <OpenInMembers
      to={`/s/${server.slug}/members?${params.toString()}${location.hash}`}
      type={type}
      id={id}
      agentTab={type === "agent" ? tab : null}
    />
  );
}

function OpenInMembers({ to, type, id, agentTab }: { to: string; type: "agent" | "human"; id: string; agentTab: string | null }) {
  const navigate = useNavigate();
  const state = useMemo<MembersLocateState>(() => ({ membersLocate: { type, id } }), [id, type]);
  useEffect(() => {
    useProfileStore.getState().openProfile(type, id, agentTab ? { defaultAgentTabIntent: agentTab } : undefined);
    navigate(to, { replace: true, state });
  }, [agentTab, id, navigate, state, to, type]);
  return null;
}

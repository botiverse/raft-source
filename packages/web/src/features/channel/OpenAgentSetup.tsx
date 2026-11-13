import { useEffect, useRef } from "react";
import { useAppNavigate } from "../../hooks/useAppNavigate";

// Opens an external agent's setup page (/agent/:id) once its channel join
// landed. Mounted only at that moment, so ChannelMembers itself needs no
// Router: some surfaces and tests render it outside one.
// Keyed by agent id, so each created agent opens its own page once.
export function OpenAgentSetup({ agentId }: { agentId: string }) {
  const nav = useAppNavigate();
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    nav.toAgent(agentId);
  }, [agentId, nav]);
  return null;
}

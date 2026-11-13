import { Suspense, useEffect } from "react";
import { deferredPanel } from "../../boot/deferredUi";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { keepAgentContextViewFor, useAgentContextViewStore } from "../../store/agentContextViewStore";
import { PHONE_MEDIA_QUERY } from "../ui/NarrowDialog";

// The context view opens from a message's menu, never on the first screen, so
// its code (AgentContextViewPanel: the column, the phone page and the message
// list they show) is deferred (boot/deferredUi): fetched after the first
// screen, normally in before anyone opens it. These slots stay in the channel
// panel and the layout and render it only while a view is open.
const AgentContextViewSection = deferredPanel(() => import("./AgentContextViewPanel").then((module) => ({ default: module.AgentContextViewSection })));
const AgentContextViewPage = deferredPanel(() => import("./AgentContextViewPanel").then((module) => ({ default: module.AgentContextViewPage })));

/** The channel panel's context view section (AgentContextViewPanel's AgentContextViewSection), while one is open for this channel. */
export function AgentContextViewSectionSlot({ channelId }: { channelId: string }) {
  const phone = useMediaQuery(PHONE_MEDIA_QUERY);
  const open = useAgentContextViewStore((s) => s.open !== null && s.open.hostChannelId === channelId);
  // Here too, not only in the section: another channel closes a view before its code is in.
  useEffect(() => keepAgentContextViewFor(channelId), [channelId]);
  if (phone || !open) return null;
  return <Suspense fallback={null}><AgentContextViewSection channelId={channelId} /></Suspense>;
}

/** The phone's context view page (AgentContextViewPanel's AgentContextViewPage), while one is open. */
export function AgentContextViewPageSlot() {
  const phone = useMediaQuery(PHONE_MEDIA_QUERY);
  const open = useAgentContextViewStore((s) => s.open !== null);
  if (!phone || !open) return null;
  return <Suspense fallback={null}><AgentContextViewPage /></Suspense>;
}

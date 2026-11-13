// Route: /s/:serverSlug/assistant — the personal assistant (RFC 075 v4).
//
// Gate: the rail entry and the phone Home row show only when the server's
// `personal_assistant` flag is on AND the assistant API says `enabled`.
// Otherwise a typed or bookmarked URL lands here and is redirected to the
// server's home. While the flag or the API is still answering, the page waits
// rather than bounce. No assistant yet: Create; otherwise its DM (or "Setting
// up your chat…" while dmChannelId is still null).

import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { useIntl } from "react-intl";
import { Spinner } from "@botiverse/raft-ui";
import PanelHeader from "../components/ui/PanelHeader";
import { useMobileBack } from "../hooks/useAppNavigate";
import { useServerStore } from "../store/serverStore";
import { useMyAssistant } from "./assistantClient";
import CreateAssistantView from "./CreateAssistantView";
import AssistantConversation from "./AssistantConversation";
import { clearAssistantExpandOrigin, dropAssistantCarry, peekAssistantExpandOrigin } from "./assistantExpand";

const LOADING_HEADER_PROPS = { className: "md:hidden" };
const MOBILE_BACK_PROPS = { "data-testid": "assistant-mobile-back" } as const;

/** While the assistant answers. On a phone the page is a pushed page (a Home
 *  row opens it), so it has the same head and Back as the page it turns into
 *  (Raft DS › Navigation: a page while it loads is no dead end). Wider
 *  screens keep the bare spinner. */
function AssistantLoading() {
  const { formatMessage } = useIntl();
  const serverSlug = useServerStore((s) => s.current?.slug ?? null);
  const onMobileBack = useMobileBack(serverSlug ? `/s/${serverSlug}` : "/");
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-layer-canvas">
      <PanelHeader
        title={formatMessage({ id: "assistant.title" })}
        onMobileBack={onMobileBack}
        mobileBackProps={MOBILE_BACK_PROPS}
        containerProps={LOADING_HEADER_PROPS}
      />
      <div className="flex flex-1 items-center justify-center" data-testid="assistant-loading">
        <Spinner aria-label={formatMessage({ id: "assistant.loading" })} />
      </div>
    </div>
  );
}

export default function AssistantRoute() {
  const serverId = useServerStore((s) => s.current?.id ?? null);
  // One page per server: switching servers on this route remounts it, so an
  // origin taken on one server never comes back after visiting another.
  return <AssistantServerPage key={serverId ?? "none"} serverId={serverId} />;
}

function AssistantServerPage({ serverId }: { serverId: string | null }) {
  const serverSlug = useServerStore((s) => s.current?.slug ?? null);
  // Expanded from the otter's popover just now: where it was, for Back to
  // popover. Taken once per visit (the next visit, by the rail or a link,
  // goes back to the conversation behind it instead), and kept here while
  // the page stays mounted.
  const [expandOrigin] = useState(() => peekAssistantExpandOrigin(serverId));
  useEffect(() => {
    clearAssistantExpandOrigin();
    dropAssistantCarry();
  }, []);
  const mine = useMyAssistant();
  if (mine.status === "loading") return <AssistantLoading />;
  if (mine.status === "off") return <Navigate to={serverSlug ? `/s/${serverSlug}` : "/"} replace />;
  if (!mine.assistant) return <CreateAssistantView />;
  return (
    <AssistantConversation
      assistant={mine.assistant}
      settings={mine.settings}
      expandOrigin={expandOrigin?.serverId === serverId ? expandOrigin : null}
    />
  );
}

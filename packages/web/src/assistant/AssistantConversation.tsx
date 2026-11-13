import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import { PanelAction, Spinner } from "@botiverse/raft-ui";
import { ArrowLeft, Minimize2 } from "lucide-react";
import { ChatPanel } from "../features/channel/ChatPanel";
import AvatarSlot from "../components/ui/AvatarSlot";
import { PHONE_MEDIA_QUERY } from "../components/ui/NarrowDialog";
import PanelHeader from "../components/ui/PanelHeader";
import Tooltip from "../components/ui/Tooltip";
import { useMediaQuery } from "../hooks/effectPrimitives";
import { useInAppNavigationStack, useMobileBack } from "../hooks/useAppNavigate";
import { useAgentStore } from "../store/agentStore";
import { useChannelStore } from "../store/channelStore";
import { useServerStore } from "../store/serverStore";
import { getDmSetupRetryDelaysMs, refetchMyAssistant } from "./assistantClient";
import type { AssistantOwnerSettings, AssistantRecord } from "./assistantClient";
import { useAssistantComposerReference } from "./AssistantContextChip";
import type { AssistantContextRef } from "./AssistantContextChip";
import { currentHistoryIdx, previousConversation, requestAssistantReopen, shrinkNavigation } from "./assistantExpand";
import type { AssistantExpandOrigin } from "./assistantExpand";
import { AssistantSettingsButton } from "./AssistantSettingsButton";
import { AssistantPausedChip, useAssistantPause } from "./AssistantPaused";

const MOBILE_BACK_PROPS = { "data-testid": "assistant-mobile-back" } as const;
const HEADER_CONTAINER_PROPS = { "data-testid": "assistant-header" } as const;
const TOOLTIP_CONTENT_PROPS = { side: "bottom" as const };

/**
 * The header's subtitle (what it can read, or what it is doing): one line,
 * cut with an ellipsis where it does not fit (the 380px popover, a phone), so
 * the 56px head keeps the name and this line whole. While it is cut, hovering
 * or focusing it shows the whole line, the same check as
 * TruncatedAttachmentTooltip (AttachmentChip): no tooltip repeating a line
 * shown in full. Callers key it by its text, so a new line is measured anew.
 */
export function AssistantSubtitle({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [cut, setCut] = useState(false);
  const measure = useCallback(() => {
    const node = ref.current;
    setCut(Boolean(node && node.scrollWidth > node.clientWidth + 1));
  }, []);
  useEffect(() => {
    measure();
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure]);
  return (
    <Tooltip content={text} disabled={!cut} contentProps={TOOLTIP_CONTENT_PROPS}>
      <span
        ref={ref}
        className="block truncate"
        data-testid="assistant-subtitle"
        // Focusable only while cut, so a keyboard reaches the whole line
        // (content shown on hover is shown on focus too, WCAG 1.4.13).
        // oxlint-disable-next-line react-doctor/no-noninteractive-tabindex
        tabIndex={cut ? 0 : undefined}
        onPointerEnter={measure}
        onFocus={measure}
      >
        {text}
      </span>
    </Tooltip>
  );
}

/**
 * Has an assistant: its header (name, what it can read, as its DM switch
 * says, and the settings entry),
 * then the owner's DM with its agent in the regular ChatPanel, without
 * ChatPanel's own header and without tasks. The assistant's summaries and
 * morning brief carry channel, thread and task references, which ChatPanel
 * renders as the usual reference chips.
 *
 * Its header has Back to popover (on a desktop; on a phone the page's own
 * Back is the way back): to where it goes back to (`useReturnTo`), with the
 * popover open again there; with no conversation to go back to it is a plain
 * Back, to Home. Leaving for it by the browser's Back opens the popover there too.
 */
export default function AssistantConversation({
  assistant,
  settings,
  expandOrigin = null,
}: {
  assistant: AssistantRecord;
  settings: AssistantOwnerSettings;
  /** The page the otter's popover was expanded from, on this server (AssistantRoute). */
  expandOrigin?: AssistantExpandOrigin | null;
}) {
  const { formatMessage } = useIntl();
  const navigate = useNavigate();
  const phone = useMediaQuery(PHONE_MEDIA_QUERY);
  const serverSlug = useServerStore((s) => s.current?.slug ?? null);
  const home = serverSlug ? `/s/${serverSlug}` : "/";
  const returnTo = useReturnTo(expandOrigin, assistant.dmChannelId);
  // On a phone the page is pushed over the one it was expanded from, so its
  // Back is already the way back there (Raft DS › Navigation: one way back on
  // a pushed page); leaving reopens the sheet (below).
  const onMobileBack = useMobileBack(home);
  // However the page is left, an otter on `returnTo`'s own history entry
  // opens its popover: the browser's Back lands there like Back to popover
  // does. Back to popover asks for itself (its replace lands on another
  // entry). In the layout phase, before the next page's otter mounts.
  const askedRef = useRef(false);
  // The latest target, for the cleanup when the page is left.
  const returnToRef = useRef(returnTo);
  returnToRef.current = returnTo;
  useLayoutEffect(() => () => {
    const to = returnToRef.current;
    if (to && !askedRef.current) requestAssistantReopen(to);
  }, []);
  const shrink = useCallback(() => {
    const to = returnTo;
    if (!to) {
      navigate(home, { replace: true });
      return;
    }
    const step = shrinkNavigation(to, currentHistoryIdx());
    askedRef.current = true;
    requestAssistantReopen(step.back ? to : { ...to, historyIdx: null });
    if (step.back) navigate(-1);
    else navigate(step.path, { replace: true });
  }, [home, navigate, returnTo]);
  // The button says what it does (Tenny): Back to popover only where it
  // lands on a conversation with the popover open; Home, it is plain Back.
  const shrinkLabel = formatMessage({ id: returnTo ? "assistant.page.shrink" : "assistant.page.back" });
  const shrinkTooltip = returnTo ? formatMessage({ id: "assistant.page.shrinkTooltip" }) : shrinkLabel;
  const subtitle = formatMessage({ id: settings.readsDms === true ? "assistant.header.metaWithDms" : "assistant.header.meta" });
  const agentId = assistant.agentId;
  const avatarUrl = useAgentStore((s) => s.agents.find((agent) => agent.id === agentId)?.avatarUrl ?? null);
  // Paused by a server owner/admin (#10654): the state beside the name; the
  // notice with Start sits over the composer (ChatPanel).
  const paused = useAssistantPause(agentId) !== null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-layer-canvas" data-testid="assistant-conversation">
      <PanelHeader
        onMobileBack={onMobileBack}
        mobileBackProps={MOBILE_BACK_PROPS}
        iconSlot={<AvatarSlot context="panel-header" type="agent" agentAvatarUrl={avatarUrl} />}
        iconKind="avatar"
        iconAlwaysVisible
        title={assistant.name}
        titleSuffix={paused ? <AssistantPausedChip className="shrink-0" /> : undefined}
        subtitle={<AssistantSubtitle key={subtitle} text={subtitle} />}
        containerProps={HEADER_CONTAINER_PROPS}
        actions={(
          <>
            {!phone ? (
              <Tooltip content={shrinkTooltip} contentProps={TOOLTIP_CONTENT_PROPS}>
                <PanelAction aria-label={shrinkLabel} onClick={shrink} data-testid="assistant-shrink">
                  {returnTo ? <Minimize2 /> : <ArrowLeft />}
                </PanelAction>
              </Tooltip>
            ) : null}
            <AssistantSettingsButton assistant={assistant} />
          </>
        )}
      />
      {assistant.dmChannelId === null ? (
        <AssistantChatSettingUp />
      ) : (
        <AssistantDm dmChannelId={assistant.dmChannelId} name={assistant.name} />
      )}
    </div>
  );
}

/**
 * Where this page goes back to: the page Expand was pressed on; reached any
 * other way, the conversation behind it in this tab's history
 * (previousConversation); null: none. Follows NavigationDepthTracker's
 * records, which may record this page's own entry after its first render.
 * This page's own history index is read in that first render, while the
 * browser is still on it.
 */
function useReturnTo(expandOrigin: AssistantExpandOrigin | null, assistantDmId: string | null): AssistantExpandOrigin | null {
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const serverSlug = useServerStore((s) => s.current?.slug ?? null);
  const stack = useInAppNavigationStack();
  const [historyIdx] = useState(currentHistoryIdx);
  return useMemo(() => {
    if (expandOrigin) return expandOrigin;
    if (!serverId || !serverSlug) return null;
    return previousConversation(stack, {
      serverId,
      serverSlug,
      assistantPath: `/s/${serverSlug}/assistant`,
      assistantDmId,
      historyIdx,
    });
  }, [assistantDmId, expandOrigin, historyIdx, serverId, serverSlug, stack]);
}

/**
 * The assistant exists but its DM with the owner does not yet: say so and ask
 * again with backoff. When the DM appears the cached record updates and the
 * DM replaces this; if it never does, this stays (no error, no crash).
 */
function AssistantChatSettingUp() {
  const { formatMessage } = useIntl();
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const delays = getDmSetupRetryDelaysMs();
    const schedule = (attempt: number) => {
      if (cancelled || attempt >= delays.length) return;
      timer = setTimeout(() => {
        refetchMyAssistant().catch(() => undefined).finally(() => schedule(attempt + 1));
      }, delays[attempt]);
    };
    schedule(0);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);
  const label = formatMessage({ id: "assistant.settingUpChat" });
  return (
    <div
      role="status"
      className="flex flex-1 items-center justify-center gap-2 px-6 text-center text-callout text-foreground-muted"
      data-testid="assistant-chat-setting-up"
    >
      <Spinner aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

const NO_DETACH = () => {};

/**
 * The owner's DM with the assistant's agent, in the regular ChatPanel (here
 * and in the otter's panel). From the otter, `context` is the conversation it
 * was opened from, a chip on the composer until `onDetachContext`. In the
 * popover the URL is the page's under it (`inPopover`): its `msg` and
 * `thread` name that page's messages, not this DM's.
 */
export function AssistantDm({ dmChannelId, name, context = null, onDetachContext = NO_DETACH, inPopover = false }: {
  dmChannelId: string;
  name: string;
  context?: AssistantContextRef | null;
  onDetachContext?: () => void;
  inPopover?: boolean;
}) {
  const { formatMessage } = useIntl();
  const composerReference = useAssistantComposerReference(context, onDetachContext);
  const channel = useChannelStore((s) => s.dmChannels.find((c) => c.id === dmChannelId) ?? null);
  const ensureChannel = useChannelStore((s) => s.ensureChannel);
  const [missing, setMissing] = useState<string | null>(null);
  const hasChannel = channel !== null;
  useEffect(() => {
    if (hasChannel) return;
    let cancelled = false;
    void ensureChannel(dmChannelId).then((resolved) => {
      if (!cancelled && !resolved) setMissing(dmChannelId);
    });
    return () => { cancelled = true; };
  }, [dmChannelId, ensureChannel, hasChannel]);

  if (!channel && missing === dmChannelId) {
    return (
      <div role="alert" className="flex flex-1 items-center justify-center px-6 text-center text-callout text-foreground-muted" data-testid="assistant-dm-missing">
        {formatMessage({ id: "assistant.conversationMissing" }, { name })}
      </div>
    );
  }
  if (!channel) {
    return (
      <div className="flex flex-1 items-center justify-center text-callout text-foreground-muted">
        {formatMessage({ id: "assistant.loadingConversation" })}
      </div>
    );
  }
  return <ChatPanel channel={channel} hideHeader allowTasks={false} composerReference={composerReference} ownsUrl={!inPopover} />;
}

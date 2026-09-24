import { useEffect, useReducer } from "react";
import { Hash, LogIn } from "lucide-react";
import { useIntl } from "react-intl";
import api from "../api/client";
import AvatarSlot from "../components/ui/AvatarSlot";
import Banner from "../components/ui/Banner";
import Button from "../components/ui/Button";
import PanelHeader from "../components/ui/PanelHeader";
import { getApiErrorResponse } from "../utils/apiErrorResponse";

interface PublicChannel {
  id: string;
  name: string;
  description: string | null;
}

interface PublicServerReadback {
  server: { id: string; name: string; slug: string; avatarUrl: string | null };
  channels: PublicChannel[];
}

interface PublicMessage {
  id: string;
  senderType: "user" | "agent" | "external_projection";
  senderName: string;
  messageType: "chat" | "system";
  content: string;
  createdAt: string;
}

interface PublicPageState {
  readback: PublicServerReadback | null;
  selectedChannelId: string | null;
  messages: PublicMessage[];
  loadingMessages: boolean;
  hasOlder: boolean;
  error: string;
}

type PublicPageAction =
  | { type: "loadServer" }
  | { type: "serverLoaded"; readback: PublicServerReadback }
  | { type: "selectChannel"; channelId: string }
  | { type: "loadMessages" }
  | { type: "messagesLoaded"; messages: PublicMessage[] }
  | { type: "olderLoaded"; channelId: string; messages: PublicMessage[] }
  | { type: "failed"; error: string };

function publicPageReducer(state: PublicPageState, action: PublicPageAction): PublicPageState {
  switch (action.type) {
    case "loadServer": return {
      readback: null,
      selectedChannelId: null,
      messages: [],
      loadingMessages: false,
      hasOlder: false,
      error: "",
    };
    case "serverLoaded": return {
      ...state,
      readback: action.readback,
      selectedChannelId: action.readback.channels[0]?.id ?? null,
    };
    case "selectChannel": return { ...state, selectedChannelId: action.channelId, messages: [], hasOlder: false };
    case "loadMessages": return { ...state, loadingMessages: true, error: "" };
    case "messagesLoaded": return { ...state, loadingMessages: false, messages: action.messages, hasOlder: action.messages.length === 50 };
    case "olderLoaded": return state.selectedChannelId === action.channelId
      ? { ...state, loadingMessages: false, messages: [...action.messages, ...state.messages], hasOlder: action.messages.length === 50 }
      : state;
    case "failed": return { ...state, loadingMessages: false, error: action.error };
  }
}

export default function PublicServerPage({
  slug,
  onSignIn,
  onRegister,
  onUnavailable,
}: {
  slug: string;
  onSignIn: () => void;
  onRegister: () => void;
  onUnavailable: () => void;
}) {
  const { formatMessage, formatDate, formatTime } = useIntl();
  const [state, dispatch] = useReducer(publicPageReducer, {
    readback: null,
    selectedChannelId: null,
    messages: [],
    loadingMessages: false,
    hasOlder: false,
    error: "",
  });
  const { readback, selectedChannelId, messages, loadingMessages, hasOlder, error } = state;

  useEffect(() => {
    let active = true;
    dispatch({ type: "loadServer" });
    api.get<PublicServerReadback>(`/public/servers/${encodeURIComponent(slug)}`)
      .then(({ data }) => {
        if (!active) return;
        dispatch({ type: "serverLoaded", readback: data });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const response = getApiErrorResponse(err);
        if (response?.status === 404) {
          onUnavailable();
          return;
        }
        dispatch({ type: "failed", error: response?.error || formatMessage({ id: "pages.publicServer.failedLoad" }) });
      });
    return () => {
      active = false;
    };
  }, [formatMessage, onUnavailable, slug]);

  useEffect(() => {
    if (!selectedChannelId) {
      return;
    }
    let active = true;
    dispatch({ type: "loadMessages" });
    api.get<{ messages: PublicMessage[] }>(`/public/servers/${encodeURIComponent(slug)}/channels/${selectedChannelId}/messages`)
      .then(({ data }) => {
        if (!active) return;
        dispatch({ type: "messagesLoaded", messages: data.messages });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const response = getApiErrorResponse(err);
        dispatch({ type: "failed", error: response?.status === 404
          ? formatMessage({ id: "pages.publicServer.noLongerPublic" })
          : response?.error || formatMessage({ id: "pages.publicServer.failedMessages" }) });
      });
    return () => {
      active = false;
    };
  }, [formatMessage, selectedChannelId, slug]);

  const loadOlder = async () => {
    if (!selectedChannelId || messages.length === 0) return;
    dispatch({ type: "loadMessages" });
    try {
      const beforeMessageId = messages[0]!.id;
      const { data } = await api.get<{ messages: PublicMessage[] }>(
        `/public/servers/${encodeURIComponent(slug)}/channels/${selectedChannelId}/messages?beforeMessageId=${encodeURIComponent(beforeMessageId)}`,
      );
      dispatch({ type: "olderLoaded", channelId: selectedChannelId, messages: data.messages });
    } catch (err: unknown) {
      const response = getApiErrorResponse(err);
      dispatch({ type: "failed", error: response?.status === 404
        ? formatMessage({ id: "pages.publicServer.noLongerPublic" })
        : response?.error || formatMessage({ id: "pages.publicServer.failedMessages" }) });
    }
  };

  if (!readback && !error) {
    return <div className="flex min-h-screen items-center justify-center bg-brutal-cream font-display font-bold">{formatMessage({ id: "common.loading" })}</div>;
  }

  const selected = readback?.channels.find((channel) => channel.id === selectedChannelId) ?? null;
  const initial = (readback?.server.name || "S").trim().charAt(0).toUpperCase() || "S";

  return (
    <div className="flex h-dvh min-h-screen flex-col overflow-hidden bg-white font-display text-black" data-testid="public-server-page">
      <Banner
        intent="info"
        density="sm"
        className="z-10 w-full shrink-0 items-center rounded-none border-x-0 border-t-0"
        data-testid="public-server-top-banner"
        actions={(
          <div className="flex items-center gap-2">
            <Button size="xs" tone="white" onClick={onSignIn}><LogIn size={13} />{formatMessage({ id: "pages.publicServer.signIn" })}</Button>
            <Button size="xs" tone="pink" onClick={onRegister}>{formatMessage({ id: "pages.publicServer.join" })}</Button>
          </div>
        )}
      >
        <span className="font-bold">{formatMessage({ id: "pages.publicServer.banner" })}</span>
      </Banner>

      <div className="flex min-h-0 flex-1" data-testid="public-server-existing-shell">
        <aside className="hidden w-[52px] shrink-0 border-r-2 border-black bg-soft-signal p-2 sm:flex sm:justify-center" data-testid="public-server-app-rail">
          {readback ? <AvatarSlot context="panel-header" type="server" serverAvatarUrl={readback.server.avatarUrl} serverInitial={initial} /> : null}
        </aside>

        <nav className="w-36 shrink-0 overflow-y-auto border-r-2 border-black bg-brutal-cream sm:w-[240px]" aria-label={formatMessage({ id: "pages.publicServer.channelsLabel" })} data-testid="public-server-channel-sidebar">
          <div className="flex h-panel-header items-center border-b-2 border-black px-4">
            <h1 className="truncate text-base font-bold">{readback?.server.name}</h1>
          </div>
          <div className="p-3">
            <p className="mb-2 px-2 text-[11px] font-bold uppercase tracking-wider text-black/50">
              {formatMessage({ id: "pages.publicServer.channelsLabel" })}
            </p>
            {readback?.channels.map((channel) => (
              <button
                key={channel.id}
                type="button"
                onClick={() => dispatch({ type: "selectChannel", channelId: channel.id })}
                className={`mb-1 flex w-full items-center gap-1.5 border-2 px-2 py-1 text-left text-sm font-medium ${selectedChannelId === channel.id ? "border-black bg-brutal-pink font-bold shadow-brutal-sm" : "border-transparent transition-colors hover:border-black hover:bg-white hover:shadow-brutal-sm"}`}
              >
                <Hash size={15} className="shrink-0" />
                <span className="min-w-0 truncate">{channel.name}</span>
              </button>
            ))}
          </div>
        </nav>

        <main className="flex min-w-0 flex-1 flex-col bg-white" data-testid="public-server-channel-panel">
          {selected ? (
            <>
              <PanelHeader
                title={selected.name}
                subtitle={selected.description}
                icon={<Hash size={18} />}
                iconBg="bg-soft-signal"
                containerProps={{ "data-testid": "public-server-channel-header" }}
              />
              {error ? <Banner intent="warning" className="m-3 shrink-0">{error}</Banner> : null}
              <div className="min-h-0 flex-1 overflow-y-auto" aria-live="polite" data-testid="public-server-message-timeline">
                {hasOlder ? (
                  <div className="py-3 text-center">
                    <Button size="xs" tone="white" disabled={loadingMessages} onClick={() => void loadOlder()}>
                      {formatMessage({ id: "pages.publicServer.loadOlder" })}
                    </Button>
                  </div>
                ) : null}
                {messages.map((message) => {
                  const senderInitial = message.senderName.trim().charAt(0).toUpperCase() || "?";
                  return (
                    <article key={message.id} className="flex gap-3 px-5 py-3 hover:bg-black/[0.025]">
                      <span className="flex size-9 shrink-0 items-center justify-center border-2 border-black bg-brutal-cyan text-sm font-bold" aria-hidden="true">{senderInitial}</span>
                      <div className="min-w-0 flex-1">
                        <div className="mb-0.5 flex flex-wrap items-baseline gap-2">
                          <span className="text-sm font-bold">{message.senderName}</span>
                          <time className="font-mono text-[11px] text-black/45" dateTime={message.createdAt}>
                            {formatDate(message.createdAt, { year: "numeric", month: "short", day: "numeric" })} {formatTime(message.createdAt, { hour: "2-digit", minute: "2-digit" })}
                          </time>
                        </div>
                        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{message.content}</p>
                      </div>
                    </article>
                  );
                })}
                {!loadingMessages && messages.length === 0 ? (
                  <div className="flex h-full items-center justify-center p-6 text-center text-sm text-black/50">
                    {formatMessage({ id: "pages.publicServer.emptyMessages" })}
                  </div>
                ) : null}
                {loadingMessages && messages.length === 0 ? (
                  <div className="p-6 text-center text-sm font-bold">{formatMessage({ id: "common.loading" })}</div>
                ) : null}
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-center text-sm text-black/55">
              {formatMessage({ id: "pages.publicServer.emptyChannels" })}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

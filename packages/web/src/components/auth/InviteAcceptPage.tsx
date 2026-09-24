import { useState, useEffect } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import type { MessageId } from "../../i18n/messages";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../../store/authStore";
import { useServerStore } from "../../store/serverStore";
import api from "../../api/client";
import { storePendingInvite } from "../../utils/socialAuth";
import { ArrowLeft, LogIn, UserPlus } from "lucide-react";
import Banner from "../ui/Banner";
import Button from "../ui/Button";
import CenteredCardFrame from "./CenteredCardFrame";
import { AuthPageIntro } from "./AuthPageFrame";
import AgreementBody from "../server/AgreementBody";

interface InviteAcceptPageProps {
  token: string;
  onInviteConsumed: () => void;
  onSwitchToLogin: () => void;
  onSwitchToRegister: () => void;
}

const BOLD_CHUNKS = { b: (chunks: React.ReactNode) => <strong key="b">{chunks}</strong> };

/**
 * Inside-count sentence for the invite page. Each SHAPE (humans only, agents
 * only, both) is one complete catalog message rather than fragments joined at
 * runtime: the connectives and the plural forms differ per language, and Chinese
 * places the counts differently, so only a whole sentence is translatable.
 * Returns null when the server has no humans/agents to mention.
 */
function renderInsideCount(
  humans: number,
  agents: number,
  formatMessage: IntlShape["formatMessage"],
): React.ReactNode {
  if (humans > 0 && agents > 0) {
    return formatMessage({ id: "pages.invite.insideBoth" }, { humans, agents, ...BOLD_CHUNKS });
  }
  if (humans > 0) return formatMessage({ id: "pages.invite.insideHumans" }, { humans, ...BOLD_CHUNKS });
  if (agents > 0) return formatMessage({ id: "pages.invite.insideAgents" }, { agents, ...BOLD_CHUNKS });
  return null;
}

function renderInsidePreview(
  inviteInfo: { memberCount: number; agentCount: number; insideCountsHidden?: boolean },
  formatMessage: IntlShape["formatMessage"],
): React.ReactNode {
  if (inviteInfo.insideCountsHidden) {
    return formatMessage({ id: "pages.invite.insideEveryone" }, BOLD_CHUNKS);
  }
  return renderInsideCount(inviteInfo.memberCount, inviteInfo.agentCount, formatMessage);
}

function clearInviteUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete("invite");
  const nextPath = window.location.pathname.startsWith("/join/") ? "/" : url.pathname;
  const nextSearch = url.searchParams.toString();
  window.history.replaceState({}, "", `${nextPath}${nextSearch ? `?${nextSearch}` : ""}${url.hash}`);
}

export default function InviteAcceptPage({
  token,
  onInviteConsumed,
  onSwitchToLogin,
  onSwitchToRegister,
}: InviteAcceptPageProps) {
  const { formatMessage } = useIntl();
  const user = useAuthStore((s) => s.user);
  const acceptInvite = useAuthStore((s) => s.acceptInvite);
  const loadServers = useServerStore((s) => s.loadServers);
  const setCurrent = useServerStore((s) => s.setCurrent);
  const navigate = useNavigate();

  const [inviteInfo, setInviteInfo] = useState<{
    kind: "email" | "join_link";
    serverName: string;
    inviterName: string | null;
    memberCount: number;
    agentCount: number;
    insideCountsHidden?: boolean;
    humanSeatLimitReached?: boolean;
    humanSeatLimitMessage?: string | null;
    agreement: {
      id: string;
      title: string;
      bodyMarkdown: string;
      version: number;
    } | null;
  } | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [acceptedServerName, setAcceptedServerName] = useState("");
  const [acceptedServerId, setAcceptedServerId] = useState("");
  const [error, setError] = useState("");
  const [errorId, setErrorId] = useState<MessageId | null>(null);
  const errorText = error || (errorId ? formatMessage({ id: errorId }) : "");
  const insidePreview = inviteInfo ? renderInsidePreview(inviteInfo, formatMessage) : null;
  const humanSeatLimitReached = inviteInfo?.humanSeatLimitReached === true;

  // Load invite info
  useEffect(() => {
    const loadInfo = async () => {
      try {
        const { data } = await api.get(`/auth/invite-info?token=${encodeURIComponent(token)}`);
        setInviteInfo(data);
      } catch (err: any) {
        const status = err?.response?.status;
        if (status === 404) {
          setErrorId("pages.invite.invalidOrExpired");
        } else if (status === 429) {
          setErrorId("pages.invite.tooManyAttempts");
        } else {
          setErrorId("pages.invite.failedToLoad");
        }
      } finally {
        setLoadingInfo(false);
      }
    };
    // Async-loader pattern: `inviteInfo` + `loadingInfo` are server-fetch
    // results / transient async indicators, not prop-derived state. Same FP
    // family as AgentDetailPanel's integrations loader.
    // oxlint-disable-next-line react-doctor/no-derived-state
    loadInfo();
  }, [token]);

  const handleAccept = async (agreementId?: string | null) => {
    setAccepting(true);
    setError("");
    setErrorId(null);
    try {
      const result = await acceptInvite(token, agreementId);
      setAccepted(true);
      setAcceptedServerName(result.serverName);
      setAcceptedServerId(result.serverId);

      clearInviteUrl();
      onInviteConsumed();

      // Reload servers and route directly into the joined server so we do not
      // fall back through "/" and restore a previously active server tab.
      await loadServers();
      const joinedServer = useServerStore.getState().servers.find((server) => server.id === result.serverId);
      if (joinedServer) {
        setCurrent(joinedServer);
        navigate(`/s/${joinedServer.slug}`, { replace: true });
        return;
      }

      // Fallback only if the fresh server list still does not contain the joined
      // server yet. The continue button will retry by serverId.
    } catch (err: any) {
      const response = err?.response?.data;
      if ((response?.error === "agreement_required" || response?.error === "agreement_changed") && response.agreement) {
        setInviteInfo((current) => current ? { ...current, agreement: response.agreement } : current);
        setError("");
    setErrorId(null);
        return;
      }
      if (response?.error) {
        setError(response.error);
      } else {
        setErrorId("pages.invite.failedToAccept");
      }
    } finally {
      setAccepting(false);
    }
  };

  const handleContinue = () => {
    const joinedServer = useServerStore.getState().servers.find((server) => server.id === acceptedServerId);
    if (joinedServer) {
      setCurrent(joinedServer);
      navigate(`/s/${joinedServer.slug}`, { replace: true });
      return;
    }
    window.location.reload();
  };

  if (loadingInfo) {
    return (
      <CenteredCardFrame>
        <div className="w-full">
          <AuthPageIntro title={formatMessage({ id: "pages.invite.loadingTitle" })} />
        </div>
      </CenteredCardFrame>
    );
  }

  if (accepted) {
    return (
      <CenteredCardFrame>
        <div className="w-full">
          <AuthPageIntro
            title={formatMessage({ id: "pages.invite.acceptedTitle" })}
            description={formatMessage(
              { id: "pages.invite.acceptedDescription" },
              { server: () => <strong key="accepted-server">{acceptedServerName}</strong> },
            )}
          />
          <Button
            onClick={handleContinue}
            size="lg"
            tone="pink"
            className="w-full"
          >
            {formatMessage({ id: "pages.invite.continueToRaft" })}
          </Button>
        </div>
      </CenteredCardFrame>
    );
  }

  return (
    <CenteredCardFrame>
      <div className="w-full">
        {errorText ? (
          <>
            <AuthPageIntro title={formatMessage({ id: "pages.invite.errorTitle" })} />
            <Banner intent="warning" className="mb-6 font-bold">
              {errorText}
            </Banner>
          </>
        ) : inviteInfo ? (
          <>
            <AuthPageIntro
              title={formatMessage({
                id: inviteInfo.kind === "join_link"
                  ? "pages.invite.joinThisServer"
                  : "pages.invite.youreInvited",
              })}
              description={inviteInfo.kind === "join_link"
                ? formatMessage(
                    { id: "pages.invite.joinLinkDescription" },
                    { server: () => <strong key="join-link-server">{inviteInfo.serverName}</strong> },
                  )
                : formatMessage(
                    { id: "pages.invite.inviterDescription" },
                    {
                      inviter: () => <strong key="inviter">{inviteInfo.inviterName}</strong>,
                      server: () => <strong key="invite-server">{inviteInfo.serverName}</strong>,
                    },
                  )}
            >
              {insidePreview && (
                <p className="mt-2 text-sm text-black/60">
                  {insidePreview}
                </p>
              )}
            </AuthPageIntro>
            {inviteInfo.agreement && (
              <div className="card-brutal mb-4 p-4 text-left">
                <div className="mb-3">
                  <div className="text-sm font-bold text-black">{inviteInfo.agreement.title}</div>
                  <div className="mt-0.5 text-xs text-black/50">
                    {formatMessage(
                      { id: "pages.invite.agreementVersion" },
                      { version: inviteInfo.agreement.version },
                    )}
                  </div>
                </div>
                <div className="max-h-56 overflow-y-auto border-2 border-black/30 bg-brutal-cream p-3 text-sm">
                  <AgreementBody source={inviteInfo.agreement.bodyMarkdown} />
                </div>
              </div>
            )}
            {humanSeatLimitReached && (
              <Banner intent="warning" className="mb-6 font-bold">
                {formatMessage({ id: "pages.invite.humanSeatLimit" })}
              </Banner>
            )}
          </>
        ) : null}

        {accepting && (
          <div className="mb-4 text-center text-sm text-black/60">
            {formatMessage({ id: "pages.invite.joiningServer" })}
          </div>
        )}

        {user && inviteInfo && !errorText && !humanSeatLimitReached && (
          <Button
            onClick={() => void handleAccept(inviteInfo.agreement?.id)}
            disabled={accepting}
            size="lg"
            tone="pink"
            className="w-full"
          >
            {accepting
              ? formatMessage({ id: "pages.invite.joiningServer" })
              : formatMessage({ id: inviteInfo.agreement ? "pages.invite.agreeAndJoin" : "pages.invite.joinServer" })}
          </Button>
        )}

        {!user && inviteInfo && !errorText && !humanSeatLimitReached && (
          <div className="space-y-3">
            <p className="text-center text-sm text-black/60 mb-4">
              {formatMessage({ id: "pages.invite.signInPrompt" })}
            </p>
            <Button
              onClick={() => {
                // Store invite token for after login, then clear URL and switch view
                storePendingInvite(token);
                clearInviteUrl();
                onSwitchToLogin();
              }}
              size="lg"
              shape="iconText"
              tone="pink"
              className="w-full"
            >
              <LogIn size={16} />
              {formatMessage({ id: "pages.invite.signIn" })}
            </Button>
            <button
              onClick={() => {
                storePendingInvite(token);
                clearInviteUrl();
                onSwitchToRegister();
              }}
              className="btn-brutal-sm flex w-full items-center justify-center gap-2 bg-white p-2 text-sm"
            >
              <UserPlus size={14} />
              {formatMessage({ id: "pages.invite.createAccount" })}
            </button>
          </div>
        )}

        {(errorText || humanSeatLimitReached) && (
          <button
            onClick={() => {
              clearInviteUrl();
              window.location.reload();
            }}
            className="btn-brutal flex w-full items-center justify-center gap-2 bg-white px-3 py-2 text-sm"
          >
            <ArrowLeft size={16} />
            {formatMessage({ id: "pages.invite.goToRaft" })}
          </button>
        )}
      </div>
    </CenteredCardFrame>
  );
}

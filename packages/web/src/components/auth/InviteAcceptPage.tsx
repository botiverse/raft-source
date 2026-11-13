import { useCallback, useState, useEffect, useRef } from "react";
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
import { Button, Card, ScrollArea } from "@botiverse/raft-ui";
import CenteredCardFrame from "./CenteredCardFrame";
import { AuthPageIntro } from "./AuthPageFrame";
import AgreementBody from "../server/AgreementBody";
import { DeploymentUserLimitText } from "../ui/DeploymentUserLimitText";
import { isDeploymentUserLimitRefusal } from "../../utils/deploymentUserLimit";

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

/**
 * The page says a full link's owners were told: tell them (task #10), once per
 * link. The server checks the seats, the flag and who made the link. Best
 * effort: the page reads the same either way.
 */
function useTellOwnersSeatsFull(token: string, shown: boolean): void {
  const toldFor = useRef<string | null>(null);
  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-event-handler -- Rendering is the event: the page showing the full state, which no handler observes.
    if (!shown || toldFor.current === token) return;
    toldFor.current = token;
    api.post("/invites/seat-blocked", { token }).catch(() => undefined);
  }, [shown, token]);
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
    /** The seats are full and pro_seat_add is on for this server; the server says so, since a visitor signed out can't evaluate the flag. */
    seatNoticeEnabled?: boolean;
    /** The source-available deployment is at the Raft License's user limit: only someone already counted can join. */
    deploymentUserLimitReached?: boolean;
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
  // The accept refused at the Raft License's user limit: its sentence has a mail link, so it is not a string.
  const [userLimitRefused, setUserLimitRefused] = useState(false);
  const errorText = error || (errorId ? formatMessage({ id: errorId }) : "");
  const hasError = Boolean(errorText) || userLimitRefused;
  const insidePreview = inviteInfo ? renderInsidePreview(inviteInfo, formatMessage) : null;
  const humanSeatLimitReached = inviteInfo?.humanSeatLimitReached === true;
  // Behind pro_seat_add (task #10, cindyz): someone signed out sees only Sign In
  // and Create Account; once signed in, the page says the owners were told.
  // Without it, the page says the seats are full to everyone, as before.
  const seatNotice = humanSeatLimitReached && inviteInfo?.seatNoticeEnabled === true;
  const seatsFull = humanSeatLimitReached && (!seatNotice || Boolean(user));
  useTellOwnersSeatsFull(token, seatNotice && Boolean(user) && !errorText);

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

  const handleAccept = useCallback(async (agreementId?: string | null) => {
    setAccepting(true);
    setError("");
    setErrorId(null);
    setUserLimitRefused(false);
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
      if (isDeploymentUserLimitRefusal(err)) {
        setUserLimitRefused(true);
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
  }, [token, acceptInvite, loadServers, setCurrent, navigate, onInviteConsumed]);

  const handleContinue = useCallback(() => {
    const joinedServer = useServerStore.getState().servers.find((server) => server.id === acceptedServerId);
    if (joinedServer) {
      setCurrent(joinedServer);
      navigate(`/s/${joinedServer.slug}`, { replace: true });
      return;
    }
    window.location.reload();
  }, [acceptedServerId, setCurrent, navigate]);

  const handleJoin = useCallback(() => {
    void handleAccept(inviteInfo?.agreement?.id);
  }, [inviteInfo, handleAccept]);

  const handleSignIn = useCallback(() => {
    // Store invite token for after login, then clear URL and switch view
    storePendingInvite(token);
    clearInviteUrl();
    onSwitchToLogin();
  }, [token, onSwitchToLogin]);

  const handleCreateAccount = useCallback(() => {
    storePendingInvite(token);
    clearInviteUrl();
    onSwitchToRegister();
  }, [token, onSwitchToRegister]);

  const handleReload = useCallback(() => {
    clearInviteUrl();
    window.location.reload();
  }, []);

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
            size="xl"
            variant="accent"
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
        {hasError ? (
          <>
            <AuthPageIntro title={formatMessage({ id: "pages.invite.errorTitle" })} />
            <Banner intent="warning" className="mb-6" data-testid={userLimitRefused ? "invite-user-limit-refused" : undefined}>
              {userLimitRefused ? <DeploymentUserLimitText /> : errorText}
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
                <p className="mt-2 text-callout text-foreground-muted">
                  {insidePreview}
                </p>
              )}
            </AuthPageIntro>
            {inviteInfo.agreement && (
              <Card className="mb-4 p-4 text-left">
                <div className="mb-3">
                  <div className="text-subhead font-bold text-foreground">{inviteInfo.agreement.title}</div>
                  <div className="mt-0.5 font-mono text-mono-meta text-foreground-hint">
                    {formatMessage(
                      { id: "pages.invite.agreementVersion" },
                      { version: inviteInfo.agreement.version },
                    )}
                  </div>
                </div>
                {/* A region named after the agreement, inside the page's scroller: a scroll past its end carries on to the page. */}
                <ScrollArea role="region" aria-label={inviteInfo.agreement.title} overscroll="auto" className="max-h-56 border-t border-line-hairline text-callout text-foreground-muted" contentClassName="pt-3">
                  <AgreementBody source={inviteInfo.agreement.bodyMarkdown} />
                </ScrollArea>
              </Card>
            )}
            {seatsFull && (seatNotice ? (
              <Banner
                intent="info"
                withIcon
                className="mb-6"
                title={formatMessage({ id: "pages.invite.seatsFullTitle" }, { server: inviteInfo.serverName })}
                data-testid="invite-seats-full"
              >
                {formatMessage({ id: "pages.invite.seatsFullBody" })}
              </Banner>
            ) : (
              <Banner intent="warning" className="mb-6">
                {formatMessage({ id: "pages.invite.humanSeatLimit" })}
              </Banner>
            ))}
            {/* Said before Join: someone already counted (a member elsewhere here) still gets in, so Join stays. */}
            {!seatsFull && inviteInfo.deploymentUserLimitReached === true && (
              <Banner intent="info" withIcon className="mb-6" data-testid="invite-user-limit-notice">
                <DeploymentUserLimitText id="deploymentUserLimit.inviteNotice" />
              </Banner>
            )}
          </>
        ) : null}

        {accepting && (
          <div className="mb-4 text-center text-callout text-foreground-muted">
            {formatMessage({ id: "pages.invite.joiningServer" })}
          </div>
        )}

        {user && inviteInfo && !hasError && !seatsFull && (
          <Button
            onClick={handleJoin}
            disabled={accepting}
            size="xl"
            variant="accent"
            className="w-full"
          >
            {accepting
              ? formatMessage({ id: "pages.invite.joiningServer" })
              : formatMessage({ id: inviteInfo.agreement ? "pages.invite.agreeAndJoin" : "pages.invite.joinServer" })}
          </Button>
        )}

        {!user && inviteInfo && !hasError && !seatsFull && (
          <div className="stack-y-3">
            <p className="mb-4 text-center text-callout text-foreground-muted">
              {formatMessage({ id: "pages.invite.signInPrompt" })}
            </p>
            <Button
              onClick={handleSignIn}
              size="xl"
              variant="accent"
              className="w-full"
            >
              <LogIn size={16} />
              {formatMessage({ id: "pages.invite.signIn" })}
            </Button>
            <Button size="lg"
              variant="outline"
              className="w-full"
              onClick={handleCreateAccount}
            >
              <UserPlus size={18} />
              {formatMessage({ id: "pages.invite.createAccount" })}
            </Button>
          </div>
        )}

        {(hasError || seatsFull) && (
          <Button size="lg"
            variant="outline"
            className="w-full"
            onClick={handleReload}
          >
            <ArrowLeft size={18} />
            {formatMessage({ id: "pages.invite.goToRaft" })}
          </Button>
        )}
      </div>
    </CenteredCardFrame>
  );
}

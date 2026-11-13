import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { useNavigate, useParams } from "react-router-dom";
import { Button, TextLink } from "@botiverse/raft-ui";
import { MAX_JOINT_CHANNEL_SERVERS } from "@botiverse/raft-shared";
import CenteredCardFrame from "../components/auth/CenteredCardFrame";
import { AuthPageIntro } from "../components/auth/AuthPageFrame";
import SignedInAs from "../components/auth/SignedInAs";
import { PaywallShown } from "../analytics/paywall";
import { ServerUpgradeDialog } from "../components/billing/DeferredServerUpgradeDialog";
import { ServerRow } from "../components/externalInvite/ServerRow";
import { useOpenJoinedChannel } from "../components/externalInvite/useOpenJoinedChannel";
import Banner from "../components/ui/Banner";
import {
  apiErrorCode,
  apiErrorStatus,
  approveServerConnectRequest,
  approverErrorMessage,
  getServerConnectRequest,
  limitOwnerNames,
  rejectServerConnectRequest,
  upgradesHere,
} from "../components/externalInvite/externalInviteAccept";
import type { RefusalMessage, ServerConnectRequestView } from "../components/externalInvite/externalInviteAccept";
import type { MessageId } from "../i18n/messages";
import { useAuthStore } from "../store/authStore";
import { useServerStore } from "../store/serverStore";
import { openUpgradeDialog } from "../store/upgradeDialogStore";
import type { ExternalLimitContext } from "../store/upgradeDialogStore";

/**
 * "Upgrade … and approve" was pressed for this request in this tab: the
 * server it upgrades, kept across the Stripe round trip. Paid without it (a
 * link with the return parameters), the page never approves.
 */
const upgradeAndApproveKey = (requestId: string) => `raft.upgradeAndApprove.${requestId}`;
function writeUpgradeAndApproveMarker(requestId: string, serverId: string): void {
  try { window.sessionStorage.setItem(upgradeAndApproveKey(requestId), serverId); } catch { /* storage off: no auto-approve */ }
}
function readUpgradeAndApproveMarker(requestId: string): string | null {
  try { return window.sessionStorage.getItem(upgradeAndApproveKey(requestId)); } catch { return null; }
}
function clearUpgradeAndApproveMarker(requestId: string): void {
  try { window.sessionStorage.removeItem(upgradeAndApproveKey(requestId)); } catch { /* nothing to clear */ }
}

/**
 * The page the approval email links to (#wg-rbac:#16, P2b-2, design v5.0
 * B3): someone invited to an external channel asks an owner or admin of a
 * server they're in to connect it. Only the named approver sees the request
 * (anyone else, and every request while external_channels_v1 is off for the
 * host, gets the server's 404: "not valid" here).
 *
 * Approve connects the server (200), or starts the channel's conversion and
 * connects after it (202). Decline is one click with no confirmation: it
 * hands the invite back to the invitee, who is emailed and can ask again or
 * join another way, so it takes nothing away that anyone holds.
 *
 * The approver's role is checked only when they act (cindyz a8bac9ef): an
 * approver who lost it reads "You can no longer approve this request" and the
 * server has already cancelled the request and told the invitee.
 *
 * A free server already in an external channel (design v4 E, the server's
 * `targetServer.atLimit`) says so as the page opens. Its owner upgrades and
 * approves in one step: the upgrade dialog opens on this page
 * (ServerUpgradeDialog), and once the server is Pro (back from Stripe, or
 * paid in another window) the page approves by itself. An admin can't
 * approve until an owner upgrades; Decline stays. An older server says none
 * of it: Approve, and the limit as its refusal, as before.
 */

type Ended =
  | "approved"
  | "rejected"
  | "cancelled"
  | "expired"
  | "lostRole"
  | "requesterLeft"
  | "archived"
  | "alreadyConnected"
  | "connected"
  | "connecting"
  | "declined";

type Step =
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "loadFailed" }
  | { kind: "pending" }
  /** `channelId`: the approver's server's channel once connected (the approve's answer), for "Open #channel". */
  | { kind: "ended"; why: Ended; channelId?: string };

const STATUS_ENDED: Record<Exclude<ServerConnectRequestView["status"], "pending">, Ended> = {
  approved: "approved",
  rejected: "rejected",
  cancelled: "cancelled",
  expired: "expired",
};

/** Refusals that end the request for this approver: a page of their own instead of a banner. */
const CODE_ENDED: Record<string, Ended> = {
  approver_lost_role: "lostRole",
  requester_left: "requesterLeft",
  request_expired: "expired",
  channel_archived: "archived",
  already_connected: "alreadyConnected",
};

/** Each ended state's title and description: serverConnectRequest.<state>.title / .description. */
function endedTitleId(why: Ended): MessageId {
  return `serverConnectRequest.${why}.title`;
}

function endedDescriptionId(why: Ended): MessageId {
  return `serverConnectRequest.${why}.description`;
}

export default function ServerConnectRequestPage() {
  const { id = "" } = useParams<{ id: string }>();
  const { formatMessage, formatList } = useIntl();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const myServers = useServerStore((s) => s.servers);
  const setCurrent = useServerStore((s) => s.setCurrent);

  // The request as last read and the step the page is on: one state, set together.
  const [view, setView] = useState<{ request: ServerConnectRequestView | null; step: Step }>({ request: null, step: { kind: "loading" } });
  const { request, step } = view;
  const setStep = useCallback((next: Step) => setView((current) => ({ ...current, step: next })), []);
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const [error, setError] = useState<RefusalMessage | null>(null);
  const [reload, setReload] = useState(0);
  // Paid on this page (ServerUpgradeDialog): the limit is lifted.
  const [paidHere, setPaidHere] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getServerConnectRequest(id)
      .then((data) => {
        if (cancelled) return;
        setView({ request: data, step: data.status === "pending" ? { kind: "pending" } : { kind: "ended", why: STATUS_ENDED[data.status] } });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStep(apiErrorStatus(err) === 404 ? { kind: "invalid" } : { kind: "loadFailed" });
      });
    return () => {
      cancelled = true;
    };
  }, [id, reload, setStep]);

  const target = myServers.find((server) => server.id === request?.targetServer.id) ?? null;
  // The free plan's one external channel, known as the page opens: the owner upgrades and approves; an admin waits for one.
  const limited = step.kind === "pending" && request?.targetServer.atLimit === true && !paidHere ? request : null;
  const upgradeHere = limited !== null && target !== null && upgradesHere(limited.targetServer, target.role);
  const waitsForOwner = limited !== null && !upgradeHere && limited.canApprove !== false;

  const handleFailure = useCallback((err: unknown) => {
    if (apiErrorStatus(err) === 404) {
      setStep({ kind: "invalid" });
      return;
    }
    const code = apiErrorCode(err);
    if (code === "request_not_pending") {
      // Decided meanwhile (by this approver elsewhere, or the invitee's invite moved on): read what it is now.
      setReload((n) => n + 1);
      return;
    }
    if (code && CODE_ENDED[code]) {
      setStep({ kind: "ended", why: CODE_ENDED[code] });
      return;
    }
    setError(approverErrorMessage(err, target));
  }, [target, setStep]);

  const handleApprove = useCallback(async () => {
    setBusy("approve");
    setError(null);
    try {
      const result = await approveServerConnectRequest(id);
      setStep(result.state === "connecting" ? { kind: "ended", why: "connecting" } : { kind: "ended", why: "connected", channelId: result.channelId });
    } catch (err) {
      handleFailure(err);
    } finally {
      setBusy(null);
    }
  }, [id, handleFailure, setStep]);

  // Paid on this page: approve, as "Upgrade and approve" said (the dialog shows
  // once the request is read). Only for the request's own target server, and
  // only after this person pressed "Upgrade … and approve" for this request in
  // this tab (the marker set before Stripe): a crafted link naming another,
  // already paid server must never approve on load (Warden, #14553 review).
  const handlePaid = useCallback((paidServerId: string) => {
    if (!request || paidServerId !== request.targetServer.id) return;
    if (readUpgradeAndApproveMarker(id) !== paidServerId) return;
    clearUpgradeAndApproveMarker(id);
    setPaidHere(true);
    if (step.kind === "pending") void handleApprove();
  }, [id, request, step.kind, handleApprove]);

  const handleDecline = useCallback(async () => {
    setBusy("decline");
    setError(null);
    try {
      await rejectServerConnectRequest(id);
      setStep({ kind: "ended", why: "declined" });
    } catch (err) {
      handleFailure(err);
    } finally {
      setBusy(null);
    }
  }, [id, handleFailure, setStep]);

  const handleUpgrade = useCallback(() => {
    const gate = error?.upgrade;
    if (!target || !gate) return;
    setCurrent(target);
    navigate(`/s/${target.slug}`);
    // The joint free-server cap's dialog for no specific limit names no paywall, so no surface, as before.
    openUpgradeDialog(gate, gate === "general" ? { serverId: target.id } : { serverId: target.id, surface: "connect_request_page" });
  }, [error, target, setCurrent, navigate]);

  // "Open #channel" (design B3): into the channel on the approver's server
  // where it is known (the approve's answer, or the request once connected),
  // else that server.
  const openChannel = useOpenJoinedChannel();
  const landingChannelId = (step.kind === "ended" ? step.channelId : undefined) ?? request?.targetChannelId ?? null;
  const handleOpenServer = useCallback(() => {
    if (request && landingChannelId) {
      void openChannel(request.targetServer.id, landingChannelId);
      return;
    }
    if (!target) {
      navigate("/", { replace: true });
      return;
    }
    setCurrent(target);
    navigate(`/s/${target.slug}`, { replace: true });
  }, [request, landingChannelId, openChannel, target, setCurrent, navigate]);

  const handleRetryLoad = useCallback(() => {
    setStep({ kind: "loading" });
    setReload((n) => n + 1);
  }, [setStep]);
  const handleLogout = useCallback(() => {
    void logout();
  }, [logout]);

  const channel = `#${request?.channelName ?? ""}`;
  const externalContext = useMemo<ExternalLimitContext>(() => ({ kind: "connect", channel }), [channel]);
  const handleUpgradeAndApprove = useCallback(() => {
    if (!target) return;
    writeUpgradeAndApproveMarker(id, target.id);
    openUpgradeDialog("external_channel_free_limit", { serverId: target.id, surface: "connect_request_page", externalContext, onPage: true });
  }, [externalContext, id, target]);

  const values = {
    channel,
    host: request?.hostServerName ?? "",
    target: request?.targetServer.name ?? "",
    requester: request?.requester.name ?? "",
    max: MAX_JOINT_CHANNEL_SERVERS,
  };

  // Why Approve waits (design v4 E): the owner's way on, or who can lift it, named when the server says who.
  const limitLine = () => {
    if (upgradeHere) return formatMessage({ id: "serverConnectRequest.limitUpgrade" }, values);
    const owners = limitOwnerNames(request?.targetServer.owners, user?.id);
    return owners.length > 0
      ? formatMessage({ id: "serverConnectRequest.limitAskOwnerNamed" }, { ...values, owners: formatList(owners, { type: "disjunction" }) })
      : formatMessage({ id: "serverConnectRequest.limitAskOwner" }, values);
  };

  const signOut = (
    <div className="mt-3 text-center">
      <TextLink className="text-footnote" onClick={handleLogout}>
        {formatMessage({ id: "externalInvite.signOut" })}
      </TextLink>
    </div>
  );

  const frame = (title: string, description: ReactNode, body: ReactNode, testId: string) => (
    <CenteredCardFrame>
      <div className="w-full" data-testid={testId}>
        <AuthPageIntro title={title} description={description}>
          <p className="mt-2 text-callout text-foreground-muted"><SignedInAs user={user} /></p>
        </AuthPageIntro>
        {body}
      </div>
      <ServerUpgradeDialog externalContext={externalContext} onPaid={handlePaid} />
    </CenteredCardFrame>
  );

  if (step.kind === "loading") {
    return (
      <CenteredCardFrame>
        <div className="w-full" data-testid="connect-request-loading">
          <AuthPageIntro title={formatMessage({ id: "serverConnectRequest.loading" })} />
        </div>
      </CenteredCardFrame>
    );
  }

  if (step.kind === "invalid" || step.kind === "loadFailed") {
    const invalid = step.kind === "invalid";
    return frame(
      formatMessage({ id: invalid ? "serverConnectRequest.invalid.title" : "externalInvite.loadFailed.title" }),
      formatMessage({ id: invalid ? "serverConnectRequest.invalid.description" : "externalInvite.loadFailed.description" }),
      <>
        {invalid ? null : (
          <Button size="lg" variant="outline" className="w-full" onClick={handleRetryLoad}>
            {formatMessage({ id: "externalInvite.retry" })}
          </Button>
        )}
        {signOut}
      </>,
      invalid ? "connect-request-invalid" : "connect-request-load-failed",
    );
  }

  if (step.kind === "ended") {
    const openable = step.why === "connected" || step.why === "approved" || step.why === "alreadyConnected";
    return frame(
      formatMessage({ id: endedTitleId(step.why) }, values),
      formatMessage({ id: endedDescriptionId(step.why) }, values),
      <>
        {openable ? (
          <Button size="xl" variant="accent" className="w-full" onClick={handleOpenServer}>
            {/* Into the channel where it's known; else the server, named as such. */}
            {formatMessage({ id: "externalInvite.openServer" }, { target: landingChannelId ? values.channel : values.target })}
          </Button>
        ) : null}
        {signOut}
      </>,
      `connect-request-${step.why}`,
    );
  }

  return frame(
    formatMessage({ id: "serverConnectRequest.title" }, values),
    formatMessage({ id: "serverConnectRequest.description" }, values),
    <>
      {/* The server being connected: the approver owns or administers it, so it is in their own list (tile, slug). */}
      <ServerRow server={target} name={values.target} meta={target ? `/${target.slug}` : null} />
      {upgradeHere || waitsForOwner ? (
        <Banner intent="warning" live={false} className="mb-4" data-testid="connect-request-limit">
          {limitLine()}
          <PaywallShown gate="external_channel_free_limit" surface="connect_request_page" serverId={request?.targetServer.id} />
        </Banner>
      ) : null}
      {error ? (
        <Banner
          intent="warning"
          className="mb-4"
          data-testid="connect-request-error"
          actions={error.upgrade && target ? (
            <Button size="md" variant="outline" type="button" onClick={handleUpgrade}>
              {formatMessage({ id: "externalInvite.upgrade" })}
            </Button>
          ) : undefined}
        >
          {formatMessage({ id: error.id }, values)}
        </Banner>
      ) : null}
      <div className="stack-y-3">
        <Button
          size="xl"
          variant="accent"
          className="w-full"
          onClick={upgradeHere ? handleUpgradeAndApprove : handleApprove}
          disabled={busy === "decline" || waitsForOwner}
          loading={busy === "approve"}
          loadingLabel={formatMessage({ id: "serverConnectRequest.approving" })}
          data-testid={upgradeHere ? "connect-request-upgrade-approve" : "connect-request-approve"}
        >
          {formatMessage({ id: upgradeHere ? "serverConnectRequest.upgradeAndApprove" : "serverConnectRequest.approve" }, values)}
        </Button>
        <Button
          size="lg"
          variant="outline"
          className="w-full"
          onClick={handleDecline}
          disabled={busy === "approve"}
          loading={busy === "decline"}
          loadingLabel={formatMessage({ id: "serverConnectRequest.declining" })}
          data-testid="connect-request-decline"
        >
          {formatMessage({ id: "serverConnectRequest.decline" })}
        </Button>
      </div>
      {signOut}
    </>,
    "connect-request-pending",
  );
}

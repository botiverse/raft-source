import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { useNavigate, useParams } from "react-router-dom";
import { Button, Field, FieldDescription, FieldLabel, Input, TextLink } from "@botiverse/raft-ui";
import { ChoiceList } from "@botiverse/raft-ui/wip";
import { MAX_JOINT_CHANNEL_SERVERS } from "@botiverse/raft-shared";
import type { ChoiceListItem } from "@botiverse/raft-ui/wip";
import CenteredCardFrame from "../components/auth/CenteredCardFrame";
import { AuthPageIntro } from "../components/auth/AuthPageFrame";
import SignedInAs from "../components/auth/SignedInAs";
import { useServerNameAndSlug } from "../components/auth/useServerNameAndSlug";
import FormField from "../components/ui/FormField";
import SlugInput from "../components/ui/SlugInput";
import Banner from "../components/ui/Banner";
import { DeploymentUserLimitText } from "../components/ui/DeploymentUserLimitText";
import { ServerRow } from "../components/externalInvite/ServerRow";
import { ApproverPicker, CancelRequestConfirm, InviteProgress } from "../components/externalInvite/InviteProgress";
import { InviteStepActions } from "../components/externalInvite/InviteStepActions";
import { stepForStatus, useInvitePolling } from "../components/externalInvite/inviteSteps";
import type { InviteNotice, InviteStep as Step, InviteView as View } from "../components/externalInvite/inviteSteps";
import { InviteWaysIn } from "../components/externalInvite/InviteWaysIn";
import { connectServerItem } from "../components/externalInvite/connectServerItem";
import { ConnectLimitNotes } from "../components/externalInvite/ConnectLimitNotes";
import { useInviteUpgrade } from "../components/externalInvite/useInviteUpgrade";
import { useOpenJoinedChannel } from "../components/externalInvite/useOpenJoinedChannel";
import { ServerUpgradeDialog } from "../components/billing/DeferredServerUpgradeDialog";
import {
  acceptExternalInviteAsGuest,
  apiErrorCode,
  apiErrorServerId,
  apiErrorStatus,
  cancelServerConnectRequest,
  connectNewServerWithInvite,
  connectServerWithInvite,
  connectServersWithInvite,
  getExternalInvite,
  inviteeErrorMessage,
  NEW_SERVER_FIELD_ERROR_VALUES,
  newServerFieldErrors,
  newServerInputRefusal,
  requestServerConnectApproval,
} from "../components/externalInvite/externalInviteAccept";
import type {
  ConnectableServer,
  ExternalInviteForInvitee,
  InviteeAction,
  NewServerFieldErrors,
  RefusalMessage,
  ServerSelection,
} from "../components/externalInvite/externalInviteAccept";
import { useAuthStore } from "../store/authStore";
import { useServerStore } from "../store/serverStore";
import type { Server } from "../store/serverStore";

/**
 * The page an external channel invite's email links to (#wg-rbac:#16, P2b-2,
 * design v5.0 B1, B2, B4, B5), laid out like "Choose server"
 * (ServerSelector: the centered card, Signed in as, an inset ListRowGroup).
 *
 * Signed out, the app shows Sign In at this address and the page opens once
 * signed in; an unverified account verifies first (App.tsx). The server
 * decides everything else: the invite's one neutral 404 (invalid, expired,
 * withdrawn, or external_channels_v1 off for the host) is this page's
 * "not valid"; one not sent to the account signed in opens on "isn't for
 * this account", the address masked (`addressedToYou`, `invitedEmailMasked`).
 *
 * Ways in, as the server offers them (`options`): join as a Guest, connect
 * servers they're in (v5.0's multi-select: checkboxes), each directly
 * (owner/admin) or by asking one of its owners/admins, or create a new server
 * and connect it (P2b-4, B1's third row). Joining as a Guest and creating a
 * server stay single choices of their own. One server chosen goes as before
 * (/connect, /request-approval); several go together (/connect-servers), each
 * decided on its own, and the page then lists where each stands (`progress`:
 * connected, connecting, waiting for its approver, or refused and why), as it
 * does when opened while several are under way. A new server is created as Create Server
 * creates one (the same name and slug fields and slug rules); a refusal after
 * it was created leaves the caller its owner, so the page says so and opens it.
 *
 * What the server tells the invitee alone: the request they're waiting on
 * (server, approver, Cancel Request), the one last declined, and once the
 * invite is theirs, where it put them ("#channel is ready", opened directly).
 * A limit refusal names whose limit it is; Upgrade only for their own server.
 * A server of theirs at its limit is listed with why (ConnectLimitNotes); its
 * owner upgrades it here and comes back to the list (useInviteUpgrade).
 */

const POLL_MS = 4000;

const INITIAL_VIEW: View = { invite: null, step: { kind: "loading" }, notice: null };
const NO_SERVERS: ConnectableServer[] = [];

/** `target`: the server the text names, when it isn't one of the invite's connectable servers (a new one). */
type ErrorState = (RefusalMessage & { serverId: string | null; target?: string }) | null;

/** A server connect-new-server created and then could not connect: the caller keeps it. */
type KeptServer = { id: string; name: string; slug: string };

export interface ExternalInvitePageProps {
  /** How often the connecting state asks again; tests shorten it. */
  pollMs?: number;
}

export default function ExternalInvitePage({ pollMs = POLL_MS }: ExternalInvitePageProps) {
  const { token = "" } = useParams<{ token: string }>();
  const { formatMessage, formatDate, formatList } = useIntl();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const myServers = useServerStore((s) => s.servers);
  const loadServers = useServerStore((s) => s.loadServers);
  const setCurrent = useServerStore((s) => s.setCurrent);

  // The invite as last read, the step it puts the page on, and a line about how it got there: one state, set together.
  const [view, setView] = useState<View>(INITIAL_VIEW);
  const { invite, step, notice } = view;
  const setStep = useCallback((next: Step) => setView((current) => ({ ...current, step: next })), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorState>(null);
  const [pickedServerIds, setPickedServerIds] = useState<string[]>([]);
  // The approver picked for each server that needs one; unpicked, its first owner or admin.
  const [pickedApproverIds, setPickedApproverIds] = useState<Record<string, string>>({});
  const { name: newServerName, slug: newServerSlug, handleNameChange, handleSlugChange } = useServerNameAndSlug();
  const [fieldErrors, setFieldErrors] = useState<NewServerFieldErrors>({});
  const [keptServer, setKeptServer] = useState<KeptServer | null>(null);
  const [reload, setReload] = useState(0);
  const serverPickerLabelId = useId();

  const servers = useMemo(() => invite?.options?.connect.servers ?? NO_SERVERS, [invite]);
  const serverById = useCallback((id: string | null) => servers.find((server) => server.id === id) ?? null, [servers]);
  const pickedServers = useMemo(
    () => pickedServerIds.flatMap((id) => servers.filter((server) => server.id === id)),
    [pickedServerIds, servers],
  );
  const approverFor = useCallback(
    (server: ConnectableServer) => pickedApproverIds[server.id] ?? server.approvers[0]?.id ?? null,
    [pickedApproverIds],
  );
  const myServer = useCallback((id: string | null | undefined): Server | null => myServers.find((server) => server.id === id) ?? null, [myServers]);
  const { externalContext, upgradeRow, upgradeInApp: upgradeServer, landingStep, refreshAfterPaid } = useInviteUpgrade({ token, channel: `#${invite?.channelName ?? ""}`, setView });

  useEffect(() => {
    let cancelled = false;
    getExternalInvite(token)
      .then((data) => {
        if (!cancelled) setView({ invite: data, step: landingStep(stepForStatus(data, null)), notice: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStep(apiErrorStatus(err) === 404 ? { kind: "invalid" } : { kind: "loadFailed" });
      });
    return () => {
      cancelled = true;
    };
  }, [token, reload, setStep, landingStep]);

  const openChannel = useOpenJoinedChannel();
  const landingOpenedRef = useRef(false);
  // Once, however many reads were in flight when it was accepted.
  const openLandingOnce = useCallback((landing: NonNullable<ExternalInviteForInvitee["accepted"]>) => {
    if (landingOpenedRef.current) return;
    landingOpenedRef.current = true;
    void openChannel(landing.serverId, landing.channelId);
  }, [openChannel]);

  // Asks again while a connection is under way or an approver decides (useInvitePolling).
  useInvitePolling({ token, step, invite, pollMs, setView, onAccepted: openLandingOnce });

  const itemLabels = useMemo(() => ({
    needsApproval: formatMessage({ id: "externalInvite.connect.needsApproval" }),
    atLimit: formatMessage({ id: "externalInvite.connect.atLimit" }),
    upgrade: formatMessage({ id: "externalInvite.upgrade" }),
    upgradeServer: (server: string) => formatMessage({ id: "externalInvite.connect.upgradeServer" }, { server }),
  }), [formatMessage]);
  const serverItems = useMemo<ChoiceListItem[]>(
    () => servers.map((server) => connectServerItem(server, myServers.find((mine) => mine.id === server.id) ?? null, itemLabels, upgradeRow)),
    [servers, myServers, itemLabels, upgradeRow],
  );
  // The channel's slots (design B1, v4.6#1): said only when there are more
  // servers to check than it can take (null: nothing said), counting down as
  // servers are checked (the ones still listed: a re-read may drop one); at 0
  // the rest can't be checked, each saying why.
  const slotsLeft = invite?.options?.connect.slotsLeft;
  const connectSlotsLeft = slotsLeft !== undefined && servers.filter((server) => !server.atLimit).length > slotsLeft
    ? Math.max(0, slotsLeft - pickedServers.length)
    : null;
  const noSlotLabel = formatMessage({ id: "externalInvite.connect.noSlot" });
  const connectItems = useMemo<ChoiceListItem[]>(() => {
    if (connectSlotsLeft !== 0) return serverItems;
    const picked = new Set(pickedServers.map((server) => server.id));
    const limited = new Set(servers.filter((server) => server.atLimit).map((server) => server.id));
    // A server at its own limit keeps its reason; the others say there's no slot.
    return serverItems.map((item) => (picked.has(item.value) || limited.has(item.value) ? item : { ...item, disabled: true, description: noSlotLabel }));
  }, [connectSlotsLeft, pickedServers, servers, serverItems, noSlotLabel]);
  const approvalServers = useMemo(
    () => (step.kind === "approval" ? step.serverIds.flatMap((id) => servers.filter((server) => server.id === id)) : NO_SERVERS),
    [step, servers],
  );
  const handlePickApprover = useCallback((serverId: string, approverId: string) => {
    setPickedApproverIds((current) => ({ ...current, [serverId]: approverId }));
  }, []);

  const values = useMemo(() => ({
    channel: `#${invite?.channelName ?? ""}`,
    server: invite?.serverName ?? "",
    inviter: invite?.inviterName ?? "",
    target: pickedServers[0]?.name ?? "",
  }), [invite, pickedServers]);

  /** A refusal: the neutral 404 is the wrong account, a request already waiting re-reads the invite, the rest is a banner. */
  const handleFailure = useCallback((err: unknown, action: InviteeAction, serverId: string | null, target?: string) => {
    if (apiErrorStatus(err) === 404) {
      setStep({ kind: "wrongAccount" });
      return;
    }
    const code = apiErrorCode(err);
    if (code === "approval_in_progress" || (code === "connect_in_progress" && action !== "guest")) {
      setReload((n) => n + 1);
      return;
    }
    const message = inviteeErrorMessage(err, action, myServer(serverId));
    setError({ ...message, serverId, target });
  }, [myServer, setStep]);

  // One action at a time: two clicks in one tick both see `busy` false (the ref doesn't wait for a render).
  const inFlightRef = useRef(false);
  const run = useCallback(async (work: () => Promise<void>) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    setError(null);
    setView((current) => ({ ...current, notice: null }));
    try {
      await work();
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }, []);

  const handleJoinAsGuest = useCallback(() => {
    void run(async () => {
      try {
        const joined = await acceptExternalInviteAsGuest(token);
        await openChannel(joined.serverId, joined.channelId);
      } catch (err) {
        handleFailure(err, "guest", null);
      }
    });
  }, [run, token, openChannel, handleFailure]);

  // Several servers go together: each decided on its own, then the list of where each stands.
  const connectMany = useCallback((selections: ServerSelection[]) => {
    const names = new Map(pickedServers.map((server) => [server.id, server.name]));
    void run(async () => {
      try {
        const outcomes = await connectServersWithInvite(token, selections);
        const fresh = await getExternalInvite(token).catch(() => null);
        const chosen = outcomes.map((outcome) => ({ ...outcome, name: names.get(outcome.serverId) ?? "" }));
        setView((current) => ({ invite: fresh ?? current.invite, step: { kind: "progress", chosen }, notice: null }));
      } catch (err) {
        handleFailure(err, "connect", null);
      }
    });
  }, [pickedServers, run, token, handleFailure]);

  const handleConnect = useCallback(() => {
    if (pickedServers.length === 0) return;
    const needApproval = pickedServers.filter((server) => server.needsApproval);
    if (needApproval.length > 0) {
      setError(null);
      setStep({ kind: "approval", serverIds: needApproval.map((server) => server.id) });
      return;
    }
    if (pickedServers.length > 1) {
      connectMany(pickedServers.map((server) => ({ serverId: server.id })));
      return;
    }
    const [server] = pickedServers as [ConnectableServer];
    void run(async () => {
      try {
        const result = await connectServerWithInvite(token, server.id);
        if (result.state === "connecting") {
          setStep({ kind: "connecting", serverId: server.id });
          return;
        }
        await openChannel(result.serverId, result.channelId);
      } catch (err) {
        handleFailure(err, "connect", server.id);
      }
    });
  }, [pickedServers, connectMany, run, token, openChannel, handleFailure, setStep]);

  const handleRequestApproval = useCallback(() => {
    if (step.kind !== "approval" || approvalServers.some((server) => !approverFor(server))) return;
    if (pickedServers.length > 1) {
      connectMany(pickedServers.map((server) => (
        server.needsApproval ? { serverId: server.id, approverUserId: approverFor(server)! } : { serverId: server.id }
      )));
      return;
    }
    const [server] = approvalServers;
    const approverId = server ? approverFor(server) : null;
    if (!server || !approverId) return;
    const approver = server.approvers.find((person) => person.id === approverId);
    void run(async () => {
      try {
        await requestServerConnectApproval(token, server.id, approverId);
        // A request runs until the invite does.
        setStep({ kind: "waiting", request: { serverId: server.id, serverName: server.name, approverName: approver?.name ?? "", expiresAt: invite?.expiresAt ?? "" } });
      } catch (err) {
        handleFailure(err, "request", server.id);
      }
    });
  }, [step, approvalServers, approverFor, pickedServers, connectMany, run, token, handleFailure, setStep, invite]);

  // Withdraw a pending request, once confirmed: the waiting page's one (the
  // page re-reads the invite), or one row of the progress list (the list
  // reads it again in place). A refusal shows on the page once the dialog has closed.
  const [confirmingCancel, setConfirmingCancel] = useState<{ requestId: string | null; approverName: string } | null>(null);
  const openCancelConfirm = useCallback(() => {
    if (step.kind === "waiting" && step.request) setConfirmingCancel({ requestId: null, approverName: step.request.approverName });
  }, [step]);
  const openRowCancelConfirm = useCallback((cancel: { requestId: string; approverName: string }) => setConfirmingCancel(cancel), []);
  const closeCancelConfirm = useCallback(() => setConfirmingCancel(null), []);
  const handleCancelRequest = useCallback(async () => {
    const requestId = confirmingCancel?.requestId ?? undefined;
    const reread = async () => {
      if (!requestId) {
        setReload((n) => n + 1);
        return;
      }
      const fresh = await getExternalInvite(token).catch(() => null);
      if (fresh) setView((current) => ({ ...current, invite: fresh }));
    };
    await run(async () => {
      try {
        await cancelServerConnectRequest(token, requestId);
        await reread();
      } catch (err) {
        if (apiErrorCode(err) === "request_not_pending") {
          await reread();
          return;
        }
        handleFailure(err, "cancel", null);
      }
    });
  }, [confirmingCancel, run, token, handleFailure]);

  const handleNewServerNameChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setFieldErrors({});
    handleNameChange(e);
  }, [handleNameChange]);
  const handleNewServerSlugChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setFieldErrors((current) => ({ ...current, slug: undefined }));
    handleSlugChange(e);
  }, [handleSlugChange]);

  // Create (B1's third row): the name and slug as Create Server takes them; 200
  // lands in the channel, 202 is the same connecting state as connecting a
  // server. The server list is read again so the new server is in it.
  const handleCreateServer = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (keptServer) return;
    const name = newServerName.trim();
    const slug = newServerSlug;
    const invalid = newServerFieldErrors(name, slug);
    if (invalid.name || invalid.slug) {
      setError(null);
      setFieldErrors(invalid);
      return;
    }
    setFieldErrors({});
    void run(async () => {
      try {
        const result = await connectNewServerWithInvite(token, { name, slug });
        if (result.state === "connecting") {
          await loadServers({ fresh: true, listOnly: true }).catch(() => undefined);
          setStep({ kind: "connecting", serverId: result.serverId });
          return;
        }
        await openChannel(result.serverId, result.channelId);
      } catch (err) {
        const keptId = apiErrorServerId(err);
        if (keptId) {
          // Created, then refused: the server is theirs; say so beside the refusal.
          await loadServers({ fresh: true, listOnly: true }).catch(() => undefined);
          setKeptServer({ id: keptId, name, slug });
          // Any refusal now is a banner (a 404 too: the invite went while the server was made).
          // The kept server is theirs: a limit of its own (the joint's free-server cap) can be lifted by upgrading it.
          setError({ ...inviteeErrorMessage(err, "newServer", { id: keptId }), serverId: keptId, target: name });
          return;
        }
        const refused = newServerInputRefusal(err, name, slug);
        if (refused) {
          setFieldErrors(refused);
          return;
        }
        handleFailure(err, "newServer", null, name);
      }
    });
  }, [keptServer, newServerName, newServerSlug, run, token, loadServers, setStep, openChannel, handleFailure]);

  const handleOpenKeptServer = useCallback(() => {
    if (!keptServer) return;
    const server = myServer(keptServer.id);
    if (server) setCurrent(server);
    navigate(`/s/${server?.slug ?? keptServer.slug}`, { replace: true });
  }, [keptServer, myServer, setCurrent, navigate]);

  const handleUpgrade = useCallback(() => {
    if (error?.upgrade) upgradeServer(error.serverId, error.upgrade);
  }, [error, upgradeServer]);

  const goTo = useCallback((kind: "options" | "guest" | "connect" | "newServer") => {
    setError(null);
    setView((current) => ({ ...current, step: { kind }, notice: null }));
  }, []);
  const showOptions = useCallback(() => goTo("options"), [goTo]);
  const showGuest = useCallback(() => goTo("guest"), [goTo]);
  const showConnect = useCallback(() => goTo("connect"), [goTo]);
  const showNewServer = useCallback(() => {
    setFieldErrors({});
    goTo("newServer");
  }, [goTo]);
  const handleRetryLoad = useCallback(() => {
    setStep({ kind: "loading" });
    setReload((n) => n + 1);
  }, [setStep]);
  const handleLogout = useCallback(() => {
    void logout();
  }, [logout]);
  const handleGoToRaft = useCallback(() => {
    navigate("/", { replace: true });
  }, [navigate]);
  const handleOpenServer = useCallback(() => {
    if (step.kind === "connected" && step.landing) {
      void openChannel(step.landing.serverId, step.landing.channelId);
      return;
    }
    const server = step.kind === "connected" || step.kind === "connecting" ? myServer(step.serverId) : null;
    if (!server) {
      navigate("/", { replace: true });
      return;
    }
    setCurrent(server);
    navigate(`/s/${server.slug}`, { replace: true });
  }, [step, myServer, setCurrent, navigate, openChannel]);

  // A row of the progress list: into its channel when connect-servers named it, else its server.
  const handleOpenProgress = useCallback((serverId: string, channelId: string | undefined) => {
    const server = myServer(serverId);
    if (!server) return;
    if (channelId) {
      void openChannel(serverId, channelId);
      return;
    }
    setCurrent(server);
    navigate(`/s/${server.slug}`, { replace: true });
  }, [myServer, openChannel, setCurrent, navigate]);

  const signedIn = <SignedInAs user={user} />;
  const signOut = (
    <div className="mt-3 text-center">
      <TextLink className="text-footnote" onClick={handleLogout}>
        {formatMessage({ id: "externalInvite.signOut" })}
      </TextLink>
    </div>
  );
  // A server connect-new-server made and kept: named in the refusal's banner, and opened from where Create was.
  const keptName = keptServer ? myServer(keptServer.id)?.name ?? keptServer.name : "";
  const keptInError = keptServer !== null && error?.serverId === keptServer.id;
  const errorBanner = error ? (
    <Banner
      intent="warning"
      className="mb-4"
      data-testid="external-invite-error"
      actions={error.upgrade ? (
        <Button size="md" variant="outline" type="button" onClick={handleUpgrade}>
          {formatMessage({ id: "externalInvite.upgrade" })}
        </Button>
      ) : undefined}
    >
      {error.id === "deploymentUserLimit.refused" ? <DeploymentUserLimitText /> : formatMessage({ id: error.id }, { ...values, max: MAX_JOINT_CHANNEL_SERVERS, target: error.target ?? serverById(error.serverId)?.name ?? values.target })}
      {keptInError ? (
        <span className="ml-1">{formatMessage({ id: "externalInvite.newServer.kept" }, { target: keptName })}</span>
      ) : null}
    </Banner>
  ) : null;

  const frame = (title: string, description: ReactNode, body: ReactNode, testId: string) => (
    <CenteredCardFrame>
      <div className="w-full" data-testid={testId}>
        <AuthPageIntro title={title} description={description}>
          <p className="mt-2 text-callout text-foreground-muted">{signedIn}</p>
        </AuthPageIntro>
        {body}
      </div>
      <ServerUpgradeDialog externalContext={externalContext} onPaid={refreshAfterPaid} />
    </CenteredCardFrame>
  );

  if (step.kind === "loading") {
    return (
      <CenteredCardFrame>
        <div className="w-full" data-testid="external-invite-loading">
          <AuthPageIntro title={formatMessage({ id: "pages.invite.loadingTitle" })} />
        </div>
      </CenteredCardFrame>
    );
  }

  if (step.kind === "invalid" || step.kind === "loadFailed") {
    const invalid = step.kind === "invalid";
    return frame(
      formatMessage({ id: invalid ? "externalInvite.invalid.title" : "externalInvite.loadFailed.title" }),
      formatMessage({ id: invalid ? "externalInvite.invalid.description" : "externalInvite.loadFailed.description" }),
      <>
        <Button size="lg" variant="outline" className="w-full" onClick={invalid ? handleGoToRaft : handleRetryLoad}>
          {formatMessage({ id: invalid ? "pages.invite.goToRaft" : "externalInvite.retry" })}
        </Button>
        {signOut}
      </>,
      invalid ? "external-invite-invalid" : "external-invite-load-failed",
    );
  }

  if (step.kind === "wrongAccount") {
    return frame(
      formatMessage({ id: "externalInvite.wrongAccount.title" }),
      step.maskedEmail ? formatMessage({ id: "externalInvite.wrongAccount.sentTo" }, { email: step.maskedEmail }) : formatMessage({ id: "externalInvite.wrongAccount.description" }),
      <Button size="xl" variant="accent" className="w-full" onClick={handleLogout}>
        {formatMessage({ id: "externalInvite.switchAccount" })}
      </Button>,
      "external-invite-wrong-account",
    );
  }

  if (!invite) return null;

  if (step.kind === "waiting") {
    // Their own request (the server names it to the requester only): its server and approver, and Cancel Request.
    return frame(
      formatMessage({ id: "externalInvite.waiting.title" }),
      step.request
        ? formatMessage(
            { id: "externalInvite.waiting.sent" },
            { approver: step.request.approverName, target: step.request.serverName, date: formatDate(step.request.expiresAt, { month: "short", day: "numeric" }) },
          )
        : formatMessage({ id: "externalInvite.waiting.description" }, values),
      <>
        {step.request ? (
          <ServerRow
            server={myServer(step.request.serverId)}
            name={step.request.serverName}
            meta={formatMessage({ id: "externalInvite.waiting.requestSent" })}
          />
        ) : null}
        {errorBanner}
        {step.request ? (
          <div className="stack-y-3">
            <Button
              size="lg"
              variant="outline"
              className="w-full"
              onClick={openCancelConfirm}
              loading={busy}
              loadingLabel={formatMessage({ id: "externalInvite.waiting.canceling" })}
              data-testid="external-invite-cancel-request"
            >
              {formatMessage({ id: "externalInvite.waiting.cancel" })}
            </Button>
          </div>
        ) : null}
        {signOut}
        {confirmingCancel && step.request ? (
          <CancelRequestConfirm approverName={confirmingCancel.approverName} onConfirm={handleCancelRequest} onClose={closeCancelConfirm} />
        ) : null}
      </>,
      "external-invite-waiting",
    );
  }

  // Every chosen server done and none in (refused, declined, withdrawn): the
  // invite is pending again, and the ways in come back under the list.
  if (step.kind === "progress" && invite.status !== "pending") {
    return frame(
      formatMessage({ id: "externalInvite.progress.title" }),
      formatMessage({ id: "externalInvite.progress.description" }, values),
      <>
        <InviteProgress
          invite={invite}
          chosen={step.chosen}
          values={values}
          myServer={myServer}
          busy={busy}
          error={errorBanner}
          onCancel={openRowCancelConfirm}
          onOpen={handleOpenProgress}
        />
        {signOut}
        {confirmingCancel?.requestId ? (
          <CancelRequestConfirm approverName={confirmingCancel.approverName} onConfirm={handleCancelRequest} onClose={closeCancelConfirm} />
        ) : null}
      </>,
      "external-invite-progress-page",
    );
  }

  if (step.kind === "connecting" || step.kind === "connected") {
    const landing = step.kind === "connected" ? step.landing : null;
    // A Guest lands in the host server, which the page names already.
    const target = serverById(step.serverId)?.name ?? myServer(step.serverId)?.name ?? (landing?.outcome === "guest" ? invite.serverName : null);
    const connected = step.kind === "connected";
    // Where they landed may be named differently on their server: "#that is ready", opened directly.
    const channel = landing ? `#${landing.channelName}` : values.channel;
    const title = connected
      ? formatMessage({ id: "externalInvite.connected.title" }, { ...values, channel })
      : target
        ? formatMessage({ id: "externalInvite.connecting.title" }, { target })
        : formatMessage({ id: "externalInvite.connecting.titleUnnamed" });
    const description = connected
      ? target
        ? formatMessage({ id: "externalInvite.connected.description" }, { ...values, target })
        : formatMessage({ id: "externalInvite.connected.descriptionUnnamed" }, values)
      : formatMessage({ id: "externalInvite.connecting.description" }, values);
    // Connecting: their server opens now, and the channel shows up there once ready.
    const connectingServer = connected ? null : myServer(step.serverId);
    return frame(
      title,
      description,
      <>
        {connected || connectingServer ? (
          <Button size="xl" variant="accent" className="w-full" onClick={handleOpenServer} data-testid={connected ? "external-invite-open-landing" : "external-invite-open-server"}>
            {landing || target || connectingServer
              ? formatMessage({ id: "externalInvite.openServer" }, { target: landing ? channel : connectingServer?.name ?? target })
              : formatMessage({ id: "pages.invite.goToRaft" })}
          </Button>
        ) : null}
        {signOut}
      </>,
      connected ? "external-invite-connected" : "external-invite-connecting",
    );
  }

  const intro = formatMessage({ id: "externalInvite.invitedBy" }, values);
  // The server that didn't connect, by name where the page knows it (one of the invite's, or the caller's); else "The server".
  const noticeText = (shown: InviteNotice) => {
    const target = serverById(shown.serverId)?.name ?? myServer(shown.serverId)?.name;
    return target
      ? formatMessage({ id: "externalInvite.notice.connectFailed" }, { target })
      : formatMessage({ id: "externalInvite.notice.connectFailedUnnamed" });
  };

  if (step.kind === "guest") {
    return frame(
      formatMessage({ id: "externalInvite.guest.title" }),
      formatMessage({ id: "externalInvite.guest.description" }, values),
      <>
        {errorBanner}
        <InviteStepActions
          label={formatMessage({ id: "externalInvite.guest.commit" })}
          loadingLabel={formatMessage({ id: "externalInvite.guest.joining" })}
          onCommit={handleJoinAsGuest}
          onBack={showOptions}
          busy={busy}
          testId="external-invite-join-guest"
        />
      </>,
      "external-invite-guest",
    );
  }

  if (step.kind === "connect") {
    const commitLabel = pickedServers.length === 0
      ? formatMessage({ id: "externalInvite.connect.commitUnpicked" })
      : pickedServers.some((server) => server.needsApproval)
        ? formatMessage({ id: "externalInvite.connect.continue" })
        : pickedServers.length === 1
          ? formatMessage({ id: "externalInvite.connect.commit" }, { target: pickedServers[0]!.name })
          : formatMessage({ id: "externalInvite.connect.commitMany" }, { count: pickedServers.length });
    return frame(
      formatMessage({ id: "externalInvite.connect.title" }),
      formatMessage({ id: "externalInvite.connect.description" }, values),
      <>
        <Field className="mb-6">
          <FieldLabel id={serverPickerLabelId}>{formatMessage({ id: "externalInvite.connect.pickerLabel" })}</FieldLabel>
          {connectSlotsLeft !== null ? (
            <FieldDescription data-testid="external-invite-connect-slots-left">
              {connectSlotsLeft === 0
                ? formatMessage({ id: "externalInvite.connect.slotsFull" }, values)
                : formatMessage({ id: "externalInvite.connect.slotsLeft" }, { count: connectSlotsLeft })}
            </FieldDescription>
          ) : null}
          <ChoiceList
            multiple
            aria-labelledby={serverPickerLabelId}
            items={connectItems}
            value={pickedServerIds}
            onValueChange={setPickedServerIds}
            disabled={busy}
            searchLabel={formatMessage({ id: "externalInvite.connect.search" })}
            searchPlaceholder={formatMessage({ id: "externalInvite.connect.search" })}
            clearSearchLabel={formatMessage({ id: "search.clearSearch" })}
            noMatchLabel={formatMessage({ id: "ui.selectionPopover.emptyLabel" })}
          />
          <ConnectLimitNotes servers={servers} myServer={myServer} viewerId={user?.id ?? null} guest={invite.options?.guest === true} />
        </Field>
        {errorBanner}
        <InviteStepActions
          label={commitLabel}
          loadingLabel={formatMessage({ id: "externalInvite.connect.connecting" })}
          onCommit={handleConnect}
          onBack={showOptions}
          busy={busy}
          disabled={pickedServers.length === 0}
          testId="external-invite-connect-commit"
        />
      </>,
      "external-invite-connect",
    );
  }

  if (step.kind === "newServer") {
    return frame(
      formatMessage({ id: "externalInvite.newServer.title" }),
      formatMessage({ id: "externalInvite.newServer.description" }, values),
      <>
        <form onSubmit={handleCreateServer} noValidate>
          <div className="mb-6 stack-y-3">
            <FormField
              label={formatMessage({ id: "pages.serverSelector.serverNameLabel" })}
              htmlFor="external-invite-new-server-name"
              error={fieldErrors.name ? formatMessage({ id: fieldErrors.name }, NEW_SERVER_FIELD_ERROR_VALUES) : undefined}
            >
              <Input
                id="external-invite-new-server-name"
                type="text"
                value={newServerName}
                onChange={handleNewServerNameChange}
                placeholder={formatMessage({ id: "pages.serverSelector.serverNamePlaceholderTeam" })}
                aria-invalid={fieldErrors.name ? true : undefined}
                disabled={busy || keptServer !== null}
                autoFocus
              />
            </FormField>
            <FormField
              label={formatMessage({ id: "pages.serverSelector.serverUrlLabel" })}
              hint={formatMessage({ id: "pages.serverSelector.serverUrlHelp" })}
              htmlFor="external-invite-new-server-slug"
              error={fieldErrors.slug ? formatMessage({ id: fieldErrors.slug }, NEW_SERVER_FIELD_ERROR_VALUES) : undefined}
            >
              <SlugInput
                id="external-invite-new-server-slug"
                type="text"
                value={newServerSlug}
                onChange={handleNewServerSlugChange}
                aria-invalid={fieldErrors.slug ? true : undefined}
                disabled={busy || keptServer !== null}
              />
            </FormField>
          </div>
          {errorBanner}
          <div className="stack-y-3">
            {keptServer ? (
              <Button
                type="button"
                size="xl"
                variant="accent"
                className="w-full"
                onClick={handleOpenKeptServer}
                data-testid="external-invite-open-kept-server"
              >
                {formatMessage({ id: "externalInvite.openServer" }, { target: keptName })}
              </Button>
            ) : (
              <Button
                type="submit"
                size="xl"
                variant="accent"
                className="w-full"
                loading={busy}
                loadingLabel={formatMessage({ id: "externalInvite.newServer.creating" })}
                data-testid="external-invite-new-server-commit"
              >
                {formatMessage({ id: "externalInvite.newServer.commit" })}
              </Button>
            )}
          </div>
        </form>
        <div className="mt-3 text-center">
          <TextLink className="text-footnote" onClick={showOptions} disabled={busy}>
            {formatMessage({ id: "externalInvite.back" })}
          </TextLink>
        </div>
      </>,
      "external-invite-new-server",
    );
  }

  if (step.kind === "approval") {
    // One list of owners and admins per server that needs approval (design
    // B2). The copy follows what the confirm does: the picked servers the
    // invitee owns or administers connect with it, named here ("Contoso
    // connects now"), and one request goes per list.
    const direct = pickedServers.filter((server) => server.canConnectDirectly);
    const requests = { count: approvalServers.length };
    const asked = formatList(approvalServers.map((server) => server.name), { type: "conjunction" });
    // Each server needs its own approver, so several servers are not named as
    // one "owner or admin of A and B" who could approve them all.
    const many = approvalServers.length > 1;
    return frame(
      approvalServers.length === 1
        ? formatMessage({ id: "externalInvite.approval.title" }, { target: approvalServers[0]!.name })
        : formatMessage({ id: "externalInvite.approval.titleMany" }, requests),
      direct.length > 0
        ? formatMessage(
            { id: many ? "externalInvite.approval.descriptionMixedMany" : "externalInvite.approval.descriptionMixed" },
            {
              count: direct.length,
              servers: formatList(direct.map((server) => server.name), { type: "conjunction" }),
              ...(many ? {} : { target: asked }),
            },
          )
        : many
          ? formatMessage({ id: "externalInvite.approval.descriptionMany" })
          : formatMessage({ id: "externalInvite.approval.description" }, { target: asked }),
      <>
        {approvalServers.map((server) => (
          <ApproverPicker
            key={server.id}
            server={server}
            value={approverFor(server)}
            onPick={handlePickApprover}
            disabled={busy}
          />
        ))}
        {errorBanner}
        <InviteStepActions
          label={formatMessage({ id: direct.length > 0 ? "externalInvite.approval.commitMixed" : "externalInvite.approval.commit" }, requests)}
          loadingLabel={formatMessage({ id: "externalInvite.approval.sending" })}
          onCommit={handleRequestApproval}
          onBack={showConnect}
          busy={busy}
          disabled={approvalServers.some((server) => !approverFor(server))}
          testId="external-invite-request-approval"
        />
      </>,
      "external-invite-approval",
    );
  }

  // The ways in (B1 / B5): as many rows as the server offers, of equal weight.
  const canGuest = invite.options?.guest === true;
  const canConnect = servers.length > 0;
  const canCreateServer = invite.options?.newServer === true;
  return frame(
    formatMessage({ id: "externalInvite.title" }, values),
    intro,
    <>
      {notice ? (
        <Banner intent="info" className="mb-4" data-testid="external-invite-notice">
          {noticeText(notice)}
        </Banner>
      ) : invite.lastRequest?.status === "rejected" ? (
        // Their last request was declined (told to the requester only): say whose, above the ways in.
        <Banner intent="info" className="mb-4" data-testid="external-invite-declined">
          {formatMessage({ id: "externalInvite.notice.declined" }, { target: invite.lastRequest.serverName })}
        </Banner>
      ) : null}
      {step.kind === "progress" && step.chosen.length > 0 ? (
        <InviteProgress
          invite={invite}
          chosen={step.chosen}
          values={values}
          myServer={myServer}
          busy={busy}
          error={errorBanner}
          onCancel={openRowCancelConfirm}
        />
      ) : null}
      {canGuest || canConnect || canCreateServer ? (
        <InviteWaysIn
          channel={values.channel}
          guest={canGuest}
          onGuest={showGuest}
          connect={canConnect}
          onConnect={showConnect}
          newServer={canCreateServer}
          onNewServer={showNewServer}
        />
      ) : (
        // A full channel takes nobody, whichever way (the server turns every option off): say so, not "no way in".
        <Banner intent="info" className="mb-6" data-testid={invite.channelFull ? "external-invite-channel-full" : "external-invite-no-options"}>
          {formatMessage({ id: invite.channelFull ? "externalInvite.error.channelFull" : "externalInvite.noOptions" }, values)}
        </Banner>
      )}
      {signOut}
    </>,
    "external-invite-options-page",
  );
}

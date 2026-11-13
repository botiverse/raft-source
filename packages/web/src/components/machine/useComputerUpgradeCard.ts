import { useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { compareComputerVersions, isComputerSemver, isRemoteUpgradeSupported } from "@botiverse/raft-shared";
import api from "../../api/client";
import { useComputerUpgradeReconnect } from "../../hooks/useComputerUpgradeReconnect";
import { useComputerVersionTier } from "../../hooks/useComputerVersionTier";
import { useMachineStore } from "../../store/machineStore";
import type { Machine, MachineUpgradeRequest } from "../../store/machineStore";
import { useServerStore } from "../../store/serverStore";
import { getComputerVersionFact } from "../../utils/computerVersionFact";
import { getLocalComputerBridge, useLocalComputerMachineId } from "./localComputer/localComputerStore";

/**
 * First Computer that reports "service unreachable", so the server can hide
 * Upgrade instead of letting the request time out. A prerelease of it counts.
 */
const COMPUTER_SERVICE_REPORT_MIN_VERSION = "1.0.54";

/** A refused Upgrade click, mapped from the server's code (never its text). */
export type UpgradeRefusal = "web_upgrade_off" | "too_old" | "not_allowed" | "managed_by_desktop" | "unknown";

function upgradeRefusalFromCode(code: string | undefined): UpgradeRefusal {
  switch (code) {
    // Older servers' answer while remote_computer_upgrade_v2 was off.
    case "remote_upgrade_disabled":
      return "web_upgrade_off";
    case "computer_remote_upgrade_unsupported":
      return "too_old";
    case "computer_broadcast_not_eligible":
      return "not_allowed";
    case "computer_managed_by_desktop":
      return "managed_by_desktop";
    default:
      return "unknown";
  }
}

/** The Computer card's one state: a status sentence and exactly one next step. */
export type ComputerUpgradeCardState =
  | { kind: "reinstall" }
  | { kind: "reading" }
  | { kind: "cannotCheck" }
  | { kind: "upToDate" }
  // Raft Desktop's bundled Computer (policy `managed_by_desktop`): Desktop
  // updates it, so a note instead of a button or the install commands.
  | { kind: "managedByDesktop" }
  // `waitingAgents` (reconciler step 13): the Computer is waiting for this
  // many of THIS server's agents to finish their work before it installs.
  // Absent: no drain, or it is over (the plain "upgrading" copy).
  | { kind: "upgrading"; version: string; waitingAgents?: number }
  | { kind: "oneClick"; version: string }
  | { kind: "manualUpgrade"; version: string }
  | { kind: "commands"; version: string; sentence: "runCommands" | "refusedNotAllowed" };

/**
 * What a Computer's upgrade looks like right now, and the one-click Upgrade
 * itself (remote upgrade v2, task #873). Shared by the Computer page's card and
 * the Computers overview rows, so both offer Upgrade, the manual command or
 * nothing for exactly the same machines.
 */
export function useComputerUpgradeCard(machine: Machine) {
  const latestComputerVersion = useMachineStore((s) => s.latestComputerVersion);
  // The machine Raft Desktop runs on is updated by Desktop (its This device
  // Updates section): no web Upgrade and no install command for it (design
  // §4.3 ④, C12 / C15), so there is one way to update it, not two.
  const localMachineId = useLocalComputerMachineId();
  const thisDevice = getLocalComputerBridge()?.hostCapable === true && localMachineId === machine.id;
  // "Is it up to date" is the web's own comparison with the latest published
  // version, independent of whether the web may drive the upgrade.
  const computerVersionFact = getComputerVersionFact(machine, latestComputerVersion);
  const upgradeRequest = machine.upgradeRequest ?? null;
  // A web upgrade restarts the Computer, so it drops offline until the new
  // version reconnects. While the upgrade is in flight that is the restart,
  // not an outage: say so instead of "Offline", for UPGRADE_RECONNECT_GRACE_MS.
  // Past the grace the plain offline card returns with a "didn't reconnect"
  // note; the server's verdict still lands later. Shared with the sidebar row.
  const {
    inFlight: upgradeInFlight,
    reconnecting: upgradeReconnecting,
    overdue: upgradeReconnectOverdue,
  } = useComputerUpgradeReconnect(machine);
  // Below the first v2-capable Computer release (or version unknown) the web
  // cannot drive the upgrade; the same fail-closed shape as the server guard.
  // The server's answer when it gives one: true → one-click, false → the
  // manual install command (the server owns platform rules). Null / absent
  // (older servers): the version gate on the client, same fail-closed shape
  // as the server guard.
  const remoteUpgradeSupported = (machine.remoteUpgradeSupported ?? isRemoteUpgradeSupported(machine.computerVersion)) === true;
  // A refused Upgrade click holds only while every live input that decides
  // whether the one-click upgrade is offered stays the same as when it was
  // refused: this machine and version, the server's
  // policy (eligibility, reason, revision, target) and whether this version
  // supports remote upgrade. The first change drops it for good (also when a
  // later snapshot matches the refused one again, e.g. a release lookup that
  // failed briefly and recovered), so the card follows the live answer.
  const upgradeAvailabilityKey = JSON.stringify([
    machine.id,
    machine.computerVersion ?? null,
    remoteUpgradeSupported,
    machine.computerUpgradeAvailable ?? null,
    machine.computerBroadcastPolicy?.eligibility ?? null,
    machine.computerBroadcastPolicy?.reasonCode ?? null,
    machine.computerBroadcastPolicy?.policyRevision ?? null,
    machine.computerBroadcastPolicy?.targetVersion ?? null,
  ]);
  const [upgradeRefusalState, setUpgradeRefusalState] = useState<{
    availabilityKey: string;
    refusal: UpgradeRefusal;
  } | null>(null);
  if (upgradeRefusalState && upgradeRefusalState.availabilityKey !== upgradeAvailabilityKey) {
    setUpgradeRefusalState(null);
  }
  const upgradeRefusal = upgradeRefusalState?.availabilityKey === upgradeAvailabilityKey
    ? upgradeRefusalState.refusal
    : null;
  const consentedTargetVersion = machine.computerBroadcastPolicy?.targetVersion ?? null;
  // The last request's outcome only while the Computer is still below that
  // request's target: a later manual upgrade makes a failure / no-response
  // line stale.
  const requestOutcomeStillTrue = Boolean(
    upgradeRequest
    && (upgradeRequest.state === "failed" || upgradeRequest.state === "no_response")
    && machine.computerVersion
    && isComputerSemver(machine.computerVersion)
    && isComputerSemver(upgradeRequest.targetVersion)
    && compareComputerVersions(machine.computerVersion, upgradeRequest.targetVersion) < 0,
  );
  // Below 1.0.54 a no_response has two causes the server cannot tell apart:
  // the Computer is not running as a service (it ignores the request), or,
  // before 1.0.50, the installer stopped before stopping the service and its
  // result waits on disk for a reconnect that never comes. Running the
  // upgrade on the machine prints the real outcome in either case.
  const noResponseMessageId = machine.computerVersion
    && isComputerSemver(machine.computerVersion)
    && compareComputerVersions(machine.computerVersion.split("-")[0], COMPUTER_SERVICE_REPORT_MIN_VERSION) < 0
    ? "machine.detail.upgradeStatus.noResponseOldComputer" as const
    : "machine.detail.upgradeStatus.noResponse" as const;
  // Click → POST → refreshed row with `upgradeRequest.state === "pending"`
  // takes a moment; without this the button gave no feedback until then.
  // Per-machine store slice (not component state) so a remount mid-request
  // still shows the request in flight and cannot submit it twice.
  // oxlint-disable-next-line react-doctor/no-event-handler -- per-machine hot-slice selector (docs/frontend/render-cost-contract.md), same shape as computerOperationProgress.
  const upgradeSubmittingVersion = useMachineStore((s) => s.computerUpgradeSubmitting[machine.id] ?? null);
  const handleRemoteUpgradeV2 = useCallback(async () => {
    const serverId = useServerStore.getState().current?.id;
    if (!serverId || !consentedTargetVersion) return;
    const store = useMachineStore.getState();
    if (store.computerUpgradeSubmitting[machine.id]) return;
    store.setComputerUpgradeSubmitting(machine.id, consentedTargetVersion);
    setUpgradeRefusalState(null);
    try {
      const { data } = await api.post<{ upgradeRequest?: MachineUpgradeRequest }>(
        `/servers/${serverId}/machines/${machine.id}/computer/upgrade`,
        { targetVersion: consentedTargetVersion },
        { headers: { "X-Server-Id": serverId } },
      );
      // Keep the accepted request: the page says "upgrading" from this answer,
      // not from whichever later refresh happens to carry the pending row.
      if (data?.upgradeRequest) useMachineStore.getState().setComputerUpgradeAccepted(machine.id, data.upgradeRequest);
      // Hold the in-flight state until the refreshed row (with the server's
      // pending request) lands, so the button doesn't flash back meanwhile.
      await useMachineStore.getState().loadMachines();
    } catch (err) {
      const code = (err as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
      setUpgradeRefusalState({
        availabilityKey: upgradeAvailabilityKey,
        refusal: upgradeRefusalFromCode(typeof code === "string" ? code : undefined),
      });
      void useMachineStore.getState().loadMachines();
    } finally {
      useMachineStore.getState().setComputerUpgradeSubmitting(machine.id, null);
    }
  }, [consentedTargetVersion, machine.id, upgradeAvailabilityKey]);
  const versionTier = useComputerVersionTier(machine);
  const policy = machine.computerBroadcastPolicy;
  const policyTargetVersion = policy?.targetVersion ?? null;
  // Web upgrade is off when the server could not read a platform hold
  // (`broadcast_gate_unavailable`) or, on an older server, its
  // remote_computer_upgrade_v2 gate was closed (`broadcast_disabled`).
  const broadcastGated = policy?.reasonCode === "broadcast_disabled"
    || policy?.reasonCode === "broadcast_gate_unavailable";
  const webUpgradeOn = !broadcastGated;
  // #proj-raft-computer task #34: the installer state looks like it needs a
  // repair run on the machine. Advisory: the install command is recommended
  // and Upgrade stays offered, only for an upgrade the web would otherwise offer.
  const installerRepairHint = machine.installerRepairHint?.reason === "unrecovered_operation";
  const oneClickTarget = machine.computerUpgradeAvailable === true
    && policy?.eligibility === "eligible"
    && policyTargetVersion
    ? policyTargetVersion
    : null;
  const cardState: ComputerUpgradeCardState = (() => {
    // Too old for the web to upgrade: the version notice at the top of the
    // page carries the reinstall command, so this card points there.
    if (versionTier.kind === "reinstall") return thisDevice ? { kind: "managedByDesktop" } : { kind: "reinstall" };
    const fact = computerVersionFact;
    if (fact.kind === "unknown") return { kind: "reading" };
    if (fact.kind === "cannotCheck") return { kind: "cannotCheck" };
    if (fact.kind === "current") return { kind: "upToDate" };
    const version = fact.availableVersion;
    if (upgradeInFlight) {
      const waitingAgents = upgradeInFlight.phase === "draining" ? upgradeInFlight.drainingAgentIds?.length ?? 0 : 0;
      return waitingAgents > 0
        ? { kind: "upgrading", version: upgradeInFlight.targetVersion, waitingAgents }
        : { kind: "upgrading", version: upgradeInFlight.targetVersion };
    }
    if (upgradeSubmittingVersion) return { kind: "upgrading", version: upgradeSubmittingVersion };
    if (thisDevice) return { kind: "managedByDesktop" };
    if (policy?.reasonCode === "managed_by_desktop" || upgradeRefusal === "managed_by_desktop") {
      return { kind: "managedByDesktop" };
    }
    if (upgradeRefusal === "not_allowed") return { kind: "commands", version, sentence: "refusedNotAllowed" };
    // Web upgrade off or refused, or this version too old for
    // it: the same "run these two commands" state.
    if (upgradeRefusal === "web_upgrade_off" || upgradeRefusal === "too_old") return { kind: "commands", version, sentence: "runCommands" };
    if (!remoteUpgradeSupported) return { kind: "manualUpgrade", version };
    if (webUpgradeOn && oneClickTarget) return { kind: "oneClick", version: oneClickTarget };
    return { kind: "commands", version, sentence: "runCommands" };
  })();
  // The last web upgrade failed in a way only the install command on the
  // machine gets past (a systemd unit, read by the server from the failure).
  // Advisory: shown beside an offered Upgrade, which stays, and only while
  // the Computer still runs the version it failed on.
  const upgradeFailureHint = cardState.kind === "oneClick"
    && requestOutcomeStillTrue
    && upgradeRequest?.state === "failed"
    && (upgradeRequest.observedVersion === null || upgradeRequest.observedVersion === machine.computerVersion)
    ? upgradeRequest.failureHint ?? null
    : null;
  // Upgrading restarts the Computer, which disconnects every agent on it, and
  // can't be taken back: every route (the card, the version notice, the
  // runtime chips, the overview row) opens one confirmation first (Raft DS ›
  // Forms, "When a change takes effect"; ComputerActionConfirms).
  const [confirmingUpgrade, setConfirmingUpgrade] = useState(false);
  // Upgrade stopped being offered while it was asked (it started elsewhere,
  // the Computer went offline): the question goes with it, for good.
  const upgradeOffered = cardState.kind === "oneClick" && machine.status === "online";
  if (confirmingUpgrade && !upgradeOffered) setConfirmingUpgrade(false);
  const startUpgrade = useCallback(() => setConfirmingUpgrade(true), []);
  const cancelUpgrade = useCallback(() => setConfirmingUpgrade(false), []);
  const confirmUpgrade = useCallback(() => {
    setConfirmingUpgrade(false);
    void handleRemoteUpgradeV2();
  }, [handleRemoteUpgradeV2]);
  return {
    cardState,
    /** Recommend the install command over the offered one-click Upgrade (which stays). */
    recommendRepair: installerRepairHint && cardState.kind === "oneClick",
    computerVersionFact,
    versionTier,
    webUpgradeOn,
    upgradeRefusal,
    upgradeRequest,
    requestOutcomeStillTrue,
    upgradeFailureHint,
    noResponseMessageId,
    upgradeInFlight,
    upgradeReconnecting,
    upgradeReconnectOverdue,
    startUpgrade,
    /** The version Upgrade asks to confirm, while its confirmation is open. */
    confirmingUpgradeVersion: confirmingUpgrade && upgradeOffered && cardState.kind === "oneClick" ? cardState.version : null,
    confirmUpgrade,
    cancelUpgrade,
  };
}

/**
 * The Computer's remote Restart (managed Computer, online only) and its
 * progress. The server relays the command to the machine's live connection,
 * which forwards it to the Computer service IPC (restart = restart-service);
 * an indeterminate bar shows until the machine comes back online. `offered`:
 * whether the caller offers Restart now (its confirmation closes when not).
 */
export function useComputerRestart(machineId: string, offered: boolean) {
  const { formatMessage } = useIntl();
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;
  // oxlint-disable-next-line react-doctor/no-event-handler -- per-machine hot-slice selector mandated by the Render-cost contract (docs/frontend/render-cost-contract.md): it must close over the machine id to subscribe to ONLY this machine's progress entry.
  const progress = useMachineStore((s) => s.computerOperationProgress[machineId] ?? null);
  const setComputerOperation = useMachineStore((s) => s.setComputerOperation);
  const handleComputerRestart = useCallback(async () => {
    const serverId = useServerStore.getState().current?.id;
    if (!serverId) return;
    // Optimistically enter progress state before the POST returns.
    setComputerOperation(machineId, { operation: "restart" });
    try {
      const { data } = await api.post(
        `/servers/${serverId}/machines/${machineId}/computer/restart`,
        {},
        { headers: { "X-Server-Id": serverId } },
      );
      const requestId = (data as { requestId?: string })?.requestId;
      if (requestId) {
        setComputerOperation(machineId, { operation: "restart", requestId });
      }
    } catch (err) {
      const errorData = (err as { response?: { data?: { code?: string; error?: string } } })?.response?.data;
      const code = errorData?.code;
      const serverError = typeof errorData?.error === "string" && errorData.error.trim().length > 0
        ? errorData.error
        : null;
      let errorMsg = serverError ?? formatMessageRef.current({ id: "machine.detail.restartRequestFailed" });
      if (code === "computer_offline") {
        errorMsg = formatMessageRef.current({ id: "machine.detail.computerOffline" });
      }
      setComputerOperation(machineId, { operation: "restart", done: true, error: errorMsg });
      // Auto-clear error after 4s so the button reappears.
      setTimeout(() => setComputerOperation(machineId, null), 4000);
    }
  }, [machineId, setComputerOperation]);
  // Restarting disconnects every agent on the Computer until it comes back:
  // Restart opens a confirmation, and only its button restarts.
  const [confirmingRestart, setConfirmingRestart] = useState(false);
  // Restart stopped being offered while it was asked (an upgrade started, the
  // Computer went offline, a restart is already running): the question goes too.
  if (confirmingRestart && (!offered || progress)) setConfirmingRestart(false);
  const restart = useCallback(() => setConfirmingRestart(true), []);
  const cancelRestart = useCallback(() => setConfirmingRestart(false), []);
  const confirmRestart = useCallback(() => {
    setConfirmingRestart(false);
    void handleComputerRestart();
  }, [handleComputerRestart]);
  // Clear terminal operation state after a display pause.
  useEffect(() => {
    if (progress?.done) {
      const t = setTimeout(() => setComputerOperation(machineId, null), 3000);
      return () => clearTimeout(t);
    }
  }, [progress?.done, machineId, setComputerOperation]);
  // Safety timeout: if an operation is in progress but no WS frames arrive
  // (e.g. HTTP server down, daemon didn't receive the command), reset to
  // buttons after 60s so the user isn't stuck with no way to retry.
  useEffect(() => {
    if (progress && !progress.done) {
      const t = setTimeout(() => {
        setComputerOperation(machineId, {
          ...progress,
          done: true,
          error: formatMessageRef.current({ id: "machine.detail.restartTimedOut" }),
        });
      }, 60_000);
      return () => clearTimeout(t);
    }
  }, [progress, machineId, setComputerOperation]);
  return { progress, restart, confirmingRestart: confirmingRestart && offered && !progress, confirmRestart, cancelRestart };
}

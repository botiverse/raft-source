// The machine Raft Desktop runs on, as a Computer this app can drive: which
// of the server's machines it is, its local service's state, and attach /
// start / stop / restart through the preload's `raftDesktop.computer`
// (utils/desktopBridge.ts). The web renders everything from it: "This device"
// on the machine's row, its local controls in the detail panel, the "This Mac"
// row while it is not one of the server's computers, and onboarding's
// "Use this Mac".
//
// Null without a host-capable bridge (a browser, the phone app, a non-host
// desktop build): every consumer then renders exactly what it did before.
import { useMemo } from "react";
import axios from "axios";
import type { DesktopComputerBridge, DesktopComputerDiagnosticsReport, DesktopComputerHostState, DesktopComputerStatus, DesktopComputerStopWhenIdleResult, DesktopComputerTurnActivity } from "@botiverse/raft-shared";
import api from "../../../api/client";
import { useAuthStore } from "../../../store/authStore";
import { RUNTIME_API_ORIGIN } from "../../../runtimeEndpoints";
import { getDesktopBridge } from "../../../utils/desktopBridge";
import { attachedHereByOtherAccount, classifyHostError, deriveControls } from "./localComputerLogic";
import type { HostErrorCode } from "./localComputerLogic";
import { getLocalComputerBridge, refreshLocalComputerHost, setLocalComputerEnabling, setLocalComputerLastError, useLocalComputerMachineId, useLocalComputerSnapshot } from "./localComputerStore";
import { deriveThisDeviceState } from "./thisDeviceLogic";
import type { ThisDeviceState } from "./thisDeviceLogic";
import { useMachineStore } from "../../../store/machineStore";
import { useServerStore } from "../../../store/serverStore";
import { getComputerVersionFact } from "../../../utils/computerVersionFact";
import { obtainDesktopAttachToken } from "./desktopAttachGrant";
import type { AttachGrantPost } from "./desktopAttachGrant";

export interface LocalComputerSelf {
  /** "mac": the copy says "This Mac"; "other": "This computer". */
  deviceKind: "mac" | "other";
  /** This machine's id in the active server's machines, or null when it is not one of them. */
  machineId: string | null;
  /** The official Raft Computer is installed here (or, on a shell without the host state, attached or running). */
  installed: boolean;
  /** Raft Desktop drives the one install ("host") once its host state is known; null before. */
  management: "host" | null;
  running: boolean;
  /** An update of the local Computer in flight: its progress shows under Updates. */
  updating: { phase: string; percent: number | null } | null;
  /** The derived This device state (thisDeviceLogic.ts): what every surface says and offers. */
  state: ThisDeviceState;
  /** The official Raft Computer as Raft Desktop sees it, when reported. */
  host: DesktopComputerHostState | null;
  /** The installed Computer's version, when known. */
  version: string | null;
  /** The servers it is attached to (its id there). */
  servers: NonNullable<DesktopComputerStatus["servers"]>;
  /** The last failed operation's raw error, for "Technical details" only (never an instruction). */
  lastErrorRaw: string | null;
}

export interface LocalComputerHost {
  self: LocalComputerSelf;
  /**
   * The bridge has answered the first status, the host state and the local
   * info: until then whether this machine is one of the server's computers,
   * and whether Raft Computer is installed, are not known, so nothing may
   * offer Add.
   */
  ready: boolean;
  /** This machine can be added from here: Raft Computer is installed, or Raft Desktop can install it. */
  canAttach: boolean;
  /**
   * Add this machine to the server: install Raft Computer when it is missing
   * or too old, attach it with a one-time approval by the current user, and
   * start it (onEnableProgress reports each step).
   */
  attach(serverSlug: string): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  /** The shell's optional capabilities; absent ones are hidden. */
  bridge: DesktopComputerBridge;
  /** Run an optional bridge operation as the controls do: errors classified, the host state re-read after. */
  runOperation<T>(operation: () => Promise<T>): Promise<T>;
  getTurnActivity: (() => Promise<DesktopComputerTurnActivity | null>) | null;
  stopWhenIdle: (() => Promise<DesktopComputerStopWhenIdleResult>) | null;
  detach: ((serverId: string) => Promise<void>) | null;
  runDiagnostics: ((options?: { cleanup?: boolean }) => Promise<DesktopComputerDiagnosticsReport>) | null;
  /** Computer's own update (`raft-computer upgrade`). */
  updateComputer: (() => Promise<void>) | null;
  /** Retry a failed move from an older Desktop's embedded Computer. */
  retryMigration: (() => Promise<void>) | null;
  openComputerLogs: (() => void) | null;
  openDesktopLogs: (() => void) | null;
}

/** An operation's rejection, with the code the copy words (localComputerCopy.ts). */
class LocalComputerError extends Error {
  readonly code: HostErrorCode;
  readonly command: string | null;
  /** install_held: the installer's reason; cli_failed: the CLI's code. */
  readonly detail: string | null;

  constructor(code: HostErrorCode, message?: string, command: string | null = null, detail: string | null = null) {
    super(message ?? code);
    this.name = "LocalComputerError";
    this.code = code;
    this.command = command;
    this.detail = detail;
  }
}

export function toLocalComputerError(error: unknown): LocalComputerError {
  if (error instanceof LocalComputerError) return error;
  const raw = error instanceof Error ? error.message : String(error);
  const { code, command, detail } = classifyHostError(raw);
  return new LocalComputerError(code, raw, command, detail ?? null);
}

function runOperation<T>(action: () => Promise<T>): Promise<T> {
  return action().then((value) => {
    setLocalComputerLastError(null);
    refreshLocalComputerHost();
    return value;
  }, (error: unknown) => {
    const classified = toLocalComputerError(error);
    setLocalComputerLastError({ code: classified.code, raw: classified.message });
    refreshLocalComputerHost();
    throw classified;
  });
}

function run(action: () => Promise<unknown>): Promise<void> {
  return runOperation(action).then(() => undefined);
}

export function useLocalComputerHost(): LocalComputerHost | null {
  const computer = getLocalComputerBridge();
  const bridge = computer?.hostCapable ? computer : null;
  const { status, host, enabling, lastError, ready } = useLocalComputerSnapshot();
  const machineId = useLocalComputerMachineId();
  const latestComputerVersion = useMachineStore((s) => s.latestComputerVersion);
  const serverSlug = useServerStore((s) => s.current?.slug ?? null);

  const { running: statusRunning, upgrading } = deriveControls({ service: status?.service, upgrade: status?.upgrade });
  // Not installed, or its status unreadable: not running.
  const running = status === null ? false : statusRunning;
  const installed = host ? host.installed : (status?.servers?.length ?? 0) > 0 || !!status?.service?.running;
  const management = host ? "host" : null;
  const hostUpdating = host?.updating === true;
  const updatingPhase = upgrading?.phase ?? (hostUpdating ? "" : null);
  const updatingPercent = upgrading?.percent ?? null;
  const version = host?.version ?? status?.service?.version?.version ?? null;
  const servers = status?.servers;
  // Attached here: one of this server's machines, or an attachment naming this
  // server, unless that attachment is another Raft account's (then it is not
  // connected here for this account, and Add connects it).
  const otherAccountHere = useMachineStore((s) => attachedHereByOtherAccount(servers, serverSlug, s.machines));
  const attachmentHere = serverSlug !== null && !otherAccountHere && (servers ?? []).some((row) => row.serverSlug === serverSlug);
  const attachedHere = machineId !== null || attachmentHere;
  // Added here, but the server's computers do not list it yet (once they have loaded).
  const machinesLoaded = useMachineStore((s) => !s.loading && s.loadStatus === "loaded");
  const awaitingListing = attachmentHere && machineId === null && machinesLoaded;
  const updateAvailable = getComputerVersionFact({ computerVersion: version, computerBroadcastPolicy: null }, latestComputerVersion).kind === "outdated";
  const platform = getDesktopBridge()?.platform;
  const state = useMemo(() => deriveThisDeviceState({
    ready,
    host,
    status,
    enabling,
    running,
    attachedHere,
    awaitingListing,
    updateAvailable,
    lastErrorCode: lastError?.code ?? null,
  }), [ready, host, status, enabling, running, attachedHere, awaitingListing, updateAvailable, lastError]);

  return useMemo<LocalComputerHost | null>(() => {
    if (!bridge) return null;
    const deviceKind = platform === "darwin" ? "mac" : "other";
    const optional = <A extends unknown[], R>(fn: ((...args: A) => Promise<R>) | undefined) =>
      typeof fn === "function" ? (...args: A) => runOperation(() => fn.apply(bridge, args)) : null;
    const opener = (fn: (() => Promise<void>) | undefined) => (typeof fn === "function" ? () => { void fn.call(bridge); } : null);
    return {
      self: {
        deviceKind,
        machineId,
        installed,
        management,
        running,
        updating: updatingPhase === null ? null : { phase: updatingPhase, percent: updatingPercent },
        state,
        host,
        version,
        servers: servers ?? [],
        lastErrorRaw: lastError?.raw ?? null,
      },
      ready,
      canAttach: ready && host !== null && (host.installSupported || host.installed),
      attach: (serverSlug: string) => {
        const { accessToken, refreshToken } = useAuthStore.getState();
        if (!accessToken || !refreshToken) return Promise.reject(new LocalComputerError("not_signed_in"));
        setLocalComputerEnabling(true);
        return run(() => attachThisComputer(bridge, serverSlug, postAnyStatus)).finally(() => setLocalComputerEnabling(false));
      },
      start: () => run(() => bridge.start()),
      stop: () => run(() => bridge.stop()),
      restart: () => run(() => bridge.restart()),
      bridge,
      runOperation,
      // Reads, not operations: a failure here is not the device's last error.
      getTurnActivity: typeof bridge.getTurnActivity === "function" ? () => bridge.getTurnActivity!() : null,
      stopWhenIdle: optional(bridge.stopWhenIdle),
      detach: optional(bridge.detach),
      runDiagnostics: typeof bridge.runDiagnostics === "function" ? (options) => bridge.runDiagnostics!(options) : null,
      updateComputer: optional(bridge.updateComputer),
      retryMigration: optional(bridge.retryMigration),
      openComputerLogs: opener(bridge.openComputerLogs),
      openDesktopLogs: opener(bridge.openDesktopLogs),
    };
  }, [bridge, platform, ready, machineId, installed, management, running, updatingPhase, updatingPercent, state, host, version, servers, lastError]);
}

async function postOnce(url: string, body: Record<string, unknown>): Promise<{ status: number; data: unknown }> {
  try {
    const response = await api.post(url, body);
    return { status: response.status, data: response.data };
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) return { status: error.response.status, data: error.response.data };
    throw error;
  }
}

/**
 * The app's API, answering every HTTP status as a value (network failures
 * throw). The client never refreshes on a 401 from an `/auth/` URL, and
 * describe / approve need the person's session: an expired access token is
 * refreshed once and the call retried.
 */
const postAnyStatus: AttachGrantPost = async (url, body) => {
  const answered = await postOnce(url, body);
  if (answered.status !== 401) return answered;
  const refreshed = await useAuthStore.getState().refreshAccessToken().catch(() => false);
  return refreshed ? postOnce(url, body) : answered;
};

/**
 * Add this machine (desktopAttachGrant.ts): install the official Raft Computer
 * when it is missing or too old, then a one-time approval: the single-use
 * attach token goes to the shell in memory, which attaches and starts it; no
 * session does. Every server hands out one-time grants (#12116): one that
 * answers without a grant is refused, never given this app's session.
 */
export async function attachThisComputer(
  bridge: DesktopComputerBridge,
  serverSlug: string,
  post: AttachGrantPost = postAnyStatus,
): Promise<unknown> {
  if (typeof bridge.enableWithToken !== "function" || typeof bridge.getAttachGrantRequest !== "function") {
    throw new LocalComputerError("host_unavailable");
  }
  if (typeof bridge.ensureInstalled === "function") await bridge.ensureInstalled();
  const machine = await bridge.getAttachGrantRequest();
  const grant = await obtainDesktopAttachToken(post, {
    serverSlug,
    machineName: machine.machineName,
    hostname: machine.hostname,
    os: machine.os,
  });
  if (grant.kind !== "token") throw new Error("attach_grant_failed:server_unsupported");
  return bridge.enableWithToken({
    serverSlug: grant.serverSlug,
    serverId: grant.serverId,
    serverUrl: RUNTIME_API_ORIGIN,
    attachToken: grant.attachToken,
  });
}

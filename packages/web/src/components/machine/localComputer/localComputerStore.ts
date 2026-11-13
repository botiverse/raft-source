// What Raft Desktop reports about the machine it runs on (the preload's
// `raftDesktop.computer`, utils/desktopBridge.ts): the official Raft Computer's
// status and host state (installed, its version, how it starts, a move from an
// older Desktop's embedded Computer), and the OS hostname. One subscription to
// the bridge, shared by every reader: opened by the first reader and then held
// for the life of the page, like the facts it carries (they are about the
// machine, not about a screen). Letting it go with its last reader made every
// surface that mounts on its own (the Computers page hides the sidebar, which
// otherwise holds it) start from "not known yet": the list showed this device
// in its plain place, then moved it to the top once the bridge answered.
// The main process polls the status on its own (every 5 s while a window
// shows), so holding the subscription costs nothing more.
//
// Off the desktop (no bridge) every reader gets the empty snapshot and nothing
// subscribes.
//
// `ready` once the first status, the host state and the local info have each
// been answered (or failed): before that, "not one of this server's
// computers" and "is it installed" are not known, so no surface may offer Add.
// A failed read is reported (once per kind) and counts as answered, with its
// value unknown: the surfaces then fall back to what a browser shows.
import { useMemo, useSyncExternalStore } from "react";
import type { DesktopComputerBridge, DesktopComputerHostState, DesktopComputerStatus } from "@botiverse/raft-shared";
import { getDesktopBridge } from "../../../utils/desktopBridge";
import { reportClientError } from "../../../utils/clientErrorTrace";
import { useMachineStore } from "../../../store/machineStore";
import { correlateSelfMachine } from "./localComputerLogic";
import type { LocalMachineIdentity } from "./localComputerLogic";

export interface LocalComputerSnapshot {
  status: DesktopComputerStatus | null;
  hostname: string | null;
  /**
   * The one official Raft Computer as Raft Desktop sees it (null: a shell
   * without the capability, or not answered yet). Pushed by onHostState, and
   * read again when the service starts or stops, after an operation
   * (refreshLocalComputerHost) and when the window regains focus.
   */
  host: DesktopComputerHostState | null;
  /** An Add This Mac (install, attach, start) is in flight from this app, on any surface. */
  enabling: boolean;
  /** The last failed operation (a code only an operation reveals, e.g. a duplicate key), until one succeeds. */
  lastError: { code: string; raw: string } | null;
  /** The ids this machine has on the servers it is attached to (authoritative). */
  machineIds: readonly string[];
  /** The first status, the host state and the local info have all been answered. */
  ready: boolean;
}

const EMPTY: LocalComputerSnapshot = { status: null, hostname: null, host: null, enabling: false, lastError: null, machineIds: [], ready: false };

let snapshot: LocalComputerSnapshot = EMPTY;
const listeners = new Set<() => void>();
let disconnect: (() => void) | null = null;
/** Read the host state again now; a no-op while nothing reads the store. */
let refreshNow: (() => void) | null = null;

/** The bridge's computer capability: what reports the local identity (any desktop build). */
export function getLocalComputerBridge(): DesktopComputerBridge | null {
  const computer = getDesktopBridge()?.computer;
  return computer && typeof computer === "object" ? computer : null;
}

function update(patch: Partial<LocalComputerSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of [...listeners]) listener();
}

type BridgeRead = "getHostState" | "getStatus" | "getLocalInfo";
const reportedReads = new Set<BridgeRead>();

/** A failed bridge read, to the client error reporter: once per kind per page. */
function reportReadFailure(read: BridgeRead, error: unknown): void {
  if (reportedReads.has(read)) return;
  reportedReads.add(read);
  reportClientError({ source: "desktop_bridge", site: `localComputer.${read}`, error });
}

function machineIdsOf(status: DesktopComputerStatus | null): string[] {
  return (status?.servers ?? [])
    .map((row) => row.machineId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

function connect(computer: DesktopComputerBridge): () => void {
  let alive = true;
  let lastRunning: boolean | undefined;
  const answered = new Set<BridgeRead>();
  const answer = (read: BridgeRead, patch: Partial<LocalComputerSnapshot>) => {
    if (!alive) return;
    answered.add(read);
    update({ ...patch, ready: answered.size === 3 });
  };
  const fail = (read: BridgeRead) => (error: unknown) => {
    reportReadFailure(read, error);
    // Answered, with the value unknown (host null: no host controls).
    answer(read, {});
  };
  const applyHost = (host: DesktopComputerHostState | null) => answer("getHostState", { host: host ?? null });
  const readHost = () => {
    if (typeof computer.getHostState !== "function") return answer("getHostState", {});
    void computer.getHostState().then(applyHost, fail("getHostState"));
  };
  refreshNow = readHost;
  const applyStatus = (status: DesktopComputerStatus | null) => {
    if (!alive) return;
    const machineIds = machineIdsOf(status ?? null);
    const same = machineIds.length === snapshot.machineIds.length && machineIds.every((id, i) => id === snapshot.machineIds[i]);
    // The ids keep their identity while unchanged, so readers of them alone
    // (every computer row) do not re-render on each status poll.
    answer("getStatus", { status: status ?? null, machineIds: same ? snapshot.machineIds : machineIds });
    // Installed, its version, stopped by the user: they change as it starts or stops.
    const running = status?.service?.running;
    if (running !== lastRunning) {
      lastRunning = running;
      readHost();
    }
  };
  if (typeof computer.getLocalInfo === "function") {
    void computer.getLocalInfo().then(
      (info) => answer("getLocalInfo", { hostname: info?.hostname ?? null }),
      fail("getLocalInfo"),
    );
  } else {
    answer("getLocalInfo", {});
  }
  if (typeof computer.getStatus === "function") void computer.getStatus().then(applyStatus, fail("getStatus"));
  else answer("getStatus", {});
  readHost();
  const unsubscribe = typeof computer.onStatus === "function" ? computer.onStatus(applyStatus) : () => {};
  const unsubscribeHost = typeof computer.onHostState === "function" ? computer.onHostState(applyHost) : () => {};
  // Installed or updated from a terminal meanwhile: it shows once the window is back.
  const onFocus = () => readHost();
  if (typeof window !== "undefined") window.addEventListener("focus", onFocus);
  return () => {
    alive = false;
    refreshNow = null;
    unsubscribe();
    unsubscribeHost();
    if (typeof window !== "undefined") window.removeEventListener("focus", onFocus);
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!disconnect) {
    const computer = getLocalComputerBridge();
    if (computer) disconnect = connect(computer);
  }
  // The last reader leaving keeps the connection and what it knows: the next
  // surface reads it at once (no "not known yet", no jump), and it stays
  // current meanwhile.
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): LocalComputerSnapshot {
  return snapshot;
}

function getServerSnapshot(): LocalComputerSnapshot {
  return EMPTY;
}

export function useLocalComputerSnapshot(): LocalComputerSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** An Add This Mac started or ended (every surface shows "Setting up…" meanwhile). */
export function setLocalComputerEnabling(enabling: boolean): void {
  if (snapshot.enabling !== enabling) update({ enabling });
}

/** The last operation failed with this code (or succeeded: null). */
export function setLocalComputerLastError(lastError: { code: string; raw: string } | null): void {
  if (snapshot.lastError?.code !== lastError?.code || snapshot.lastError?.raw !== lastError?.raw) update({ lastError });
}

/** The current snapshot, outside React (a host command). */
export function getLocalComputerSnapshot(): LocalComputerSnapshot {
  return snapshot;
}

/** Read the host state again (after an operation). */
export function refreshLocalComputerHost(): void {
  refreshNow?.();
}

/**
 * This machine's identity, for matching it to one of the server's machines
 * (correlateSelfMachine). Changes only when the identity does, not on each
 * status poll.
 */
export function useLocalComputerIdentity(): LocalMachineIdentity {
  const hostname = useSyncExternalStore(subscribe, () => snapshot.hostname, () => null);
  const machineIds = useSyncExternalStore(subscribe, () => snapshot.machineIds, () => EMPTY.machineIds);
  return useMemo(() => ({ hostname, machineIds }), [hostname, machineIds]);
}

/**
 * Whether which machine this app runs on is settled: the bridge's first reads
 * have been answered (`ready`), or there is no bridge to ask (a browser, the
 * phone: no device of its own). A boolean, so a reader re-renders once.
 */
export function useLocalComputerIdentitySettled(): boolean {
  return useSyncExternalStore(subscribe, () => snapshot.ready || getLocalComputerBridge() === null, () => true);
}

/**
 * The id of the server's machine this app runs on: "This device", first in
 * every list of computers. A string or null, so a reader re-renders only when
 * it changes (not on every machine update).
 */
export function useLocalComputerMachineId(): string | null {
  const identity = useLocalComputerIdentity();
  return useMachineStore((s) => correlateSelfMachine(s.machines, identity)?.id ?? null);
}

/**
 * Test seam: subscribe once, as the app's first reader does, so a dialog
 * opened later finds the identity already known.
 */
export function holdLocalComputerForTests(): () => void {
  return subscribe(() => {});
}

/** Test seam: forget the snapshot and any subscription. */
export function resetLocalComputerStoreForTests(): void {
  disconnect?.();
  disconnect = null;
  listeners.clear();
  snapshot = EMPTY;
  reportedReads.clear();
}

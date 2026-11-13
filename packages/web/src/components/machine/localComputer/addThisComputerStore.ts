// Add Computer on Raft Desktop: the one setup of this computer in flight
// (AddThisComputerDialog shows it). It starts from a click (Add to this
// server: useAddThisComputer; This computer in Add Computer's choice), never
// from an effect, and again from Try Again; it
// follows Add This Mac's steps (`onEnableProgress`) while it runs, and
// outlives the dialog ("Continue in Background").
import { create } from "zustand";
import type { DesktopComputerEnableProgress } from "@botiverse/raft-shared";
import type { LocalComputerHost } from "./useLocalComputerHost";
import {
  applyEnableProgress,
  completeEnableProgress,
  ENABLE_PROGRESS_START,
  failEnableProgress,
} from "./addThisDeviceChoice";
import type { EnableProgress } from "./addThisDeviceChoice";
import { belowMinimumVersion } from "./thisDeviceLogic";

export type AddThisComputerThen = "this-device" | "create-agent";

export type ThisDeviceSetupPhase = "idle" | "working" | "failed" | "ready";

export interface ThisDeviceSetupState {
  phase: ThisDeviceSetupPhase;
  /** The server it is being added to: a setup belongs to its server. */
  serverSlug: string | null;
  /** Where Done goes: back to Create Agent when that is where it started (J3). */
  then: AddThisComputerThen;
  progress: EnableProgress;
  error: unknown;
}

const IDLE: ThisDeviceSetupState = { phase: "idle", serverSlug: null, then: "this-device", progress: ENABLE_PROGRESS_START, error: null };

/** The setup for `serverSlug`'s current view: another server's setup is not this one's. */
export function setupForServer(state: ThisDeviceSetupState, serverSlug: string | null): ThisDeviceSetupState {
  return state.phase !== "idle" && state.serverSlug !== serverSlug ? IDLE : state;
}

export const useAddThisComputerStore = create<ThisDeviceSetupState>(() => IDLE);

let runId = 0;

/**
 * The steps this computer has already done, checked from the start: Raft
 * Computer installed (and new enough) skips Install, shown done with its
 * version.
 */
export function alreadyDone(host: Pick<LocalComputerHost, "self">): EnableProgress {
  const state = host.self.host;
  const installed = state?.installed === true && !belowMinimumVersion(state);
  return {
    ...ENABLE_PROGRESS_START,
    install: installed
      ? { state: "done", skipped: true, ...(state?.version ? { version: state.version } : {}) }
      : { state: "wait" },
  };
}

/** Connect this computer to `serverSlug` (Add Computer's one click; Try Again). */
export function startAddThisComputer(host: LocalComputerHost, serverSlug: string, then?: AddThisComputerThen): void {
  const id = ++runId;
  const set = (update: (state: ThisDeviceSetupState) => Partial<ThisDeviceSetupState>) => {
    if (id === runId) useAddThisComputerStore.setState(update);
  };
  useAddThisComputerStore.setState((state) => ({ phase: "working", serverSlug, then: then ?? (state.serverSlug === serverSlug ? state.then : "this-device"), progress: alreadyDone(host), error: null }));
  const { bridge } = host;
  const unsubscribe = typeof bridge.onEnableProgress === "function"
    ? bridge.onEnableProgress((event: DesktopComputerEnableProgress) => set((state) => ({ progress: applyEnableProgress(state.progress, event) })))
    : null;
  void host.attach(serverSlug).then(() => {
    // Attached and started: the server listing it (online) is the web's own wait.
    set((state) => ({ phase: "ready", progress: { ...completeEnableProgress(state.progress), online: { state: "wait" } } }));
  }, (e: unknown) => {
    set((state) => ({ phase: "failed", error: e ?? new Error("unknown"), progress: failEnableProgress(state.progress) }));
  }).finally(() => unsubscribe?.());
}

/**
 * What Add Computer shows, from the setup and This device's one derived
 * listing flag: the attach can finish before the server lists this machine,
 * and until it does the setup is not done ("listing": waiting for the server
 * to list it, the last step). Ready only once it is listed.
 */
export type ThisDeviceSetupView = "idle" | "working" | "failed" | "listing" | "ready";

export function thisDeviceSetupView(
  phase: ThisDeviceSetupPhase,
  self: { machineId: string | null; state: { flags: { awaitingListing: boolean } } },
): ThisDeviceSetupView {
  if (phase !== "ready") return phase;
  return self.machineId !== null && !self.state.flags.awaitingListing ? "ready" : "listing";
}

/** The dialog closed on a finished or failed setup: the next Add Computer starts clean. */
export function resetAddThisComputer(): void {
  if (useAddThisComputerStore.getState().phase !== "working") useAddThisComputerStore.setState(IDLE);
}

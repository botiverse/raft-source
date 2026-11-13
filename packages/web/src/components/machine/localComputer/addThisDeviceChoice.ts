// Add Computer on Raft Desktop: what "This computer" is in Add Computer's
// choice (AddMachineDialog: This computer / Another computer of my own /
// Raft-hosted). It can be connected to the current server (one click once
// picked: install when missing, connect, start), or there is nothing to add
// here: this computer is already one of the server's computers, or it can't
// be added right now (Raft Computer is being moved to its standard install,
// that move failed, its state can't be read, or Raft Desktop can't install
// it here), and This device's page says what there is to do. Pure, so every
// case is unit-tested.
import type { DesktopComputerEnableProgress } from "@botiverse/raft-shared";
import type { ThisDeviceStateKind } from "./thisDeviceLogic";

export type AddComputerOnDesktop =
  /** Connect this computer to the server now (installs Raft Computer when missing). */
  | { kind: "connect" }
  /** Nothing to add here: this device's page (`attached`: already here; `blocked`: what is in the way). */
  | { kind: "open-this-device"; reason: "attached" | "blocked" };

export interface AddComputerOnDesktopInput {
  kind: ThisDeviceStateKind;
  /** This computer is one of the current server's computers, for this account. */
  attachedHere: boolean;
  /** Raft Computer is installed, or Raft Desktop can install it. */
  canAttach: boolean;
}

/** States where adding would only fail: the page says what is in the way. */
const BLOCKED: ReadonlySet<ThisDeviceStateKind> = new Set(["setting-up", "migrating", "migration-failed", "unreadable", "duplicate-key"]);

export function addComputerOnDesktop(input: AddComputerOnDesktopInput): AddComputerOnDesktop {
  if (input.attachedHere) return { kind: "open-this-device", reason: "attached" };
  if (BLOCKED.has(input.kind) || !input.canAttach) return { kind: "open-this-device", reason: "blocked" };
  return { kind: "connect" };
}

// ── Setting up: the bridge's Add This Mac progress ───────────────────────────
// The steps show real work only, in real order: install (done at once when it
// is already installed) → connect to the server (attach) → start → online
// (the server lists this Mac: the web's own wait).

export const ENABLE_STEPS = ["install", "attach", "start", "online"] as const;
export type EnableStepKey = (typeof ENABLE_STEPS)[number];

export interface EnableStepProgress {
  state: "wait" | "active" | "done" | "failed";
  /** Done without work: Raft Computer was already installed. */
  skipped?: boolean;
  /** install: the version installed (or already there). */
  version?: string;
}

export type EnableProgress = Record<EnableStepKey, EnableStepProgress>;

export const ENABLE_PROGRESS_START: EnableProgress = {
  install: { state: "wait" },
  attach: { state: "wait" },
  start: { state: "wait" },
  online: { state: "wait" },
};

/** One event from `onEnableProgress`: its step takes the new state, and the steps before an active one are done. */
export function applyEnableProgress(progress: EnableProgress, event: DesktopComputerEnableProgress): EnableProgress {
  if (!(ENABLE_STEPS as readonly string[]).includes(event.step)) return progress;
  const next: EnableProgress = { ...progress };
  const index = ENABLE_STEPS.indexOf(event.step);
  if (event.state !== "failed") {
    for (const earlier of ENABLE_STEPS.slice(0, index)) {
      if (next[earlier].state !== "done") next[earlier] = { ...next[earlier], state: "done" };
    }
  }
  const skipped = event.state === "skipped";
  next[event.step] = {
    ...next[event.step],
    state: event.state === "skipped" ? "done" : event.state,
    ...(skipped ? { skipped: true } : {}),
    ...(event.version ? { version: event.version } : {}),
  };
  return next;
}

/** Add This Mac finished: every step is done. */
export function completeEnableProgress(progress: EnableProgress): EnableProgress {
  const next: EnableProgress = { ...progress };
  for (const step of ENABLE_STEPS) next[step] = { ...next[step], state: "done" };
  return next;
}

/**
 * Add This Mac failed: the step it failed at turns to error (the one the
 * bridge named, else the one in progress, else the first not done).
 */
export function failEnableProgress(progress: EnableProgress): EnableProgress {
  if (ENABLE_STEPS.some((step) => progress[step].state === "failed")) return progress;
  const at = ENABLE_STEPS.find((step) => progress[step].state === "active")
    ?? ENABLE_STEPS.find((step) => progress[step].state !== "done")
    ?? "online";
  return { ...progress, [at]: { ...progress[at], state: "failed" } };
}

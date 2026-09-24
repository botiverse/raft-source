import {
  getCreatableRuntimeOptions,
  getSetupRuntimeOptions,
} from "@botiverse/raft-shared";
import type {
  RuntimeInfo,
  RuntimeSelectionOption,
} from "@botiverse/raft-shared";
import type { ServerSetupComputer } from "../components/onboarding/ServerSetupComputerRuntimeStep";
import type { ServerSetupRuntimeStatus } from "../components/onboarding/serverSetupProjection";

export type ServerSetupPreviewView =
  | "ready"
  | "not-ready"
  | "not-connected"
  | "connecting"
  | "create-agent"
  // They connected a computer and it is simply switched off. The screen they used to get
  // was "install + setup" — i.e. we asked a returning user who they were.
  | "offline-recovery"
  // Same, but a legacy daemon machine that has not migrated to Computer:
  // `raft-computer start` does not exist on that box, so it gets its daemon command.
  | "offline-recovery-daemon"
  // Several sleeping machines and no new connection: list them, one command, no chooser.
  | "offline-recovery-many";

export type ServerSetupPreviewFixture = {
  computer: ServerSetupComputer | null;
  /**
   * The server's verdict, which the real Screen B now receives on the setup projection
   * instead of deriving from the machine store. The preview has to STATE it for the same
   * reason the browser may not compute it: a fixture that infers it from the runtime list
   * would be re-implementing the very second opinion this change deletes. It is the full
   * enum, not a boolean — "not been told yet" is not "told there is nothing".
   */
  runtimeStatus: ServerSetupRuntimeStatus;
  /** Synthetic server-owned setup projection; preview code must not fall back to raw capability. */
  runtimeOptions: RuntimeSelectionOption[];
  /** Synthetic new-agent projection used only by the Create Cindy preview. */
  createRuntimeOptions?: RuntimeSelectionOption[];
  /** DURABLE: a non-revoked computer exists. Not "a computer is online right now". */
  hasConnectedComputer: boolean;
  offlineComputers?: Array<{ id: string; name: string; lastHeartbeat: string | null; isComputer?: boolean }>;
};

const COMPUTER_NAME = "Wenyi's MacBook Pro";
const PREVIEW_CREATE_RUNTIME_IDS = ["claude", "builtin", "pi"];

function projectFlagOffPreviewOptions(
  candidates: RuntimeInfo[],
  installedRuntimeIds: readonly string[],
): RuntimeSelectionOption[] {
  const installed = new Set(installedRuntimeIds);
  return candidates
    .filter((runtime) => runtime.id !== "grok")
    .map((runtime) => {
      const capabilityStatus = installed.has(runtime.id)
        ? "available" as const
        : runtime.binary === ""
          ? "update_required" as const
          : "not_installed" as const;
      return {
        runtimeId: runtime.id,
        capabilityStatus,
        admissionStatus: "available_for_new" as const,
        admissionReason: null,
        current: false,
        availableForNew: true,
        manageableForCurrentAgent: false,
        canSelectInThisContext: capabilityStatus === "available",
      };
    });
}

function setupRuntimeOptions(installedRuntimeIds: readonly string[]): RuntimeSelectionOption[] {
  return projectFlagOffPreviewOptions(getSetupRuntimeOptions(), installedRuntimeIds);
}

function createRuntimeOptions(): RuntimeSelectionOption[] {
  return projectFlagOffPreviewOptions(getCreatableRuntimeOptions(), PREVIEW_CREATE_RUNTIME_IDS);
}

export function serverSetupPreviewFixture(view: ServerSetupPreviewView): ServerSetupPreviewFixture {
  if (view === "not-connected") {
    return { computer: null, runtimeStatus: "unknown", runtimeOptions: [], hasConnectedComputer: false };
  }
  if (view === "offline-recovery-many") {
    return {
      computer: null,
      runtimeStatus: "unknown",
      runtimeOptions: [],
      hasConnectedComputer: true,
      offlineComputers: [
        { id: "m1", name: COMPUTER_NAME, lastHeartbeat: "2026-07-13T13:30:00.000Z" },
        // No heartbeat on record: the row says "Offline" and nothing more. We do not invent
        // a last-seen time to make the card look complete.
        { id: "m2", name: "Wenyi's Mac Studio", lastHeartbeat: null },
        { id: "m3", name: "office-linux", lastHeartbeat: "2026-07-01T09:00:00.000Z" },
      ],
    };
  }
  if (view === "offline-recovery" || view === "offline-recovery-daemon") {
    return {
      computer: {
        id: "preview-computer",
        name: COMPUTER_NAME,
        status: "offline",
        runtimeIds: [],
        isComputer: view === "offline-recovery",
      },
      runtimeStatus: "unknown",
      runtimeOptions: [],
      hasConnectedComputer: true,
    };
  }
  const installedRuntimeIds = view === "ready" || view === "create-agent" ? ["claude"] : [];
  return {
    computer: {
      id: "preview-computer",
      name: COMPUTER_NAME,
      status: view === "connecting" ? "offline" : "online",
      runtimeIds: installedRuntimeIds,
    },
    hasConnectedComputer: view !== "connecting",
    runtimeOptions: view === "connecting" ? [] : setupRuntimeOptions(installedRuntimeIds),
    createRuntimeOptions: view === "create-agent" ? createRuntimeOptions() : undefined,
    runtimeStatus: view === "ready" || view === "create-agent"
      ? "ready_recommended"
      : view === "connecting"
        ? "unknown"          // computer not online yet: we have not been told anything
        : "not_ready",       // the computer answered, and the answer was "nothing usable"
  };
}

export function readServerSetupPreviewView(search: string): ServerSetupPreviewView {
  const view = new URLSearchParams(search).get("view");
  const known: ServerSetupPreviewView[] = [
    "not-ready", "not-connected", "connecting", "create-agent",
    "offline-recovery", "offline-recovery-daemon", "offline-recovery-many",
  ];
  return known.includes(view as ServerSetupPreviewView) ? view as ServerSetupPreviewView : "ready";
}

/**
 * Machine domain events + reducer.
 *
 * Realtime machine mutations enter state through this pure reducer. Socket
 * handlers and UI intents adapt payloads into MachineEvent values; this module
 * owns the status/capabilities/Computer-operation state transforms.
 */

import type { ComputerOperationProgress, Machine } from "../machineStore";

export interface MachineDomainState {
  machines: Machine[];
  latestDaemonVersion: string | null;
  latestComputerVersion: string | null;
  computerOperationProgress: Record<string, ComputerOperationProgress | null>;
}

export type MachineEvent =
  | {
      kind: "hydrate";
      machines: Machine[];
      latestDaemonVersion: string | null;
      latestComputerVersion: string | null;
    }
  | {
      kind: "reconcile";
      reason: "machine-updated" | "scheduled";
    }
  | {
      kind: "status";
      machineId: string;
      status: "online" | "offline";
      statusVersion?: number;
    }
  | {
      kind: "capabilities";
      machineId: string;
      runtimes: string[];
      runtimeVersions?: Record<string, string>;
      hostname?: string;
      os?: string;
      daemonVersion?: string;
      computerVersion?: string | null;
    }
  | {
      kind: "operation-set";
      machineId: string;
      progress: ComputerOperationProgress | null;
    }
  | {
      kind: "upgrade-progress";
      machineId: string;
      requestId: string;
      phase: "downloading" | "verifying" | "applying" | "restarting";
      message?: string;
      percent?: number;
    }
  | {
      kind: "upgrade-done";
      machineId: string;
      requestId: string;
      ok: boolean;
      newVersion?: string;
      rolledBack?: boolean;
      error?: string;
    }
  | {
      kind: "restart-done";
      machineId: string;
      requestId: string;
      ok: boolean;
      error?: string;
    }
  | {
      kind: "reset";
    };

export interface MachineTransition {
  event: MachineEvent["kind"];
  touched: number;
  machineId: string | null;
  accepted: boolean;
  recoveryAction:
    | "reload-machines"
    | "reload-machines-and-agents"
    | null;
}

export interface MachineApplyResult {
  state: MachineDomainState;
  transition: MachineTransition;
}

const EMPTY_STATE: MachineDomainState = {
  machines: [],
  latestDaemonVersion: null,
  latestComputerVersion: null,
  computerOperationProgress: {},
};

const PHASE_VALUE: Record<string, number> = {
  downloading: 85,
  verifying: 90,
  applying: 95,
};

export function applyMachineEvent(
  state: MachineDomainState,
  event: MachineEvent,
): MachineApplyResult {
  switch (event.kind) {
    case "hydrate":
      return {
        state: {
          ...state,
          machines: event.machines,
          latestDaemonVersion: event.latestDaemonVersion,
          latestComputerVersion: event.latestComputerVersion,
        },
        transition: {
          event: "hydrate",
          touched: event.machines.length,
          machineId: null,
          accepted: true,
          recoveryAction: null,
        },
      };

    case "reconcile":
      return {
        state,
        transition: {
          event: "reconcile",
          touched: 0,
          machineId: null,
          accepted: true,
          recoveryAction:
            event.reason === "machine-updated"
              ? "reload-machines"
              : "reload-machines-and-agents",
        },
      };

    case "reset":
      return {
        state: EMPTY_STATE,
        transition: {
          event: "reset",
          touched:
            state.machines.length +
            Object.keys(state.computerOperationProgress).length,
          machineId: null,
          accepted: true,
          recoveryAction: null,
        },
      };

    case "status":
      return applyStatus(state, event);

    case "capabilities":
      return applyCapabilities(state, event);

    case "operation-set":
      return updateOperation(
        state,
        event.machineId,
        event.progress,
        event.kind,
      );

    case "upgrade-progress":
      return applyUpgradeProgress(state, event);

    case "upgrade-done":
      return applyUpgradeDone(state, event);

    case "restart-done":
      return applyRestartDone(state, event);
  }
}

function applyRestartDone(
  state: MachineDomainState,
  event: Extract<MachineEvent, { kind: "restart-done" }>,
): MachineApplyResult {
  const current = state.computerOperationProgress[event.machineId];
  if (
    !current ||
    current.operation !== "restart" ||
    current.requestId !== event.requestId
  ) {
    return noop(state, event.kind, event.machineId);
  }
  return updateOperation(
    state,
    event.machineId,
    {
      ...current,
      done: true,
      ...(event.ok ? {} : { error: event.error ?? "restart_failed" }),
    },
    event.kind,
  );
}

function applyStatus(
  state: MachineDomainState,
  event: Extract<MachineEvent, { kind: "status" }>,
): MachineApplyResult {
  let changed = false;
  const machines = state.machines.map((machine) => {
    if (machine.id !== event.machineId) return machine;
    const merged = mergeMachineStatusByVersionGate(
      machine,
      event.status,
      event.statusVersion,
    );
    if (merged !== machine) changed = true;
    return merged;
  });
  if (!changed) {
    return noop(
      state,
      event.kind,
      event.machineId,
      event.status === "online" ? "reload-machines-and-agents" : null,
    );
  }
  return {
    state: { ...state, machines },
    transition: {
      event: event.kind,
      touched: 1,
      machineId: event.machineId,
      accepted: true,
      recoveryAction: "reload-machines-and-agents",
    },
  };
}

function applyCapabilities(
  state: MachineDomainState,
  event: Extract<MachineEvent, { kind: "capabilities" }>,
): MachineApplyResult {
  let changed = false;
  const machines = state.machines.map((machine) => {
    if (machine.id !== event.machineId) return machine;
    const next: Machine = {
      ...machine,
      runtimes: event.runtimes,
      ...(event.runtimeVersions !== undefined
        ? { runtimeVersions: event.runtimeVersions }
        : {}),
      ...(event.hostname !== undefined ? { hostname: event.hostname } : {}),
      ...(event.os !== undefined ? { os: event.os } : {}),
      ...(event.daemonVersion !== undefined
        ? { daemonVersion: event.daemonVersion }
        : {}),
      ...(event.computerVersion !== undefined
        ? { computerVersion: event.computerVersion }
        : {}),
    };
    if (!machineShallowEqual(machine, next)) changed = true;
    return machineShallowEqual(machine, next) ? machine : next;
  });
  if (!changed) return noop(state, event.kind, event.machineId);
  return {
    state: { ...state, machines },
    transition: {
      event: event.kind,
      touched: 1,
      machineId: event.machineId,
      accepted: true,
      recoveryAction: null,
    },
  };
}

function applyUpgradeProgress(
  state: MachineDomainState,
  event: Extract<MachineEvent, { kind: "upgrade-progress" }>,
): MachineApplyResult {
  const cur = state.computerOperationProgress[event.machineId];
  if (cur?.requestId && cur.requestId !== event.requestId) {
    return noop(state, event.kind, event.machineId);
  }
  const progressValue =
    event.phase === "downloading" && typeof event.percent === "number"
      ? Math.min(85, Math.max(0, Math.round((event.percent / 100) * 85)))
      : PHASE_VALUE[event.phase];
  return updateOperation(
    state,
    event.machineId,
    {
      operation: "upgrade",
      requestId: event.requestId,
      phase: event.phase,
      message: event.message,
      progressValue,
    },
    event.kind,
  );
}

function applyUpgradeDone(
  state: MachineDomainState,
  event: Extract<MachineEvent, { kind: "upgrade-done" }>,
): MachineApplyResult {
  const cur = state.computerOperationProgress[event.machineId];
  if (!cur || cur.requestId !== event.requestId) {
    return noop(state, event.kind, event.machineId);
  }
  return updateOperation(
    state,
    event.machineId,
    {
      ...cur,
      done: true,
      rolledBack: event.rolledBack ?? false,
      newVersion: event.newVersion,
      error: event.error,
      progressValue: event.ok && !event.rolledBack ? 100 : cur.progressValue,
    },
    event.kind,
  );
}

function updateOperation(
  state: MachineDomainState,
  machineId: string,
  progress: ComputerOperationProgress | null,
  event: MachineTransition["event"],
): MachineApplyResult {
  if (
    operationEqual(state.computerOperationProgress[machineId] ?? null, progress)
  ) {
    return noop(state, event, machineId);
  }
  return {
    state: {
      ...state,
      computerOperationProgress: {
        ...state.computerOperationProgress,
        [machineId]: progress,
      },
    },
    transition: {
      event,
      touched: 1,
      machineId,
      accepted: true,
      recoveryAction: null,
    },
  };
}

function noop(
  state: MachineDomainState,
  event: MachineTransition["event"],
  machineId: string | null,
  recoveryAction: MachineTransition["recoveryAction"] = null,
): MachineApplyResult {
  return {
    state,
    transition: {
      event,
      touched: 0,
      machineId,
      accepted: false,
      recoveryAction,
    },
  };
}

/**
 * Version-gated status merge lives in the machine reducer because it is the
 * ordering contract other realtime domains should copy: old statusVersion
 * frames are dropped without replacing references; equal/newer frames win.
 */
function mergeMachineStatusByVersionGate(
  machine: Machine,
  status: "online" | "offline",
  statusVersion?: number,
): Machine {
  if (statusVersion !== undefined && statusVersion < machine.statusVersion) {
    return machine;
  }

  return {
    ...machine,
    status,
    statusVersion: statusVersion ?? machine.statusVersion,
  };
}

function machineShallowEqual(a: Machine, b: Machine): boolean {
  const aKeys = Object.keys(a) as Array<keyof Machine>;
  const bKeys = Object.keys(b) as Array<keyof Machine>;
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => {
    const av = a[key];
    const bv = b[key];
    if (key === "runtimeVersions") return stringRecordEqual(av, bv);
    return Array.isArray(av) && Array.isArray(bv)
      ? arrayEqual(av, bv)
      : Object.is(av, bv);
  });
}

function stringRecordEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const keys = Object.keys(aRecord);
  return keys.length === Object.keys(bRecord).length
    && keys.every((key) => Object.is(aRecord[key], bRecord[key]));
}

function operationEqual(
  a: ComputerOperationProgress | null,
  b: ComputerOperationProgress | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const aKeys = Object.keys(a) as Array<keyof ComputerOperationProgress>;
  const bKeys = Object.keys(b) as Array<keyof ComputerOperationProgress>;
  if (aKeys.length !== bKeys.length) return false;
  const bKeySet = new Set<keyof ComputerOperationProgress>(bKeys);
  return aKeys.every(
    (key) => bKeySet.has(key) && Object.is(a[key], b[key]),
  );
}

function arrayEqual<T>(a: T[], b: T[]): boolean {
  return (
    a.length === b.length &&
    a.every((value, index) => Object.is(value, b[index]))
  );
}

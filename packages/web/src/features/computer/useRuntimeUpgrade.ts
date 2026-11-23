import type { RuntimeAuthRuntime } from "@botiverse/raft-shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { runtimeAuthRequestError, runtimeUpgradeOffered } from "../../utils/runtimeAuthClient";
import type { RuntimeAuthClient, RuntimeAuthView } from "../../utils/runtimeAuthClient";
import { runtimeUpgradeRefusal } from "./runtimeUpgradeOutcomeCopy";
import type { RuntimeUpgradeState } from "./runtimeUpgradeOutcomeCopy";

const IDLE: RuntimeUpgradeState = { kind: "idle" };

/**
 * One runtime's Upgrade on one Computer (docs/contracts/runtime-auth.md,
 * "Upgrade"): `start` runs the runtime's own updater there, only on the
 * person's press, and `state` says what it has learned. The state belongs to
 * its subject (server, Computer, runtime): another subject starts idle. Once
 * the Computer answers, its runtime-auth view is read again (the Computer
 * re-detects its runtimes after an updater ran, and reports the new status).
 */
export function useRuntimeUpgrade(
  client: RuntimeAuthClient,
  serverId: string,
  machineId: string,
  runtime: RuntimeAuthRuntime | null,
): { state: RuntimeUpgradeState; start: () => void } {
  const subject = `${serverId}\0${machineId}\0${runtime ?? ""}`;
  const [held, setHeld] = useState<{ subject: string; state: RuntimeUpgradeState } | null>(null);
  const current = useRef(subject);
  useEffect(() => {
    current.current = subject;
  }, [subject]);
  const state: RuntimeUpgradeState = held?.subject === subject ? held.state : IDLE;
  const running = state.kind === "running";

  const start = useCallback(() => {
    if (!runtime || running) return;
    const startedFor = subject;
    const settle = (next: RuntimeUpgradeState) => {
      if (current.current === startedFor) setHeld({ subject: startedFor, state: next });
    };
    setHeld({ subject: startedFor, state: { kind: "running" } });
    void client.upgradeRuntime(serverId, machineId, runtime).then(
      (result) => settle({ kind: "done", result }),
      (error: unknown) => {
        // By the server's code; anything else (a network failure, an answer this page cannot read) is a plain failure.
        settle({ kind: "refused", reason: runtimeUpgradeRefusal(runtimeAuthRequestError(error).code) });
      },
    ).finally(() => client.invalidate(serverId, machineId));
  }, [client, machineId, runtime, running, serverId, subject]);

  return { state, start };
}

/**
 * Upgrade where the server's view offers it for this runtime
 * (`runtimeUpgradeOffered`: runtime_upgrade_button, a viewer who may act, a
 * Computer that runs this runtime's updater); null otherwise.
 */
export function useOfferedRuntimeUpgrade(
  client: RuntimeAuthClient,
  serverId: string,
  machineId: string,
  runtime: RuntimeAuthRuntime | null,
  view: RuntimeAuthView | null,
): { state: RuntimeUpgradeState; onUpgrade: () => void } | null {
  const { state, start } = useRuntimeUpgrade(client, serverId, machineId, runtime);
  const offered = runtimeUpgradeOffered(view, runtime);
  return useMemo(() => (offered ? { state, onUpgrade: start } : null), [offered, start, state]);
}

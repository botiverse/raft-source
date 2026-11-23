import type { RuntimeAuthRuntime } from "@botiverse/raft-shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { runtimeAuthRequestError } from "../../utils/runtimeAuthClient";
import type { RuntimeAuthClient } from "../../utils/runtimeAuthClient";
import { runtimeInstallRefusal, runtimeInstallStateForPlan } from "./runtimeInstallCopy";
import type { RuntimeInstallState } from "./runtimeInstallCopy";

const IDLE: RuntimeInstallState = { kind: "idle" };

/**
 * Install on one Computer (docs/contracts/runtime-auth.md §6e), one runtime
 * at a time from this page: `start` reads what the Computer would run (the
 * plan) and puts it before the person, `confirm` runs it (only on that
 * press), `cancel` drops the plan. Only the runtime is ever sent. The state
 * belongs to its subject (server, Computer): another Computer starts idle.
 * Once the Computer answers an install, its runtime-auth view is read again
 * (the Computer re-detects its runtimes after one was installed).
 */
export function useRuntimeInstall(
  client: RuntimeAuthClient,
  serverId: string | null,
  machineId: string,
): { state: RuntimeInstallState; start: (runtime: RuntimeAuthRuntime) => void; confirm: () => void; cancel: () => void } {
  const subject = `${serverId ?? ""}\0${machineId}`;
  const [held, setHeld] = useState<{ subject: string; state: RuntimeInstallState } | null>(null);
  const current = useRef(subject);
  useEffect(() => {
    current.current = subject;
  }, [subject]);
  const state: RuntimeInstallState = held?.subject === subject ? held.state : IDLE;
  const busy = state.kind === "planning" || state.kind === "running";

  const settleFor = useCallback((startedFor: string) => (next: RuntimeInstallState) => {
    if (current.current === startedFor) setHeld({ subject: startedFor, state: next });
  }, []);

  const start = useCallback((runtime: RuntimeAuthRuntime) => {
    if (!serverId || busy) return;
    const settle = settleFor(subject);
    settle({ kind: "planning", runtime });
    void client.runtimeInstallPlan(serverId, machineId, runtime).then(
      (plan) => settle(runtimeInstallStateForPlan(runtime, plan)),
      (error: unknown) => settle({ kind: "refused", runtime, reason: runtimeInstallRefusal(runtimeAuthRequestError(error).code) }),
    );
  }, [busy, client, machineId, serverId, settleFor, subject]);

  const confirm = useCallback(() => {
    if (!serverId || state.kind !== "confirm") return;
    const runtime = state.runtime;
    const settle = settleFor(subject);
    settle({ kind: "running", runtime });
    void client.installRuntime(serverId, machineId, runtime).then(
      (result) => settle({ kind: "done", runtime, result }),
      // By the server's code; anything else (a network failure, an answer this page cannot read) is a plain failure.
      (error: unknown) => settle({ kind: "refused", runtime, reason: runtimeInstallRefusal(runtimeAuthRequestError(error).code) }),
    ).finally(() => client.invalidate(serverId, machineId));
  }, [client, machineId, serverId, settleFor, state, subject]);

  // From the latest state: the dialog closes right after its confirm, which has already moved on to `running`.
  const cancel = useCallback(() => {
    setHeld((previous) => (previous?.subject === subject && (previous.state.kind === "confirm" || previous.state.kind === "manual")
      ? { subject, state: IDLE }
      : previous));
  }, [subject]);

  return { state, start, confirm, cancel };
}

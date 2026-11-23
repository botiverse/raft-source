import { useCallback, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { getRuntimeDisplayName } from "@botiverse/raft-shared";
import { useRuntimeAuthView } from "../machine/useRuntimeAuthView";
import { RuntimeSignInDialog } from "../../features/computer/RuntimeSignInDialog";
import { runtimeAuthClient as defaultRuntimeAuthClient } from "../../utils/runtimeAuthClient";
import type { RuntimeAuthClient } from "../../utils/runtimeAuthClient";
import { runtimeSignInState, signInRuntimeFor } from "../../utils/runtimeSignInState";
import type { Agent } from "../../store/agentStore";
import type { AgentActivityState } from "../../store/events/agentActivityEvents";
import { firstAgentStartFailure } from "./firstAgentStartFailure";

function stopSubmit(event: FormEvent) {
  event.stopPropagation();
}

export type FirstAgentStartFailureView = {
  /** She could not start; null while she runs or nothing says she failed. */
  failed: boolean;
  name: string;
  runtimeName: string;
  /** The next step is a sign-in: the error says so, or the Computer reports the runtime signed out. */
  signInNext: boolean;
  /** Sign in can be offered here (the viewer may act and the Computer is reachable). */
  canSignIn: boolean;
  openSignIn: () => void;
  /** The sign-in dialog while open (RuntimeSignInDialog), for the caller to render. */
  signInDialog: ReactNode;
};

/**
 * The first agent's failed start, for the handoff step: whether she failed, what
 * the next step is, and the sign-in it offers. The step's footer carries the
 * action (Cat: the page's pink button, never a button in the card) and the card
 * (FirstAgentStartFailureNotice) only says what happened.
 *
 * Sign in opens the runtime picker's RuntimeSignInDialog. It closes the same way
 * on Cancel, ×, a failed and a finished sign-in, so `onSignedIn` (start her again)
 * runs only when the Computer then reports the runtime signed in (a finished
 * sign-in drops the cached read): a manual start also lifts the server's
 * automatic-restart pause.
 */
export function useFirstAgentStartFailure({
  serverId,
  agent,
  activity,
  onSignedIn,
  client = defaultRuntimeAuthClient,
}: {
  serverId: string;
  agent: Pick<Agent, "name" | "displayName" | "runtime" | "machineId" | "status" | "lastRuntimeError"> | null | undefined;
  activity: AgentActivityState | null | undefined;
  onSignedIn?: () => void;
  client?: RuntimeAuthClient;
}): FirstAgentStartFailureView {
  const failure = firstAgentStartFailure(agent, activity);
  const runtime = agent?.runtime ?? "";
  const authRuntime = runtime ? signInRuntimeFor(runtime) : null;
  const machineId = agent?.machineId ?? "";
  const { view } = useRuntimeAuthView(client, serverId, machineId, failure !== null && authRuntime !== null && machineId !== "");
  const [signingIn, setSigningIn] = useState(false);
  const openSignIn = useCallback(() => setSigningIn(true), []);
  const closeSignIn = useCallback(() => {
    setSigningIn(false);
    if (!onSignedIn || !machineId) return;
    void client.read(serverId, machineId).then((latest) => {
      if (runtimeSignInState(latest, runtime) === "signed_in") onSignedIn();
    }, () => undefined);
  }, [client, machineId, onSignedIn, runtime, serverId]);
  const signInNext = failure !== null && authRuntime !== null && (failure.signIn || runtimeSignInState(view, runtime) === "signed_out");
  return {
    failed: failure !== null,
    name: agent ? agent.displayName || agent.name : "",
    runtimeName: runtime ? getRuntimeDisplayName(runtime) : "",
    signInNext,
    canSignIn: signInNext && Boolean(view?.canAct && view.availability === "ok") && machineId !== "",
    openSignIn,
    signInDialog: signingIn && authRuntime && machineId ? (
      // The dialog portals out of the DOM but not out of the React tree: keep its form's submit to itself.
      <div className="contents" onSubmit={stopSubmit}>
        <RuntimeSignInDialog serverId={serverId} machineId={machineId} runtimeId={runtime} runtime={authRuntime} client={client} onClose={closeSignIn} />
      </div>
    ) : null,
  };
}

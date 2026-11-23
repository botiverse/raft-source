import { TextLink } from "@botiverse/raft-ui";
import { getRuntimeDisplayName } from "@botiverse/raft-shared";
import { useCallback, useState } from "react";
import type { FormEvent } from "react";
import { useIntl } from "react-intl";
import { RuntimeSignInDialog } from "../../features/computer/RuntimeSignInDialog";
import { runtimeAuthClient } from "../../utils/runtimeAuthClient";
import type { RuntimeAuthClient } from "../../utils/runtimeAuthClient";
import { useAgentRuntimeSignInView } from "./useAgentRuntimeSignInView";

function stopSubmit(event: FormEvent) {
  event.stopPropagation();
}

/**
 * #triage:#494: "Sign in" beside an agent's "Sign-in needed" status (the
 * member list, a DM's header). It opens the same sign-in as the profile's and
 * the runtime picker's notice (`RuntimeSignInDialog`), offered by the same rule
 * as the notice (`runtimeSignInOffered`): a viewer who may see the Computer's
 * sign-in state, whom the server lets act on it from here, while the Computer
 * says the runtime is signed out. Anyone else, and any other live state
 * (signed in since, `unknown`, `unavailable`), gets nothing. A quiet text
 * action (DS TextLink), as the profile badge's Retry and Change model are; its
 * accessible name names the runtime ("Sign in to Kimi Code"), so a list of
 * them can be told apart.
 */
export function RuntimeSignInAction({
  machineId,
  runtimeId,
  className,
  testId,
  client = runtimeAuthClient,
}: {
  machineId: string | null;
  runtimeId: string;
  className?: string;
  testId?: string;
  client?: RuntimeAuthClient;
}) {
  const { formatMessage } = useIntl();
  const { serverId, authRuntime, offered } = useAgentRuntimeSignInView(machineId, runtimeId, true, client);
  const [signingIn, setSigningIn] = useState(false);
  const openSignIn = useCallback(() => setSigningIn(true), []);
  const closeSignIn = useCallback(() => setSigningIn(false), []);
  if (!offered || !authRuntime || !serverId || !machineId) return null;
  return (
    <>
      <TextLink
        type="button"
        className={className ?? "shrink-0 whitespace-nowrap text-footnote"}
        onClick={openSignIn}
        aria-label={formatMessage({ id: "machine.runtimeAuth.signIn.title" }, { runtime: getRuntimeDisplayName(runtimeId) })}
        data-testid={testId}
      >
        {formatMessage({ id: "machine.runtimeAuth.signInAction" })}
      </TextLink>
      {signingIn && (
        // The dialog portals out of the DOM but not out of the React tree: its code form's submit stays its own.
        <div className="contents" onSubmit={stopSubmit}>
          <RuntimeSignInDialog
            serverId={serverId}
            machineId={machineId}
            runtimeId={runtimeId}
            runtime={authRuntime}
            client={client}
            onClose={closeSignIn}
          />
        </div>
      )}
    </>
  );
}

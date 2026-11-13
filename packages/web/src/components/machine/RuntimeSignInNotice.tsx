import { Button } from "@botiverse/raft-ui";
import { getRuntimeDisplayName, runtimeAuthRuntimeFor, runtimeAuthSignsInPerProvider, runtimeAuthSupports } from "@botiverse/raft-shared";
import { LogIn } from "lucide-react";
import { useCallback, useState } from "react";
import type { FormEvent } from "react";
import { useIntl } from "react-intl";
import Banner from "../ui/Banner";
import { runtimeAuthClient, runtimeAuthStatusOf } from "../../utils/runtimeAuthClient";
import type { RuntimeAuthClient } from "../../utils/runtimeAuthClient";
import { useRuntimeAuthView } from "./RuntimeAccountUsageChip";
import { RuntimeSignInDialog } from "../../features/computer/RuntimeSignInDialog";

function stopSubmit(event: FormEvent) {
  event.stopPropagation();
}

/**
 * Under a runtime picker: the picked runtime (Claude Code, Codex, Kimi Code,
 * Qoder) is signed out on the Computer. Says so, with the same Sign In the runtime chip's card offers, and
 * blocks nothing — the agent can still be created or saved.
 *
 * Reads the same per-Computer sign-in state the chip's card reads (cached per
 * Computer, re-read when the Computer reports a new one). `enabled` is the
 * caller's say on whether this person may see that state at all.
 */
export default function RuntimeSignInNotice({
  serverId,
  machineId,
  machineName,
  runtimeId,
  enabled,
  client = runtimeAuthClient,
}: {
  serverId: string | null | undefined;
  machineId: string | null | undefined;
  machineName: string;
  runtimeId: string;
  enabled: boolean;
  client?: RuntimeAuthClient;
}) {
  const { formatMessage } = useIntl();
  // Runtimes with one sign-in only: Qwen Code's provider key has its own card, and its presence-only status is no "signed out";
  // Pi with no stored sign-in may still run on a key in the Computer's environment or models.json.
  const signInRuntime = runtimeAuthRuntimeFor(runtimeId);
  const authRuntime = signInRuntime && runtimeAuthSupports(signInRuntime, "login") && !runtimeAuthSignsInPerProvider(signInRuntime) ? signInRuntime : null;
  const active = enabled && authRuntime !== null && Boolean(serverId) && Boolean(machineId);
  const { view } = useRuntimeAuthView(client, serverId ?? "", machineId ?? "", active);
  const [signingIn, setSigningIn] = useState(false);
  const openSignIn = useCallback(() => setSigningIn(true), []);
  const closeSignIn = useCallback(() => setSigningIn(false), []);
  if (!active || !authRuntime || !serverId || !machineId) return null;
  const signedOut = runtimeAuthStatusOf(view, authRuntime)?.kind === "logged_out";
  return (
    <>
      {signedOut ? (
        // raft-ui's warning Banner is role="status" (polite): picking a
        // signed-out runtime is announced without interrupting. It leads with
        // the warning's TriangleAlert, as every warning does (Raft DS Banner).
        <Banner
          intent="warning"
          density="sm"
          withIcon
          data-testid="runtime-picker-not-signed-in"
          actions={view?.canAct && view.availability === "ok" ? (
            <Button type="button" size="md" variant="default" onClick={openSignIn}>
              <LogIn size={16} aria-hidden="true" />
              {formatMessage({ id: "machine.runtimeAuth.signInAction" })}
            </Button>
          ) : undefined}
        >
          {formatMessage(
            { id: "runtime.picker.notSignedIn" },
            { runtime: getRuntimeDisplayName(runtimeId), computer: machineName },
          )}
        </Banner>
      ) : null}
      {signingIn && (
        // The dialog portals out of the DOM but not out of the React tree: its
        // own code form's submit would bubble on to the Create / Save form.
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

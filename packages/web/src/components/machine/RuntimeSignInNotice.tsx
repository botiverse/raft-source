import { Button } from "@botiverse/raft-ui";
import { getRuntimeDisplayName } from "@botiverse/raft-shared";
import { LogIn } from "lucide-react";
import { useCallback, useState } from "react";
import type { FormEvent } from "react";
import { useIntl } from "react-intl";
import Banner from "../ui/Banner";
import { runtimeAuthClient, runtimeAuthComputerSupports, runtimeAuthStatusOf, runtimeUpgradeOffered } from "../../utils/runtimeAuthClient";
import { signInRuntimeFor } from "../../utils/runtimeSignInState";
import type { RuntimeAuthClient } from "../../utils/runtimeAuthClient";
import { useRuntimeAuthView } from "./RuntimeAccountUsageChip";
import { RuntimeSignInDialog } from "../../features/computer/RuntimeSignInDialog";
import { RackCommand } from "../../features/computer/RackCommand";
import { RUNTIME_INSTALL_COMMANDS } from "./runtimeInstallCommands";
import { runtimePickerCliProblem } from "./runtimePickerCliProblem";
import { runtimeSignInOffered } from "./runtimeSignInGate";
import { RuntimeUpgradeButton } from "../../features/computer/RuntimeUpgradeButton";
import { runtimeUpgradeCopy } from "../../features/computer/runtimeUpgradeOutcomeCopy";
import { useRuntimeUpgrade } from "../../features/computer/useRuntimeUpgrade";

function stopSubmit(event: FormEvent) {
  event.stopPropagation();
}

/**
 * Under a runtime picker: the picked runtime (Claude Code, Codex, Kimi Code,
 * Qoder) is signed out on the Computer. Says so, with the same Sign In the runtime chip's card offers, and
 * blocks nothing — the agent can still be created or saved. A runtime whose
 * CLI the Computer reports missing or too old to sign in (the Computer card's
 * `unavailable`) gets that said instead, with the install line where one is
 * known: no Sign In would work there (#oar-raft:#20). A CLI too old to sign
 * in (`version_unsupported`, once OAR reports it for a CLI too old) gets
 * Upgrade instead of the "update it there" guidance where it is offered
 * (`runtimeUpgradeOffered`); its outcome stays in the notice once the
 * Computer has rescanned, as success or as what to do next.
 *
 * Reads the same per-Computer sign-in state the chip's card reads (cached per
 * Computer, re-read when the Computer reports a new one). `enabled` is the
 * caller's say on whether this person may see that state at all.
 *
 * `unknownNotice` (Create Cindy): also say so when the Computer's read came
 * back without a sign-in state for the runtime (an older Computer, or
 * `unknown`), with Sign In where the Computer signs it in from here, so a
 * runtime preselected on an unknown state is never a silent guess.
 */
export default function RuntimeSignInNotice({
  serverId,
  machineId,
  machineName,
  runtimeId,
  enabled,
  unknownNotice = false,
  agentName = "",
  client = runtimeAuthClient,
}: {
  serverId: string | null | undefined;
  machineId: string | null | undefined;
  machineName: string;
  runtimeId: string;
  enabled: boolean;
  unknownNotice?: boolean;
  /** With `unknownNotice`: the agent being created, named in its next step. */
  agentName?: string;
  client?: RuntimeAuthClient;
}) {
  const { formatMessage } = useIntl();
  // Runtimes with one sign-in only: Qwen Code's provider key has its own card, and its presence-only status is no "signed out";
  // Pi with no stored sign-in may still run on a key in the Computer's environment or models.json.
  const authRuntime = signInRuntimeFor(runtimeId);
  const active = enabled && authRuntime !== null && Boolean(serverId) && Boolean(machineId);
  const { view } = useRuntimeAuthView(client, serverId ?? "", machineId ?? "", active);
  const [signingIn, setSigningIn] = useState(false);
  const openSignIn = useCallback(() => setSigningIn(true), []);
  const closeSignIn = useCallback(() => setSigningIn(false), []);
  const upgrade = useRuntimeUpgrade(client, serverId ?? "", machineId ?? "", authRuntime);
  if (!active || !authRuntime || !serverId || !machineId) return null;
  const status = runtimeAuthStatusOf(view, authRuntime);
  const signedOut = status?.kind === "logged_out";
  // Read, and no answer for this runtime: only where the caller asks for it.
  const signInUnknown = unknownNotice && view !== null && (status === null || status.kind === "unknown");
  const canSignIn = Boolean(view?.canAct && view.availability === "ok");
  const cliProblem = runtimePickerCliProblem(status);
  const runtimeName = getRuntimeDisplayName(runtimeId);
  // Upgrade where the server offers it to this viewer on this Computer; an outcome stays after the rescan.
  const upgradeOffered = runtimeUpgradeOffered(view, authRuntime);
  const offerUpgrade = upgradeOffered && cliProblem === "version_unsupported";
  const upgradeOutcome = runtimeUpgradeCopy(upgrade.state);
  const showUpgrade = offerUpgrade || (upgradeOffered && upgrade.state.kind !== "idle" && cliProblem !== "not_installed");
  const install = cliProblem ? RUNTIME_INSTALL_COMMANDS[runtimeId] : undefined;
  return (
    <>
      {showUpgrade ? (
        // Raft DS Banner: warning while the CLI is too old or the upgrade did not help, success once it did;
        // its one button is Upgrade (`default`, `md`), shown while the Computer still reports it too old.
        <Banner
          intent={upgradeOutcome?.tone === "success" ? "success" : "warning"}
          density="sm"
          withIcon
          data-testid="runtime-picker-cli-unavailable"
          actions={offerUpgrade ? <RuntimeUpgradeButton state={upgrade.state} onUpgrade={upgrade.start} /> : undefined}
        >
          <div className="stack-y-1 min-w-0">
            {cliProblem === "version_unsupported" ? (
              <p>{formatMessage({ id: "runtime.picker.versionUnsupportedUpgrade" }, { runtime: runtimeName, computer: machineName })}</p>
            ) : null}
            {upgradeOutcome ? (
              <p data-testid="runtime-upgrade-outcome">{formatMessage({ id: upgradeOutcome.id }, { runtime: runtimeName, ...upgradeOutcome.values })}</p>
            ) : null}
          </div>
        </Banner>
      ) : cliProblem ? (
        <Banner intent="warning" density="sm" withIcon data-testid="runtime-picker-cli-unavailable">
          <div className="stack-y-1 min-w-0">
            <p>
              {formatMessage(
                { id: cliProblem === "not_installed" ? "runtime.picker.notInstalled" : "runtime.picker.versionUnsupported" },
                { runtime: runtimeName, computer: machineName },
              )}
            </p>
            {install ? <RackCommand command={install} testId="runtime-picker-install-line" /> : null}
          </div>
        </Banner>
      ) : null}
      {signedOut ? (
        // raft-ui's warning Banner is role="status" (polite): picking a
        // signed-out runtime is announced without interrupting. It leads with
        // the warning's TriangleAlert, as every warning does (Raft DS Banner).
        <Banner
          intent="warning"
          density="sm"
          withIcon
          data-testid="runtime-picker-not-signed-in"
          actions={runtimeSignInOffered(view, authRuntime) ? (
            <Button type="button" size="md" variant="default" onClick={openSignIn}>
              <LogIn size={16} aria-hidden="true" />
              {formatMessage({ id: "machine.runtimeAuth.signInAction" })}
            </Button>
          ) : undefined}
        >
          {formatMessage(
            { id: "runtime.picker.notSignedIn" },
            { runtime: runtimeName, computer: machineName },
          )}
        </Banner>
      ) : signInUnknown ? (
        <Banner
          intent="info"
          density="sm"
          withIcon
          data-testid="runtime-picker-sign-in-unknown"
          actions={canSignIn && view && runtimeAuthComputerSupports(view, authRuntime) ? (
            <Button type="button" size="md" variant="default" onClick={openSignIn}>
              <LogIn size={16} aria-hidden="true" />
              {formatMessage({ id: "machine.runtimeAuth.signInAction" })}
            </Button>
          ) : undefined}
        >
          {formatMessage(
            { id: "runtime.picker.signInUnknown" },
            { runtime: runtimeName, computer: machineName, name: agentName },
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

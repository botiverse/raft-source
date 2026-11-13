// The oldest `raft` CLI Artifacts' agent API accepts while Artifacts is
// dogfooding (docs/development/workspace-artifacts.md#minimum-cli-version):
// a CLI below it is answered 426 CLIENT_UPGRADE_REQUIRED (shared
// agentApiClientUpgrade.ts) with how to upgrade, before the route runs.
// mount.ts sets it as the agent API's client gate; the web and signed-out
// routes never see it.
import {
  AGENT_API_CLIENT_UPGRADE_REQUIRED_CODE,
  AGENT_API_CLIENT_UPGRADE_REQUIRED_STATUS,
  compareComputerVersions,
  isComputerSemver,
  type AgentApiClientUpgradeRequiredBody,
} from "@botiverse/raft-shared";
import type { AppAgentClient, AppClientRefusal } from "../../platform/apps";

/**
 * Raised only when Artifacts' agent API needs something a newer CLI does,
 * and only once more than half of the online Computers run that version
 * (a Computer upgrades when its owner presses Upgrade, so a new stable
 * release alone is no reason: 1.0.59 the day it went stable refused most
 * agents' Artifacts commands, v1.21.42). Never above the CLI the latest
 * stable Raft Computer bundles (since 1.0.55 the CLI shares the Computer's
 * version). Removed, with the gate, when xxchan declares Artifacts
 * officially released.
 */
export const ARTIFACTS_MIN_CLI_VERSION = "1.0.56";

/** What an agent on a too-old CLI does: the machine's owner upgrades a Computer from the web; an npm install upgrades itself. */
export const ARTIFACTS_CLI_UPGRADE_STEPS =
  "On a Raft Computer, ask the machine's owner to click Upgrade on the Computer page in the Raft web app "
  + "(do not run `raft-computer upgrade` yourself); with a CLI installed from npm, run `npm install -g @botiverse/raft@latest`. "
  + "Then run the command again.";

const release = (version: string) => version.split("+", 1)[0]!.split("-", 1)[0]!;

/**
 * The gate: a request that says it is the CLI (`X-Raft-Client: cli`, or the
 * older `X-Slock-Client: cli`) whose version, release part only (so
 * `1.0.56-rc.1` meets a 1.0.56 floor), is below `minVersion` is refused; so
 * is one with no version, since every CLI from 1.0.55 on sends it. Anything
 * else passes: the SDK names itself `sdk` (earlier SDK builds and other
 * clients send no `X-Raft-Client`), and the daemon's own requests name
 * themselves (`daemon`, `daemon-…`).
 *
 * A Computer's agent proxy (packages/daemon/src/agentCredentialProxy.ts) sets
 * `X-Raft-Client: cli` on every request it forwards, CLI or not, and passes
 * the CLI's version through: so anything reaching Artifacts through the proxy
 * counts as the CLI here. A future non-CLI caller through the proxy (an MCP
 * tool, a runtime) must send an `X-Raft-Client-Version` at or above the
 * floor, or the proxy must name it otherwise, or it gets the 426 (Archer,
 * #botiverse-raft-deployment).
 */
export function artifactsCliFloor(client: AppAgentClient, minVersion: string = ARTIFACTS_MIN_CLI_VERSION): AppClientRefusal | null {
  if (client.kind?.toLowerCase() !== "cli") return null;
  const yourVersion = client.version !== null && isComputerSemver(client.version) ? client.version : null;
  if (yourVersion !== null && compareComputerVersions(release(yourVersion), release(minVersion)) >= 0) return null;
  const body: AgentApiClientUpgradeRequiredBody = {
    error: `This raft CLI ${yourVersion === null ? "is too old for Artifacts (it sends no version)" : `(${yourVersion}) is too old for Artifacts`}, `
      + `which needs raft CLI ${minVersion} or newer. ${ARTIFACTS_CLI_UPGRADE_STEPS}`,
    code: AGENT_API_CLIENT_UPGRADE_REQUIRED_CODE,
    minVersion,
    yourVersion,
    suggestedNextAction: ARTIFACTS_CLI_UPGRADE_STEPS,
  };
  return { kind: "error", status: AGENT_API_CLIENT_UPGRADE_REQUIRED_STATUS, body: { ...body } };
}

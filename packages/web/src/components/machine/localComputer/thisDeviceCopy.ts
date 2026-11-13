// The words for This device (thisDeviceLogic.ts): the state as a short
// phrase (the Computers list row, the panel's status line). Never a command:
// this machine is managed with buttons.
import type { IntlShape } from "react-intl";
import type { ThisDeviceFeature, ThisDeviceStateKind } from "./thisDeviceLogic";
import type { MessageId } from "../../../i18n/messages";

type Format = Pick<IntlShape, "formatMessage">;

const STATE_PHRASE: Record<ThisDeviceStateKind, MessageId> = {
  "checking": "computerHost.thisDevice.state.checking",
  "not-installed": "computerHost.thisDevice.state.notInstalled",
  "setting-up": "computerHost.thisDevice.state.settingUp",
  "migrating": "computerHost.thisDevice.state.migrating",
  "migration-failed": "computerHost.thisDevice.state.migrationFailed",
  "update-required": "computerHost.thisDevice.state.updateRequired",
  "updating": "computerHost.thisDevice.state.updating",
  "stopped": "computerHost.thisDevice.state.stopped",
  "running": "computerHost.thisDevice.state.running",
  "unreadable": "computerHost.thisDevice.state.unreadable",
  "duplicate-key": "computerHost.thisDevice.state.cannotStart",
};

/**
 * The state as a short phrase: "Running", "Running · Update required", …
 * Below the minimum it still runs, so that phrase says whether it does.
 */
export function thisDeviceStatePhrase(kind: ThisDeviceStateKind, { formatMessage }: Format, running = false): string {
  if (kind === "update-required") {
    return `${formatMessage({ id: running ? "computerHost.thisDevice.state.running" : "computerHost.thisDevice.state.stopped" })} · ${formatMessage({ id: STATE_PHRASE[kind] })}`;
  }
  return formatMessage({ id: STATE_PHRASE[kind] });
}

/** While the move waits for agents to finish their turns, it says so. */
export function thisDeviceMigratingPhrase(step: string | null, { formatMessage }: Format): string {
  return formatMessage({ id: step === "quiet" ? "computerHost.thisDevice.state.migratingWaitingTurns" : "computerHost.thisDevice.state.migrating" });
}

/**
 * The state in words where a server is named (the list row, the page): while
 * this machine waits for the server to list it, that is what it says (one
 * derived flag, ThisDeviceFlags.awaitingListing); setting up and problems
 * come first.
 */
export function thisDeviceStatusPhrase(
  state: { kind: ThisDeviceStateKind; problem: boolean; flags: { awaitingListing: boolean; serviceRunning?: boolean } },
  deviceKind: "mac" | "other",
  serverName: string,
  intl: Format,
): string {
  if (state.flags.awaitingListing && state.kind !== "setting-up" && !state.problem) {
    return intl.formatMessage({ id: deviceKind === "mac" ? "computerHost.thisDevice.awaitingListingMac" : "computerHost.thisDevice.awaitingListingOther" }, { server: serverName });
  }
  return thisDeviceStatePhrase(state.kind, intl, state.flags.serviceRunning === true);
}

/** The status light for a state: a problem is orange (error), running green, the rest offline. */
export function thisDevicePresence(kind: ThisDeviceStateKind, problem: boolean, awaitingListing = false): "online" | "busy" | "error" | "offline" {
  if (problem) return "error";
  // Not done yet: being added, or waiting for the server to list it, is the
  // pending dot (as Setting Up), never green; green once the server lists it.
  if (awaitingListing) return "busy";
  switch (kind) {
    case "running":
      return "online";
    case "updating":
    case "setting-up":
    case "migrating":
      return "busy";
    default:
      return "offline";
  }
}

const FEATURE_NAME: Record<ThisDeviceFeature, MessageId> = {
  addThisMac: "computerHost.thisDevice.feature.addThisMac",
  diagnostics: "computerHost.thisDevice.feature.diagnostics",
  stopWhenIdle: "computerHost.thisDevice.feature.stopWhenIdle",
};

/** "Add This Mac and Run Diagnostics": the features a Computer update brings, as a list in the UI language. */
export function missingFeaturesText(features: readonly ThisDeviceFeature[], intl: Format & Partial<Pick<IntlShape, "formatList">>): string {
  const names = features.map((feature) => intl.formatMessage({ id: FEATURE_NAME[feature] }));
  return intl.formatList ? intl.formatList(names, { type: "conjunction" }) : names.join(", ");
}

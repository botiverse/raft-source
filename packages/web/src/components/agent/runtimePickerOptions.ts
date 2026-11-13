import type { RuntimeCapabilityStatus } from "@botiverse/raft-shared";
import type { MessageId } from "../../i18n/messages/en";
import type { RuntimeOption } from "./RuntimeConfigFields";

/** One runtime-options row, labelled and with today's selectability already decided. */
export interface RuntimePickerRow {
  value: string;
  /** The runtime's name, without what this computer lacks for it. */
  label: string;
  /** What this computer lacks for it, as text after the name: " (not installed)",
   *  " · Update required". Said wherever the row's group does not say it already. */
  availabilitySuffix?: string;
  /** Drawn with raft-ui's Experimental badge after the name. */
  experimental?: boolean;
  disabled: boolean;
  capabilityStatus: RuntimeCapabilityStatus;
  /** The server lets the person pick it here at all (`canSelectInThisContext`).
   *  Unlike `disabled`, a moment's loading does not clear it. Defaults to `!disabled`. */
  selectable?: boolean;
  /** The agent's current runtime (the switch picker): pinned first, in its own group. */
  current?: boolean;
}

type FormatMessage = (descriptor: { id: MessageId }, values?: Record<string, string>) => string;

/**
 * Groups a runtime picker by "can it run on this computer right now", from the
 * server's runtime-options rows alone: the current runtime first (switching),
 * then Ready on this computer, then Needs a Raft Computer update, then — only when the
 * person asked for all supported runtimes — Not installed on this computer.
 * Grouping never changes whether a row can be picked; `disabled` is kept as is.
 * A runtime this computer has but the server does not let the person pick here
 * (rollout or admission) is not "Ready", and is not listed: only as the field's
 * current value does it show, under "Not available on this server".
 * Inside Needs a Raft Computer update and Not installed the group heading
 * already says what the row's availability suffix would, so the rows there go
 * without it in the list; anywhere else (the current runtime, say) they keep
 * it. The closed field always keeps it: it shows no heading.
 *
 * `canToggle` says whether a Show All Supported toggle has anything to show.
 * When nothing else is listed, not-installed rows show without asking: an
 * empty list would explain nothing.
 * `selectedValue` stays listed even when it would be hidden, so the field never
 * shows a value its list does not have (a runtime uninstalled after it was picked).
 */
export function groupRuntimePickerRows(
  rows: readonly RuntimePickerRow[],
  input: { showAll: boolean; selectedValue: string; formatMessage: FormatMessage },
): { options: RuntimeOption[]; canToggle: boolean } {
  const { selectedValue, formatMessage } = input;
  // Over the rows the list can show: one this server doesn't offer is not listed (below), so it doesn't count.
  const unoffered = (row: RuntimePickerRow) => row.capabilityStatus === "available" && !(row.selectable ?? !row.disabled) && row.value !== selectedValue;
  const onlyNotInstalled = rows.every((row) => unoffered(row) || (!row.current && row.capabilityStatus === "not_installed"));
  const showAll = input.showAll || onlyNotInstalled;
  const current: RuntimeOption[] = [];
  const ready: RuntimeOption[] = [];
  const notAvailable: RuntimeOption[] = [];
  const needsUpdate: RuntimeOption[] = [];
  const notInstalled: RuntimeOption[] = [];
  let notInstalledCount = 0;
  const groupLabels = {
    current: formatMessage({ id: "runtime.picker.group.current" }),
    ready: formatMessage({ id: "runtime.picker.group.ready" }),
    notAvailable: formatMessage({ id: "runtime.picker.group.notAvailable" }),
    needsUpdate: formatMessage({ id: "runtime.picker.group.needsComputerUpdate" }),
    notInstalled: formatMessage({ id: "runtime.picker.group.notInstalled" }),
  };
  for (const row of rows) {
    const option: RuntimeOption = {
      value: row.value,
      label: row.label,
      disabled: row.disabled,
      ...(row.experimental ? { experimental: true } : {}),
      ...(row.availabilitySuffix ? { availabilitySuffix: row.availabilitySuffix } : {}),
    };
    // The heading says it in the list; the closed field still does.
    const bare: RuntimeOption = { ...option, availabilitySuffixInList: false };
    if (row.current) {
      current.push({ ...option, group: groupLabels.current });
    } else if (row.capabilityStatus === "available" && !(row.selectable ?? !row.disabled)) {
      // Not offered here (rollout or admission): nothing to do about it, so not listed,
      // unless it is the field's value.
      if (row.value === selectedValue) notAvailable.push({ ...option, group: groupLabels.notAvailable });
    } else if (row.capabilityStatus === "available" || !row.disabled) {
      // A row the person can pick runs here by definition: never hide it.
      ready.push({ ...option, group: groupLabels.ready });
    } else if (row.capabilityStatus === "update_required") {
      needsUpdate.push({ ...bare, group: groupLabels.needsUpdate });
    } else {
      notInstalledCount += 1;
      if (showAll || row.value === selectedValue) notInstalled.push({ ...bare, group: groupLabels.notInstalled });
    }
  }
  return { options: [...current, ...ready, ...notAvailable, ...needsUpdate, ...notInstalled], canToggle: notInstalledCount > 0 && !onlyNotInstalled };
}

/** Every row in one flat list, each saying what this computer lacks for it
 *  (onboarding's runtime list has no groups to say it). */
export function flatRuntimePickerOptions(rows: readonly RuntimePickerRow[]): RuntimeOption[] {
  return rows.map((row) => ({
    value: row.value,
    label: row.label,
    disabled: row.disabled,
    ...(row.experimental ? { experimental: true } : {}),
    ...(row.availabilitySuffix ? { availabilitySuffix: row.availabilitySuffix } : {}),
  }));
}

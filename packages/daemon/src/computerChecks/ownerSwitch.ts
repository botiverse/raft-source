// The machine owner's local off switch, `<RAFT_HOME>/computer/checks.json`:
// `{ "disabled": "all" }` or `{ "disabled": ["aws", "gcloud"] }`. It wins over
// whatever the server enables. `raft-computer checks off` will write it.
//
// It guards against the server, not against agents on this computer: an agent
// running as the same user can edit or delete it. So every change of the
// switch is recorded (`checks-switch-seen.json` beside it) and reported, and
// the owner sees "switched off ..., back on at T" rather than nothing.
import path from "node:path";
import { logger } from "../logger";
import { writeJsonAtomic } from "./atomicFile";
import { readRegularFile } from "./declaredFile";
import { COMPUTER_CHECK_IDS, isComputerCheckId, type ComputerCheckId, type OwnerSwitchDisabled, type OwnerSwitchReport } from "./types";

export type OwnerChecksSwitch = { disabled: "all" | ReadonlySet<ComputerCheckId> };

export const OWNER_CHECKS_FILE = path.join("computer", "checks.json");
/** The switch as last seen, and when it last changed. Written by the daemon only. */
export const OWNER_SWITCH_SEEN_FILE = path.join("computer", "checks-switch-seen.json");
/** A switch file is a few dozen bytes; anything bigger is not one. */
export const OWNER_SWITCH_MAX_BYTES = 4 * 1024;

export function isDisabledByOwner(owner: OwnerChecksSwitch, id: ComputerCheckId): boolean {
  return owner.disabled === "all" || owner.disabled.has(id);
}

function parseDisabled(text: string): OwnerSwitchDisabled | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    const disabled = typeof parsed === "object" && parsed !== null && "disabled" in parsed ? parsed.disabled : undefined;
    if (disabled === "all") return "all";
    // Unknown ids (a check a newer release added) are ignored, not fatal.
    if (Array.isArray(disabled) && disabled.every((id) => typeof id === "string")) {
      return COMPUTER_CHECK_IDS.filter((id) => disabled.includes(id));
    }
  } catch {
    // Falls through: the parse error is not logged.
  }
  return undefined;
}

/**
 * Missing file: nothing disabled. A file that exists but cannot be read or
 * understood disables everything: the owner wrote it to turn something off.
 * That includes anything that is not a small regular file (a FIFO, a device,
 * a directory, over 4 KB): those are never waited on, only refused.
 */
export async function readOwnerChecksSwitch(raftHome: string): Promise<OwnerChecksSwitch> {
  const read = await readRegularFile(path.join(raftHome, OWNER_CHECKS_FILE), OWNER_SWITCH_MAX_BYTES);
  if ("unavailable" in read) {
    if (read.unavailable === "missing") return { disabled: new Set() };
    logger.warn("[computer-checks] owner switch unreadable; all checks off");
    return { disabled: "all" };
  }
  const disabled = parseDisabled(read.text);
  if (disabled === undefined) {
    logger.warn("[computer-checks] owner switch not understood; all checks off");
    return { disabled: "all" };
  }
  return { disabled: disabled === "all" ? "all" : new Set(disabled.filter(isComputerCheckId)) };
}

function disabledOf(owner: OwnerChecksSwitch): OwnerSwitchDisabled {
  return owner.disabled === "all" ? "all" : COMPUTER_CHECK_IDS.filter((id) => (owner.disabled as ReadonlySet<ComputerCheckId>).has(id));
}

function sameDisabled(a: OwnerSwitchDisabled, b: OwnerSwitchDisabled): boolean {
  return a === "all" || b === "all" ? a === b : a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * Compares `owner` (as just read) with the state recorded last round and
 * records it when it changed. The report carries the current state and, once
 * any change has been seen, the previous state and when the change was
 * noticed (the first round that saw it, not the file's own time). A missing
 * or unreadable record is a first sighting: no change is claimed. If the
 * record cannot be written the change is still reported this round.
 */
export async function observeOwnerChecksSwitch(raftHome: string, owner: OwnerChecksSwitch, now: () => number = Date.now): Promise<OwnerSwitchReport> {
  const disabled = disabledOf(owner);
  const seenPath = path.join(raftHome, OWNER_SWITCH_SEEN_FILE);
  let last: OwnerSwitchReport | undefined;
  const read = await readRegularFile(seenPath, OWNER_SWITCH_MAX_BYTES);
  if ("text" in read) {
    try {
      const parsed = JSON.parse(read.text) as { disabled?: unknown; previous?: unknown; changedAt?: unknown };
      const lastDisabled = parseDisabled(JSON.stringify({ disabled: parsed.disabled }));
      const previous = parseDisabled(JSON.stringify({ disabled: parsed.previous }));
      const changedAt = typeof parsed.changedAt === "string" && !Number.isNaN(Date.parse(parsed.changedAt)) ? new Date(parsed.changedAt).toISOString() : undefined;
      if (lastDisabled !== undefined) {
        last = { disabled: lastDisabled, ...(previous !== undefined && changedAt ? { previous, changedAt } : {}) };
      }
    } catch {
      // A corrupt record is a first sighting.
    }
  }
  if (last && sameDisabled(last.disabled, disabled)) return last;
  const next: OwnerSwitchReport = last
    ? { disabled, previous: last.disabled, changedAt: new Date(now()).toISOString() }
    : { disabled };
  try {
    // Exclusive, unpredictable temp file: a symlink planted beside it is never written through.
    await writeJsonAtomic(seenPath, next);
  } catch {
    logger.warn("[computer-checks] could not record the owner switch state");
  }
  return next;
}

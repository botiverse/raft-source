// Backfill the linked `machines.id` into a per-server attachment that lacks it.
//
// Files written by the old machine-key adoption path, and session attaches
// from before the server returned it, carry no `machineId`. Raft Desktop
// matches "this Mac" by `status --json` `servers[].machineId`, so such a file
// leaves the Mac unrecognised until something fills it in. The server already
// knows it: GET /internal/computer/self answers with this key's computer and
// its machine. Best-effort only: any failure leaves the file as it is.
import { ComputerSelfClient, type ComputerSelfResult } from "./apiClient";
import { readServerAttachment, writeServerAttachment, type ServerAttachment } from "./serverState";

export type MachineIdBackfillOutcome =
  | { status: "present" }
  | { status: "skipped"; reason: "legacy_key" }
  | { status: "backfilled"; machineId: string }
  | { status: "mismatch"; computerId: string }
  | { status: "unavailable"; code: string };

export type ReadComputerSelf = (attachment: ServerAttachment) => Promise<ComputerSelfResult>;

const defaultReadComputerSelf: ReadComputerSelf = (attachment) =>
  new ComputerSelfClient(attachment.serverUrl, attachment.apiKey).self({ signal: AbortSignal.timeout(15_000) });

/** The self route answers only `sk_computer_*` keys; older files may hold a legacy machine key. */
export function canReadComputerSelf(attachment: ServerAttachment): boolean {
  return attachment.apiKey.startsWith("sk_computer_");
}

/**
 * Write the self answer's machine id into the attachment file when it is
 * missing and the answer is about this file's computer (`computerId` equals
 * `serverMachineId`). Re-reads the file first so a concurrent re-attach or key
 * rotation is never overwritten with stale fields. Returns the attachment to
 * use from here on (unchanged unless backfilled).
 */
export async function applySelfMachineId(
  slockHome: string,
  attachment: ServerAttachment,
  self: ComputerSelfResult,
): Promise<{ attachment: ServerAttachment; outcome: MachineIdBackfillOutcome }> {
  if (attachment.machineId) return { attachment, outcome: { status: "present" } };
  if (self.status !== "success") {
    return { attachment, outcome: { status: "unavailable", code: self.status === "route_unavailable" ? "route_unavailable" : self.code } };
  }
  if (self.computer.computerId !== attachment.serverMachineId || !self.computer.machineId) {
    return { attachment, outcome: { status: "mismatch", computerId: self.computer.computerId } };
  }
  const current = await readServerAttachment(slockHome, attachment.serverId);
  if (
    !current ||
    current.machineId ||
    current.serverMachineId !== attachment.serverMachineId ||
    current.apiKey !== attachment.apiKey
  ) {
    return { attachment, outcome: { status: "unavailable", code: "attachment_changed" } };
  }
  const updated: ServerAttachment = { ...current, machineId: self.computer.machineId };
  await writeServerAttachment(slockHome, updated);
  return { attachment: updated, outcome: { status: "backfilled", machineId: self.computer.machineId } };
}

/** Ask the server (by the attachment's own key) and backfill. Never throws. */
export async function backfillAttachmentMachineId(
  slockHome: string,
  attachment: ServerAttachment,
  readSelf: ReadComputerSelf = defaultReadComputerSelf,
): Promise<{ attachment: ServerAttachment; outcome: MachineIdBackfillOutcome }> {
  if (attachment.machineId) return { attachment, outcome: { status: "present" } };
  if (!canReadComputerSelf(attachment)) return { attachment, outcome: { status: "skipped", reason: "legacy_key" } };
  try {
    return await applySelfMachineId(slockHome, attachment, await readSelf(attachment));
  } catch (err) {
    return { attachment, outcome: { status: "unavailable", code: err instanceof Error ? err.message : String(err) } };
  }
}

export function describeMachineIdBackfill(serverId: string, outcome: MachineIdBackfillOutcome): string | null {
  switch (outcome.status) {
    case "present":
    case "skipped":
      return null;
    case "backfilled":
      return `raft-computer: recorded machine id ${outcome.machineId} for server ${serverId}.\n`;
    case "mismatch":
      return `raft-computer: machine id backfill skipped for server ${serverId}: the server answered for computer ${outcome.computerId}, not this attachment's.\n`;
    case "unavailable":
      return `raft-computer: machine id backfill skipped for server ${serverId} (${outcome.code}); will retry on the next start.\n`;
  }
}

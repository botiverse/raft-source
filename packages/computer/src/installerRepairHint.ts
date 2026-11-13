// Advisory hint that this Computer's installer state looks like it needs a
// repair run by hand (#proj-raft-computer task #34). The web then recommends
// the install command next to Upgrade; it never blocks a web upgrade. Read from
// the installer's own state under the Raft home (installer rust/operation.rs,
// rust/report.rs, rust/supervisor.rs); cheap file reads only, no process is
// spawned. Sent in `ready` and re-read by the runner while connected.
//
// What is known: the installer's supervisor reruns its worker with the SAME
// request id (recovery only), and the rerun goes on to a repair, so one
// request, a web upgrade included, can recover an operation an earlier run left
// behind. Yet machines in production keep failing web upgrades with "An
// earlier installation could not be recovered" for reasons not pinned down
// yet, and running the install command on the machine is the known working fix.
//
// unrecovered_operation: `installer/active.json` names an operation whose plan
// the installer can read, with no terminal receipt, and the installer already
// failed to recover it: that operation's receipt is `unresolved`, or (no
// receipt yet) its `metadata-damage.json` marker exists. Conservative on
// purpose:
//   - an unreadable pointer, plan or receipt is not reported: the installer
//     treats it as damage and goes straight to a repair;
//   - an operation with no receipt and no marker may be running now;
//   - a repair with no receipt yet is taken to be in progress (it may also
//     have died; the next read after its receipt tells).
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ComputerInstallerRepairHint } from "@botiverse/raft-shared";
import { computerDir } from "./paths";

/** The installer reads at most 1 MiB of a record (rust/operation.rs `json`). */
const MAX_RECORD_BYTES = 1024 * 1024;

type Read = { state: "absent" } | { state: "unreadable" } | { state: "read"; value: Record<string, unknown> };

async function readRecord(path: string): Promise<Read> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? { state: "absent" } : { state: "unreadable" };
  }
  try {
    const value: unknown = raw.length > MAX_RECORD_BYTES ? null : JSON.parse(raw);
    return typeof value === "object" && value !== null ? { state: "read", value: value as Record<string, unknown> } : { state: "unreadable" };
  } catch {
    return { state: "unreadable" };
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function readInstallerRepairHint(slockHome: string): Promise<ComputerInstallerRepairHint | null> {
  const installerDir = join(computerDir(slockHome), "installer");
  const active = await readRecord(join(installerDir, "active.json"));
  if (active.state !== "read" || active.value.formatVersion !== 1) return null;
  const id = active.value.id;
  if (typeof id !== "string" || id === "") return null;
  const key = createHash("sha256").update(id).digest("hex");
  const plan = await readRecord(join(installerDir, "operations", key, "plan.json"));
  const request = plan.state === "read" ? plan.value.request as { id?: unknown } | undefined : undefined;
  if (plan.state !== "read" || request?.id !== id) return null;
  const receipt = await readRecord(join(installerDir, "receipts", `${key}.json`));
  if (receipt.state === "unreadable") return null;
  if (receipt.state === "read") {
    if (receipt.value.id !== id) return null;
    // A terminal receipt settles the operation; the installer drops the pointer.
    return receipt.value.outcome === "unresolved" ? { reason: "unrecovered_operation" } : null;
  }
  if (plan.value.kind === "repair") return null;
  return await exists(join(installerDir, "metadata-damage.json")) ? { reason: "unrecovered_operation" } : null;
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInstallerRepairHint } from "./installerRepairHint";

// Layout and formats as the installer writes them (installer rust/operation.rs,
// rust/report.rs): <home>/computer/installer/{active.json, metadata-damage.json,
// operations/<sha256(id)>/plan.json, receipts/<sha256(id)>.json}.
const key = (id: string) => createHash("sha256").update(id).digest("hex");

async function withHome(run: (installer: string, root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "raft-installer-repair-hint-"));
  const installer = join(root, "computer", "installer");
  mkdirSync(join(installer, "receipts"), { recursive: true });
  try {
    await run(installer, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The pointer and its plan, as the installer publishes an operation. */
function writeOperation(installer: string, id: string, kind = "upgrade"): void {
  writeFileSync(join(installer, "active.json"), JSON.stringify({ formatVersion: 1, id }));
  mkdirSync(join(installer, "operations", key(id)), { recursive: true });
  writeFileSync(join(installer, "operations", key(id), "plan.json"), JSON.stringify({ formatVersion: 1, request: { id }, kind, phase: "upgrading" }));
}

function writeReceipt(installer: string, id: string, outcome: string): void {
  writeFileSync(join(installer, "receipts", `${key(id)}.json`), JSON.stringify({ protocol: "raft-computer-installer/v3", id, operation: "upgrade", outcome }));
}

function writeDamage(installer: string): void {
  writeFileSync(join(installer, "metadata-damage.json"), JSON.stringify({ formatVersion: 1, requiresRepair: true }));
}

const HINT = { reason: "unrecovered_operation" };

test("no installer state: no hint", () => withHome(async (_installer, root) => {
  assert.equal(await readInstallerRepairHint(root), null);
}));

test("an operation the installer already marked damaged, with no receipt: hint", () => withHome(async (installer, root) => {
  writeOperation(installer, "req-a");
  writeDamage(installer);
  assert.deepEqual(await readInstallerRepairHint(root), HINT);
}));

test("an operation whose receipt is unresolved: hint, also after a failed repair", () => withHome(async (installer, root) => {
  writeOperation(installer, "req-a", "repair");
  writeReceipt(installer, "req-a", "unresolved");
  assert.deepEqual(await readInstallerRepairHint(root), HINT);
}));

test("an operation with no receipt and no damage mark may be running now: no hint", () => withHome(async (installer, root) => {
  writeOperation(installer, "req-a");
  assert.equal(await readInstallerRepairHint(root), null);
}));

test("a repair with no receipt yet is in progress: no hint, even with the damage mark", () => withHome(async (installer, root) => {
  writeOperation(installer, "req-r", "repair");
  writeDamage(installer);
  assert.equal(await readInstallerRepairHint(root), null);
}));

test("a settled operation (terminal receipt) gives no hint even with the damage mark left behind", () => withHome(async (installer, root) => {
  writeOperation(installer, "req-a");
  writeReceipt(installer, "req-a", "promoted");
  writeDamage(installer);
  assert.equal(await readInstallerRepairHint(root), null);
}));

test("the damage mark alone (no operation to resume) leaves the next upgrade to repair: no hint", () => withHome(async (installer, root) => {
  writeDamage(installer);
  assert.equal(await readInstallerRepairHint(root), null);
}));

test("an unreadable pointer, plan or receipt is not reported: the installer repairs it directly", () => withHome(async (installer, root) => {
  writeDamage(installer);
  writeFileSync(join(installer, "active.json"), "{not json");
  assert.equal(await readInstallerRepairHint(root), null, "pointer");
  writeFileSync(join(installer, "active.json"), JSON.stringify({ formatVersion: 2, id: "req-a" }));
  assert.equal(await readInstallerRepairHint(root), null, "pointer format");
  writeFileSync(join(installer, "active.json"), JSON.stringify({ formatVersion: 1, id: "req-a" }));
  assert.equal(await readInstallerRepairHint(root), null, "no plan");
  writeOperation(installer, "req-a");
  writeFileSync(join(installer, "operations", key("req-a"), "plan.json"), "{torn");
  assert.equal(await readInstallerRepairHint(root), null, "plan");
  writeOperation(installer, "req-a");
  writeFileSync(join(installer, "receipts", `${key("req-a")}.json`), "{torn");
  assert.equal(await readInstallerRepairHint(root), null, "receipt");
}));

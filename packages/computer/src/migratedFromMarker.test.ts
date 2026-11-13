import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acknowledgeMigratedFrom, readMigratedFromForServer } from "./migratedFromMarker";
import { writeServerAttachment } from "./serverState";

// Raft Desktop's one-shot `computer/migrated-from.json` (`{"from":"electron"}`)
// becomes `ready.migratedFrom` once per attached server, then is deleted.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "raft-migrated-from-"));
  try {
    for (const serverId of [A, B]) {
      await writeServerAttachment(home, { kind: "computer-attachment", serverId, serverMachineId: `m-${serverId}`, apiKey: "sk_machine_x", serverUrl: "https://raft.example" });
    }
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const note = (home: string) => join(home, "computer", "migrated-from.json");
const exists = (file: string) => stat(file).then(() => true, () => false);

test("each attached server's first ready gets it once; the note goes when the last one had it, with every per-server record", () => withHome(async (home) => {
  await writeFile(note(home), JSON.stringify({ from: "electron" }));
  assert.equal(await readMigratedFromForServer(home, A), "electron");
  assert.equal(await readMigratedFromForServer(home, B), "electron");
  await acknowledgeMigratedFrom(home, A);
  assert.equal(await readMigratedFromForServer(home, A), null, "A had it: never again");
  assert.equal(await readMigratedFromForServer(home, B), "electron", "B has not yet");
  assert.equal(await exists(note(home)), true, "kept for B");
  await acknowledgeMigratedFrom(home, B);
  assert.equal(await exists(note(home)), false, "deleted once every attached server had it");
  for (const serverId of [A, B]) {
    assert.deepEqual((await readdir(join(home, "computer", "servers", serverId))).filter((f) => f.startsWith("migrated-from")), []);
    assert.equal(await readMigratedFromForServer(home, serverId), null);
  }
}));

test("no note, an unreadable one, or one naming anything else: nothing is reported (and Desktop's file is left alone)", () => withHome(async (home) => {
  assert.equal(await readMigratedFromForServer(home, A), null);
  await mkdir(join(home, "computer"), { recursive: true });
  for (const body of ["{", JSON.stringify({ from: "npm" }), JSON.stringify({ from: "/Applications/Raft.app" }), "null"]) {
    await writeFile(note(home), body);
    assert.equal(await readMigratedFromForServer(home, A), null, body);
    assert.equal(await exists(note(home)), true);
  }
}));

test("a runner that already sent it, reading while another runner cleans up, never reports it again", () => withHome(async (home) => {
  await writeFile(note(home), JSON.stringify({ from: "electron" }));
  await acknowledgeMigratedFrom(home, A);
  // B's ready went out; its cleanup (note, then records) runs between A's two reads.
  await writeFile(join(home, "computer", "servers", B, "migrated-from.sent"), "");
  assert.equal(await readMigratedFromForServer(home, A, () => acknowledgeMigratedFrom(home, B)), null);
  assert.equal(await exists(note(home)), false);
  assert.equal(await readMigratedFromForServer(home, A), null);
  assert.equal(await readMigratedFromForServer(home, B), null);
}));

test("a runner that has not sent it yet still gets it while the note is there", () => withHome(async (home) => {
  await writeFile(note(home), JSON.stringify({ from: "electron" }));
  assert.equal(await readMigratedFromForServer(home, B, async () => { await acknowledgeMigratedFrom(home, A); }), "electron", "A's ack alone does not delete it: B has not had it");
}));

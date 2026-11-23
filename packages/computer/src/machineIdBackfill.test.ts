// A Computer attached through the old machine-key adoption path (or a pre-#99
// session attach) has no `machineId` in runner.state.json, so `status --json`
// reports `servers[].machineId: null` and Raft Desktop never recognises
// "this Mac". The runner fills it in once per start from its own key's
// GET /internal/computer/self, only when the answer is about this file's
// computer.
//
// RED proof: drop the backfill call in runResident and the "start" tests see
// no machineId written.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComputerSelfResult } from "./apiClient";
import { serverAttachmentPath } from "./paths";
import { readServerAttachment, writeServerAttachment, type ServerAttachment } from "./serverState";
import { runResident, type ResidentCore } from "./service";

const SERVER = "11111111-1111-4111-8111-111111111111";
const COMPUTER = "cm-1";
const MACHINE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const ADOPTED: ServerAttachment = {
  kind: "computer-attachment",
  serverId: SERVER,
  serverSlug: "alpha",
  serverMachineId: COMPUTER,
  apiKey: "sk_computer_test",
  serverUrl: "http://127.0.0.1:1",
  attachedAt: "2026-05-20T00:00:00.000Z",
  adoptedFromLegacy: true,
  legacyMachineId: MACHINE,
  legacyApiKeyFingerprint: "1234567890abcdef",
};

function selfAnswer(computerId: string, machineId: string): ComputerSelfResult {
  return {
    status: "success",
    computer: { computerId, computerName: "laptop", serverId: SERVER, machineId, machineName: "laptop", agentCount: 0 },
  };
}

async function withRunnerHome(
  attachment: ServerAttachment,
  readComputerSelf: (a: ServerAttachment) => Promise<ComputerSelfResult>,
  fn: (h: { home: string; started: () => boolean; before: string }) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "raft-machineid-backfill-"));
  const oldRaft = process.env.RAFT_HOME;
  const oldSlock = process.env.SLOCK_HOME;
  process.env.RAFT_HOME = home;
  process.env.SLOCK_HOME = home;
  const sigterm = process.listeners("SIGTERM");
  const sigint = process.listeners("SIGINT");
  const stderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    await writeServerAttachment(home, attachment);
    const before = await readFile(serverAttachmentPath(home, SERVER), "utf8");
    let started = false;
    const core: ResidentCore = {
      start: () => { started = true; },
      stop: async () => {},
      getRunningAgentIds: () => [],
      recordMachineKeyRevokedStop: () => {},
    };
    await runResident(SERVER, { coreFactory: () => core, exit: () => {}, readComputerSelf });
    await fn({ home, started: () => started, before });
  } finally {
    process.stderr.write = stderrWrite;
    for (const l of process.listeners("SIGTERM")) if (!sigterm.includes(l)) process.off("SIGTERM", l);
    for (const l of process.listeners("SIGINT")) if (!sigint.includes(l)) process.off("SIGINT", l);
    if (oldRaft === undefined) delete process.env.RAFT_HOME; else process.env.RAFT_HOME = oldRaft;
    if (oldSlock === undefined) delete process.env.SLOCK_HOME; else process.env.SLOCK_HOME = oldSlock;
    await rm(home, { recursive: true, force: true });
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test("start: a file without machineId gains it when the self answer is about this computer; nothing else changes", async () => {
  let calls = 0;
  await withRunnerHome(ADOPTED, async () => { calls += 1; return selfAnswer(COMPUTER, MACHINE); }, async ({ home, started, before }) => {
    assert.equal(started(), true);
    await vi.waitFor(async () => assert.equal((await readServerAttachment(home, SERVER))?.machineId, MACHINE));
    const after = JSON.parse(await readFile(serverAttachmentPath(home, SERVER), "utf8")) as Record<string, unknown>;
    const { machineId, ...rest } = after;
    assert.equal(machineId, MACHINE);
    assert.deepEqual(rest, JSON.parse(before));
    if (process.platform !== "win32") {
      assert.equal((await stat(serverAttachmentPath(home, SERVER))).mode & 0o777, 0o600);
    }
    assert.equal(calls, 1);
  });
});

test("start: a self answer for another computer leaves the file unchanged", async () => {
  await withRunnerHome(ADOPTED, async () => selfAnswer("cm-other", MACHINE), async ({ home, started, before }) => {
    assert.equal(started(), true);
    await settle();
    assert.equal(await readFile(serverAttachmentPath(home, SERVER), "utf8"), before);
  });
});

test("start: a failing self call leaves the file unchanged and the runner still starts", async () => {
  for (const readSelf of [
    async (): Promise<ComputerSelfResult> => { throw new Error("ECONNREFUSED"); },
    async (): Promise<ComputerSelfResult> => ({ status: "error", code: "request_failed" }),
    async (): Promise<ComputerSelfResult> => ({ status: "route_unavailable" }),
  ]) {
    await withRunnerHome(ADOPTED, readSelf, async ({ home, started, before }) => {
      assert.equal(started(), true);
      await settle();
      assert.equal(await readFile(serverAttachmentPath(home, SERVER), "utf8"), before);
    });
  }
});

test("start: a file that already has machineId is not asked", async () => {
  let calls = 0;
  await withRunnerHome({ ...ADOPTED, machineId: MACHINE }, async () => { calls += 1; return selfAnswer(COMPUTER, "other"); }, async ({ home, started, before }) => {
    assert.equal(started(), true);
    await settle();
    assert.equal(calls, 0);
    assert.equal(await readFile(serverAttachmentPath(home, SERVER), "utf8"), before);
  });
});

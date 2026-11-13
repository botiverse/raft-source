import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { vi } from "vitest";

import { servicePidPath, serviceVersionPath } from "../paths";
import { stop } from "../services/stop";
import { findLiveServicePid, findLiveServicePidReadOnly } from "./service-pid-fallback";

// Which start read a caller gets when it passes none. For a command that acts
// on the answer, "unknown" means the old behaviour (stop signals the pid), and
// PowerShell with CIM on a cold Windows machine can take longer than 5 s.
const reads = vi.hoisted(() => ({ display: [] as number[], beforeActing: [] as number[] }));

vi.mock("./process-primitives", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./process-primitives")>()),
  readProcessStartTimeMs: async (pid: number) => { reads.display.push(pid); return undefined; },
  readProcessStartTimeMsBeforeActing: async (pid: number) => { reads.beforeActing.push(pid); return undefined; },
}));

test("status reads a recorded service pid's start with the short read; stop and start (the read-write walk) with the long one", async () => {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-read-defaults-"));
  try {
    await mkdir(dirname(servicePidPath(home)), { recursive: true });
    await writeFile(servicePidPath(home), "7720");
    await writeFile(serviceVersionPath(home), JSON.stringify({ version: "1.22.0", installRoot: "/raft", pid: 7720, writtenAt: "2026-11-13T08:00:00.000Z" }));
    const live = { isProcessAlive: (pid: number) => pid === 7720, endpointAnswers: async () => false };

    await findLiveServicePidReadOnly(home, live);
    assert.deepEqual(reads, { display: [7720], beforeActing: [] });

    await findLiveServicePid(home, live);
    assert.deepEqual(reads, { display: [7720], beforeActing: [7720] });

    let alive = true;
    await stop({ slockHome: home }, {
      isProcessAlive: (pid) => pid === 7720 && alive,
      probeLiveServicePid: async () => null,
      killService: () => { alive = false; },
      sleep: async () => undefined,
      inspectSupervisor: async () => null,
    });
    assert.deepEqual(reads, { display: [7720], beforeActing: [7720, 7720] });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

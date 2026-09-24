import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";

import { servicePidPath, serviceVersionPath } from "../paths.js";
import { publishServiceIdentityAfterIpcBind } from "./serviceIdentity.js";

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "raft-service-identity-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("publishServiceIdentityAfterIpcBind publishes pid then version after ownership", async () => {
  await withHome(async (home) => {
    const calls: string[] = [];
    const ipc = { close: async () => {} };

    const result = await publishServiceIdentityAfterIpcBind(
      home,
      async () => {
        calls.push("bind");
        return ipc;
      },
      {
        pid: 4242,
        writePidfileAtFn: async (path, pid) => {
          calls.push(`pid:${path}:${pid}`);
        },
        writeServiceVersionEvidenceFn: async (slockHome) => {
          calls.push(`version:${slockHome}`);
        },
      },
    );

    assert.equal(result, ipc);
    assert.deepEqual(calls, [
      "bind",
      `pid:${servicePidPath(home)}:4242`,
      `version:${home}`,
    ]);
  });
});

test("publishServiceIdentityAfterIpcBind preserves incumbent bytes when ownership is lost", async () => {
  await withHome(async (home) => {
    const pidPath = servicePidPath(home);
    const versionPath = serviceVersionPath(home);
    const incumbentPid = Buffer.from("31337\n");
    const incumbentVersion = Buffer.from('{"pid":31337,"version":"1.0.2"}\n');
    await mkdir(dirname(pidPath), { recursive: true });
    await writeFile(pidPath, incumbentPid);
    await writeFile(versionPath, incumbentVersion);

    await assert.rejects(
      publishServiceIdentityAfterIpcBind(home, async () => {
        throw Object.assign(new Error("service endpoint already owned"), { code: "EADDRINUSE" });
      }),
      { code: "EADDRINUSE" },
    );

    assert.deepEqual(await readFile(pidPath), incumbentPid);
    assert.deepEqual(await readFile(versionPath), incumbentVersion);
  });
});

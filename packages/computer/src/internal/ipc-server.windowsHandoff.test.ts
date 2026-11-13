// Service self-restart handoff over the REAL transport (task #924). Runs on
// every platform and is listed in the Windows contract job: a Windows named
// pipe stays bound while any connection to it is open, so a handoff that only
// stops accepting cannot let the replacement (or the incumbent, on rollback)
// bind again. POSIX unlinks the socket path instead, which is why the
// original handoff test never caught this on Linux/macOS.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectService } from "../lib/ipc-client";
import { ServiceClientError } from "../lib/types";
import { createIpcServer, type RequestHandlerMap } from "./ipc-server";

const RESET_RESULT = { status: "ok", previousState: "running", clearedCrashCount: 0 } as const;

function heldHandlers(): {
  handlers: RequestHandlerMap;
  entered: Promise<void>;
  release: () => void;
} {
  let release!: () => void;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  return {
    handlers: {
      "reset-service": async () => {
        markEntered();
        await held;
        return RESET_RESULT;
      },
    },
    entered,
    release,
  };
}

async function withInstallRoot(fn: (installRoot: string) => Promise<void>): Promise<void> {
  const installRoot = await mkdtemp(join(tmpdir(), "slock-ipc-win-handoff-"));
  try {
    await fn(installRoot);
  } finally {
    await rm(installRoot, { recursive: true, force: true });
  }
}

test("ipc-server handoff — a replacement binds while clients are connected to the incumbent", async () => {
  await withInstallRoot(async (installRoot) => {
    const held = heldHandlers();
    const incumbent = createIpcServer({ installRoot, handlers: held.handlers });
    const replacement = createIpcServer({
      installRoot,
      handlers: { "reset-service": async () => ({ ...RESET_RESULT, clearedCrashCount: 2 }) },
    });
    await incumbent.listen();
    // The restart requester and an unrelated idle client (a runner's or the
    // desktop app's connection) both hold the endpoint at release time.
    const requester = await connectService(installRoot);
    const idle = await connectService(installRoot);
    try {
      const inFlight = requester.request("reset-service", undefined);
      inFlight.catch(() => undefined);
      await held.entered;

      await incumbent.releaseListener();
      await replacement.listen();

      const next = await connectService(installRoot);
      try {
        assert.equal((await next.request("reset-service", undefined)).clearedCrashCount, 2);
      } finally {
        await next.close();
      }

      held.release();
      if (process.platform === "win32") {
        // The pipe could only be freed by closing the requester's connection,
        // so the requester learns the outcome some other way.
        await assert.rejects(inFlight, (error: unknown) =>
          error instanceof ServiceClientError && error.code === "IPC_CLIENT_CLOSED");
      } else {
        assert.deepEqual(await inFlight, RESET_RESULT);
      }
    } finally {
      await requester.close();
      await idle.close();
      await incumbent.close();
      await replacement.close();
    }
  });
});

test("ipc-server handoff — the incumbent re-binds after a failed takeover while clients were connected", async () => {
  await withInstallRoot(async (installRoot) => {
    const held = heldHandlers();
    const incumbent = createIpcServer({ installRoot, handlers: held.handlers });
    await incumbent.listen();
    const requester = await connectService(installRoot);
    const idle = await connectService(installRoot);
    try {
      const inFlight = requester.request("reset-service", undefined);
      inFlight.catch(() => undefined);
      await held.entered;

      await incumbent.releaseListener();
      // The replacement never bound; the incumbent restores ownership.
      await incumbent.listen();

      const next = await connectService(installRoot);
      try {
        held.release();
        assert.deepEqual(await next.request("reset-service", undefined), RESET_RESULT);
      } finally {
        await next.close();
      }
    } finally {
      held.release();
      await requester.close();
      await idle.close();
      await incumbent.close();
    }
  });
});

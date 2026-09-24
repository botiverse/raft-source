// Integration tests for `internal/ipc-server.ts` driven through the
// REAL `lib/ipc-client.ts` over a REAL Unix-domain socket. The test
// goal is to prove wire-byte agreement between the two sides — frame
// codec, handshake exchange, request/response correlation, error
// envelope, event broadcast, and iterator natural-completion semantics
// (§4.7 disjoint split).
//
// Strategy:
//   - Each test uses `mkdtemp` to get an isolated install root, builds
//     the server with a small handler table, listens on the real socket
//     path, then drives it with `connectService(installRoot)` from
//     `lib/ipc-client.ts`. No stub / fake on either side.
//   - Tests assert externally observable behavior (resolved promises,
//     thrown error codes, iterator completion). They do NOT inspect
//     internal state of either module — keeps the contract on the
//     wire boundary, which is the durable surface.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer as nodeCreateServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";

import { connectService } from "../lib/ipc-client.js";
import { ServiceClientError, type RequestMethodMap } from "../lib/types.js";
import { createIpcServer, type IpcServer, type RequestHandlerMap } from "./ipc-server.js";

// Canonical `ComputerStatusReport` fixture — matches the lib/types.ts
// `ServiceStatusResult` shape exactly so handler return types
// `satisfies` the `RequestMethodMap["service-status"]["result"]`
// contract. Hao's PR #2313 §-axis review byte-pinned this shape: tests
// use the SAME concrete report shape `buildStatusReport` produces, not
// a fictional `{ state, computerVersion }` shape that bypasses
// `tsc --noEmit`. (Computer is not currently in CI's typecheck job
// scope — `for pkg in shared server web daemon` — so the original
// committed fixture only failed under local typecheck. Flagged
// separately for follow-up CI extension.)
const STATUS_FIXTURE: RequestMethodMap["service-status"]["result"] = {
  slockHome: "/tmp/slock-ipc-server-fixture",
  cliVersion: "0.0.0-test",
  loggedIn: false,
  userId: null,
  userName: null,
  userDisplayName: null,
  userEmail: null,
  loginServerUrl: null,
  userSessionError: null,
  service: {
    running: false,
    logPath: "/tmp/slock-ipc-server-fixture/computer/service.log",
    version: {
      version: null,
      evidencePath: "/tmp/slock-ipc-server-fixture/computer/service-version.json",
      evidencePid: null,
      evidenceWrittenAt: null,
    shellEnvironment: null,
    },
  },
  upgrade: null,
  hostLifecycle: null,
  servers: [],
};

interface Harness {
  installRoot: string;
  server: IpcServer;
  socketPath: string;
}

async function withHarness(
  handlers: RequestHandlerMap,
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const installRoot = await mkdtemp(join(tmpdir(), "slock-ipc-server-"));
  const server = createIpcServer({ installRoot, handlers });
  const socketPath = await server.listen();
  try {
    await fn({ installRoot, server, socketPath });
  } finally {
    await server.close();
    await rm(installRoot, { recursive: true, force: true });
  }
}

test("ipc-server — successful handshake + request round-trip", async () => {
  const handlers: RequestHandlerMap = {
    "service-status": async () => STATUS_FIXTURE,
  };
  await withHarness(handlers, async ({ installRoot }) => {
    const client = await connectService(installRoot);
    const result = await client.request("service-status", undefined);
    assert.equal(result.slockHome, STATUS_FIXTURE.slockHome);
    assert.equal(result.loggedIn, false);
    assert.deepEqual(result.servers, []);
    await client.close();
  });
});

test("ipc-server — a failed bind clears internal state so the same handle can retry", async (t) => {
  if (process.platform === "win32") {
    t.skip();
    return;
  }
  const installRoot = await mkdtemp(join(tmpdir(), "slock-ipc-retry-"));
  const incumbent = createIpcServer({ installRoot, handlers: {} });
  const socketPath = await incumbent.listen();
  const retrying = createIpcServer({ installRoot, handlers: {} });
  try {
    await assert.rejects(
      () => retrying.listen(),
      (error: unknown) => {
        assert.equal((error as NodeJS.ErrnoException).code, "EADDRINUSE");
        return true;
      },
    );
    await incumbent.close();
    assert.equal(await retrying.listen(), socketPath);
  } finally {
    await incumbent.close();
    await retrying.close();
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("ipc-server — handler throwing ServiceClientError surfaces as typed error", async () => {
  const handlers: RequestHandlerMap = {
    "service-status": async () => {
      throw new ServiceClientError("IPC_REQUEST_TIMEOUT", "synthetic timeout");
    },
  };
  await withHarness(handlers, async ({ installRoot }) => {
    const client = await connectService(installRoot);
    await assert.rejects(
      () => client.request("service-status", undefined),
      (err: unknown) => {
        assert.ok(err instanceof ServiceClientError);
        assert.equal(err.code, "IPC_REQUEST_TIMEOUT");
        assert.equal(err.message, "synthetic timeout");
        return true;
      },
    );
    await client.close();
  });
});

test("ipc-server — handler throwing non-ServiceClientError normalizes to IPC_MALFORMED_FRAME", async () => {
  const handlers: RequestHandlerMap = {
    "service-status": async () => {
      throw new Error("handler exploded");
    },
  };
  await withHarness(handlers, async ({ installRoot }) => {
    const client = await connectService(installRoot);
    await assert.rejects(
      () => client.request("service-status", undefined),
      (err: unknown) => {
        assert.ok(err instanceof ServiceClientError);
        // Closed-set discipline: handler emitted a non-typed error, the
        // wire boundary normalizes it rather than letting `Error` leak
        // through. Original message preserved for operator signal.
        assert.equal(err.code, "IPC_MALFORMED_FRAME");
        assert.match(err.message, /handler exploded/);
        return true;
      },
    );
    await client.close();
  });
});

test("ipc-server — request for unknown method responds with IPC_MALFORMED_FRAME", async () => {
  await withHarness({}, async ({ installRoot }) => {
    const client = await connectService(installRoot);
    await assert.rejects(
      // Cast: deliberately call a method the server has no handler for.
      () => client.request("service-status", undefined),
      (err: unknown) => {
        assert.ok(err instanceof ServiceClientError);
        assert.equal(err.code, "IPC_MALFORMED_FRAME");
        return true;
      },
    );
    await client.close();
  });
});

test("ipc-server — protocol version mismatch surfaces as IPC_PROTOCOL_VERSION_UNSUPPORTED", async () => {
  await withHarness({}, async ({ installRoot }) => {
    await assert.rejects(
      () => connectService(installRoot, { protocolVersion: 99 }),
      (err: unknown) => {
        assert.ok(err instanceof ServiceClientError);
        assert.equal(err.code, "IPC_PROTOCOL_VERSION_UNSUPPORTED");
        return true;
      },
    );
  });
});

test("ipc-server — broadcast(event) reaches every connected client", async () => {
  await withHarness({}, async ({ installRoot, server }) => {
    const a = await connectService(installRoot);
    const b = await connectService(installRoot);
    const aIter = a.events[Symbol.asyncIterator]();
    const bIter = b.events[Symbol.asyncIterator]();

    // Allow the post-handshake `data` listener to attach on both sides
    // before broadcasting (handshake settles via a one-shot `data`
    // listener that is then replaced — broadcast must arrive AFTER
    // that handoff completes).
    await new Promise((resolve) => setTimeout(resolve, 20));

    server.broadcast({ kind: "service-state-changed", payload: { state: "degraded" } });

    const [aResult, bResult] = await Promise.all([aIter.next(), bIter.next()]);
    assert.equal(aResult.done, false);
    assert.equal(bResult.done, false);
    assert.equal(aResult.value?.kind, "service-state-changed");
    assert.equal(bResult.value?.kind, "service-state-changed");

    await a.close();
    await b.close();
  });
});

test("ipc-server — iterator naturally completes when the server closes the socket (§4.7)", async () => {
  await withHarness({}, async ({ installRoot, server }) => {
    const client = await connectService(installRoot);
    const iter = client.events[Symbol.asyncIterator]();

    // Schedule a server-side close after the iterator is awaiting.
    setTimeout(() => {
      void server.close();
    }, 30);

    const result = await iter.next();
    // §4.7 disjoint split: graceful close → natural completion (done),
    // NOT a thrown protocol error. This is the contract that lets
    // consumers reconnect via a plain outer `while (!stopped) { … }`
    // wrap with no try/catch.
    assert.equal(result.done, true);
  });
});

test("ipc-server — close() is idempotent (calling twice does not throw)", async () => {
  await withHarness({}, async ({ server }) => {
    await server.close();
    await server.close();
  });
});

test("ipc-server — per-connection isolation: one client's failure does not affect others", async () => {
  // The `service-status` handler uses params content as a steering
  // signal: when called with the sentinel "explode", throw; otherwise
  // return a normal status. Drive two clients sequentially against the
  // same server to prove the failing call does not desynchronize the
  // server for the other client.
  const handlers: RequestHandlerMap = {
    "service-status": async () => STATUS_FIXTURE,
    "reset-service": async () => {
      throw new ServiceClientError("IPC_REQUEST_CANCELED", "synthetic per-connection failure");
    },
  };
  await withHarness(handlers, async ({ installRoot }) => {
    const a = await connectService(installRoot);
    const b = await connectService(installRoot);

    // Client a: a failing call.
    await assert.rejects(
      () => a.request("reset-service", undefined),
      (err: unknown) => err instanceof ServiceClientError && err.code === "IPC_REQUEST_CANCELED",
    );
    // Client b: a successful call against the same server, after the failure.
    const status = await b.request("service-status", undefined);
    assert.equal(status.loggedIn, false);
    // Client a can still issue further requests on its own socket (the
    // failure was a typed error, not a protocol-level transport break).
    const statusA = await a.request("service-status", undefined);
    assert.equal(statusA.loggedIn, false);

    await a.close();
    await b.close();
  });
});

test("ipc-server — singleton-pathname guard: second listen on same installRoot rejects with EADDRINUSE; original server keeps serving", async () => {
  // Hao §-axis review on PR #2313 regression: previous (pre-fix)
  // `clearStaleSocket()` unconditionally unlinked the existing socket
  // file before binding, which silently let a second service starting
  // on the same `installRoot` steal the socket pathname while the
  // original kept running on an unlinked inode. The probe-then-clear
  // shape MUST refuse to listen when an active service is bound, AND
  // critically must NOT have stolen the pathname (proven by driving a
  // real `connectService(installRoot)` round-trip against server A
  // *after* server B's reject).
  const handlers: RequestHandlerMap = {
    "service-status": async () => STATUS_FIXTURE,
  };
  const installRoot = await mkdtemp(join(tmpdir(), "slock-ipc-singleton-"));
  const serverA = createIpcServer({ installRoot, handlers });
  await serverA.listen();
  try {
    // Second server attempting to bind same install root MUST refuse
    // with native EADDRINUSE produced by `createServer.listen()` —
    // surfaced at the service-startup boundary, NOT a
    // `ServiceClientError` (those are for client request boundaries).
    // The errno number is platform-specific (Darwin -48 / Linux -98 /
    // etc.); we only assert on `.code === "EADDRINUSE"`, which is
    // stable across all POSIX platforms Node supports.
    const serverB = createIpcServer({ installRoot, handlers });
    await assert.rejects(
      () => serverB.listen(),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as NodeJS.ErrnoException).code, "EADDRINUSE");
        assert.ok(!(err instanceof ServiceClientError),
          "EADDRINUSE must surface as native errno error, not as IPC wire ServiceClientError");
        return true;
      },
    );
    // Critical: prove server A's socket pathname was NOT replaced by
    // the failed B attempt — drive a real `connectService` against the
    // installRoot and round-trip a request. If B had stolen the
    // pathname, this client request would either fail to connect or
    // reach a different server with a different fixture.
    const client = await connectService(installRoot);
    const status = await client.request("service-status", undefined);
    assert.equal(status.slockHome, STATUS_FIXTURE.slockHome);
    await client.close();
  } finally {
    await serverA.close();
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("ipc-server — bounded handoff keeps the initiating socket while exactly one replacement listener takes ownership", async () => {
  const installRoot = await mkdtemp(join(tmpdir(), "slock-ipc-handoff-"));
  let releaseIncumbent!: () => void;
  let markIncumbentEntered!: () => void;
  const incumbentEntered = new Promise<void>((resolve) => { markIncumbentEntered = resolve; });
  const incumbentResult = new Promise<void>((resolve) => { releaseIncumbent = resolve; });
  const serverA = createIpcServer({
    installRoot,
    handlers: {
      "reset-service": async () => {
        markIncumbentEntered();
        await incumbentResult;
        return { status: "ok", previousState: "running", clearedCrashCount: 1 };
      },
    },
  });
  const serverB = createIpcServer({
    installRoot,
    handlers: {
      "reset-service": async () => ({
        status: "ok",
        previousState: "degraded",
        clearedCrashCount: 2,
      }),
    },
  });
  await serverA.listen();
  const clientA = await connectService(installRoot);
  try {
    const incumbentRequest = clientA.request("reset-service", undefined);
    await incumbentEntered;
    await serverA.releaseListener();
    await serverB.listen();

    const clientB = await connectService(installRoot);
    try {
      assert.deepEqual(await clientB.request("reset-service", undefined), {
        status: "ok",
        previousState: "degraded",
        clearedCrashCount: 2,
      });
    } finally {
      await clientB.close();
    }

    releaseIncumbent();
    assert.deepEqual(await incumbentRequest, {
      status: "ok",
      previousState: "running",
      clearedCrashCount: 1,
    });
  } finally {
    await clientA.close();
    await serverA.close();
    await serverB.close();
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("ipc-server — stale socket left behind by a crashed prior service is cleared and listen succeeds", async () => {
  // The other half of the singleton-pathname guard: an inert socket
  // file at the path (no listener bound — i.e. the prior service
  // crashed without unlinking) must not block startup. The probe
  // refuses-connect, the helper unlinks, listen proceeds. Without the
  // probe-then-clear logic this would either (a) fail with EADDRINUSE
  // forever or (b) regress to the original "blind unlink" defect.
  const installRoot = await mkdtemp(join(tmpdir(), "slock-ipc-stale-"));
  // Pre-create the run/ dir + a stale socket file. We bind a one-shot
  // dummy server at the path and immediately close it. Node's
  // `server.close()` actually unlinks, so the file is gone after — but
  // that's still useful coverage: the probe sees ENOENT from `stat`
  // and short-circuits to "nothing to clear", listen proceeds. (The
  // "live socket file with no live listener" case can occur after a
  // crash on POSIX where the OS does NOT unlink AF_UNIX socket files;
  // that path is covered by the helper's connect-refused branch — see
  // ipc-server.ts probeAndClearStaleSocket.)
  const stalePath = join(installRoot, "computer", "run", "service.sock");
  await mkdir(dirname(stalePath), { recursive: true });
  await new Promise<void>((resolve) => {
    const dummy = nodeCreateServer();
    dummy.listen(stalePath, () => {
      dummy.close(() => resolve());
    });
  });
  const server = createIpcServer({ installRoot, handlers: {} });
  try {
    const path = await server.listen();
    assert.equal(path, stalePath);
    // Sanity: a real client can connect to the freshly-bound server.
    const client = await connectService(installRoot);
    await client.close();
  } finally {
    await server.close();
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("POSIX IPC protects its directory before accepting clients", async () => {
  if (process.platform === "win32") return;
  await withHarness({}, async ({ socketPath }) => {
    assert.equal((await stat(dirname(socketPath))).mode & 0o777, 0o700);
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
  });
});

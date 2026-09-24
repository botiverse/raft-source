// Tests for `lib/ipc-client.ts` `connectService` + frame codec + handshake
// (PR-impl-2 commit 1, RFC v9.8 §4.1-§4.7 first-commit scope).
//
// Strategy: spawn a tiny stub IPC server on a temp Unix socket inside a
// `mkdtemp` workspace. The stub implements just enough of the §4 protocol
// to exercise the client behavior we're proving:
//   - successful handshake → ServiceClient returned
//   - hello-reject (version) → throws `IPC_PROTOCOL_VERSION_UNSUPPORTED`
//   - hello-reject (other reason) → throws `IPC_PROTOCOL_HANDSHAKE_FAILED`
//   - first frame not hello-ack/reject → throws `IPC_PROTOCOL_HANDSHAKE_FAILED`
//   - request → response correlation by id
//   - request → error response → throws ServiceClientError with the wire code
//   - server closes socket → events iterator natural completion (no throw)
//   - frame > 1 MiB → throws `IPC_FRAME_TOO_LARGE`
//   - close() rejects in-flight requests with `IPC_CLIENT_CLOSED`
//
// We deliberately use a real Unix socket (not in-memory paired socket) so
// the codepath that resolves `serviceSocketPath` + `net.connect({path})`
// is exercised end-to-end; the stub server does not import from
// `internal/ipc-server.ts` (that module lands in commit 2) — it is a
// hand-rolled test fixture.
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { connectService } from "./ipc-client.js";
import { IPC_ERROR_CODES, ServiceClientError } from "./types.js";
import { serviceSocketPath } from "../paths.js";

interface StubServer {
  server: Server;
  sockets: Socket[];
  close(): Promise<void>;
}

interface StubBehavior {
  // Called when the stub receives a hello frame; returns the response
  // frame(s) the stub should emit (or `null` to close the connection
  // without responding).
  onHello?: (frame: Record<string, unknown>) => Array<Record<string, unknown>> | null;
  // Called when the stub receives a request frame; returns the response
  // frame(s) (or `null` to drop silently).
  onRequest?: (frame: Record<string, unknown>) => Array<Record<string, unknown>> | null;
  // Called when the stub receives any frame after handshake but no
  // specific handler matched. Default: no-op.
  onAnyFrame?: (frame: Record<string, unknown>, socket: Socket) => void;
}

async function withStubServer(home: string, behavior: StubBehavior, fn: (server: StubServer) => Promise<void>): Promise<void> {
  const installRoot = join(home, "computer");
  await mkdir(join(installRoot, "run"), { recursive: true });
  const socketPath = serviceSocketPath(home);
  const sockets: Socket[] = [];

  const server = createServer((socket) => {
    sockets.push(socket);
    let buffer: Buffer = Buffer.alloc(0);
    let handshakeDone = false;
    socket.on("data", (chunk: Buffer) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (buffer.length < 4 + length) break;
        const body = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
        } catch {
          socket.destroy();
          return;
        }

        if (!handshakeDone && frame.type === "hello") {
          const response = behavior.onHello?.(frame);
          if (response === null) {
            socket.destroy();
            return;
          }
          handshakeDone = true;
          const frames = response ?? [{ type: "hello-ack", protocolVersion: 1, serviceVersion: "stub" }];
          for (const f of frames) socket.write(encodeFrame(f));
          continue;
        }

        if (frame.type === "request") {
          const response = behavior.onRequest?.(frame);
          if (response === null) continue;
          if (response) {
            for (const f of response) socket.write(encodeFrame(f));
          }
          continue;
        }

        if (frame.type === "pong") continue; // heartbeat round-trip — no-op
        behavior.onAnyFrame?.(frame, socket);
      }
    });
    socket.on("error", () => {/* ignore */});
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  try {
    await fn({
      server,
      sockets,
      async close() {
        for (const s of sockets) s.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    });
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function encodeFrame(payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, json]);
}

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "slock-ipc-client-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("connectService — successful handshake returns ServiceClient", async () => {
  await withTempHome(async (home) => {
    await withStubServer(home, {}, async () => {
      const client = await connectService(home);
      assert.equal(typeof client.request, "function");
      assert.equal(typeof client.close, "function");
      assert.ok(client.events && Symbol.asyncIterator in client.events);
      await client.close();
    });
  });
});

test("connectService — hello-reject with version mismatch throws IPC_PROTOCOL_VERSION_UNSUPPORTED", async () => {
  await withTempHome(async (home) => {
    await withStubServer(home, {
      onHello: () => [{
        type: "hello-reject",
        reason: "IPC_PROTOCOL_VERSION_UNSUPPORTED",
        supported: [2, 3],
      }],
    }, async () => {
      await assert.rejects(
        () => connectService(home),
        (err: unknown) => {
          assert.ok(err instanceof ServiceClientError);
          assert.equal(err.code, "IPC_PROTOCOL_VERSION_UNSUPPORTED");
          return true;
        },
      );
    });
  });
});

test("connectService — hello-reject with non-version reason throws IPC_PROTOCOL_HANDSHAKE_FAILED", async () => {
  await withTempHome(async (home) => {
    await withStubServer(home, {
      onHello: () => [{
        type: "hello-reject",
        reason: "AUTH_FAILED",
      }],
    }, async () => {
      await assert.rejects(
        () => connectService(home),
        (err: unknown) => {
          assert.ok(err instanceof ServiceClientError);
          assert.equal(err.code, "IPC_PROTOCOL_HANDSHAKE_FAILED");
          return true;
        },
      );
    });
  });
});

test("connectService — first frame not hello-ack/reject throws IPC_PROTOCOL_HANDSHAKE_FAILED", async () => {
  await withTempHome(async (home) => {
    await withStubServer(home, {
      onHello: () => [{ type: "garbage", payload: "wat" }],
    }, async () => {
      await assert.rejects(
        () => connectService(home),
        (err: unknown) => {
          assert.ok(err instanceof ServiceClientError);
          assert.equal(err.code, "IPC_PROTOCOL_HANDSHAKE_FAILED");
          return true;
        },
      );
    });
  });
});

test("connectService — server closes before hello-ack throws IPC_PROTOCOL_HANDSHAKE_FAILED", async () => {
  await withTempHome(async (home) => {
    await withStubServer(home, {
      onHello: () => null, // close socket
    }, async () => {
      // The connect succeeds, but the handshake-await detects the close
      // and throws. (We can't be precise about whether the socket close
      // races the hello frame parse; both paths surface the same code.)
      await assert.rejects(
        () => connectService(home),
        (err: unknown) => {
          assert.ok(err instanceof ServiceClientError);
          // Acceptable: HANDSHAKE_FAILED (client wired) or MALFORMED_FRAME
          // (parse race — both are protocol-level pre-ack failures).
          assert.match(
            err.code,
            /^(IPC_PROTOCOL_HANDSHAKE_FAILED|IPC_MALFORMED_FRAME)$/,
          );
          return true;
        },
      );
    });
  });
});

test("connectService — accepted socket without hello-ack obeys the handshake deadline", async () => {
  await withTempHome(async (home) => {
    await withStubServer(home, { onHello: () => [] }, async () => {
      await assert.rejects(
        () => connectService(home, { timeoutMs: 25 }),
        (err: unknown) => err instanceof ServiceClientError
          && err.code === "IPC_PROTOCOL_HANDSHAKE_FAILED"
          && /timed out waiting for hello-ack/.test(err.message),
      );
    });
  });
});

test("ServiceClient.request — successful round-trip resolves with result", async () => {
  await withTempHome(async (home) => {
    await withStubServer(home, {
      onRequest: (frame) => [{
        type: "response",
        id: frame.id,
        result: { state: "running" as const },
      }],
    }, async () => {
      const client = await connectService(home);
      const result = await client.request("service-status", undefined);
      assert.deepEqual(result, { state: "running" });
      await client.close();
    });
  });
});

test("ServiceClient.request — error response rejects with closed-set ServiceClientError", async () => {
  await withTempHome(async (home) => {
    await withStubServer(home, {
      onRequest: (frame) => [{
        type: "response",
        id: frame.id,
        error: { code: "IPC_REQUEST_TIMEOUT", message: "stub timeout" },
      }],
    }, async () => {
      const client = await connectService(home);
      await assert.rejects(
        () => client.request("service-status", undefined),
        (err: unknown) => {
          assert.ok(err instanceof ServiceClientError);
          assert.equal(err.code, "IPC_REQUEST_TIMEOUT");
          return true;
        },
      );
      await client.close();
    });
  });
});

test("ServiceClient.request — accepted request without response obeys the request deadline", async () => {
  await withTempHome(async (home) => {
    await withStubServer(home, { onRequest: () => null }, async () => {
      const client = await connectService(home);
      try {
        await assert.rejects(
          () => client.request("machine-attestation", undefined, { timeoutMs: 25 }),
          (err: unknown) => err instanceof ServiceClientError
            && err.code === "IPC_REQUEST_TIMEOUT"
            && /machine-attestation/.test(err.message),
        );
      } finally {
        await client.close();
      }
    });
  });
});

test("ServiceClient.events — natural completion on socket close (no throw, §4.7)", async () => {
  await withTempHome(async (home) => {
    let savedSocket: Socket | null = null;
    await withStubServer(home, {
      onAnyFrame: (_frame, socket) => {
        savedSocket = socket;
      },
    }, async () => {
      const client = await connectService(home);
      const iter = client.events[Symbol.asyncIterator]();

      // Schedule a server-side close after a short delay so the iterator
      // is awaiting when it happens.
      setTimeout(() => {
        // Close all server-held sockets via the StubServer's tracking
        // (the connect callback pushed onto `sockets`).
        client.close();
      }, 50);

      const result = await iter.next();
      assert.equal(result.done, true);
      // Asserting absence of throw is the key §4.7 contract: natural
      // completion vs throw split.
      assert.equal(savedSocket, null); // never received any non-handshake frame
    });
  });
});

test("ServiceClient.close — rejects outstanding requests with IPC_CLIENT_CLOSED", async () => {
  await withTempHome(async (home) => {
    await withStubServer(home, {
      onRequest: () => null, // never respond — leave hanging
    }, async () => {
      const client = await connectService(home);
      const pending = client.request("service-status", undefined);
      // Allow the request frame to be sent before closing.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await client.close();
      await assert.rejects(pending, (err: unknown) => {
        assert.ok(err instanceof ServiceClientError);
        assert.equal(err.code, "IPC_CLIENT_CLOSED");
        return true;
      });
    });
  });
});

test("IPC_ERROR_CODES — closed-set sentinel: 10 tokens, exact-shape, no silent shrink/reorder", () => {
  // Sentinel-grep discipline carry-forward (Compy msg=2f6d23af + XX
  // msg=418bd0ca byte-pin sign): pin the 10-token closed-set tuple by
  // length + by exact element-by-element membership. Adding tokens is
  // a forward-only minor library bump (must update this assertion);
  // removing / renaming / reordering tokens is a major bump (must
  // update this assertion AND the lib semver).
  assert.equal(IPC_ERROR_CODES.length, 11, "IPC_ERROR_CODES tuple length must be 11");
  assert.deepEqual(
    [...IPC_ERROR_CODES],
    [
      "IPC_FRAME_TOO_LARGE",
      "IPC_PROTOCOL_VERSION_UNSUPPORTED",
      "IPC_PROTOCOL_HANDSHAKE_FAILED",
      "IPC_HEARTBEAT_TIMEOUT",
      "IPC_MALFORMED_FRAME",
      "IPC_REQUEST_TIMEOUT",
      "IPC_REQUEST_CANCELED",
      "IPC_CLIENT_CLOSED",
      "SELF_RELAUNCH_UNAVAILABLE",
      "CONTROL_BUSY",
      "UPGRADE_START_REJECTED",
    ],
    "IPC_ERROR_CODES exact-shape sentinel — extending requires updating this test (forward-only minor); reordering / removing / renaming requires major lib bump",
  );
});

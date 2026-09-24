// Computer service §4 IPC transport — server runtime (RFC v9.8 §4.1-§4.7).
//
// Package-private: this module lives under `src/internal/` and is NOT
// exported from `@botiverse/raft-computer/lib`. The Computer service binary
// imports it directly inside the package; downstream library consumers
// only see the client (`lib/ipc-client.ts`) and the closed-set types
// (`lib/types.ts`).
//
// Scope (PR-impl-2 commit 2):
//   - Listen on the §4.1 transport endpoint (POSIX Unix-domain socket
//     at `<installRoot>/run/service.sock` with `0o600` ownership;
//     Windows named-pipe `\\.\pipe\raft-computer-<hash>` via the
//     `serviceWindowsPipeName` path helper).
//   - Per-connection length-prefixed JSON frame codec via the shared
//     `internal/ipc-codec.ts` module (single source of truth for wire
//     bytes — both ends consume the identical encoder/decoder).
//   - `hello` ↔ `hello-ack | hello-reject` handshake (§4.3); reject the
//     connection with `IPC_PROTOCOL_VERSION_UNSUPPORTED` if the client
//     requests a protocol version we cannot honor.
//   - Request → handler dispatch with response correlation by request id.
//     Handlers `satisfies RequestMethodMap[M]["result"]` so the wire
//     contract is type-checked at registration time.
//   - Event broadcast — `broadcast(event)` queues a `ServiceEvent` to
//     every connected client, length-prefix-framed as `{ type: "event",
//     kind, payload }`.
//   - Per-connection isolation: a malformed/over-size frame from one
//     client terminates that client's socket only; other clients keep
//     running.
//   - Singleton-pathname guard (Hao §-axis review on PR #2313): before
//     `listen()` rebinds an existing socket file, probe-connect to it.
//     A successful probe means a live service is already bound — we
//     refuse listen with the native `EADDRINUSE` (service-startup
//     boundary, NOT a client-side IPC wire error). Only `ECONNREFUSED`
//     / `ENOENT` / non-socket file is treated as stale and unlinked.
//     This prevents a second service starting on the same install root
//     from silently stealing the socket pathname while the first
//     service keeps running on an unlinked inode.
//   - Graceful close: `close()` stops accepting new connections and
//     destroys all open sockets immediately. In-flight handler
//     responses are NOT drained — outstanding requests on the client
//     surface as `IPC_CLIENT_CLOSED`. Idempotent. (Drain semantics are
//     deferred to commit 3 alongside `cancel` + per-request timeout
//     wiring; until then `close()` is the abrupt-shutdown primitive.)
//
// Deferred to subsequent commits on this branch:
//   - `cancel` frame handling (`IPC_REQUEST_CANCELED`) and per-request
//     `timeoutMs` deadline (`IPC_REQUEST_TIMEOUT`) — §4.4 + §3.2.
//   - Heartbeat ping schedule with ±10% jitter (§4.5).
//   - Concrete handler bindings for the `RequestMethodMap`
//     (mechanical delegation to the lib readers + mutation pipeline).
//
// Closed-set discipline (§7):
//   Handlers may throw `ServiceClientError` (the same envelope the
//   client surfaces). The server serializes it onto the wire as
//   `{ error: { code: IpcErrorCode, message } }`. Any other thrown
//   value is normalized to `IPC_MALFORMED_FRAME` server-side rather
//   than leaking an arbitrary string code onto the wire — closed-set
//   discipline holds at the wire boundary even when handlers misbehave.
//
// Hermeticity invariant (5th carry-forward):
//   This module imports ONLY `node:net` / `node:fs/promises` /
//   `../paths.js` / `../lib/types.js` / `./ipc-codec.js`. It MUST NOT
//   reach into service / CLI surfaces — handler bindings come in
//   later commits via dependency injection (`registerHandler`), keeping
//   the transport module free of every business-logic import.
import { connect, createServer, type Server, type Socket } from "node:net";
import { chmod, lstat, mkdir, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { serviceSocketPath, serviceWindowsPipeName } from "../paths.js";
import { FrameDecoder, encodeFrame } from "./ipc-codec.js";
import {
  ServiceClientError,
  type IpcErrorCode,
  type RequestMethodMap,
  type ServiceEvent,
} from "../lib/types.js";

const SUPPORTED_PROTOCOL_VERSIONS = [1] as const;
const SERVICE_VERSION = "0.0.0";

/**
 * Per-method handler signature. The handler receives the typed `params`
 * for method `M` and returns a `Promise` of the typed `result`. Throw
 * a `ServiceClientError` with a member of `IPC_ERROR_CODES` to surface
 * a typed error to the client; any other thrown value is normalized to
 * `IPC_MALFORMED_FRAME` at the wire boundary (closed-set discipline).
 */
export type RequestHandler<M extends keyof RequestMethodMap> = (
  params: RequestMethodMap[M]["params"],
) => Promise<RequestMethodMap[M]["result"]>;

export type RequestHandlerMap = {
  [M in keyof RequestMethodMap]?: RequestHandler<M>;
};

export interface IpcServerOptions {
  /** Install root for socket path resolution (passes through `serviceSocketPath`). */
  installRoot: string;
  /** Per-method handler table. Methods absent from the map respond with `IPC_MALFORMED_FRAME`. */
  handlers: RequestHandlerMap;
}

export interface IpcServer {
  /** Start listening; returns the resolved transport path so callers can echo it. */
  listen(): Promise<string>;
  /** Broadcast an event to every connected client. Drops silently if the server is closed. */
  broadcast(event: ServiceEvent): void;
  /**
   * Stop accepting new connections without destroying already-connected
   * request sockets. Used only for the bounded service handoff: the incumbent
   * keeps the initiating request alive while a replacement proves ownership.
   */
  releaseListener(): Promise<void>;
  /** Stop accepting connections and destroy open sockets. Idempotent. */
  close(): Promise<void>;
}

interface Connection {
  socket: Socket;
  decoder: FrameDecoder;
  handshakeDone: boolean;
}

/**
 * Resolve the transport endpoint identity. POSIX = filesystem socket
 * path (must be created under `<installRoot>/run/`); Windows = named
 * pipe identity that does not live on the filesystem.
 */
function resolveTransportPath(installRoot: string): string {
  return process.platform === "win32"
    ? serviceWindowsPipeName(installRoot)
    : serviceSocketPath(installRoot);
}

/**
 * Probe the existing socket file before `listen()` rebinds it.
 *
 * Singleton-pathname guard (Hao §-axis review on PR #2313): naively
 * unlinking a stale socket is unsafe — if a live service is currently
 * bound to the path, `unlink` followed by `createServer.listen` would
 * silently steal the pathname while the original service keeps running
 * on an unlinked inode. New clients reach the second service; the
 * first service is functionally a zombie. The §4 IPC endpoint MUST be
 * a singleton per `installRoot`, so an active service starting
 * collision is a hard error, not a recoverable race.
 *
 * Singleton boundary: **fail-closed** (Hao re-review on `804146a`,
 * `msg=9dc148c8`). We only unlink when we have positive proof the
 * socket is stale — anything else preserves the existing path and lets
 * the platform-native `listen()` produce its own canonical
 * `EADDRINUSE` errno. This module never synthesizes a fake errno;
 * Darwin's `-48`, Linux's `-98`, and Windows' named-pipe collision
 * shape all come from the OS via `createServer.listen()` directly.
 *
 * Algorithm:
 *   1. `stat` the path.
 *      - `ENOENT` → nothing to clear; return.
 *      - Other `stat` failure (EACCES, etc.) → fail-closed: leave the
 *        path; downstream `listen()` will surface the fs error verbatim.
 *   2. Not a socket → leave it (might be operator data). `listen()`
 *      will surface `EADDRINUSE` / `EEXIST` / `EISDIR` directly.
 *   3. Socket exists → probe-connect with a short timeout.
 *      - Connect resolves: a live service is bound → fail-closed,
 *        leave the path. `createServer.listen()` produces native
 *        `EADDRINUSE`.
 *      - Connect rejects with `ECONNREFUSED`: the kernel knows about
 *        the inode but no listener is accepting → safe to unlink.
 *      - Anything else (timeout, `EACCES`, unknown error): we cannot
 *        prove stale → fail-closed, leave the path.
 *
 * Windows is a no-op: named-pipe identities don't live on the
 * filesystem; OS-level pipe-server creation surfaces collision through
 * `EADDRINUSE` directly when the pipe name is in use.
 */
async function probeAndClearStaleSocket(socketPath: string): Promise<void> {
  if (process.platform === "win32") return;

  let isSocket = false;
  try {
    const stats = await stat(socketPath);
    isSocket = stats.isSocket();
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return;
    // Other stat failures (permission, etc.) — fail-closed; leave the
    // path so `listen()` surfaces the underlying fs error verbatim.
    return;
  }
  if (!isSocket) {
    // A non-socket file at the path: do not unlink (might be operator
    // data placed there by accident). `listen()` will surface the
    // EADDRINUSE / EEXIST / EISDIR errno directly.
    return;
  }

  // The path exists and is a socket — probe whether the kernel will
  // refuse-connect (proving stale) or accept (proving live). Anything
  // else is fail-closed and short-circuits without unlink.
  type ProbeOutcome = "connected" | "refused" | "indeterminate";
  const outcome = await new Promise<ProbeOutcome>((resolve) => {
    const probe = connect({ path: socketPath });
    const finalize = (o: ProbeOutcome): void => {
      probe.removeAllListeners();
      probe.destroy();
      resolve(o);
    };
    const timer = setTimeout(() => finalize("indeterminate"), 500);
    probe.once("connect", () => {
      clearTimeout(timer);
      finalize("connected");
    });
    probe.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      finalize(err.code === "ECONNREFUSED" ? "refused" : "indeterminate");
    });
  });

  if (outcome !== "refused") {
    // - "connected": a live service is bound. Leave the path; native
    //   `listen()` will surface `EADDRINUSE` from the OS.
    // - "indeterminate": timeout or non-ECONNREFUSED error — we have
    //   no positive proof of staleness, so fail-closed. The operator
    //   sees whatever `listen()` raises (typically `EADDRINUSE`).
    return;
  }

  // outcome === "refused": kernel knows the inode but nobody is
  // accepting. Unlink so listen() can rebind cleanly.
  try {
    await unlink(socketPath);
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return;
    throw err;
  }
}

/**
 * Construct the §4 IPC server. Returns an `IpcServer` handle the
 * caller can `listen()` on.
 *
 * Lifecycle:
 *   1. `listen()` — creates the parent dir (`<installRoot>/run`),
 *      removes any stale socket, binds, and chmod's the file to `0o600`
 *      so only the owning user can connect (POSIX). Returns the resolved
 *      transport path on success.
 *   2. Per-connection: install `data` listener that drives a
 *      `FrameDecoder` and dispatches frames; install `close` / `error`
 *      listeners to clean up the connection record.
 *   3. `close()` — stops accepting new connections, destroys every
 *      open socket, and resolves once the server has emitted `close`.
 *      Idempotent.
 */
export function createIpcServer(options: IpcServerOptions): IpcServer {
  const { installRoot, handlers } = options;
  const transportPath = resolveTransportPath(installRoot);
  const connections = new Set<Connection>();
  let server: Server | null = null;
  let closed = false;

  function dispatchFrame(conn: Connection, frame: unknown): void {
    if (!isRecord(frame) || typeof frame.type !== "string") {
      writeError(conn, null, "IPC_MALFORMED_FRAME", "frame is missing required `type` field");
      conn.socket.destroy();
      return;
    }

    if (!conn.handshakeDone) {
      handleHello(conn, frame);
      return;
    }

    if (frame.type === "request") {
      void handleRequest(conn, frame);
      return;
    }
    if (frame.type === "ping") {
      conn.socket.write(encodeFrame({ type: "pong" }));
      return;
    }
    if (frame.type === "pong") {
      // Heartbeat ack consumed by the schedule that lands in a later
      // commit — no-op here.
      return;
    }
    // Unknown post-handshake frame types are ignored by design — clients
    // may send `cancel` (lands in commit 3) ahead of older servers, and
    // the protocol must not crash on forward-compat additions.
  }

  function handleHello(conn: Connection, frame: Record<string, unknown>): void {
    if (frame.type !== "hello") {
      // Handshake violation — first frame must be `hello`. Reject with
      // a generic handshake-failed reason and close.
      conn.socket.write(encodeFrame({
        type: "hello-reject",
        reason: "IPC_PROTOCOL_HANDSHAKE_FAILED",
        message: `expected hello, got \`${String(frame.type)}\``,
      }));
      conn.socket.destroy();
      return;
    }
    const requested = Number(frame.protocolVersion);
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(requested as 1)) {
      conn.socket.write(encodeFrame({
        type: "hello-reject",
        reason: "IPC_PROTOCOL_VERSION_UNSUPPORTED",
        supported: [...SUPPORTED_PROTOCOL_VERSIONS],
      }));
      conn.socket.destroy();
      return;
    }
    conn.handshakeDone = true;
    conn.socket.write(encodeFrame({
      type: "hello-ack",
      protocolVersion: requested,
      serviceVersion: SERVICE_VERSION,
    }));
  }

  async function handleRequest(conn: Connection, frame: Record<string, unknown>): Promise<void> {
    const id = typeof frame.id === "string" ? frame.id : "";
    const method = typeof frame.method === "string" ? frame.method : "";
    if (id === "" || method === "") {
      writeError(conn, id || null, "IPC_MALFORMED_FRAME", "request missing `id` or `method`");
      return;
    }
    const handler = handlers[method as keyof RequestMethodMap];
    if (!handler) {
      writeError(conn, id, "IPC_MALFORMED_FRAME", `unknown method \`${method}\``);
      return;
    }
    try {
      // Cast: the handler is typed for the specific method literal; at
      // dispatch time we have a wire string, so we narrow via the map
      // index. Per-method type safety is enforced at handler
      // registration (the `RequestHandler<M>` constraint).
      const result = await (handler as RequestHandler<keyof RequestMethodMap>)(
        frame.params as RequestMethodMap[keyof RequestMethodMap]["params"],
      );
      if (conn.socket.destroyed) return;
      conn.socket.write(encodeFrame({ type: "response", id, result }));
    } catch (error) {
      if (conn.socket.destroyed) return;
      const { code, message } = normalizeHandlerError(error);
      writeError(conn, id, code, message);
    }
  }

  function writeError(conn: Connection, id: string | null, code: IpcErrorCode, message: string): void {
    if (conn.socket.destroyed) return;
    try {
      conn.socket.write(encodeFrame({
        type: "response",
        id: id ?? "",
        error: { code, message },
      }));
    } catch {/* socket already torn down — drop */}
  }

  function attachConnection(socket: Socket): void {
    if (closed) {
      socket.destroy();
      return;
    }
    const conn: Connection = {
      socket,
      decoder: new FrameDecoder(),
      handshakeDone: false,
    };
    connections.add(conn);
    socket.on("data", (chunk: Buffer) => {
      try {
        conn.decoder.push(chunk);
        const frames = conn.decoder.drain();
        for (const frame of frames) dispatchFrame(conn, frame);
      } catch (error) {
        // Codec-level failure on this connection: emit a best-effort
        // error frame, then destroy the socket. Other connections keep
        // running — per-connection isolation invariant.
        const { code, message } = normalizeHandlerError(error);
        writeError(conn, null, code, message);
        socket.destroy();
      }
    });
    socket.on("close", () => connections.delete(conn));
    socket.on("error", () => {/* swallowed; close listener cleans up */});
  }

  return {
    async listen(): Promise<string> {
      if (server) throw new Error("ipc-server: listen() called twice");
      if (process.platform !== "win32") {
        const directory = dirname(transportPath);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const owner = await lstat(directory);
        if (!owner.isDirectory() || (process.getuid && owner.uid !== process.getuid())) {
          throw new Error("IPC directory must belong to the service user");
        }
        // Restrict traversal BEFORE binding, so even the pre-chmod socket
        // cannot be reached by another user under a permissive umask.
        await chmod(directory, 0o700);
        await probeAndClearStaleSocket(transportPath);
      }
      const s = createServer(attachConnection);
      server = s;
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (err: Error): void => {
            s.removeListener("error", onError);
            reject(err);
          };
          s.once("error", onError);
          s.listen(transportPath, () => {
            s.removeListener("error", onError);
            resolve();
          });
        });
      } catch (error) {
        if (server === s) server = null;
        try {
          s.close();
        } catch {
          /* bind never became active */
        }
        throw error;
      }
      if (process.platform !== "win32") {
        try {
          await chmod(transportPath, 0o600);
        } catch (error) {
          s.close();
          server = null;
          throw error;
        }
      }
      return transportPath;
    },
    broadcast(event: ServiceEvent): void {
      if (closed) return;
      const payload = encodeFrame({ type: "event", kind: event.kind, payload: event.payload });
      for (const conn of connections) {
        if (!conn.handshakeDone || conn.socket.destroyed) continue;
        try {
          conn.socket.write(payload);
        } catch {/* drop — close listener will reap */}
      }
    },
    async releaseListener(): Promise<void> {
      const s = server;
      server = null;
      if (!s) return;
      // `Server.close()` stops accepts immediately but waits to emit `close`
      // until existing request sockets drain. Do not await that event here:
      // the restart request itself is intentionally one of those sockets.
      s.close();
      if (process.platform !== "win32") {
        await unlink(transportPath).catch((error: unknown) => {
          if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
        });
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const s = server;
      server = null;
      for (const conn of connections) conn.socket.destroy();
      connections.clear();
      if (s) {
        await new Promise<void>((resolve) => {
          s.close(() => resolve());
        });
      }
    },
  };
}

function normalizeHandlerError(error: unknown): { code: IpcErrorCode; message: string } {
  if (error instanceof ServiceClientError) {
    return { code: error.code, message: error.message };
  }
  // Closed-set discipline: any non-`ServiceClientError` thrown value is
  // normalized to `IPC_MALFORMED_FRAME` rather than leaking an arbitrary
  // code string onto the wire. The original message is preserved so the
  // operator still has signal in `service.log`.
  const message = error instanceof Error ? error.message : "handler threw non-Error value";
  return { code: "IPC_MALFORMED_FRAME", message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === "string";
}

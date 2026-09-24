// `@botiverse/raft-computer/lib` § 4 IPC transport — connectService client
// runtime (RFC v9.8 §4.1-§4.7).
//
// Scope (PR-impl-2 commit 1):
//   - POSIX Unix-domain socket connect at `<installRoot>/run/service.sock`
//   - Windows named-pipe support via the `serviceWindowsPipeName` path
//     helper from `../paths.js` (single connect call shape handles both
//     thanks to `net.connect`).
//   - Length-prefixed frame codec (4-byte BE length + UTF-8 JSON body,
//     max 1 MiB — over-size frames throw `IPC_FRAME_TOO_LARGE` and the
//     connection terminates).
//   - `hello` ↔ `hello-ack | hello-reject` handshake (protocol version 1
//     floor; rejected with `IPC_PROTOCOL_VERSION_UNSUPPORTED` if the
//     service cannot honor the requested version).
//   - `request<M>(method, params, options?)` → `Promise<result>` with
//     correlation by request id (UUIDv4); response error frames throw
//     `ServiceClientError` carrying the §7 closed-set `IpcErrorCode`.
//   - `events: AsyncIterable<ServiceEvent>` that completes naturally on
//     any socket-close path (graceful local/remote, transient, RST) and
//     throws `ServiceClientError` ONLY on protocol-level failure (frame
//     parse, frame > 1 MiB, malformed JSON). §4.7 disjoint split — the
//     `for-await` loop exits without try/catch in the idiomatic reconnect
//     wrapper.
//   - `close()` is idempotent; outstanding requests reject with
//     `IPC_CLIENT_CLOSED`.
//
// Deferred to subsequent commits on this branch:
//   - `RequestOptions.signal` wiring (`IPC_REQUEST_CANCELED`) — §4.4 + §3.2.
//   - Heartbeat ping/pong with ±10% jitter (§4.5).
//
// Closed-set discipline (§7):
//   `ServiceClientError.code` is a member of `IPC_ERROR_CODES` — every
//   throw path narrows through the union before constructing the error.
//   No string code escapes the closed set.
import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { clearClockTimeout, currentTimeMs, setClockTimeout } from "@botiverse/raft-shared";
import { serviceSocketPath, serviceWindowsPipeName } from "../paths.js";
import { FrameDecoder, encodeFrame } from "../internal/ipc-codec.js";
import {
  ServiceClientError,
  type ConnectServiceOptions,
  type IpcErrorCode,
  type RequestMethodMap,
  type RequestOptions,
  type ServiceClient,
  type ServiceEvent,
} from "./types.js";

const DEFAULT_PROTOCOL_VERSION = 1;
const CLIENT_KIND = "lib";
// Pinned client version surfaced in the handshake; bumped via the lib
// semver. The service may use this for compatibility branching but
// MUST NOT use it to gate the protocol — the protocol version field is
// the contract surface.
const CLIENT_VERSION = "0.0.0";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

function deadlineTimer(timeoutMs: number | undefined, onTimeout: () => void): unknown | null {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
  return setClockTimeout(onTimeout, timeoutMs);
}

/**
 * Resolve the platform-specific transport endpoint for the Computer
 * service. POSIX = Unix-domain socket file path; Windows = named-pipe
 * identity. `net.connect` accepts both shapes via the same option
 * object so the rest of this module stays platform-agnostic.
 */
function resolveTransportPath(installRoot: string): string {
  return process.platform === "win32"
    ? serviceWindowsPipeName(installRoot)
    : serviceSocketPath(installRoot);
}

/**
 * Connect to the Computer service over the §4 IPC transport, perform the
 * versioned handshake (§4.3), and return a typed `ServiceClient`. Throws
 * `ServiceClientError` (member of `IPC_ERROR_CODES`) on any handshake or
 * connect-time failure.
 */
export async function connectService(
  installRoot: string,
  options: ConnectServiceOptions = {},
): Promise<ServiceClient> {
  const protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
  const transportPath = resolveTransportPath(installRoot);
  const connectDeadline = options.timeoutMs && options.timeoutMs > 0
    ? currentTimeMs() + options.timeoutMs
    : undefined;
  const remainingConnectMs = (): number | undefined => connectDeadline === undefined
    ? undefined
    : Math.max(1, connectDeadline - currentTimeMs());

  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = connect({ path: transportPath });
    let timer: unknown | null = null;
    const settle = (action: () => void): void => {
      if (timer !== null) clearClockTimeout(timer);
      s.removeListener("connect", onConnect);
      s.removeListener("error", onError);
      action();
    };
    const onConnect = (): void => {
      if (timer !== null) clearClockTimeout(timer);
      s.removeListener("connect", onConnect);
      // Keep the one-shot error listener across the await handoff so an
      // immediate post-connect error cannot become an unhandled event before
      // the long-lived socket listener below is installed.
      resolve(s);
    };
    const onError = (err: Error): void => settle(() => reject(
      new ServiceClientError("IPC_PROTOCOL_HANDSHAKE_FAILED", `unable to connect to ${transportPath}: ${err.message}`, err),
    ));
    s.once("connect", onConnect);
    s.once("error", onError);
    timer = deadlineTimer(remainingConnectMs(), () => settle(() => {
      s.destroy();
      reject(new ServiceClientError(
        "IPC_PROTOCOL_HANDSHAKE_FAILED",
        `timed out connecting to ${transportPath}`,
      ));
    }));
  });

  const decoder = new FrameDecoder();
  const pendingRequests = new Map<string, PendingRequest>();
  const eventQueue: ServiceEvent[] = [];
  const eventWaiters: Array<{ resolve: (event: ServiceEvent | null) => void }> = [];
  let closed = false;
  let protocolError: ServiceClientError | null = null;

  function terminate(error: ServiceClientError | null): void {
    if (closed) return;
    closed = true;
    if (error) protocolError = error;
    socket.destroy();
    // Reject all in-flight requests; release the iterator waiters.
    for (const pending of pendingRequests.values()) {
      pending.reject(error ?? new ServiceClientError("IPC_CLIENT_CLOSED", "service client closed before response"));
    }
    pendingRequests.clear();
    for (const waiter of eventWaiters) waiter.resolve(null);
    eventWaiters.length = 0;
  }

  function dispatchFrame(frame: unknown): void {
    if (!isRecord(frame) || typeof frame.type !== "string") {
      throw new ServiceClientError("IPC_MALFORMED_FRAME", "frame is missing required `type` field");
    }
    if (frame.type === "event") {
      // §4.4 — push event. `kind` discriminator validated against
      // ServiceEvent union by the consumer's exhaustive switch; we do
      // not narrow here because the union may grow as a minor library
      // bump and any extra discriminant should not crash the client.
      const event = { kind: String(frame.kind), payload: frame.payload } as ServiceEvent;
      if (eventWaiters.length > 0) {
        const waiter = eventWaiters.shift()!;
        waiter.resolve(event);
      } else {
        eventQueue.push(event);
      }
      return;
    }
    if (frame.type === "response") {
      const id = String(frame.id ?? "");
      const pending = pendingRequests.get(id);
      if (!pending) return; // stale response (e.g. after cancel) — drop silently
      pendingRequests.delete(id);
      if ("error" in frame && isRecord(frame.error)) {
        const code = String(frame.error.code ?? "IPC_MALFORMED_FRAME") as IpcErrorCode;
        const message = String(frame.error.message ?? "service request failed");
        pending.reject(new ServiceClientError(code, message));
      } else {
        pending.resolve(frame.result);
      }
      return;
    }
    if (frame.type === "ping") {
      socket.write(encodeFrame({ type: "pong" }));
      return;
    }
    if (frame.type === "pong") {
      // Heartbeat ack — consumed in the subsequent commit that wires the
      // ping schedule. No-op here.
      return;
    }
    // Unknown frame types are ignored by design: the service may emit
    // additional kinds (e.g. `cancel-ack` in a future minor bump) and
    // older clients must not crash on them.
  }

  socket.on("data", (chunk: Buffer) => {
    try {
      decoder.push(chunk);
      const frames = decoder.drain();
      for (const frame of frames) {
        dispatchFrame(frame);
      }
    } catch (error) {
      // Protocol-level failure — terminate the connection and propagate
      // through the iterator (`throw`, per §4.7 split) and any in-flight
      // requests (`reject`).
      terminate(error instanceof ServiceClientError
        ? error
        : new ServiceClientError("IPC_MALFORMED_FRAME", "frame decode failed", error));
    }
  });
  socket.on("close", () => terminate(null));
  socket.on("error", (err) => terminate(
    new ServiceClientError("IPC_MALFORMED_FRAME", `socket error: ${err.message}`, err),
  ));

  // §4.3 — handshake. Send `hello` first; await `hello-ack` or
  // `hello-reject` before exposing the client to the caller.
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: unknown | null = null;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearClockTimeout(timer);
      socket.removeListener("close", onHandshakeClose);
      socket.removeListener("error", onHandshakeError);
      socket.removeListener("data", onFirstFrame);
      action();
    };
    const onHandshakeClose = (): void => settle(() => {
      reject(new ServiceClientError(
        "IPC_PROTOCOL_HANDSHAKE_FAILED",
        "service closed connection before sending hello-ack",
      ));
    });
    const onHandshakeError = (err: Error): void => settle(() => {
      reject(new ServiceClientError(
        "IPC_PROTOCOL_HANDSHAKE_FAILED",
        `handshake socket error: ${err.message}`,
        err,
      ));
    });
    socket.once("close", onHandshakeClose);
    socket.once("error", onHandshakeError);
    const onFirstFrame = (chunk: Buffer): void => {
      // Push to decoder, then peek the first parsed frame BEFORE the
      // regular `data` handler observes it. The handshake exchange is a
      // single-frame request/response; once the ack arrives we hand off
      // streaming control to the `data` listener installed below.
      socket.removeListener("data", onFirstFrame);
      try {
        decoder.push(chunk);
        const frames = decoder.drain();
        if (frames.length === 0) {
          // Partial handshake frame — wait for more.
          socket.once("data", onFirstFrame);
          return;
        }
        const [firstFrame, ...remaining] = frames;
        if (!isRecord(firstFrame) || typeof firstFrame.type !== "string") {
          settle(() => reject(new ServiceClientError("IPC_PROTOCOL_HANDSHAKE_FAILED", "handshake response missing `type`")));
          return;
        }
        if (firstFrame.type === "hello-reject") {
          const reason = String(firstFrame.reason ?? "IPC_PROTOCOL_VERSION_UNSUPPORTED") as IpcErrorCode;
          settle(() => reject(new ServiceClientError(
            reason === "IPC_PROTOCOL_VERSION_UNSUPPORTED" ? "IPC_PROTOCOL_VERSION_UNSUPPORTED" : "IPC_PROTOCOL_HANDSHAKE_FAILED",
            `service rejected handshake: ${String(firstFrame.reason ?? "unknown")}`,
          )));
          return;
        }
        if (firstFrame.type !== "hello-ack") {
          settle(() => reject(new ServiceClientError("IPC_PROTOCOL_HANDSHAKE_FAILED", `expected hello-ack, got \`${firstFrame.type}\``)));
          return;
        }
        // Drain any remaining frames buffered alongside hello-ack into
        // the regular dispatch path so we don't lose pre-handshake-ack
        // bursts.
        for (const frame of remaining) {
          dispatchFrame(frame);
        }
        settle(resolve);
      } catch (error) {
        settle(() => reject(error instanceof ServiceClientError
          ? error
          : new ServiceClientError("IPC_PROTOCOL_HANDSHAKE_FAILED", "handshake decode failed", error)));
      }
    };
    socket.once("data", onFirstFrame);
    timer = deadlineTimer(remainingConnectMs(), () => settle(() => {
      socket.destroy();
      reject(new ServiceClientError(
        "IPC_PROTOCOL_HANDSHAKE_FAILED",
        `timed out waiting for hello-ack from ${transportPath}`,
      ));
    }));
    socket.write(encodeFrame({
      type: "hello",
      protocolVersion,
      clientKind: CLIENT_KIND,
      clientVersion: CLIENT_VERSION,
    }));
  });

  const events: AsyncIterable<ServiceEvent> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<ServiceEvent>> {
          // Drain queued events first.
          if (eventQueue.length > 0) {
            return { value: eventQueue.shift()!, done: false };
          }
          // Iterator-completion semantics (§4.7): if the connection
          // has closed cleanly (no protocol error), return natural
          // completion. If a protocol error terminated the socket,
          // throw — consumers distinguish "reconnect" (return) from
          // "give up" (throw) without runtime classification.
          if (closed) {
            if (protocolError) throw protocolError;
            return { value: undefined, done: true };
          }
          // Wait for the next event or socket close.
          return new Promise<IteratorResult<ServiceEvent>>((resolve, reject) => {
            eventWaiters.push({
              resolve: (event) => {
                if (event === null) {
                  if (protocolError) reject(protocolError);
                  else resolve({ value: undefined, done: true });
                } else {
                  resolve({ value: event, done: false });
                }
              },
            });
          });
        },
        async return(): Promise<IteratorResult<ServiceEvent>> {
          terminate(null);
          return { value: undefined, done: true };
        },
      };
    },
  };

  const client: ServiceClient = {
    events,
    async request<M extends keyof RequestMethodMap>(
      method: M,
      params: RequestMethodMap[M]["params"],
      options: RequestOptions = {},
    ): Promise<RequestMethodMap[M]["result"]> {
      if (closed) {
        throw protocolError ?? new ServiceClientError("IPC_CLIENT_CLOSED", "service client is closed");
      }
      const id = randomUUID();
      return new Promise<RequestMethodMap[M]["result"]>((resolve, reject) => {
        let timer: unknown | null = null;
        const settle = (action: () => void): void => {
          if (timer !== null) clearClockTimeout(timer);
          action();
        };
        pendingRequests.set(id, {
          resolve: (value) => settle(() => resolve(value as RequestMethodMap[M]["result"])),
          reject: (error) => settle(() => reject(error)),
        });
        timer = deadlineTimer(options.timeoutMs, () => {
          if (!pendingRequests.delete(id)) return;
          try { socket.write(encodeFrame({ type: "cancel", id })); } catch {}
          reject(new ServiceClientError(
            "IPC_REQUEST_TIMEOUT",
            `service request \`${String(method)}\` timed out after ${options.timeoutMs}ms`,
          ));
        });
        try {
          socket.write(encodeFrame({ type: "request", id, method, params }));
        } catch (error) {
          pendingRequests.delete(id);
          settle(() => reject(error));
        }
      });
    },
    async close(): Promise<void> {
      terminate(null);
    },
  };

  return client;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

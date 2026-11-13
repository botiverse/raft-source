import pg from "pg";

// Caps how many new PG connections one pool is opening at the same moment.
//
// Neon's proxy limits connection attempts that are in progress per endpoint,
// not open connections: it refuses with "Failed to acquire permit to connect
// to the database. Too many database connection attempts are currently
// ongoing." while the database side has a few hundred of 4000 connections
// open. pg.Pool opens one connection per waiting request with no limit, so a
// burst of requests on an empty or idle-trimmed pool sends dozens of
// handshakes at once from every task (48 h to 10-12: 575 refusal waves, 68 of
// them on all 12 tasks in the same second).
//
// The gate holds a permit from the start of the handshake until it succeeds or
// fails; further connects queue in FIFO order. Queue time counts toward the
// pool's connectionTimeoutMillis: a client whose deadline passed while it was
// queued fails as soon as it reaches the front instead of opening a connection
// nobody waits for.

// A Neon handshake takes 600-700 ms (TLS + auth through the proxy), so 8
// permits let one task open about 12 connections a second. In refusal waves a
// task had p50 9 / p90 18 / max 45 handshakes in flight at once.
export const DEFAULT_PG_CONNECT_CONCURRENCY = 8;

/** `PG_CONNECT_CONCURRENCY` (default 8). 0 disables the cap. */
export function resolveConnectConcurrency(env: NodeJS.ProcessEnv): number {
  const raw = env.PG_CONNECT_CONCURRENCY;
  const parsed = raw === undefined || raw.trim() === "" ? DEFAULT_PG_CONNECT_CONCURRENCY : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_PG_CONNECT_CONCURRENCY;
  return Math.floor(parsed);
}

/**
 * Deadline for the transport part of a handshake: TCP connect plus TLS. Those
 * take milliseconds; one that stalls (a dead socket: 10-29 a task opened no
 * connection for 4 minutes while others did, #triage:e17fe621) would hold its
 * permit for the whole pool timeout, and 8 of them block every new connection
 * on the task. Startup and authentication are not covered: when Neon itself is
 * slow (11-02, handshakes p50 6.7 s that did complete) they stay under the
 * pool's connectionTimeoutMillis rather than turning slow into failed.
 */
export const DEFAULT_PG_CONNECT_TRANSPORT_TIMEOUT_MS = 2_500;

/** `PG_CONNECT_TRANSPORT_TIMEOUT_MS` (default 2500). 0 disables the deadline. */
export function resolveConnectTransportTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.PG_CONNECT_TRANSPORT_TIMEOUT_MS;
  const parsed = raw === undefined || raw.trim() === "" ? DEFAULT_PG_CONNECT_TRANSPORT_TIMEOUT_MS : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_PG_CONNECT_TRANSPORT_TIMEOUT_MS;
  return Math.floor(parsed);
}

/** Error code of a handshake given up at the transport deadline. */
export const CONNECT_TRANSPORT_TIMEOUT = "CONNECT_TRANSPORT_TIMEOUT";

/**
 * Where a handshake spent its time, in ms from its start (the permit). A phase
 * not reached is absent. `dns` is the lookup inside the TCP connect.
 */
export interface ConnectPhases {
  dnsMs?: number;
  tcpMs?: number;
  tlsMs?: number;
  /** Startup and authentication: transport done to ready for query. */
  authMs?: number;
}

export const CONNECT_PHASES = Symbol("slock.connectPhases");

/** The phases of this client's handshake (unset if never gated or not finished). */
export function connectPhases(client: object): ConnectPhases | undefined {
  return (client as { [CONNECT_PHASES]?: ConnectPhases })[CONNECT_PHASES];
}

type PhaseStream = {
  once?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  destroy?: (error?: Error) => void;
  destroyed?: boolean;
};
type PhaseConnection = {
  ssl?: unknown;
  stream?: PhaseStream;
  once?: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

/**
 * Times the phases of one handshake and enforces the transport deadline. On
 * the deadline the socket is destroyed first, so the connect fails (and its
 * permit is released by the caller) only once the socket is gone: the handshakes
 * really in progress never exceed the gate's limit.
 */
function watchHandshake(connection: PhaseConnection | undefined, transportTimeoutMs: number) {
  const startedAt = Date.now();
  const phases: ConnectPhases = {};
  let transportAt: number | undefined;
  let stage: "tcp" | "tls" | "auth" = "tcp";
  let timedOut = false;
  const transportDone = () => {
    if (transportAt !== undefined) return;
    transportAt = Date.now();
    stage = "auth";
    if (timer) clearTimeout(timer);
  };
  connection?.stream?.once?.("lookup", () => { phases.dnsMs = Date.now() - startedAt; });
  connection?.once?.("connect", () => {
    phases.tcpMs = Date.now() - startedAt;
    if (connection.ssl) stage = "tls";
    else transportDone();
  });
  // pg emits sslconnect once the server accepted TLS, then swaps in the TLS
  // socket: the transport is done when that socket's handshake completes.
  connection?.once?.("sslconnect", () => {
    connection.stream?.once?.("secureConnect", () => {
      phases.tlsMs = Date.now() - startedAt - (phases.tcpMs ?? 0);
      transportDone();
    });
  });
  const timer = transportTimeoutMs > 0
    ? setTimeout(() => {
      if (transportAt !== undefined) return;
      timedOut = true;
      const error = Object.assign(new Error(`Connection transport (TCP/TLS) timed out after ${transportTimeoutMs} ms`), { code: CONNECT_TRANSPORT_TIMEOUT });
      connection?.stream?.destroy?.(error);
    }, transportTimeoutMs)
    : undefined;
  timer?.unref?.();
  return {
    get stage() { return stage; },
    get timedOut() { return timedOut; },
    finish(succeeded: boolean): ConnectPhases {
      if (timer) clearTimeout(timer);
      if (succeeded && transportAt !== undefined) phases.authMs = Date.now() - transportAt;
      return phases;
    },
  };
}

export interface ConnectPermit {
  waitMs: number;
  release: () => void;
}

export interface ConnectGate {
  readonly limit: number;
  /** Rejects with `signal.reason` (and leaves the queue) if `signal` aborts before a permit is granted. */
  acquire(signal?: AbortSignal): Promise<ConnectPermit>;
  /** Handshakes holding a permit, and connects waiting for one. */
  state(): { connecting: number; queued: number };
}

export function createConnectGate(limit: number, now: () => number = Date.now): ConnectGate {
  let connecting = 0;
  const queue: Array<() => void> = [];

  const grant = (startedAt: number): ConnectPermit => {
    connecting += 1;
    let released = false;
    return {
      waitMs: now() - startedAt,
      release: () => {
        if (released) return;
        released = true;
        connecting -= 1;
        const next = queue.shift();
        if (next) next();
      },
    };
  };

  return {
    limit,
    acquire(signal) {
      const startedAt = now();
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (limit <= 0 || connecting < limit) return Promise.resolve(grant(startedAt));
      return new Promise<ConnectPermit>((resolve, reject) => {
        const onAbort = () => {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          reject(signal!.reason);
        };
        const waiter = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve(grant(startedAt));
        };
        queue.push(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    state: () => ({ connecting, queued: queue.length }),
  };
}

export const CONNECT_PERMIT_WAIT_MS = Symbol("slock.connectPermitWaitMs");

/** How long this client waited for a connect permit (unset if never gated). */
export function connectPermitWaitMs(client: object): number | undefined {
  return (client as { [CONNECT_PERMIT_WAIT_MS]?: number })[CONNECT_PERMIT_WAIT_MS];
}

type SocketLike = {
  destroyed?: boolean;
  once?: (event: "close", listener: () => void) => unknown;
  removeListener?: (event: "close", listener: () => void) => unknown;
};

type ConnectCallback = ((err: Error) => void) | ((err: null, client: pg.Client) => void);

/**
 * Low-cardinality category of a failed connect, for traces (never the message):
 * the driver/socket code when there is one, else what the message says.
 */
export function connectErrorCategory(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{2,32}$/.test(code)) return code;
  const message = err instanceof Error ? err.message : "";
  if (/waiting for a connect permit/i.test(message)) return "permit_wait_timeout";
  // pg-pool's own deadline ("timeout exceeded when trying to connect") or the
  // client's ("Connection terminated due to connection timeout").
  if (/timeout exceeded when trying to connect|due to connection timeout/i.test(message)) return "pool_connect_timeout";
  if (/connection terminated/i.test(message)) return "connection_terminated";
  if (/too many connections|remaining connection slots/i.test(message)) return "too_many_connections";
  return "other";
}

/**
 * One connect that did not produce a client. `stage` says where it stopped:
 * queued for a permit (the gate was full) or in the handshake itself.
 */
export interface ConnectAttemptFailure {
  stage: "permit_wait" | "handshake";
  permitWaitMs: number;
  /** Time in the handshake; 0 when it never got a permit. */
  handshakeMs: number;
  errorCategory: string;
  /** Handshake failures: the phase it was in, and the phases it got through. */
  handshakeStage?: "tcp" | "tls" | "auth";
  phases?: ConnectPhases;
}

/** A pg.Client subclass for `new pg.Pool({ Client })` whose connect() goes through `gate`. */
export function gatedClientClass(
  gate: ConnectGate,
  onPermit: (waitMs: number) => void = () => {},
  onAttemptFailed: (failure: ConnectAttemptFailure) => void = () => {},
  transportTimeoutMs: number = DEFAULT_PG_CONNECT_TRANSPORT_TIMEOUT_MS,
): typeof pg.Client {
  return class GatedClient extends pg.Client {
    // pg-pool constructs the client right before starting its connect timer,
    // so time since construction is never less than the timer's elapsed time.
    readonly #createdAtMs = Date.now();

    override connect(): Promise<pg.Client>;
    override connect(callback: ConnectCallback): void;
    override connect(callback?: ConnectCallback): Promise<pg.Client> | void {
      // pg-pool's connect timeout only destroys the client's socket, and the
      // caller hears nothing until connect() settles. So a queued client
      // watches its socket and leaves the queue as soon as it is closed,
      // instead of failing only once a permit frees up (up to ~2x the timeout
      // behind a hanging handshake).
      const stream = (this as unknown as { connection?: { stream?: SocketLike } }).connection?.stream;
      const queued = new AbortController();
      const onClose = () => queued.abort(new Error("Connection timed out while waiting for a connect permit"));
      stream?.once?.("close", onClose);
      const permitted = gate.acquire(queued.signal).finally(() => stream?.removeListener?.("close", onClose));
      permitted.catch((err: unknown) => {
        onAttemptFailed({
          stage: "permit_wait",
          permitWaitMs: Date.now() - this.#createdAtMs,
          handshakeMs: 0,
          errorCategory: connectErrorCategory(err),
        });
      });
      const connecting = permitted.then(async (permit) => {
        (this as { [CONNECT_PERMIT_WAIT_MS]?: number })[CONNECT_PERMIT_WAIT_MS] = permit.waitMs;
        onPermit(permit.waitMs);
        try {
          // pg-pool passes its options to the client, so this is the pool's
          // connectionTimeoutMillis. Its timer may not have fired yet when the
          // permit arrives at the deadline; don't dial in that case either.
          const self = this as unknown as {
            connection?: { stream?: { destroyed?: boolean } };
            _connectionTimeoutMillis?: number;
          };
          const timeoutMs = self._connectionTimeoutMillis ?? 0;
          if (self.connection?.stream?.destroyed || (timeoutMs > 0 && Date.now() - this.#createdAtMs >= timeoutMs)) {
            const late = new Error("Connection timed out while waiting for a connect permit");
            onAttemptFailed({ stage: "permit_wait", permitWaitMs: permit.waitMs, handshakeMs: 0, errorCategory: connectErrorCategory(late) });
            throw late;
          }
          const handshakeStartedAt = Date.now();
          const watch = watchHandshake((this as unknown as { connection?: PhaseConnection }).connection, transportTimeoutMs);
          try {
            const client = await super.connect();
            (this as { [CONNECT_PHASES]?: ConnectPhases })[CONNECT_PHASES] = watch.finish(true);
            return client;
          } catch (err) {
            const phases = watch.finish(false);
            onAttemptFailed({
              stage: "handshake",
              permitWaitMs: permit.waitMs,
              handshakeMs: Date.now() - handshakeStartedAt,
              errorCategory: watch.timedOut ? CONNECT_TRANSPORT_TIMEOUT : connectErrorCategory(err),
              handshakeStage: watch.stage,
              phases,
            });
            throw err;
          }
        } finally {
          permit.release();
        }
      });
      if (!callback) return connecting;
      const done = callback as (err: Error | null, client?: pg.Client) => void;
      connecting.then((client) => done(null, client), (err: Error) => done(err));
    }
  };
}

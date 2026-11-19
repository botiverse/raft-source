/**
 * Whether this process has entered the drain going-away phase.
 *
 * The going-away spread (server.ts `beginGoingAway`) closes a snapshot of the
 * long-lived connections taken at drain start. For 3–30 s after that the ALB
 * still routes new connections to the draining task (deployment thread
 * 3f292dc3), and a connection accepted then is outside the snapshot: it is
 * never closed gracefully and gets hard-cut when the deregistration delay
 * expires, a second drop for that client. So every long-lived connection
 * entry point (browser Socket.IO handshake, `/daemon/connect` upgrade, the
 * wake-hint SSE stream) refuses with 503 once this is set, and the client
 * retries with its own backoff until the ALB routes it to a healthy task.
 *
 * One process-wide latch, set once and never cleared: a draining task does
 * not come back.
 */
let draining = false;

export function markDraining(): void {
  draining = true;
}

export function isDraining(): boolean {
  return draining;
}

/** The three long-lived connection kinds a draining task refuses. */
export type DrainRefusalKind = "socketio" | "daemon" | "sse";

type DrainRefusalSink = (kind: DrainRefusalKind) => void;
let refusalSink: DrainRefusalSink | null = null;

/**
 * Where refusals are reported (server.ts wires the tracer). Each refusal is
 * one `slock.server.drain_refused` event with `reason=server_draining` and the
 * kind, so the intentional 503s can be counted per deploy and excluded from
 * 5xx stop lines and alert rules (AndyLok, deployment thread 3f292dc3). The
 * Socket.IO refusal happens in an Engine.IO middleware, below the layer that
 * creates request spans, so the event is the only record of it in telemetry.
 */
export function setDrainRefusalSink(sink: DrainRefusalSink | null): void {
  refusalSink = sink;
}

/** Report one refused connection. Telemetry only: never throws. */
export function recordDrainRefusal(kind: DrainRefusalKind): void {
  try {
    refusalSink?.(kind);
  } catch {
    // Telemetry must not change the refusal.
  }
}

export function __resetDrainStateForTests(): void {
  draining = false;
  refusalSink = null;
}

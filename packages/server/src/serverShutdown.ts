export interface ServerShutdownDeps {
  stopAcceptingHttp(): Promise<void>;
  releaseMachineOwnership(): Promise<void>;
  /** Let background workers finish the operation in flight (bounded by each worker). */
  settleWorkers(): Promise<void>;
  flushTraces(): Promise<void>;
  /**
   * Close the browser socket transports and SSE streams still open (bounded).
   * Resolves before shared state (Redis, the Socket.IO adapter) shuts down.
   */
  closeRemainingConnections(): Promise<void>;
  shutdownSharedState(): Promise<void>;
  warn(message: string, reason: unknown): void;
}

/**
 * Start the HTTP drain synchronously before releasing machine ownership.
 * Existing requests and the remaining shutdown work may then drain in
 * parallel, but no new request can enter after the owner mapping is removed.
 *
 * Shared state goes last, after the remaining browser sockets and SSE streams
 * are closed: a socket still open once the Redis adapter is gone silently
 * misses every cross-replica emit until the process exits (deployment thread
 * 3f292dc3). Closing them runs next to the HTTP drain rather than after it,
 * because `server.close()` waits for every open connection, upgraded
 * WebSockets and SSE responses included, so it would not finish while they
 * are open.
 */
export async function shutdownServerRuntime(deps: ServerShutdownDeps): Promise<void> {
  const httpDrain = deps.stopAcceptingHttp();
  const results = await Promise.allSettled([
    httpDrain,
    deps.releaseMachineOwnership(),
    // Traces flush after the workers settle, so their last spans are written.
    deps.settleWorkers().then(() => deps.flushTraces()),
    deps.closeRemainingConnections(),
  ]);

  const labels = ["drain HTTP server", "shutdown agent orchestrator", "settle workers and flush server traces", "close remaining browser connections"];
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      deps.warn(`Failed to ${labels[index]}`, result.reason);
    }
  }

  await deps.shutdownSharedState();
}

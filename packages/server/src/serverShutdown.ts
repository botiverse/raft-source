export interface ServerShutdownDeps {
  stopAcceptingHttp(): Promise<void>;
  releaseMachineOwnership(): Promise<void>;
  flushTraces(): Promise<void>;
  shutdownSharedState(): Promise<void>;
  warn(message: string, reason: unknown): void;
}

/**
 * Start the HTTP drain synchronously before releasing machine ownership.
 * Existing requests and the remaining shutdown work may then drain in
 * parallel, but no new request can enter after the owner mapping is removed.
 */
export async function shutdownServerRuntime(deps: ServerShutdownDeps): Promise<void> {
  const httpDrain = deps.stopAcceptingHttp();
  const results = await Promise.allSettled([
    httpDrain,
    deps.releaseMachineOwnership(),
    deps.flushTraces(),
  ]);

  const labels = ["drain HTTP server", "shutdown agent orchestrator", "flush server traces"];
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      deps.warn(`Failed to ${labels[index]}`, result.reason);
    }
  }

  await deps.shutdownSharedState();
}

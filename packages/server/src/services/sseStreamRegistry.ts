import type { ServerResponse } from "node:http";

/**
 * Registry of open SSE (text/event-stream) responses so the going-away
 * phase can end them deliberately instead of letting the shutdown deadline
 * sever them mid-stream (task #261).
 *
 * SSE responses are in-flight requests that never finish on their own, so
 * `server.close()` would otherwise hang on them until the process is killed.
 * Ending the stream here lets the client reconnect immediately against a
 * healthy task.
 */
export interface SseStreamRegistry {
  register(res: ServerResponse): void;
  unregister(res: ServerResponse): void;
  /** End one stream and drop it. Returns false if it was already ended. */
  end(res: ServerResponse): boolean;
  /** The streams open right now, for the paced drain going-away. */
  snapshot(): ServerResponse[];
  readonly size: number;
}

export function createSseStreamRegistry(): SseStreamRegistry {
  const streams = new Set<ServerResponse>();
  return {
    register(res) {
      streams.add(res);
    },
    unregister(res) {
      streams.delete(res);
    },
    end(res) {
      streams.delete(res);
      if (res.writableEnded) return false;
      res.end();
      return true;
    },
    snapshot() {
      return [...streams];
    },
    get size() {
      return streams.size;
    },
  };
}

/**
 * Process-wide registry used by the HTTP routes and the drain going-away
 * phase. Module-level because the route routers are themselves module-level
 * singletons.
 */
export const sharedSseStreamRegistry: SseStreamRegistry = createSseStreamRegistry();

import { MIDDLEWARE_PHASE_FINISHED_EVENT } from "../tracing/semanticTrace";

/** The `phase` of the pre-handler middleware reads' `db.query.finished` (middleware/auth.ts). */
const MIDDLEWARE_QUERY_PHASES = new Set(["auth", "server_membership"]);

/**
 * A request span's events without what the pre-handler middleware records
 * (`middleware.phase.finished` and the middleware's own `db.query.finished`),
 * for route tests that pin the handler's phases and query shape. The
 * middleware events have their own test (middleware/middlewarePhaseTrace.api.test.ts).
 */
export function handlerTraceEvents<E extends { name: string; attrs?: Record<string, unknown> }>(events: readonly E[]): E[] {
  return events.filter((event) => {
    if (event.name === MIDDLEWARE_PHASE_FINISHED_EVENT) return false;
    if (event.name === "db.query.finished" && MIDDLEWARE_QUERY_PHASES.has(String(event.attrs?.phase))) return false;
    return true;
  });
}

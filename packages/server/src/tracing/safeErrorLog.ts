import { sanitizeRouteErrorMessage } from "./routeFailure.js";

/** Logging boundary: never pass driver params, detail, cause or stack to console. */
export function serializeErrorForLog(error: unknown): { name: string; message: string } {
  let current = error;
  const seen = new Set<Error>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (/\bfailed query:/i.test(current.message)) {
      return { name: "DatabaseError", message: "Database query failed" };
    }
    current = current.cause;
  }
  return {
    name: "Error",
    message: error instanceof Error ? sanitizeRouteErrorMessage(error.message) : "Non-Error failure",
  };
}

import type { NextFunction, Request, Response, Router } from "express";
import { UUID_RE } from "./messageId";
import { addTraceEvent } from "../tracing/semanticTrace";
import { refuse } from "./refusal";

/**
 * Uniform 404 for non-UUID path parameters (task #12).
 *
 * A mistyped or garbage path segment (e.g. `/api/channels/threads` falling
 * through to `/channels/:id`) names no resource; letting it reach the query
 * layer raises a Postgres uuid-cast error and comes back as a 500. Registering
 * a guard per param name via `router.param` makes every matching route answer
 * 404 before its handler runs:
 *
 *   guardUuidPathParams(channelRouter, { id: "Channel", inviteId: "Invite" });
 *
 * Only register params that are UUID-typed on EVERY route of that router
 * (e.g. never `taskNumber` or `targetType`). The check uses the shared
 * UUID_RE (shape-only, any version nibble): a well-formed but unknown UUID
 * reaches the handler and gets the resource's ordinary not-found path, which
 * is the same 404 either way.
 *
 * A router whose handlers answer not-found with a machine-readable body
 * (e.g. `{ error, code: "agent_missing" }`) passes that body instead of a
 * resource name, so a malformed id gets exactly the unknown id's answer.
 */
export function guardUuidPathParams(
  router: Router,
  params: Readonly<Record<string, string | UuidPathParamNotFoundBody>>,
): void {
  for (const [name, resource] of Object.entries(params)) {
    const body = typeof resource === "string" ? { error: `${resource} not found` } : resource;
    router.param(name, (req: Request, res: Response, next: NextFunction, value: unknown) => {
      if (typeof value !== "string" || !UUID_RE.test(value)) {
        // This 404 answers before the handler, so the handler's own reject
        // events never fire (#triage:#503: a thread lookup 404 had no reason).
        // Record which param and the value's shape, never the value itself.
        addTraceEvent("path_param.rejected", { param: name, ...pathParamShape(value) });
        // A coded body goes out as the handler's own refuse() would write it
        // (the envelope's `errorCode` too), or the two answers would differ.
        if (typeof resource === "string") res.status(404).json(body);
        else refuse(res, 404, resource);
        return;
      }
      next();
    });
  }
}

/** The 404 body a guarded param answers with, when a resource name is not enough. */
export interface UuidPathParamNotFoundBody {
  error: string;
  code: string;
}

/**
 * The shape of a rejected path value without the value: its length and each
 * character mapped to a class (a = ASCII letter, 9 = digit, `-_.:~` kept, anything else ?),
 * cut to 48 characters. `temp-1731` -> `aaaa-9999`; a UUID with one bad
 * character still shows where it broke.
 */
export function pathParamShape(value: unknown): { value_length: number; value_shape: string } {
  const text = typeof value === "string" ? value : String(value);
  const shape = text.slice(0, 48).replace(/[A-Za-z]/g, "a").replace(/[0-9]/g, "9").replace(/[^a9\-_.:~]/g, "?");
  return { value_length: text.length, value_shape: shape };
}

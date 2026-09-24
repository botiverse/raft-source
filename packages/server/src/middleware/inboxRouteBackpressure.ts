import type { RequestHandler, Response } from "express";
import { addTraceEvent } from "../tracing/semanticTrace.js";
import {
  InboxBackpressureRejectedError,
  type InboxRouteBackpressure,
  createDefaultInboxRouteBackpressure,
} from "../services/inboxRouteBackpressure.js";

const defaultInboxRouteBackpressure = createDefaultInboxRouteBackpressure();
const INBOX_BACKPRESSURE_ADMISSION = Symbol("inboxBackpressureAdmission");

export type InboxRouteBackpressureAdmission = {
  release(): void;
};

type ResponseWithAdmission = Response & {
  [INBOX_BACKPRESSURE_ADMISSION]?: InboxRouteBackpressureAdmission;
};

export function getInboxRouteBackpressureAdmission(
  res: Response,
): InboxRouteBackpressureAdmission | undefined {
  return (res as ResponseWithAdmission)[INBOX_BACKPRESSURE_ADMISSION];
}

export const inboxRouteBackpressureMiddleware: RequestHandler = async (req, res, next) => {
  if (req.method !== "GET" || req.path !== "/inbox") {
    next();
    return;
  }

  // This middleware can terminate before Express reaches the concrete Router
  // layer. Preserve the already-known constant route for bounded telemetry
  // instead of emitting the overload response under the `unmatched` bucket.
  req.observedRoutePattern = "/api/channels/inbox";

  const backpressure = (
    req.app.get("inboxRouteBackpressure") as InboxRouteBackpressure | undefined
  ) ?? defaultInboxRouteBackpressure;
  const abortController = new AbortController();
  const abortQueuedRequest = () => abortController.abort();
  req.once("aborted", abortQueuedRequest);

  let lease;
  try {
    lease = await backpressure.acquire({ signal: abortController.signal });
    addTraceEvent("inbox.backpressure.admitted", {
      queued: lease.queued,
      wait_ms: Math.round(lease.waitMs),
      active: lease.snapshot.active,
      queue_depth: lease.snapshot.queued,
      max_concurrency: lease.snapshot.maxConcurrency,
      max_queue: lease.snapshot.maxQueue,
    });
  } catch (error) {
    req.off("aborted", abortQueuedRequest);
    if (!(error instanceof InboxBackpressureRejectedError)) {
      next(error);
      return;
    }
    const snapshot = backpressure.snapshot();
    addTraceEvent("inbox.backpressure.rejected", {
      reason: error.reason,
      active: snapshot.active,
      queue_depth: snapshot.queued,
      max_concurrency: snapshot.maxConcurrency,
      max_queue: snapshot.maxQueue,
    });
    if (error.reason === "request_aborted") return;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Retry-After", "1");
    res.status(429).json({
      code: error.code,
      error: "Inbox is busy; retry later",
      reason: error.reason,
    });
    return;
  }

  req.off("aborted", abortQueuedRequest);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    res.off("finish", release);
    res.off("close", release);
    lease.release();
    const snapshot = backpressure.snapshot();
    addTraceEvent("inbox.backpressure.released", {
      active: snapshot.active,
      queue_depth: snapshot.queued,
      max_concurrency: snapshot.maxConcurrency,
      max_queue: snapshot.maxQueue,
    });
  };
  (res as ResponseWithAdmission)[INBOX_BACKPRESSURE_ADMISSION] = { release };
  res.once("finish", release);
  res.once("close", release);
  next();
};

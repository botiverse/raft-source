/**
 * The request id of a confirmed card's dispatched request (dispatchOwnerRoute,
 * assistantOwnerActionCards.ts), for the code that request runs: the route's
 * own audit writers record it (integrationAuditService fills an audit row's
 * `request_id` with it when the writer passes none), and the card's own audit
 * event carries the same id, so an investigator joins the route's audit row to
 * the card that ran it. Its own module, with no imports of the card code, so
 * the audit service can read it.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const dispatch = new AsyncLocalStorage<{ requestId: string }>();

/** Runs `fn` (the app handling a dispatched request) with `requestId` as the dispatch's id. */
export function runInOwnerDispatch<T>(requestId: string, fn: () => T): T {
  return dispatch.run({ requestId }, fn);
}

/** The id of the dispatched request this code runs inside; null outside one. */
export function ownerDispatchRequestId(): string | null {
  return dispatch.getStore()?.requestId ?? null;
}

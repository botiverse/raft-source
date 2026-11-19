/**
 * Marks a request dispatchOwnerRoute made (services/assistantOwnerActionCards.ts):
 * a JS Symbol on the request object, so no client can set it. A marked request
 * never comes back in as the assistant (middleware/assistantAsOwner.ts) and
 * never confirms an owner-action or request:prepare card (routes/actions.ts):
 * no dispatch from inside a dispatch.
 *
 * Its own module so a route's gate (routes/secondFactor.ts) can write to the
 * mark without importing the dispatcher.
 */
export const OWNER_DISPATCH_MARK: unique symbol = Symbol("raft.assistantOwnerDispatch");

/** What the mark holds: the card that dispatched the request, and the request's own id (its audit rows carry it). */
export interface OwnerDispatchMark {
  cardMessageId: string;
  requestId: string;
  /**
   * Set by the step-up gate when it refuses this request for a second step
   * (noteOwnerDispatchStepUp). The dispatcher reports it on the answer; a
   * request:prepare card branches on it, never on a 403 body's code.
   */
  stepUpRequired?: boolean;
}

/** Whether `req` is one dispatchOwnerRoute made. */
export function isOwnerDispatch(req: object): boolean {
  return (req as { [OWNER_DISPATCH_MARK]?: unknown })[OWNER_DISPATCH_MARK] !== undefined;
}

/** The dispatch's mark on `req`, when dispatchOwnerRoute made it. */
export function ownerDispatchMarkOf(req: object): OwnerDispatchMark | null {
  return (req as { [OWNER_DISPATCH_MARK]?: OwnerDispatchMark })[OWNER_DISPATCH_MARK] ?? null;
}

/** The step-up gate refused `req` for a second step: says so on its dispatch mark, when it has one. */
export function noteOwnerDispatchStepUp(req: object | undefined): void {
  const mark = req ? ownerDispatchMarkOf(req) : null;
  if (mark) mark.stepUpRequired = true;
}

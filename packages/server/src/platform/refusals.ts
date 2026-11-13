// Platform entry point: the Server's refusal envelope (#wg-ax:#13,
// docs/contracts/agent-api-refusals.md) for an app. An operation that answers
// through core's transport (an AppError) builds its body with refusalBody, so
// core writes the envelope as it is; a route of the app's own (an internal
// router) answers with refuse(). Either way `error` is one sentence that says
// why and what to change, naming no command; the step goes in `next`.
export { rateLimitRefusal, refusalBody, refuse, RefusalError, type RefusalInput, type RefusalStatus } from "../lib/refusal";

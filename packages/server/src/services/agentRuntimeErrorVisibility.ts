import {
  boundedRuntimeErrorDetail,
  classifyRuntimeErrorCode,
  isRuntimeErrorDetailActivity,
  memberRuntimeErrorMessage,
  type AgentRuntimeErrorState,
  type RuntimeErrorCode,
} from "@botiverse/raft-shared";

/**
 * #wg-rbac:#57 — the server's one projection of an agent's runtime error per
 * viewer. A manager (the agent's human creator, a user with `editAgents`, a
 * personal assistant's owner) reads the scrubbed, capped text and the code;
 * everyone else reads the code and its fixed sentence (or the generic
 * message), never the error's text. Applied on every outbound path, also to
 * rows stored before the server scrubbed at ingest.
 */
export type RuntimeErrorViewer = "manager" | "member";

/** The code of a stored error (its typed class first, else its text). */
export function runtimeErrorCodeOf(error: Pick<AgentRuntimeErrorState, "message" | "errorClass" | "requiredAction"> | null | undefined): RuntimeErrorCode | null {
  if (!error) return null;
  return classifyRuntimeErrorCode({ message: error.message, errorClass: error.errorClass ?? null, requiredAction: error.requiredAction ?? null });
}

export function projectRuntimeErrorState(
  error: AgentRuntimeErrorState | null | undefined,
  viewer: RuntimeErrorViewer,
): AgentRuntimeErrorState | null {
  if (!error) return null;
  const code = runtimeErrorCodeOf({ ...error, message: boundedRuntimeErrorDetail(error.message) });
  const { code: _storedCode, ...rest } = error;
  return {
    ...rest,
    message: viewer === "manager" ? boundedRuntimeErrorDetail(error.message) : memberRuntimeErrorMessage(code),
    ...(code ? { code } : {}),
  };
}

/**
 * The code and text of a runtime error activity's detail for one viewer
 * (isRuntimeErrorDetailActivity: an `error` activity, or a runtime-error /
 * crash detail kind on any activity). The stored error answers the code when
 * it is the error the activity shows (same scrubbed text); otherwise the
 * detail's text does. Any other activity is returned as is.
 */
export function projectRuntimeErrorActivityDetail(
  input: { activity: string | null | undefined; detailKind?: string | null; detail: string; lastRuntimeError?: AgentRuntimeErrorState | null },
  viewer: RuntimeErrorViewer,
): { detail: string; errorCode?: RuntimeErrorCode } {
  if (!isRuntimeErrorDetailActivity(input)) return { detail: input.detail };
  const scrubbed = boundedRuntimeErrorDetail(input.detail);
  const stored = input.lastRuntimeError;
  const code = stored && boundedRuntimeErrorDetail(stored.message) === scrubbed
    ? runtimeErrorCodeOf({ ...stored, message: scrubbed })
    : classifyRuntimeErrorCode({ message: scrubbed });
  return {
    detail: viewer === "manager" ? scrubbed : memberRuntimeErrorMessage(code),
    ...(code ? { errorCode: code } : {}),
  };
}

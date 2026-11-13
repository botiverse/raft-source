// A question card's answer sent as the page goes away (question-card spec
// §5.10, questionSubmitUndo.ts): pagehide, or the tab hidden (mobile Safari
// may never fire pagehide). An axios request started then is routinely
// cancelled with the page, so this is a `fetch` with `keepalive`, which the
// browser completes after unload. The same request as executeActionCard
// (actionCardCommon.tsx) through the api client (api/client.ts): the same URL
// under RUNTIME_API_BASE, the bearer token, the current server, the client
// headers, the same body; the browser's default `same-origin` credentials, as
// axios sends without withCredentials. What it cannot do, the page being
// gone: ask "Verify it's you"; such a failure is read as any other
// (readActionCardFormSubmitFailure). It keeps what the api client's
// interceptors do for every request: a `traceparent` span
// (startWebHttpClientSpan), a failure's trace id for the next error toast
// (recordFailedRequestTraceId), the pending-deletion page on 403
// account_deletion_pending; and a 401 while the page is still shown (the tab
// was hidden, not closed) is sent once more through the api client, which
// refreshes the token. The execute route itself is not keyed: one send per
// answer is the caller's (the undo hook takes the waiting answer before
// sending it, so it goes once).

import type { ActionCardFormSubmission } from "@botiverse/raft-shared";
import { RUNTIME_API_BASE } from "../../runtimeEndpoints";
import { noteAccountDeletionPendingFrom } from "../../store/accountDeletionPending";
import { useServerStore } from "../../store/serverStore";
import { clientRequestHeaders } from "../../utils/clientPlatformHint";
import { recordFailedRequestTraceId } from "../../utils/requestTraceId";
import { startWebHttpClientSpan } from "../../utils/webHttpClientTrace";
import type { WebHttpClientSpan } from "../../utils/webHttpClientTrace";
import { executeActionCard } from "./actionCardCommon";
import type { ActionCardMutationResponse } from "./actionCardCommon";

export async function executeActionCardKeepalive(
  messageId: string,
  confirmationVersion: number | undefined,
  form: ActionCardFormSubmission,
): Promise<ActionCardMutationResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...clientRequestHeaders() };
  const token = localStorage.getItem("slock_access_token");
  if (token) headers.Authorization = `Bearer ${token}`;
  const serverId = useServerStore.getState().current?.id;
  if (serverId) headers["X-Server-Id"] = serverId;
  let span: WebHttpClientSpan | null = null;
  try {
    span = startWebHttpClientSpan("POST");
    headers.traceparent = span.traceparent;
  } catch {
    // Tracing is diagnostic only: the answer goes without it.
  }
  const url = `${RUNTIME_API_BASE.replace(/\/$/, "")}/actions/${messageId}/execute`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      keepalive: true,
      credentials: "same-origin",
      headers,
      // As axios writes it: an undefined version is left out.
      body: JSON.stringify({ expectedState: "prepared", expectedConfirmationVersion: confirmationVersion, form }),
    });
  } catch (err) {
    endSpan(span, { requestUrl: url });
    throw err;
  }
  const data: unknown = await response.json().catch(() => null);
  endSpan(span, { statusCode: response.status, responseData: data, requestUrl: url });
  if (response.ok) return data as ActionCardMutationResponse;
  // The shape the api client's helpers and readActionCardFormSubmitFailure read from an axios error.
  const error = Object.assign(new Error(`Request failed with status code ${response.status}`), {
    response: { status: response.status, data, headers: { "x-trace-id": response.headers.get("x-trace-id") ?? undefined } },
    config: { headers },
  });
  noteAccountDeletionPendingFrom(error);
  if (response.status === 401 && document.visibilityState === "visible") return executeActionCard(messageId, confirmationVersion, form);
  if (response.status !== 401) recordFailedRequestTraceId(error);
  throw error;
}

function endSpan(span: WebHttpClientSpan | null, input: Parameters<WebHttpClientSpan["end"]>[0]) {
  try {
    span?.end(input);
  } catch {
    // As startWebHttpClientSpan: failure-isolated.
  }
}

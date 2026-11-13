import axios, { AxiosHeaders } from "axios";
import type { AxiosAdapter } from "axios";
import { useServerStore } from "../store/serverStore";
import { clearAllLastCounts } from "../store/lastCounts";
import { purgeStoredMachineKeys } from "../store/machineKeyStorage";
import { clientRequestHeaders } from "../utils/clientPlatformHint";
import {
  authRefreshAttemptIdFromError,
  isMissingRefreshTokenError,
} from "../utils/authErrors";
import { getProtectedRequestAuthFailureAction } from "../utils/protectedRequestAuthPolicy";
import { refreshTokensWithDedupe } from "../utils/refreshCoordinator";
import { getAuthRuntimeSnapshot } from "../utils/authSessionRuntime";
import { emitAuthTraceAndFlushBeforeUnload } from "../utils/webAuthTrace";
import {
  attachWebHttpClientTrace,
  continueWebHttpClientTrace,
  finishWebHttpClientTrace,
} from "../utils/webHttpClientTrace";
import { readBootFetch, takeBootFetch } from "../boot/bootPrefetch";
import { RUNTIME_API_BASE } from "../runtimeEndpoints";
import { recordFailedRequestTraceId } from "../utils/requestTraceId";
import { forgetLocalUser } from "../store/localTables/persistence";
import { localTableSession } from "../store/localTables/storeWriters";
import { forgetDrafts } from "../store/draftStorage";
import { noteAccountDeletionPendingFrom } from "../store/accountDeletionPending";
import { redirectForSsoRequired } from "../utils/ssoSignIn";
import { noteWriteSent, noteWriteSettled } from "../utils/inFlightWrites";

const api = axios.create({
  baseURL: RUNTIME_API_BASE,
});

/**
 * A GET the boot script already sent (boot/bootPrefetch.ts, the same URL and
 * headers) takes its answer instead of going out again; anything else, or a
 * boot request that failed, goes to the network. After the request
 * interceptor, so the headers compared are the ones that would be sent; before
 * the response interceptors, which see an adopted answer as any other.
 */
const networkAdapter = api.defaults.adapter;
const bootPrefetchAdapter: AxiosAdapter = async (config) => {
  const toNetwork = () => axios.getAdapter(networkAdapter)(config);
  if ((config.method ?? "get").toLowerCase() !== "get" || config.signal?.aborted) return toNetwork();
  const early = takeBootFetch(api.getUri(config), AxiosHeaders.from(config.headers).toJSON());
  const answer = early ? await readBootFetch(early) : null;
  if (!early || !answer || config.signal?.aborted || (config.validateStatus && !config.validateStatus(answer.status))) return toNetwork();
  continueWebHttpClientTrace(config, early.h.traceparent, early.t);
  return {
    data: answer.data,
    status: answer.status,
    statusText: answer.statusText,
    headers: AxiosHeaders.from(answer.headers),
    config,
    request: {},
  };
};
api.defaults.adapter = bootPrefetchAdapter;

// A config-less third-party rejection cannot be correlated back to an attempt.
// Model it as already terminal so it never enters auth retry logic.
const CONFIGLESS_REQUEST = { _retry: true };

// Request interceptor — attach token and server ID. Synchronous (it awaits
// nothing): axios then sends the request inside the api.get call. Otherwise it
// goes out a microtask later, after React has rendered and run the effects of
// any synchronous update made in the same input handler, so a read sent at a
// click (conversationPrefetch, openThread) left only after the view rendered.
// So it reads the token and the server at the api.* call itself: logout's
// api.post (before its storage is cleared) carries the old token and server
// header, which is harmless (/auth/logout reads only the body's refresh
// token). And the request is already sent when the call returns: aborting its
// signal in the same tick cancels it in flight, it no longer keeps it unsent.
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("slock_access_token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  // A request that names its server explicitly (e.g. a top-level page acting
  // on a server other than the current one) keeps it. `false` sends none (a
  // route that reads no server, e.g. a public Artifact's; axios drops a false
  // header). Naming nothing (undefined, or a caller's null or empty id) gets
  // the current server.
  const named = config.headers["X-Server-Id"];
  const serverId = useServerStore.getState().current?.id;
  if (named !== false && !named && serverId) {
    config.headers["X-Server-Id"] = serverId;
  }
  // Which client this is, for a signup's account_created (task #13), and its
  // versions, for the request's trace (task #15 in #proj-analytics).
  for (const [name, value] of Object.entries(clientRequestHeaders())) config.headers[name] = value;

  // Attach only after synchronous request preparation succeeds. If preparation
  // rejects, no adapter/network attempt exists and therefore no span should be
  // left waiting for a response interceptor that Axios cannot associate.
  attachWebHttpClientTrace(config);
  // A write in flight holds a reload onto a new Web release (utils/reloadSafety).
  noteWriteSent(config, config.method);
  return config;
}, undefined, { synchronous: true });

export async function clearAuthAndRedirect() {
  try {
    await emitAuthTraceAndFlushBeforeUnload("slock.auth.session_cleared", {
      clearSessionCaller: "clearAuthAndRedirect",
      logoutTrigger: "terminal_verdict",
    });
  } finally {
    // The session's local tables (store/localTables); the next boot finishes the delete if the page leaves first.
    forgetLocalUser(localTableSession());
    // And its composer drafts, with any pending write dropped so the unload flush cannot restore them.
    forgetDrafts(localTableSession());
    localStorage.removeItem("slock_access_token");
    localStorage.removeItem("slock_refresh_token");
    // Task #164: the saved unread counts and Activity rows belong to the
    // session that just ended (401, refresh refused), not to whoever signs in next.
    clearAllLastCounts();
    purgeStoredMachineKeys();
    window.location.href = "/";
  }
}

// Response interceptor — handle 401 with deduplicated token refresh
api.interceptors.response.use(
  (response) => {
    noteWriteSettled(response.config);
    finishWebHttpClientTrace(response.config, {
      statusCode: response.status,
      responseData: response.data,
      responseHeaders: response.headers,
    });
    return response;
  },
  async (error) => {
    const originalRequest = error.config ?? CONFIGLESS_REQUEST;
    noteWriteSettled(error.config);
    finishWebHttpClientTrace(originalRequest, {
      statusCode: error.response?.status,
      cancelled: axios.isCancel(error),
      responseData: error.response?.data,
      responseHeaders: error.response?.headers,
    });
    // An error toast raised right after this failure shows its trace id (#proj-o11y:#18).
    // Not for a cancelled request, nor a 401, which is refreshed and retried below.
    if (!axios.isCancel(error) && error.response?.status !== 401) recordFailedRequestTraceId(error);

    // A scheduled account deletion refuses every other API (403
    // `account_deletion_pending`): App then shows the pending-deletion page
    // in place of the app (store/accountDeletionPending.ts).
    noteAccountDeletionPendingFrom(error);
    // A Server that requires its single sign-on (403 SSO_REQUIRED): sign in with it and come back.
    redirectForSsoRequired(error);

    // Don't retry auth endpoints or already-retried requests. A wrong password
    // sent inline (POST /me/account/deletion's `password`) is a 401 too, but
    // not about this sign-in: refreshing and resending it would count it twice.
    if (
      error.response?.status === 401 &&
      error.response?.data?.code !== "password_incorrect" &&
      !originalRequest._retry &&
      !originalRequest.url?.includes("/auth/")
    ) {
      originalRequest._retry = true;

      try {
        const { accessToken: newToken } = await refreshTokensWithDedupe();

        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        return api(originalRequest);
      } catch (refreshError: any) {
        const status = refreshError?.response?.status as number | undefined;
        const noRefreshToken = isMissingRefreshTokenError(refreshError);
        const action = getProtectedRequestAuthFailureAction({
          status,
          hasRefreshToken: !noRefreshToken,
          // task #632: a visitor who never signed in holds neither token, and a
          // 401 for them means "this needs a login", not "your session ended".
          // Read at failure time, which can race a concurrent logout that has
          // already cleared storage — but that request is redirecting anyway, so
          // the page outcome is the same.
          hasAccessToken: localStorage.getItem("slock_access_token") !== null,
          authRefreshAttemptId: authRefreshAttemptIdFromError(refreshError),
          ...getAuthRuntimeSnapshot(),
        });
        if (action === "logout") {
          void clearAuthAndRedirect();
          return;
        }

        // "no-session" joins "keep-session" / "defer-to-auth-restore" here: the
        // caller sees the 401 and decides for itself. Nothing is cleared and the
        // page is not navigated.
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);

export default api;

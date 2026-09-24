import axios from "axios";
import { useServerStore } from "../store/serverStore";
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
  finishWebHttpClientTrace,
} from "../utils/webHttpClientTrace";
import { assertValidDesktopRuntimeEnvironment, RUNTIME_API_BASE } from "../desktopRuntimeEnvironment";

const api = axios.create({
  baseURL: RUNTIME_API_BASE,
});

// A config-less third-party rejection cannot be correlated back to an attempt.
// Model it as already terminal so it never enters auth retry logic.
const CONFIGLESS_REQUEST = { _retry: true };

// Request interceptor — attach token and server ID
api.interceptors.request.use((config) => {
  assertValidDesktopRuntimeEnvironment();

  const token = localStorage.getItem("slock_access_token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  const serverId = useServerStore.getState().current?.id;
  if (serverId) {
    config.headers["X-Server-Id"] = serverId;
  }

  // Attach only after synchronous request preparation succeeds. If preparation
  // rejects, no adapter/network attempt exists and therefore no span should be
  // left waiting for a response interceptor that Axios cannot associate.
  attachWebHttpClientTrace(config);
  return config;
});

export async function clearAuthAndRedirect() {
  try {
    await emitAuthTraceAndFlushBeforeUnload("slock.auth.session_cleared", {
      clearSessionCaller: "clearAuthAndRedirect",
      logoutTrigger: "terminal_verdict",
    });
  } finally {
    localStorage.removeItem("slock_access_token");
    localStorage.removeItem("slock_refresh_token");
    window.location.href = "/";
  }
}

// Response interceptor — handle 401 with deduplicated token refresh
api.interceptors.response.use(
  (response) => {
    finishWebHttpClientTrace(response.config, {
      statusCode: response.status,
      responseData: response.data,
      responseHeaders: response.headers,
    });
    return response;
  },
  async (error) => {
    const originalRequest = error.config ?? CONFIGLESS_REQUEST;
    finishWebHttpClientTrace(originalRequest, {
      statusCode: error.response?.status,
      cancelled: axios.isCancel(error),
      responseData: error.response?.data,
      responseHeaders: error.response?.headers,
    });

    // Don't retry auth endpoints or already-retried requests
    if (
      error.response?.status === 401 &&
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
          authRefreshAttemptId: authRefreshAttemptIdFromError(refreshError),
          ...getAuthRuntimeSnapshot(),
        });
        if (action === "logout") {
          void clearAuthAndRedirect();
          return;
        }

        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);

export default api;

import { create } from "zustand";
import api from "../api/client";
import { disconnectSocket, updateSocketAuthFromStorage } from "../api/socket";
import {
  shouldKeepSessionAfterLoadUserFailure,
  shouldLogoutAfterRefreshFailure,
  shouldLogoutAfterPostRefreshLoadUserFailure,
  shouldRetryLoadUserAfterError,
} from "../utils/authSessionPolicy";
import { refreshTokensWithDedupe } from "../utils/refreshCoordinator";
import { authRefreshAttemptIdFromError } from "../utils/authErrors";
import { authTokenSync } from "../utils/authTokenSync";
import {
  HOST_ACCESS_TOKEN_BINDING_STORAGE_KEY,
  accessTokenSubject,
  createHostAccessTokenSync,
  hostAccessTokenSurfaceForPathname,
  parseHostAccessTokenBindingStorage,
} from "../utils/hostAccessTokenSync";
import { clearSlockdevManualLogout, markSlockdevManualLogout } from "../utils/devMode";
import { useServerStore } from "./serverStore";
import {
  deriveInitialAuthRestoreState,
  nextAuthRestoreState,
  nextAuthRestoreStateAfterExternalTokenSync,
} from "../utils/authRestoreMachine";
import type {
  AuthRestoreState,
  AuthRestoreEvent,
} from "../utils/authRestoreMachine";
import { updateAuthRuntimeSnapshot } from "../utils/authSessionRuntime";
import { emitHostEvent } from "../embed/hostBridge";
import {
  emitAuthTrace,
  emitAuthTraceAndFlush,
  readAuthBootInitTraceAttrs,
  setAuthTracePrincipalIdGetter,
} from "../utils/webAuthTrace";
import type {
  LogoutTrigger,
} from "../utils/webAuthTrace";
import { seedMessageBodyFontSizeFromProfile } from "./appearanceStore";
import { resetServerFeatureFlagsForSession } from "./serverFeatureFlags";
import { resetServerLabsSettingsForSession } from "./serverLabsSettingsStore";
import { useAnnouncementStore } from "./announcementStore";
import { AVATAR_TOO_LARGE_CODE, isAvatarFileTooLarge } from "../utils/avatarUpload";
import { detectBrowserTimezone } from "../utils/timeFormatting";
import { getEmbedMode } from "../embed";

export interface User {
  id: string;
  email: string;
  gravatarHash: string;
  name: string;
  displayName: string | null;
  description: string | null;
  avatarUrl: string | null;
  emailVerified: boolean;
  profileSetupCompletedAt?: string | null;
  signupSurveyCompletedAt?: string | null;
  signupRole?: string | null;
  profileSetupSuggestedHandle?: string | null;
  profileSetupProvider?: "google" | "github" | "apple" | null;
  preferredLanguage: string | null;
  /** UI display language (app-chrome i18n). Distinct from preferredLanguage. */
  displayLanguage: string | null;
  preferredTimezone: string | null;
  firstObservedTimezone?: string | null;
  firstObservedTimezoneAt?: string | null;
  lastObservedTimezone?: string | null;
  lastObservedTimezoneAt?: string | null;
  autoTranslationEnabled: boolean;
  preferredTranslationMode: "auto" | "manual" | "off";
  preferredTranslationDisplay: "translated" | "original" | "bilingual";
  preferredTimeFormat: "12h" | "24h" | null;
  preferredMessageBodyFontSize: "sm" | "md" | "lg" | null;
  referralSource: string | null;
  referralSourceOther: string | null;
  referralSourceSkippedAt: string | null;
}

interface AuthState {
  user: User | null;
  accessToken: string | null;
  refreshToken: string | null;
  loading: boolean;
  initialized: boolean;
  restoreState: AuthRestoreState;

  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, legalAcceptance: { acceptTerms: boolean; termsVersion: string; privacyVersion: string; legalAcceptanceSource?: "signup" | "invite" }) => Promise<void>;
  completeOnboardingProfile: (
    name: string,
    displayName: string,
    avatarFile?: File | null,
  ) => Promise<void>;
  logout: (trigger?: LogoutTrigger) => void;
  loadUser: () => Promise<void>;
  refreshAccessToken: () => Promise<boolean>;
  setTokens: (accessToken: string, refreshToken: string) => void;

  // Email verification
  verifyEmail: (token: string) => Promise<void>;
  resendVerification: () => Promise<void>;

  // Password reset
  forgotPassword: (email: string) => Promise<void>;
  resetPassword: (token: string, password: string) => Promise<void>;

  // Profile update
  updateProfile: (fields: {
    displayName?: string;
    description?: string | null;
    avatarUrl?: string | null;
    preferredLanguage?: string | null;
    displayLanguage?: string | null;
    preferredTimezone?: string | null;
    autoTranslationEnabled?: boolean;
    preferredTranslationMode?: "auto" | "manual" | "off";
    preferredTranslationDisplay?: "translated" | "original" | "bilingual";
    preferredTimeFormat?: "12h" | "24h" | null;
    referralSource?: string | null;
    referralSourceOther?: string | null;
    referralSourceSkipped?: boolean;
    signupRole?: string | null;
    // Lets the server brief the onboarding agent with the role the moment it lands.
    signupSurveyServerId?: string;
    currentPassword?: string;
    newPassword?: string;
  }) => Promise<void>;
  uploadAvatar: (file: File) => Promise<void>;

  // Invite
  acceptInvite: (token: string, agreementId?: string | null) => Promise<{ serverId: string; serverName: string }>;
}

// Choke-point for restore-state transitions: compute the next state, emit a
// fire-and-forget L4 trace, and return. NO business branches live here — callers
// keep their own logic; this only adds observability to every transition.
function transitionRestore(current: AuthRestoreState, event: AuthRestoreEvent): AuthRestoreState {
  const next = nextAuthRestoreState(current, event);
  emitAuthTrace("slock.auth.restore", { restoreEvent: event.type, restoreState: next });
  return next;
}

let bootInitTraceEmitted = false;
let authBootInitTraceEmitter = emitAuthTrace;

function emitAuthBootInitTraceOnce(): void {
  if (bootInitTraceEmitted) return;
  bootInitTraceEmitted = true;
  authBootInitTraceEmitter("slock.auth.boot_init", readAuthBootInitTraceAttrs());
}

export function __resetAuthBootInitTraceForTest(emitter: typeof emitAuthTrace = emitAuthTrace): void {
  bootInitTraceEmitted = false;
  authBootInitTraceEmitter = emitter;
}

export function __setAuthBootInitTraceEmitterForTest(emitter: typeof emitAuthTrace): void {
  authBootInitTraceEmitter = emitter;
}

type OnboardingProfileStep = "avatar" | "profile";

function markOnboardingProfileError(error: unknown, onboardingStep: OnboardingProfileStep): unknown {
  if (typeof error === "object" && error !== null) {
    (error as { onboardingStep?: OnboardingProfileStep }).onboardingStep = onboardingStep;
    return error;
  }
  return Object.assign(new Error(String(error)), { onboardingStep });
}

const timezoneObservationInFlight = new Set<string>();

function reportBrowserTimezoneObservation(user: User): void {
  // `undefined` means an older server/fixture that does not support this
  // contract yet. Any server exposing the first-observation field supports the
  // endpoint; newer servers also update the mutable last observation.
  if (user.firstObservedTimezone === undefined || timezoneObservationInFlight.has(user.id)) return;

  let timezone: string;
  try {
    const detected = detectBrowserTimezone();
    if (!detected) return;
    timezone = detected;
  } catch {
    return;
  }

  timezoneObservationInFlight.add(user.id);
  void api.post("/auth/me/timezone-observation", { timezone })
    .then(({ data }) => {
      const current = useAuthStore.getState().user;
      if (current === null || current.id !== user.id) return;
      useAuthStore.setState({
        user: {
          ...current,
          firstObservedTimezone: data.firstObservedTimezone,
          firstObservedTimezoneAt: data.firstObservedTimezoneAt,
          lastObservedTimezone: "lastObservedTimezone" in data
            ? data.lastObservedTimezone
            : current.lastObservedTimezone,
          lastObservedTimezoneAt: "lastObservedTimezoneAt" in data
            ? data.lastObservedTimezoneAt
            : current.lastObservedTimezoneAt,
        },
      });
    }, () => {
      // Observation is analytics enrichment, never an authentication blocker.
    })
    .finally(() => {
      timezoneObservationInFlight.delete(user.id);
    });
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  accessToken: localStorage.getItem("slock_access_token"),
  refreshToken: localStorage.getItem("slock_refresh_token"),
  loading: false,
  initialized: false,
  restoreState: deriveInitialAuthRestoreState(
    !!(localStorage.getItem("slock_access_token") && localStorage.getItem("slock_refresh_token")),
  ),

  login: async (email, password) => {
    set({ loading: true });
    try {
      const { data } = await api.post("/auth/login", { email, password });
      // Signing in on purpose retires the "I logged out" suppression.
      clearSlockdevManualLogout();
      localStorage.setItem("slock_access_token", data.accessToken);
      localStorage.setItem("slock_refresh_token", data.refreshToken);
      seedMessageBodyFontSizeFromProfile(data.user.preferredMessageBodyFontSize);
      if (get().user?.id !== data.user.id) useAnnouncementStore.getState().reset();
      set({
        user: data.user,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        loading: false,
        initialized: true,
        restoreState: transitionRestore(get().restoreState, { type: "LOGIN_SUCCEEDED" }),
      });
      reportBrowserTimezoneObservation(data.user);
    } catch (err: any) {
      set({ loading: false });
      throw err;
    }
  },

  register: async (email, password, legalAcceptance) => {
    set({ loading: true });
    try {
      const { data } = await api.post("/auth/register", { email, password, ...legalAcceptance });
      localStorage.setItem("slock_access_token", data.accessToken);
      localStorage.setItem("slock_refresh_token", data.refreshToken);
      seedMessageBodyFontSizeFromProfile(data.user.preferredMessageBodyFontSize);
      if (get().user?.id !== data.user.id) useAnnouncementStore.getState().reset();
      set({
        user: data.user,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        loading: false,
        initialized: true,
        restoreState: transitionRestore(get().restoreState, { type: "LOGIN_SUCCEEDED" }),
      });
      reportBrowserTimezoneObservation(data.user);
    } catch (err: any) {
      set({ loading: false });
      throw err;
    }
  },

  completeOnboardingProfile: async (name, displayName, avatarFile) => {
    set({ loading: true });
    try {
      if (avatarFile) {
        try {
          if (isAvatarFileTooLarge(avatarFile)) throw new Error(AVATAR_TOO_LARGE_CODE);
          const formData = new FormData();
          formData.append("avatar", avatarFile);
          const { data } = await api.post("/auth/me/avatar", formData, {
            headers: { "Content-Type": "multipart/form-data" },
          });
          set({ user: data });
        } catch (error) {
          throw markOnboardingProfileError(error, "avatar");
        }
      }

      try {
        const { data } = await api.post("/auth/me/complete-profile", {
          name: name.trim(),
          displayName: displayName.trim(),
        });
        seedMessageBodyFontSizeFromProfile(data.preferredMessageBodyFontSize);
        set({ user: data, loading: false });
      } catch (error) {
        throw markOnboardingProfileError(error, "profile");
      }
    } catch (error) {
      set({ loading: false });
      throw error;
    }
  },

  logout: (trigger: LogoutTrigger = "explicit_user_logout") => {
    emitAuthTraceAndFlush("slock.auth.session_cleared", {
      clearSessionCaller: "logout",
      logoutTrigger: trigger,
    });
    const { refreshToken } = get();
    if (refreshToken) {
      api.post("/auth/logout", { refreshToken }).catch(() => {});
    }
    // Disconnect socket before clearing auth state
    disconnectSocket();
    // Dev envs auto-log-in as the seeded user. Logging out and being handed straight
    // back to that account is not a logout, so record the intent and let the auto-login
    // stand down for this tab.
    markSlockdevManualLogout();
    // The next person to sign in on this tab must not inherit this person's servers.
    // Leaving them behind meant the app tried to restore a server the new account cannot
    // see (→ a "server not found" page before it corrected itself) and, for someone who
    // has no servers at all, showed an empty "Choose server" screen instead of the
    // create-your-first-server step they had stopped on.
    useServerStore.setState({ servers: [], current: null, loading: true });
    // Stryker disable next-line all: logout wiring is pinned by a source contract; cache reset behavior is covered in serverFeatureFlags.test.ts.
    resetServerFeatureFlagsForSession();
    resetServerLabsSettingsForSession();
    useAnnouncementStore.getState().reset();
    localStorage.removeItem("slock_access_token");
    localStorage.removeItem("slock_refresh_token");
    set({
      user: null,
      accessToken: null,
      refreshToken: null,
      initialized: true,
      restoreState: transitionRestore(get().restoreState, { type: "LOGOUT" }),
    });
    // Signal a host-embedded WebView, if any, that the user COMPLETED logout.
    //
    // Gated to `explicit_user_logout` deliberately (@MingQi review r4 #1). Other
    // triggers — `terminal_verdict`, `restore_timeout`, `dev_clear_local_state`,
    // `unknown` — are recoverable states, not "user asked to log out"; forcing
    // the host to destroy its session on those paths would bypass the design
    // contract (`mobile/docs/host-web-event-bridge-2026-07-15.md`) which says
    // refresh-failure is wake/intent and host must bootstrap its own auth.
    // Emitted AFTER the local-clear sequence so the signal reflects post-state,
    // not intent. `session:token-refresh-failed` (a distinct kind) lands in
    // its own future PR alongside its own timing/reconciliation decision.
    if (trigger === "explicit_user_logout") {
      emitHostEvent("session:logout");
    }
  },

  loadUser: async () => {
    emitAuthBootInitTraceOnce();
    const { accessToken } = get();
    if (!accessToken) {
      set({
        initialized: true,
        restoreState: transitionRestore(get().restoreState, {
          type: "BOOT",
          hasStoredSession: false,
        }),
      });
      return;
    }
    set({
      restoreState: transitionRestore(get().restoreState, { type: "RESTORE_STARTED" }),
    });
    try {
      const { data } = await api.get("/auth/me");
      seedMessageBodyFontSizeFromProfile(data.preferredMessageBodyFontSize);
      if (get().user?.id !== data.id) useAnnouncementStore.getState().reset();
      set({
        user: data,
        initialized: true,
        restoreState: transitionRestore(get().restoreState, { type: "RESTORE_SUCCEEDED" }),
      });
      reportBrowserTimezoneObservation(data);
    } catch (err: any) {
      const status = err?.response?.status as number | undefined;
      const hasStoredSession = !!(get().accessToken && get().refreshToken);
      // Non-auth failures should not force logout.
      if (shouldKeepSessionAfterLoadUserFailure(status)) {
        set({
          initialized: true,
          restoreState: transitionRestore(get().restoreState, {
            type: "RESTORE_TRANSIENT_FAILURE",
            hasStoredSession,
          }),
        });
        return;
      }

      // Token might be expired — try refresh.
      if (!shouldRetryLoadUserAfterError(status)) {
        set({
          initialized: true,
          restoreState: transitionRestore(get().restoreState, {
            type: "RESTORE_TRANSIENT_FAILURE",
            hasStoredSession,
          }),
        });
        return;
      }

      try {
        const refreshed = await get().refreshAccessToken();
        if (refreshed) {
          try {
            const { data } = await api.get("/auth/me");
            seedMessageBodyFontSizeFromProfile(data.preferredMessageBodyFontSize);
            if (get().user?.id !== data.id) useAnnouncementStore.getState().reset();
            set({
              user: data,
              initialized: true,
              restoreState: transitionRestore(get().restoreState, { type: "RESTORE_SUCCEEDED" }),
            });
            reportBrowserTimezoneObservation(data);
          } catch (meErr: any) {
            const meStatus = meErr?.response?.status as number | undefined;
            if (shouldLogoutAfterPostRefreshLoadUserFailure({
              status: meStatus,
              initialized: get().initialized,
              restoreState: get().restoreState,
            })) {
              get().logout("terminal_verdict");
            } else {
              set({
                initialized: true,
                restoreState: transitionRestore(get().restoreState, {
                  type: "RESTORE_TRANSIENT_FAILURE",
                  hasStoredSession: !!(get().accessToken && get().refreshToken),
                }),
              });
            }
          }
        } else {
          // /auth/refresh is authoritative for stored-session viability. If
          // it returns an auth failure, do not let the bootstrap retry loop
          // produce repeated /auth/me -> /auth/refresh 401s for 30s.
          get().logout("terminal_verdict");
        }
      } catch {
        // Transient refresh failure — keep session and let later calls retry.
        set({
          initialized: true,
          restoreState: transitionRestore(get().restoreState, {
            type: "RESTORE_TRANSIENT_FAILURE",
            hasStoredSession: !!(get().accessToken && get().refreshToken),
          }),
        });
      }
    }
  },

  refreshAccessToken: async () => {
    try {
      const tokens = await refreshTokensWithDedupe();
      set({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      });
      return true;
    } catch (err: any) {
      const status = err?.response?.status as number | undefined;
      if (shouldLogoutAfterRefreshFailure({
        status,
        hasRefreshToken: !!localStorage.getItem("slock_refresh_token"),
        authRefreshAttemptId: authRefreshAttemptIdFromError(err),
      })) {
        return false;
      }
      throw err;
    }
  },

  setTokens: (accessToken, refreshToken) => {
    if (accessTokenSubject(get().accessToken) !== accessTokenSubject(accessToken)) {
      useAnnouncementStore.getState().reset();
    }
    localStorage.setItem("slock_access_token", accessToken);
    localStorage.setItem("slock_refresh_token", refreshToken);
    set({
      accessToken,
      refreshToken,
      restoreState: transitionRestore(get().restoreState, { type: "TOKENS_STORED" }),
    });
  },

  // ── Email Verification ──

  verifyEmail: async (token) => {
    await api.post("/auth/verify-email", { token });
    // Refresh user data to get updated emailVerified status
    const { data } = await api.get("/auth/me");
    seedMessageBodyFontSizeFromProfile(data.preferredMessageBodyFontSize);
    set({ user: data });
  },

  resendVerification: async () => {
    await api.post("/auth/resend-verification");
  },

  // ── Password Reset ──

  forgotPassword: async (email) => {
    await api.post("/auth/forgot-password", { email });
  },

  resetPassword: async (token, password) => {
    await api.post("/auth/reset-password", { token, password });
  },

  // ── Profile Update ──

  updateProfile: async (fields) => {
    const { data } = await api.patch("/auth/me", fields);
    seedMessageBodyFontSizeFromProfile(data.preferredMessageBodyFontSize);
    set({ user: data });
  },

  uploadAvatar: async (file) => {
    if (isAvatarFileTooLarge(file)) throw new Error(AVATAR_TOO_LARGE_CODE);
    const formData = new FormData();
    formData.append("avatar", file);
    const { data } = await api.post("/auth/me/avatar", formData, {
      headers: { "Content-Type": "multipart/form-data" },
    });
    seedMessageBodyFontSizeFromProfile(data.preferredMessageBodyFontSize);
    set({ user: data });
  },

  // ── Invite ──

  acceptInvite: async (token, agreementId) => {
    const { data } = await api.post("/auth/accept-invite", { token, agreementId });
    return data;
  },
}));

setAuthTracePrincipalIdGetter(() => (
  accessTokenSubject(localStorage.getItem("slock_access_token")) ?? undefined
));

authTokenSync.subscribe((tokens) => {
  const current = useAuthStore.getState();
  if (accessTokenSubject(current.accessToken) !== accessTokenSubject(tokens.accessToken)) {
    useAnnouncementStore.getState().reset();
  }
  useAuthStore.setState((state) => {
    if (
      state.accessToken === tokens.accessToken
      && state.refreshToken === tokens.refreshToken
    ) {
      return state;
    }
    localStorage.setItem("slock_access_token", tokens.accessToken);
    localStorage.setItem("slock_refresh_token", tokens.refreshToken);
    updateSocketAuthFromStorage();
    return {
      ...state,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      restoreState: nextAuthRestoreStateAfterExternalTokenSync(state.restoreState),
    };
  });
});

/**
 * Apply a native-host rotation without ever importing a refresh token into the
 * embedded page. Exported as a narrow test seam; production calls only through
 * the single document-level hostAccessTokenSync below.
 */
export function applyHostAccessOnlyToken(accessToken: string): void {
  let tokenChanged = false;
  useAuthStore.setState((state) => {
    tokenChanged = state.accessToken !== accessToken;
    if (!tokenChanged && state.refreshToken === null) return state;
    return {
      ...state,
      accessToken,
      refreshToken: null,
    };
  });
  if (tokenChanged) updateSocketAuthFromStorage();
}

if (typeof window !== "undefined") {
  createHostAccessTokenSync({
    eventTarget: window,
    expectedBinding: parseHostAccessTokenBindingStorage(
      localStorage.getItem(HOST_ACCESS_TOKEN_BINDING_STORAGE_KEY),
    ),
    readContext: () => {
      const auth = useAuthStore.getState();
      const embedMode = getEmbedMode();
      const accountId = auth.user?.id ?? accessTokenSubject(auth.accessToken);
      return {
        hostShell: embedMode.embedded && embedMode.shell === "host",
        surface: hostAccessTokenSurfaceForPathname(window.location.pathname),
        accountId,
        serverId: useServerStore.getState().current?.id ?? null,
      };
    },
    readAccessToken: () => localStorage.getItem("slock_access_token"),
    commitAccessOnlyToken: applyHostAccessOnlyToken,
  });
}

updateAuthRuntimeSnapshot({
  initialized: useAuthStore.getState().initialized,
  restoreState: useAuthStore.getState().restoreState,
});

useAuthStore.subscribe((state) => {
  updateAuthRuntimeSnapshot({
    initialized: state.initialized,
    restoreState: state.restoreState,
  });
});

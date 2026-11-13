import { assertAccountLinkCompleted } from "../utils/pendingAccountLink";
import { afterFirstScreen } from "../boot/deferredUi";
import { markBootMilestone, markBootTokenRefreshedFirst } from "../boot/bootTiming";
import type { PendingAccountLink } from "../utils/pendingAccountLink";
import type { StoredComposerSendKey, StoredShortcutOverrides } from "@botiverse/raft-shared";
import { create } from "zustand";
import api from "../api/client";
import { disconnectSocket, updateSocketAuthFromStorage } from "../api/socket";
import {
  shouldKeepSessionAfterLoadUserFailure,
  shouldLogoutAfterRefreshFailure,
  shouldLogoutAfterPostRefreshLoadUserFailure,
  shouldRetryLoadUserAfterError,
  isUnreachableFailure,
} from "../utils/authSessionPolicy";
import type { RefreshTrigger } from "../utils/authSessionPolicy";
import { refreshTokensWithDedupe } from "../utils/refreshCoordinator";
import { authRefreshAttemptIdFromError } from "../utils/authErrors";
import { authTokenSync } from "../utils/authTokenSync";
import {
  HOST_ACCESS_TOKEN_BINDING_STORAGE_KEY,
  accessTokenSubject,
  isAccessTokenExpired,
  createHostAccessTokenSync,
  hostAccessTokenSurfaceForPathname,
  parseHostAccessTokenBindingStorage,
} from "../utils/hostAccessTokenSync";
import { clearSlockdevManualLogout, markSlockdevManualLogout } from "../utils/devMode";
import { useServerStore } from "./serverStore";
import { isAccountDeletionPending, isAccountDeletionPendingError, markAccountDeletionPending } from "./accountDeletionPending";
import { markOnboardingProfileError } from "../utils/onboardingProfileError";
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
  startWebSpan,
} from "../utils/webAuthTrace";
import type {
  EmitWebEventOptions,
  LogoutTrigger,
  WebSpanHandle,
} from "../utils/webAuthTrace";
import { seedMessageBodyFontSizeFromProfile } from "./appearanceStore";
import { resetServerFeatureFlagsForSession } from "./serverFeatureFlags";
import { resetServerLabsSettingsForSession } from "./serverLabsSettingsStore";
import { useAnnouncementStore } from "./announcementStore";
import { AVATAR_TOO_LARGE_CODE, isAvatarFileTooLarge } from "../utils/avatarUpload";
import { detectBrowserTimezone } from "../utils/timeFormatting";
import { getEmbedMode } from "../embed";
import { clearAllLastCounts } from "./lastCounts";
import { purgeStoredMachineKeys } from "./machineKeyStorage";
import { resetRwFreshness } from "./rwFreshness";
import { resetActorResolve, setActorScopeUserIdGetter } from "./localTables/actorResolve";
import { forgetLocalUser } from "./localTables/persistence";
import { forgetDrafts } from "./draftStorage";
import "./besideMemory"; // forgets what was open beside conversations with the drafts (onDraftsForgotten)
import { forgetActionCardFormDrafts } from "./actionCardFormDrafts";
import { sanitizeAppLocalReturnPath } from "@botiverse/raft-shared";
import { readSecondFactorChallenge, startSecondFactorSignIn } from "../components/auth/secondFactorSignIn";
import { noteSignInFailure } from "../components/auth/signInFailure";
import type { PasskeyAssertionJSON } from "../components/auth/webauthn";

export interface User {
  id: string;
  email: string;
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
  /** The person's rail tab order, complete; null/absent = the default order. */
  railTabOrder?: string[] | null;
  /** How the message box sends (#triage:#210); null/absent = Enter (features/composer/composerSendKey.ts). */
  composerSendKey?: StoredComposerSendKey;
  shortcutOverrides?: StoredShortcutOverrides | null; // changed keyboard shortcuts (#proj-frontend:#37); null = all defaults
  assistantOtterShortcut?: string | null; // the otter's Settings-era shortcut, read until the shortcuts panel saves one
  /** RFC-067 "Share usage data"; null = not chosen (SHARE_USAGE_DATA_DEFAULT applies). */
  shareUsageData?: boolean | null;
  referralSource: string | null;
  referralSourceOther: string | null;
  referralSourceSkippedAt: string | null;
  /**
   * GET /auth/me only (deep links, 1d): this account used Raft Desktop in the
   * last 30 days. A hint for the desktop-browser "Open in Raft Desktop"
   * banner; absent from other profile responses (login, updates).
   */
  usedDesktopAppRecently?: boolean;
}

export type LoginOutcome = "signedIn" | "secondFactor";

interface AuthState {
  user: User | null;
  accessToken: string | null;
  refreshToken: string | null;
  loading: boolean;
  initialized: boolean;
  restoreState: AuthRestoreState;
  /** The last failed restore got no answer (offline, a network error; isUnreachableFailure): store/offlineSession.ts. */
  restoreUnreachable: boolean;

  /**
   * Password sign-in. `"secondFactor"`: two-step verification is on for the
   * account, so no session yet; the second step is pending
   * (components/auth/secondFactorSignIn.ts) and finishes the sign-in.
   */
  login: (email: string, password: string, pendingLink?: PendingAccountLink) => Promise<LoginOutcome>;
  /**
   * Passkey sign-in (POST /auth/passkey/verify with the challenge from POST
   * /auth/passkey/options): both factors at once, so never a second step;
   * signs in exactly as a password sign-in does. No pending account link:
   * the server's passkey sign-in can't complete one (the sign-in page offers
   * passkeys only without one).
   */
  loginWithPasskey: (challenge: string, response: PasskeyAssertionJSON) => Promise<void>;
  /**
   * A session handed over in the password sign-in's body (`{ user,
   * accessToken, refreshToken }`) by another flow: Raft Desktop's passkey
   * sign-in through the browser (POST /auth/app-login/complete). Signs in
   * exactly as a password sign-in does.
   */
  applySignIn: (body: { user: User; accessToken: string; refreshToken: string }) => void;
  /** `returnTo`: the page signed up from (an Artifact link); the verification email's link lands back on it (#88). */
  register: (email: string, password: string, legalAcceptance: { acceptTerms: boolean; termsVersion: string; privacyVersion: string; legalAcceptanceSource?: "signup" | "invite" }, returnTo?: string) => Promise<void>;
  completeOnboardingProfile: (
    name: string,
    displayName: string,
    avatarFile?: File | null,
  ) => Promise<void>;
  logout: (trigger?: LogoutTrigger) => void;
  loadUser: () => Promise<void>;
  refreshAccessToken: (trigger?: RefreshTrigger) => Promise<boolean>;
  setTokens: (accessToken: string, refreshToken: string) => void;

  // Email verification
  /** Answers where to land: the server's validated `returnTo` from the link, or "/" when it had none. */
  verifyEmail: (token: string, returnTo?: string | null) => Promise<string>;
  resendVerification: (returnTo?: string | null) => Promise<void>;
  /** Re-reads the account after the link was opened somewhere else (another tab, a phone): true once verified. */
  checkEmailVerified: () => Promise<boolean>;

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
    shareUsageData?: boolean | null;
    referralSource?: string | null;
    referralSourceOther?: string | null;
    referralSourceSkipped?: boolean;
    signupRole?: string | null;
    // Lets the server brief the onboarding agent with the role the moment it lands.
    signupSurveyServerId?: string;
    currentPassword?: string;
    newPassword?: string;
  }) => Promise<void>;
  /** Shows the new rail tab order at once and saves it to the account; a failed
   *  save puts the previous order back. */
  updateRailTabOrder: (railTabOrder: string[]) => Promise<void>;
  uploadAvatar: (file: File) => Promise<void>;

  // Invite
  acceptInvite: (token: string, agreementId?: string | null) => Promise<{ serverId: string; serverName: string }>;
}

// The `slock.auth.load_user` span that is running right now, if any. Restore
// and boot_init events emitted while it runs carry its trace and span ids.
let activeLoadUserSpan: WebSpanHandle | null = null;

/** The page to land back on after verifying, sent only when it isn't the home page (the server validates it again). */
function landingBody(returnTo: string | null | undefined): { returnTo?: string } {
  const path = sanitizeAppLocalReturnPath(returnTo);
  return path === "/" ? {} : { returnTo: path };
}

function loadUserSpanContext(): EmitWebEventOptions {
  if (!activeLoadUserSpan) return {};
  return { traceId: activeLoadUserSpan.traceId, spanId: activeLoadUserSpan.spanId };
}

// Choke-point for restore-state transitions: compute the next state, emit a
// fire-and-forget L4 trace, and return. NO business branches live here. Callers
// keep their own logic; this only adds observability to every transition.
function transitionRestore(current: AuthRestoreState, event: AuthRestoreEvent): AuthRestoreState {
  const next = nextAuthRestoreState(current, event);
  emitAuthTrace("slock.auth.restore", { restoreEvent: event.type, restoreState: next }, loadUserSpanContext());
  return next;
}

let bootInitTraceEmitted = false;
let authBootInitTraceEmitter = emitAuthTrace;

function emitAuthBootInitTraceOnce(): void {
  if (bootInitTraceEmitted) return;
  bootInitTraceEmitted = true;
  authBootInitTraceEmitter("slock.auth.boot_init", readAuthBootInitTraceAttrs(), loadUserSpanContext());
}

export function __resetAuthBootInitTraceForTest(emitter: typeof emitAuthTrace = emitAuthTrace): void {
  bootInitTraceEmitted = false;
  authBootInitTraceEmitter = emitter;
}

export function __setAuthBootInitTraceEmitterForTest(emitter: typeof emitAuthTrace): void {
  authBootInitTraceEmitter = emitter;
}

const timezoneObservationInFlight = new Set<string>();

function reportBrowserTimezoneObservation(user: User): void {
  // `undefined` means an older server/fixture that does not support this
  // contract yet. Any server exposing the first-observation field supports the
  // endpoint; newer servers also update the mutable last observation.
  if (user.firstObservedTimezone === undefined || timezoneObservationInFlight.has(user.id) || isAccountDeletionPending()) return;

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

type AuthStoreSet = (partial: Partial<AuthState>) => void;
type AuthStoreGet = () => AuthState;

/** A restore that failed transiently: the stored session is kept and retried (AppShell). */
function restoreTransientFailure(get: AuthStoreGet, err: unknown): Partial<AuthState> {
  return {
    initialized: true,
    restoreUnreachable: isUnreachableFailure(err),
    restoreState: transitionRestore(get().restoreState, {
      type: "RESTORE_TRANSIENT_FAILURE",
      hasStoredSession: !!(get().accessToken && get().refreshToken),
    }),
  };
}

/**
 * An expired stored access token (a third of prod boots: it lives 15 minutes)
 * is refreshed at module start (main.tsx), before React mounts, so the early
 * requests (server list, the opened conversation) can go out with the new
 * token alongside /auth/me instead of after it. loadUser's own refresh joins
 * it (refreshTokensWithDedupe shares an in-flight refresh). Resolves true when
 * new tokens are stored; false for no stored session, a valid token, or any
 * refresh failure (loadUser's path decides, as before).
 */
export function refreshExpiredTokenAtBoot(): Promise<boolean> {
  const { accessToken, refreshToken } = useAuthStore.getState();
  if (!accessToken || !refreshToken || !isAccessTokenExpired(accessToken, Date.now())) return Promise.resolve(false);
  markBootTokenRefreshedFirst();
  return useAuthStore.getState().refreshAccessToken("boot_expired").catch(() => false);
}

// The body of loadUser. It runs inside the `slock.auth.load_user` span, so
// every restore transition it causes is attached to that span.
async function restoreUserWithinLoadUserSpan(set: AuthStoreSet, get: AuthStoreGet): Promise<void> {
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
  // The access token lives 15 minutes, so most boots after a break hold an
  // expired one: /auth/me with it is a certain 401, then refresh, then a
  // retry (40% of prod boots, +1.4s p50). Refresh first instead. Any refresh
  // outcome other than new tokens falls through to the path below unchanged.
  if (isAccessTokenExpired(accessToken, Date.now())) {
    markBootTokenRefreshedFirst();
    try {
      await get().refreshAccessToken("boot_expired");
    } catch {
      // Transient: the /auth/me path below retries as before.
    }
  }
  try {
    markBootMilestone("auth_sent");
    const { data } = await api.get("/auth/me");
    seedMessageBodyFontSizeFromProfile(data.preferredMessageBodyFontSize);
    if (get().user?.id !== data.id) useAnnouncementStore.getState().reset();
    set({
      user: data,
      initialized: true,
      restoreUnreachable: false,
      restoreState: transitionRestore(get().restoreState, { type: "RESTORE_SUCCEEDED" }),
    });
    markBootMilestone("auth");
    // Boot: not needed for the first screen (boot/deferredUi).
    afterFirstScreen(() => reportBrowserTimezoneObservation(data));
  } catch (err: any) {
    const status = err?.response?.status as number | undefined;
    // Deletion scheduled: its page stands in for the shell, no refresh (store/accountDeletionPending.ts).
    if (isAccountDeletionPendingError(err)) return void set({ initialized: true });
    // Non-auth failures should not force logout.
    if (shouldKeepSessionAfterLoadUserFailure(status)) return void set(restoreTransientFailure(get, err));

    // Token might be expired. Try refresh.
    if (!shouldRetryLoadUserAfterError(status)) return void set(restoreTransientFailure(get, err));

    try {
      const refreshed = await get().refreshAccessToken("load_user");
      if (refreshed) {
        try {
          markBootMilestone("auth_sent");
          const { data } = await api.get("/auth/me");
          seedMessageBodyFontSizeFromProfile(data.preferredMessageBodyFontSize);
          if (get().user?.id !== data.id) useAnnouncementStore.getState().reset();
          set({
            user: data,
            initialized: true,
            restoreUnreachable: false,
            restoreState: transitionRestore(get().restoreState, { type: "RESTORE_SUCCEEDED" }),
          });
          markBootMilestone("auth");
          afterFirstScreen(() => reportBrowserTimezoneObservation(data));
        } catch (meErr: any) {
          const meStatus = meErr?.response?.status as number | undefined;
          if (shouldLogoutAfterPostRefreshLoadUserFailure({
            status: meStatus,
            initialized: get().initialized,
            restoreState: get().restoreState,
          })) {
            get().logout("terminal_verdict");
          } else {
            set(restoreTransientFailure(get, meErr));
          }
        }
      } else {
        // /auth/refresh is authoritative for stored-session viability. If
        // it returns an auth failure, do not let the bootstrap retry loop
        // produce repeated /auth/me -> /auth/refresh 401s for 30s.
        get().logout("terminal_verdict");
      }
    } catch (refreshErr) {
      // Transient refresh failure. Keep session and let later calls retry.
      set(restoreTransientFailure(get, refreshErr));
    }
  }
}

/** The signed-in person: the user, or, before /auth/me answers, the one the
 * stored access token belongs to (the same id /auth/me returns). */
export function signedInPersonId(state: Pick<AuthState, "user" | "accessToken">): string | null {
  return state.user?.id ?? accessTokenSubject(state.accessToken);
}

/** `accountDeletion`: on a newer server, present only while a deletion is scheduled (#12416). */
type PasswordSignInBody = { user: User; accessToken: string; refreshToken: string; accountDeletion?: { status?: string; scheduledFor?: string } };

/**
 * A password sign-in's success body (POST /auth/login, the second step's
 * POST /auth/second-factor/verify, or a passkey sign-in's POST
 * /auth/passkey/verify, which answer with the same body): store the session
 * and the person.
 */
function applyPasswordSignIn(set: AuthStoreSet, get: AuthStoreGet, data: PasswordSignInBody, pendingLink?: PendingAccountLink): void {
  if (pendingLink) assertAccountLinkCompleted(data, pendingLink);
  // Signing in on purpose retires the "I logged out" suppression.
  clearSlockdevManualLogout();
  localStorage.setItem("slock_access_token", data.accessToken);
  localStorage.setItem("slock_refresh_token", data.refreshToken);
  // Scheduled for deletion: the pending page before any boot request answers 403. No field (nothing scheduled, or a server without
  // account deletion): nothing to do, as the first 403 `account_deletion_pending` still shows the page (api/client.ts).
  if (data.accountDeletion?.status === "scheduled") markAccountDeletionPending(data.accountDeletion.scheduledFor);
  seedMessageBodyFontSizeFromProfile(data.user.preferredMessageBodyFontSize);
  if (get().user?.id !== data.user.id) useAnnouncementStore.getState().reset();
  set({
    user: data.user,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    loading: false,
    initialized: true,
    restoreUnreachable: false,
    restoreState: transitionRestore(get().restoreState, { type: "LOGIN_SUCCEEDED" }),
  });
  reportBrowserTimezoneObservation(data.user);
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  accessToken: localStorage.getItem("slock_access_token"),
  refreshToken: localStorage.getItem("slock_refresh_token"),
  loading: false,
  initialized: false,
  restoreUnreachable: false,
  restoreState: deriveInitialAuthRestoreState(
    !!(localStorage.getItem("slock_access_token") && localStorage.getItem("slock_refresh_token")),
  ),

  login: async (email, password, pendingLink) => {
    set({ loading: true });
    try {
      const { data } = await api.post("/auth/login", { email, password, ...(pendingLink ? { pendingLinkToken: pendingLink.token } : {}) });
      const challenge = readSecondFactorChallenge(data);
      if (challenge) {
        // Two-step verification is on: the second step's answer is this
        // login's answer, and it signs in exactly as below.
        set({ loading: false });
        startSecondFactorSignIn({ challenge, email, finish: async (body) => applyPasswordSignIn(set, get, body as PasswordSignInBody, pendingLink) });
        return "secondFactor";
      }
      applyPasswordSignIn(set, get, data, pendingLink);
      return "signedIn";
    } catch (err: any) {
      set({ loading: false });
      noteSignInFailure(err);
      throw err;
    }
  },

  loginWithPasskey: async (challenge, response) => {
    set({ loading: true });
    try {
      const { data } = await api.post("/auth/passkey/verify", { challenge, response });
      applyPasswordSignIn(set, get, data);
    } catch (err: unknown) {
      set({ loading: false });
      throw err;
    }
  },

  applySignIn: (body) => {
    applyPasswordSignIn(set, get, body);
  },

  register: async (email, password, legalAcceptance, returnTo) => {
    set({ loading: true });
    try {
      const { data } = await api.post("/auth/register", { email, password, ...legalAcceptance, ...landingBody(returnTo) });
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
    // The actors table itself is cleared per user by the persistence layer.
    resetActorResolve();
    useAnnouncementStore.getState().reset();
    // Their local tables too, in memory and on the device.
    forgetLocalUser(signedInPersonId(get()));
    // Their unsent composer drafts too, before the next person's composer can read them.
    forgetDrafts(signedInPersonId(get()));
    // And their half-answered form sheets (question cards), kept in this tab.
    forgetActionCardFormDrafts();
    localStorage.removeItem("slock_access_token");
    localStorage.removeItem("slock_refresh_token");
    // Task #164: the saved unread counts and Activity rows are this person's;
    // the next one to sign in on this browser must not see them.
    clearAllLastCounts();
    purgeStoredMachineKeys();
    resetRwFreshness();
    set({
      user: null,
      accessToken: null,
      refreshToken: null,
      initialized: true,
      restoreUnreachable: false,
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
    const loadUserSpan = startWebSpan("slock.auth.load_user");
    activeLoadUserSpan = loadUserSpan;
    const hasStoredSession = Boolean(get().accessToken);
    try {
      await restoreUserWithinLoadUserSpan(set, get);
    } finally {
      if (activeLoadUserSpan === loadUserSpan) activeLoadUserSpan = null;
      const restoreState = get().restoreState;
      const restored = !hasStoredSession || restoreState === "authenticated";
      loadUserSpan.end(restored ? "ok" : "error", { routeFamily: "bootstrap", hasStoredSession, restoreState });
    }
  },


  refreshAccessToken: async (trigger) => {
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
        trigger,
      })) {
        return false;
      }
      throw err;
    }
  },

  setTokens: (accessToken, refreshToken) => {
    if (accessTokenSubject(get().accessToken) !== accessTokenSubject(accessToken)) {
      useAnnouncementStore.getState().reset();
      // Another person in this tab: the previous one's half-written answers do not stay on the device.
      forgetActionCardFormDrafts();
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

  verifyEmail: async (token, returnTo) => {
    const { data: verified } = await api.post<{ ok: boolean; returnTo?: string }>("/auth/verify-email", { token, ...landingBody(returnTo) });
    // Refresh user data to get updated emailVerified status
    const { data } = await api.get("/auth/me");
    seedMessageBodyFontSizeFromProfile(data.preferredMessageBodyFontSize);
    set({ user: data });
    // The server validated it; checked again here because it is about to become a navigation.
    return sanitizeAppLocalReturnPath(verified?.returnTo);
  },

  resendVerification: async (returnTo) => {
    await api.post("/auth/resend-verification", landingBody(returnTo));
  },

  checkEmailVerified: async () => {
    const { data } = await api.get("/auth/me");
    if (!data?.emailVerified) return false;
    seedMessageBodyFontSizeFromProfile(data.preferredMessageBodyFontSize);
    set({ user: data });
    return true;
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

  updateRailTabOrder: async (railTabOrder) => {
    const user = get().user;
    if (!user) return;
    const previous = user.railTabOrder ?? null;
    set({ user: { ...user, railTabOrder } });
    try {
      const { data } = await api.patch("/auth/me", { railTabOrder });
      const current = get().user;
      // A later drag already replaced this order: keep that one.
      if (current?.railTabOrder !== railTabOrder) return;
      set({ user: { ...current, railTabOrder: Array.isArray(data?.railTabOrder) ? data.railTabOrder : railTabOrder } });
    } catch {
      const current = get().user;
      if (current?.railTabOrder === railTabOrder) set({ user: { ...current, railTabOrder: previous } });
    }
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
    // Another person signed in on another tab: the previous one's local tables go.
    forgetLocalUser(signedInPersonId(current));
    forgetDrafts(signedInPersonId(current));
    forgetActionCardFormDrafts();
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
      const accountId = signedInPersonId(auth);
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

// Before /auth/me answers (a server opened from the device at boot), the person
// is the one the stored token belongs to: the same id /auth/me will return.
setActorScopeUserIdGetter(() => {
  return signedInPersonId(useAuthStore.getState()) ?? undefined;
});

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

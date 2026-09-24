import type { MessageId } from "../i18n/messages/en";

export const SLOCKDEV_EMAIL = import.meta.env?.VITE_SLOCKDEV_EMAIL?.trim() || "dev@slock.ai";
// An explicit logout must beat the dev convenience auto-login. Without this, clicking
// "Log out" mid-onboarding dropped you straight back into the seeded dev account — the
// one thing logging out is supposed to stop. Kept in sessionStorage so it dies with the
// tab: a fresh tab still gets the convenience.
export const SLOCKDEV_MANUAL_LOGOUT_KEY = "slockdev_manual_logout";

export function markSlockdevManualLogout(storage: Pick<Storage, "setItem"> | undefined = globalThis.sessionStorage) {
  try {
    storage?.setItem(SLOCKDEV_MANUAL_LOGOUT_KEY, "1");
  } catch {
    // Storage can be unavailable (private mode); the auto-login is a convenience, not a contract.
  }
}

export function clearSlockdevManualLogout(storage: Pick<Storage, "removeItem"> | undefined = globalThis.sessionStorage) {
  try {
    storage?.removeItem(SLOCKDEV_MANUAL_LOGOUT_KEY);
  } catch {
    // ignore
  }
}

export function hasSlockdevManualLogout(storage: Pick<Storage, "getItem"> | undefined = globalThis.sessionStorage): boolean {
  try {
    return storage?.getItem(SLOCKDEV_MANUAL_LOGOUT_KEY) === "1";
  } catch {
    return false;
  }
}
export const SLOCKDEV_PASSWORD = "password123";

export type AuthView = "login" | "register" | "forgot-password";

export function isSlockdevEnvironment(deploymentEnv: string | undefined | null): boolean {
  return deploymentEnv === "slockdev";
}

/**
 * Deployment env identifier → catalog id.
 * Keep identifiers (slockdev / staging / web-preview / release-qa) untranslated; format labels
 * with formatMessage at the React/intl boundary.
 */
export function getEnvironmentLabelMessageId(
  deploymentEnv: string | undefined | null,
): MessageId | null {
  if (deploymentEnv === "slockdev") return "env.badge.dev";
  if (deploymentEnv === "staging") return "env.badge.staging";
  if (deploymentEnv === "web-preview") return "env.badge.webPreview";
  if (deploymentEnv === "release-qa") return "env.badge.releaseQa";
  return null;
}

export function getPreviewEnvironmentDetails(
  env: {
    branch?: string | null;
    commitSha?: string | null;
    apiTarget?: string | null;
  },
  formatMessage?: (descriptor: { id: "common.envBadge.dataSuffix" }) => string,
): string | null {
  const branch = env.branch?.trim();
  const commitSha = env.commitSha?.trim();
  const apiTarget = env.apiTarget?.trim();
  if (!branch && !commitSha && !apiTarget) return null;

  const dataSuffix = formatMessage
    ? formatMessage({ id: "common.envBadge.dataSuffix" })
    : " DATA";
  const parts = [
    branch,
    commitSha ? commitSha.slice(0, 8) : null,
    apiTarget ? `${apiTarget.toUpperCase()}${dataSuffix}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ");
}

export function getSlockdevSeedCommand(envName: string | undefined | null): string {
  const name = envName?.trim() || "<env>";
  return `./raftdev seed ${name}`;
}

export function shouldAutoDismissSlockdevAnnouncement(deploymentEnv: string | undefined | null): boolean {
  return isSlockdevEnvironment(deploymentEnv);
}

export function shouldAutoLoginSlockdev(params: {
  deploymentEnv: string | undefined | null;
  initialized: boolean;
  attempted: boolean;
  hasUser: boolean;
  hasStoredSession: boolean;
  authView: AuthView;
  authCallback: string | null;
  resetToken: string | null;
  inviteToken: string | null;
}): boolean {
  if (import.meta.env?.VITE_SLOCKDEV_SKIP_AUTO_LOGIN === "1") return false;
  if (hasSlockdevManualLogout()) return false;
  return (
    isSlockdevEnvironment(params.deploymentEnv)
    && params.initialized
    && !params.attempted
    && !params.hasUser
    && !params.hasStoredSession
    && params.authView === "login"
    && !params.authCallback
    && !params.resetToken
    && !params.inviteToken
  );
}

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { CURRENT_SCHEMA_VERSION, userSessionPath } from "../paths.js";
import { computerFetch } from "../proxy.js";
import { canonicalizeServerUrl, resolveServerUrl, resolveServerUrlEnv } from "../serverUrl.js";

const USER_SESSION_EXPIRY_LEEWAY_MS = 30_000;
const refreshUserSessionInflight = new Map<string, Promise<boolean>>();

export interface UserSession {
  kind?: string;
  schemaVersion?: number;
  userId?: string;
  accessToken?: string;
  refreshToken?: string;
  serverUrl?: string;
  email?: string;
  name?: string;
  displayName?: string;
  createdAt?: string;
}

export interface UserSessionIdentity {
  userId?: string;
  email?: string;
  name?: string;
  displayName?: string;
}

export type UsableUserSession =
  | {
      status: "usable";
      accessToken: string;
      serverUrl?: string;
      refreshed: boolean;
    }
  | {
      status: "not_logged_in";
      reason: "missing" | "invalid" | "expired" | "refresh_failed" | "server_origin_mismatch";
      serverUrl?: string;
    };

export async function readUserSessionAuth(
  slockHome: string,
): Promise<{ accessToken: string; serverUrl?: string }> {
  const session = await readUserSession(slockHome);
  return {
    accessToken: typeof session?.accessToken === "string" ? session.accessToken : "",
    ...(typeof session?.serverUrl === "string" ? { serverUrl: canonicalizeServerUrl(session.serverUrl) } : {}),
  };
}

export async function readUserSessionIdentity(slockHome: string): Promise<UserSessionIdentity | null> {
  const session = await readUserSession(slockHome);
  if (!session || session.kind !== "user-session") return null;
  return {
    ...(typeof session.userId === "string" && session.userId.length > 0 ? { userId: session.userId } : {}),
    ...(typeof session.email === "string" && session.email.length > 0 ? { email: session.email } : {}),
    ...(typeof session.name === "string" && session.name.length > 0 ? { name: session.name } : {}),
    ...(typeof session.displayName === "string" && session.displayName.length > 0
      ? { displayName: session.displayName }
      : {}),
  };
}

export async function hasUnexpiredUserSessionShape(slockHome: string): Promise<boolean> {
  const session = await readUserSession(slockHome);
  return isUsableSessionShape(session) && !isJwtExpired(session.accessToken);
}

export async function ensureUsableUserSession(
  slockHome: string,
  serverUrl?: string,
  options: { requireServerOrigin?: boolean } = {},
): Promise<UsableUserSession> {
  const session = await readUserSession(slockHome);
  if (!session) return { status: "not_logged_in", reason: "missing" };
  if (!isUsableSessionShape(session)) {
    return {
      status: "not_logged_in",
      reason: "invalid",
      ...(typeof session.serverUrl === "string" ? { serverUrl: canonicalizeServerUrl(session.serverUrl) } : {}),
    };
  }

  const requestedServerUrl = typeof serverUrl === "string" ? canonicalizeServerUrl(serverUrl) : null;
  const sessionServerUrl = typeof session.serverUrl === "string" ? canonicalizeServerUrl(session.serverUrl) : null;
  const originMismatch = options.requireServerOrigin === true
    && requestedServerUrl !== null
    && requestedServerUrl !== sessionServerUrl;
  if (originMismatch) {
    return {
      status: "not_logged_in",
      reason: "server_origin_mismatch",
      ...(sessionServerUrl ? { serverUrl: sessionServerUrl } : {}),
    };
  }
  if (!isJwtExpired(session.accessToken)) {
    return {
      status: "usable",
      accessToken: session.accessToken,
      ...(typeof session.serverUrl === "string" ? { serverUrl: canonicalizeServerUrl(session.serverUrl) } : {}),
      refreshed: false,
    };
  }

  const refreshed = await refreshUserSession(slockHome, serverUrl);
  if (!refreshed) {
    return {
      status: "not_logged_in",
      reason: typeof session.refreshToken === "string" && session.refreshToken.length > 0
        ? "refresh_failed"
        : "expired",
      ...(typeof session.serverUrl === "string" ? { serverUrl: canonicalizeServerUrl(session.serverUrl) } : {}),
    };
  }

  const next = await readUserSession(slockHome);
  if (!isUsableSessionShape(next)) {
    return {
      status: "not_logged_in",
      reason: "refresh_failed",
      ...(typeof next?.serverUrl === "string" ? { serverUrl: canonicalizeServerUrl(next.serverUrl) } : {}),
    };
  }
  return {
    status: "usable",
    accessToken: next.accessToken,
    ...(typeof next.serverUrl === "string" ? { serverUrl: canonicalizeServerUrl(next.serverUrl) } : {}),
    refreshed: true,
  };
}

export async function refreshUserSession(slockHome: string, serverUrl?: string): Promise<boolean> {
  const file = userSessionPath(slockHome);
  const session = await readUserSession(slockHome);
  if (!session || session.kind !== "user-session" || typeof session.refreshToken !== "string" || session.refreshToken.length === 0) {
    return false;
  }

  const baseUrl = resolveServerUrl(serverUrl, session.serverUrl, resolveServerUrlEnv());
  const existing = refreshUserSessionInflight.get(file);
  if (existing) return existing;
  const refresh = refreshUserSessionOnce(file, session, baseUrl);
  refreshUserSessionInflight.set(file, refresh);
  try {
    return await refresh;
  } finally {
    if (refreshUserSessionInflight.get(file) === refresh) {
      refreshUserSessionInflight.delete(file);
    }
  }
}

async function refreshUserSessionOnce(file: string, session: UserSession, baseUrl: string): Promise<boolean> {
  const tmpFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    const res = await computerFetch(new URL("/api/auth/refresh", baseUrl).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.status !== 200 || typeof body?.accessToken !== "string" || typeof body.refreshToken !== "string") {
      return false;
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      tmpFile,
      JSON.stringify(
        {
          kind: "user-session",
          schemaVersion: CURRENT_SCHEMA_VERSION,
          userId: session.userId,
          accessToken: body.accessToken,
          refreshToken: body.refreshToken,
          serverUrl: baseUrl,
          ...(typeof session.email === "string" ? { email: session.email } : {}),
          ...(typeof session.name === "string" ? { name: session.name } : {}),
          ...(typeof session.displayName === "string" ? { displayName: session.displayName } : {}),
          createdAt: session.createdAt ?? new Date().toISOString(),
          refreshedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    await chmod(tmpFile, 0o600);
    await rename(tmpFile, file);
    return true;
  } catch {
    await rm(tmpFile, { force: true }).catch(() => undefined);
    return false;
  }
}

export function isJwtExpired(token: string, nowMs = Date.now()): boolean {
  const [, payload] = token.split(".");
  if (!payload) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof parsed.exp === "number" && parsed.exp * 1000 <= nowMs + USER_SESSION_EXPIRY_LEEWAY_MS;
  } catch {
    return false;
  }
}

async function readUserSession(slockHome: string): Promise<UserSession | null> {
  try {
    const parsed = JSON.parse(await readFile(userSessionPath(slockHome), "utf8")) as UserSession;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isUsableSessionShape(session: UserSession | null): session is UserSession & { accessToken: string } {
  return (
    session?.kind === "user-session" &&
    typeof session.accessToken === "string" &&
    session.accessToken.length > 0
  );
}

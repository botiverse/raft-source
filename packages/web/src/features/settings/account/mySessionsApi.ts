/**
 * The person's own sign-ins (Settings › Account › Signed-in devices; server
 * routes/mySessions.ts, services/mySessions.ts):
 *
 *   GET    /me/sessions                -> { sessions, othersLostDeviceReach }
 *   DELETE /me/sessions/:id { reason } -> { cascade }
 *   POST   /me/sessions/revoke-others { reason } -> { revoked, cascade }
 *
 * `reason` is the person's choice, never defaulted: `sign_out` (what the
 * sign-in approved keeps working) or `lost_device` (that goes too: the
 * Computers and agent keys counted in `lostDeviceReach`). Refusals by code:
 * 403 `reauth_required` (password again, or a recent sign-in), 403
 * `second_factor_step_up_required` (the app's step-up), 404
 * `session_not_found` (gone meanwhile), 400 `current_session`.
 *
 * `platform` and `version` are the client's own claims, display only.
 */
import api from "../../../api/client";

/** A sign-in (session family) id as GET /me/sessions lists it: only parseMySessions makes one. */
export type SignInId = string & { readonly __signInId: unique symbol };

export type MySessionRevokeReason = "sign_out" | "lost_device";

/** Live Computers and agent keys a `lost_device` revoke also turns off. */
export interface LostDeviceReach {
  computers: number;
  agentKeys: number;
}

export interface MySession {
  id: SignInId;
  /** browser, pwa, desktop_app, ios, android, harmonyos; null when unknown. */
  platform: string | null;
  version: string | null;
  createdAt: string;
  lastActiveAt: string;
  /** The sign-in this page is open in. */
  current: boolean;
  lostDeviceReach: LostDeviceReach;
}

export interface MySessionList {
  sessions: MySession[];
  othersLostDeviceReach: LostDeviceReach;
}

/** done: the lost-device revoke finished; pending: the hourly repair finishes it; none: sign_out. */
export type MySessionCascade = "done" | "pending" | "none";

function countOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function reachOf(value: unknown): LostDeviceReach {
  const reach = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return { computers: countOf(reach.computers), agentKeys: countOf(reach.agentKeys) };
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** GET /me/sessions's body; rows without an id or times are left out. */
export function parseMySessions(body: unknown): MySessionList {
  const data = (body && typeof body === "object" ? body : {}) as { sessions?: unknown; othersLostDeviceReach?: unknown };
  const rows = Array.isArray(data.sessions) ? data.sessions : [];
  const sessions: MySession[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.createdAt !== "string" || typeof row.lastActiveAt !== "string") continue;
    sessions.push({
      id: row.id as SignInId,
      platform: textOrNull(row.platform),
      version: textOrNull(row.version),
      createdAt: row.createdAt,
      lastActiveAt: row.lastActiveAt,
      current: row.current === true,
      lostDeviceReach: reachOf(row.lostDeviceReach),
    });
  }
  return { sessions, othersLostDeviceReach: reachOf(data.othersLostDeviceReach) };
}

function cascadeOf(value: unknown): MySessionCascade {
  return value === "done" || value === "pending" ? value : "none";
}

export async function listMySessions(): Promise<MySessionList> {
  const { data } = await api.get("/me/sessions");
  return parseMySessions(data);
}

export async function revokeMySession(id: SignInId, reason: MySessionRevokeReason): Promise<MySessionCascade> {
  const { data } = await api.delete(`/me/sessions/${encodeURIComponent(id)}`, { data: { reason } });
  return cascadeOf((data as { cascade?: unknown } | undefined)?.cascade);
}

export async function revokeMyOtherSessions(reason: MySessionRevokeReason): Promise<{ revoked: number; cascade: MySessionCascade }> {
  const { data } = await api.post("/me/sessions/revoke-others", { reason });
  const body = (data ?? {}) as { revoked?: unknown; cascade?: unknown };
  return { revoked: countOf(body.revoked), cascade: cascadeOf(body.cascade) };
}

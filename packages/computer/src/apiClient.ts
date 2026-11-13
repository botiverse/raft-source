// Minimal HTTP client for the PR-A2 shared device-code grant
// (`/api/auth/device/*`, RFC v0.8 contract v3 §3). undici fetch.
// Errors are mapped to ACTIONABLE codes — the caller renders guidance,
// never a raw server body (binding constraint).
import { fetch } from "undici";
import { computerFetch } from "./proxy";
import { isValidServerId } from "./paths";
import { COMPUTER_VERSION } from "./version";
import { classifyAdoptLegacyAccessResponse, type AdoptLegacyAccessResult } from "./lib/adoptLegacyResponse";

export interface DeviceAuthorizeResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

/**
 * A one-time grant asked for at authorize (device-auth design v2 §3.1): "add
 * this machine to a server", the server picked on the approval page. An
 * older server ignores it and answers the poll with a session instead.
 */
export interface ComputerAttachGrantRequest {
  kind: "computer_attach";
  machineName: string;
  hostname: string;
  os: string;
}

/**
 * A one-time grant for `raft-computer setup`'s legacy-daemon migration: "move
 * this machine's old daemon on a server over", the server picked on the
 * approval page. The token it yields reads only the approver's own legacy
 * roster on that server and adopts one old daemon there, once: one of those,
 * or by its machine id another member's when the approver is an owner or admin. A server
 * older than this grant kind refuses it at authorize (DeviceGrantRejectedError).
 */
export interface ComputerMigrateGrantRequest {
  kind: "computer_migrate";
  machineName: string;
  hostname: string;
  os: string;
}

export type DeviceGrantRequest = ComputerAttachGrantRequest | ComputerMigrateGrantRequest;

export const ATTACH_TOKEN_PREFIX = "dvat_";
export const MIGRATE_TOKEN_PREFIX = "dvmt_";

/**
 * The server refused the grant itself at authorize (400 `grant_invalid` /
 * `grant_kind_unsupported`): a server that has one-time grants but not this
 * kind. Nothing was started there.
 */
export class DeviceGrantRejectedError extends Error {
  constructor(readonly code: string) {
    super(`the server does not support this kind of approval (${code})`);
    this.name = "DeviceGrantRejectedError";
  }
}

/** Per-request budget for one device-token poll. */
export const DEVICE_TOKEN_TIMEOUT_MS = 15_000;

export type DeviceTokenResult =
  /** A device session: the legacy (grant-less) answer, also what a server older than one-time grants returns for a grant. */
  | { status: "success"; accessToken: string; refreshToken: string; userId: string }
  /** A one-time attach token (`dvat_*`, single use, minutes) for the server the person picked. Never a session. */
  | { status: "attach_token"; attachToken: string; serverId: string; serverSlug: string }
  /** A migrate token (`dvmt_*`, minutes) for the server the person picked: the legacy roster and one adoption there. Never a session. */
  | { status: "migrate_token"; migrateToken: string; serverId: string; serverSlug: string }
  | { status: "pending" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "error"; code: string };

export class DeviceAuthClient {
  constructor(private readonly baseUrl: string) {}

  private url(p: string): string {
    return new URL(p, this.baseUrl).toString();
  }

  async authorize(clientName: string, grant?: DeviceGrantRequest): Promise<DeviceAuthorizeResult> {
    const res = await computerFetch(this.url("/api/auth/device/authorize"), {
      method: "POST",
      // #wg-device-auth:#1: the Server records the requester's User-Agent on
      // the authorization, so a login can be traced to the Computer version
      // that started it (undici's default names no version).
      headers: { "Content-Type": "application/json", "User-Agent": `raft-computer/${COMPUTER_VERSION}` },
      body: JSON.stringify(grant ? { clientName, grant } : { clientName }),
    });
    if (res.status === 404) {
      throw new Error(
        "device login is not enabled on this server (ask an admin to unset SLOCK_DEVICE_LOGIN_ENABLED or set it back to a non-false value; this surface is on by default since PR-G — upgrade the server if you are on an older build)",
      );
    }
    if (res.status === 400 && grant) {
      const refused = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const code = refused && typeof refused.code === "string" ? refused.code : null;
      // grant_kind_unsupported: the server does not know this kind (REFUSAL_CODES).
      // grant_invalid: what Servers from before that code answer for an unknown
      // kind; drop it once no supported Server answers that way.
      if (code === "grant_kind_unsupported" || code === "grant_invalid") throw new DeviceGrantRejectedError(code);
    }
    if (res.status !== 201) {
      throw new Error(`device authorize failed (HTTP ${res.status}) — check --server-url / server version`);
    }
    const body = (await res.json().catch(() => null)) as DeviceAuthorizeResult | null;
    if (!body || typeof body.deviceCode !== "string" || typeof body.userCode !== "string") {
      throw new Error("device authorize returned an unexpected response — server may be incompatible");
    }
    return body;
  }

  /**
   * One poll. Bounded by DEVICE_TOKEN_TIMEOUT_MS so a stalled socket fails
   * (TimeoutError) instead of hanging the poll; `signal` (the caller's
   * cancel) aborts it too.
   */
  async token(deviceCode: string, signal?: AbortSignal): Promise<DeviceTokenResult> {
    const timeout = AbortSignal.timeout(DEVICE_TOKEN_TIMEOUT_MS);
    const res = await computerFetch(this.url("/api/auth/device/token"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceCode }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    // A one-time grant's answer is recognised by its shape: `kind` plus a
    // `dvat_*` token. A session is only ever taken from an answer that is not
    // a grant answer, so an answer carrying both is never read as a session.
    if (res.status === 200 && body && body.kind === "computer_attach") {
      if (
        typeof body.attachToken === "string" &&
        body.attachToken.startsWith(ATTACH_TOKEN_PREFIX) &&
        typeof body.serverId === "string" &&
        // A server id names a local directory (servers/<id>/): only a UUID.
        isValidServerId(body.serverId) &&
        typeof body.serverSlug === "string" &&
        body.serverSlug.length > 0
      ) {
        return {
          status: "attach_token",
          attachToken: body.attachToken,
          serverId: body.serverId,
          serverSlug: body.serverSlug,
        };
      }
      return { status: "error", code: "unexpected_response" };
    }
    if (res.status === 200 && body && body.kind === "computer_migrate") {
      if (
        typeof body.migrateToken === "string" &&
        body.migrateToken.startsWith(MIGRATE_TOKEN_PREFIX) &&
        body.migrateToken.length > MIGRATE_TOKEN_PREFIX.length &&
        typeof body.serverId === "string" &&
        isValidServerId(body.serverId) &&
        typeof body.serverSlug === "string" &&
        body.serverSlug.length > 0
      ) {
        return {
          status: "migrate_token",
          migrateToken: body.migrateToken,
          serverId: body.serverId,
          serverSlug: body.serverSlug,
        };
      }
      return { status: "error", code: "unexpected_response" };
    }
    if (res.status === 200 && body && typeof body.accessToken === "string") {
      return {
        status: "success",
        accessToken: body.accessToken as string,
        refreshToken: String(body.refreshToken ?? ""),
        userId: String(body.userId ?? ""),
      };
    }
    const code = body && typeof body.code === "string" ? (body.code as string) : `http_${res.status}`;
    if (code === "authorization_pending") return { status: "pending" };
    if (code === "access_denied") return { status: "denied" };
    if (code === "expired_token") return { status: "expired" };
    return { status: "error", code };
  }
}

// --- Computer attach (RFC v0.8 contract v3 §6/§9) ---
// `attach` consumes an existing USER session (from `login`) to create/
// resume this machine's Computer attachment, then runs the §9 read-only
// preflight with the issued sk_computer_* BEFORE any local state is
// written. Both calls map server responses to ACTIONABLE codes.

export type AttachResult =
  | {
      status: "success";
      apiKey: string;
      serverMachineId: string;
      /** `machines.id` of the row backing this Computer (vs
       *  `serverMachineId` = `computers.id`). The dashboard route
       *  `/s/<slug>/computer/:machineId` resolves against this — the
       *  menu-bar "Open This Computer in Browser" link uses it.
       *  Optional in the type so a pre-#99 server still parses; the
       *  caller (attach service) treats absence as "this server is old,
       *  fall back to serverMachineId for the URL (will 404 like before
       *  the fix, but never crash)". */
      machineId?: string;
      serverId: string;
      serverSlug: string;
      resumed: boolean;
    }
  | { status: "not_authorized" }
  | { status: "requires_admin" }
  | { status: "server_not_found" }
  | { status: "disabled" }
  | { status: "error"; code: string };

export type PreflightResult = { ok: true; serverSlug?: string } | { ok: false; code: string };

export type AdoptLegacyResult =
  | {
      status: "success";
      apiKey: string;
      computerId: string;
      machineId: string;
      serverId: string;
      resumed: boolean;
    }
  | { status: "legacy_key_invalid" }
  | { status: "legacy_machine_key_migrated" }
  | { status: "auth_required" }
  | AdoptLegacyAccessResult
  | { status: "network_failed"; serverUrl: string }
  | { status: "error"; code: string };

export class ComputerAttachClient {
  constructor(
    private readonly baseUrl: string,
    private readonly accessToken: string,
  ) {}

  private url(p: string): string {
    return new URL(p, this.baseUrl).toString();
  }

  /** POST /api/computer/attach — user-authed; issues sk_computer_*. */
  async attach(serverSlug: string, name: string): Promise<AttachResult> {
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await computerFetch(this.url("/api/computer/attach"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify({ serverSlug, name }),
      });
    } catch {
      return { status: "error", code: "request_failed" };
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const code = body && typeof body.code === "string" ? (body.code as string) : undefined;
    if (res.status === 201 && body && typeof body.apiKey === "string") {
      return {
        status: "success",
        apiKey: body.apiKey as string,
        serverMachineId: String(body.serverMachineId ?? ""),
        // Old servers (pre-#99) won't return this; treat as absent rather
        // than empty so downstream callers can distinguish "missing" from
        // a legitimate empty UUID. The lib threads it into
        // `ServerStatusRow.machineId` only when present.
        ...(typeof body.machineId === "string" && body.machineId
          ? { machineId: body.machineId }
          : {}),
        serverId: String(body.serverId ?? ""),
        serverSlug: String(body.serverSlug ?? serverSlug),
        resumed: body.resumed === true,
      };
    }
    // A one-time attach token the server refused (invalid / expired / used /
    // for another server): its own codes, never "session expired".
    if (code && code.startsWith("attach_token_")) return { status: "error", code };
    if (res.status === 401) return { status: "error", code: "session_invalid" };
    // The server distinguishes "you're a member but lack the manageMachines
    // capability" (requires_admin) from the membership/existence collapse
    // (not_authorized). Surface it so the caller can render "ask an admin"
    // instead of a misleading "you're not a member".
    if (res.status === 403) return code === "requires_admin" ? { status: "requires_admin" } : { status: "not_authorized" };
    if (res.status === 404) {
      // Older/disabled servers expose the attach route as a plain 404, but
      // some deployments return 404 with a structured auth/not-found code for
      // unknown slugs. Preserve that as a user-actionable slug/membership
      // error instead of mislabeling it as a disabled Computer surface.
      if (code === "not_authorized" || code === "server_not_found") return { status: "server_not_found" };
      if (!code || code === "computer_attach_disabled") return { status: "disabled" };
    }
    return { status: "error", code: code ?? `http_${res.status}` };
  }

  /**
   * POST /api/computer/adopt-legacy — task #39 PR-J1 (RFC v8.2 §5.11).
   * User-authed; the legacy `sk_machine_*` key is the proof of authority
   * over the machine. On success the server marks the machine row migrated
   * and mints a fresh `sk_computer_*`. The raw legacy key MUST NOT be
   * persisted by the caller — only the freshly-minted sk_computer_* lands
   * in runner.state.json.
   */
  async adoptLegacy(legacyApiKey: string, name?: string): Promise<AdoptLegacyResult> {
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await computerFetch(this.url("/api/computer/adopt-legacy"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify({ legacyApiKey, ...(name ? { name } : {}) }),
      });
    } catch {
      return { status: "network_failed", serverUrl: this.baseUrl };
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.status === 201 && body && typeof body.apiKey === "string") {
      return {
        status: "success",
        apiKey: body.apiKey as string,
        computerId: String(body.computerId ?? ""),
        machineId: String(body.machineId ?? ""),
        serverId: String(body.serverId ?? ""),
        resumed: body.resumed === true,
      };
    }
    const code = body && typeof body.code === "string" ? (body.code as string) : undefined;
    // A migrate token the server no longer takes (expired / used / revoked):
    // the credential needs renewing, like an expired session.
    if (isMigrateTokenRefusal(code)) return { status: "auth_required" };
    if (res.status === 401) {
      if (code === "legacy_key_invalid") return { status: "legacy_key_invalid" };
      if (code === "auth_required") return { status: "auth_required" };
      return { status: "unexpected_response", httpStatus: res.status, ...(code ? { code } : {}) };
    }
    if (res.status === 409 && code === "legacy_machine_key_migrated") {
      return { status: "legacy_machine_key_migrated" };
    }
    const accessResult = classifyAdoptLegacyAccessResponse(res.status, code);
    if (accessResult) return accessResult;
    if (!code) return { status: "unexpected_response", httpStatus: res.status };
    return { status: "error", code };
  }

  /**
   * POST /api/computer/adopt-legacy — user-authed roster-selected adoption.
   * Used by setup after the operator selected a server-rostered legacy
   * candidate. The user session + serverSlug + legacyMachineId +
   * apiKeyFingerprint are the authority; no raw legacy key is required.
   */
  async adoptLegacyByFingerprint(input: {
    serverSlug: string;
    legacyMachineId: string;
    apiKeyFingerprint: string;
    name?: string;
  }): Promise<AdoptLegacyResult> {
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await computerFetch(this.url("/api/computer/adopt-legacy"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify({
          serverSlug: input.serverSlug,
          legacyMachineId: input.legacyMachineId,
          apiKeyFingerprint: input.apiKeyFingerprint,
          ...(input.name ? { name: input.name } : {}),
        }),
      });
    } catch {
      return { status: "network_failed", serverUrl: this.baseUrl };
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.status === 201 && body && typeof body.apiKey === "string") {
      return {
        status: "success",
        apiKey: body.apiKey as string,
        computerId: String(body.computerId ?? ""),
        machineId: String(body.machineId ?? ""),
        serverId: String(body.serverId ?? ""),
        resumed: body.resumed === true,
      };
    }
    const code = body && typeof body.code === "string" ? (body.code as string) : undefined;
    // A migrate token the server no longer takes (expired / used / revoked):
    // the credential needs renewing, like an expired session.
    if (isMigrateTokenRefusal(code)) return { status: "auth_required" };
    if (res.status === 401) {
      if (code === "legacy_key_invalid") return { status: "legacy_key_invalid" };
      if (code === "auth_required") return { status: "auth_required" };
      return { status: "unexpected_response", httpStatus: res.status, ...(code ? { code } : {}) };
    }
    if (res.status === 409 && code === "legacy_machine_key_migrated") {
      return { status: "legacy_machine_key_migrated" };
    }
    const accessResult = classifyAdoptLegacyAccessResponse(res.status, code);
    if (accessResult) return accessResult;
    if (!code) return { status: "unexpected_response", httpStatus: res.status };
    return { status: "error", code };
  }

  /**
   * POST /api/computer/adopt-legacy — user-authed manual server-row adoption.
   * A row bound to the target Server that is the caller's own, or any row
   * there for a caller with `registerMachines`; local fingerprint bytes are
   * not required.
   */
  async adoptLegacyByDaemonId(input: {
    serverSlug: string;
    daemonId: string;
    name?: string;
  }): Promise<AdoptLegacyResult> {
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await computerFetch(this.url("/api/computer/adopt-legacy"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify({
          serverSlug: input.serverSlug,
          daemonId: input.daemonId,
          ...(input.name ? { name: input.name } : {}),
        }),
      });
    } catch {
      return { status: "network_failed", serverUrl: this.baseUrl };
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.status === 201 && body && typeof body.apiKey === "string") {
      return {
        status: "success",
        apiKey: body.apiKey as string,
        computerId: String(body.computerId ?? ""),
        machineId: String(body.machineId ?? ""),
        serverId: String(body.serverId ?? ""),
        resumed: body.resumed === true,
      };
    }
    const code = body && typeof body.code === "string" ? (body.code as string) : undefined;
    // A migrate token the server no longer takes (expired / used / revoked):
    // the credential needs renewing, like an expired session.
    if (isMigrateTokenRefusal(code)) return { status: "auth_required" };
    if (res.status === 401) {
      if (code === "auth_required") return { status: "auth_required" };
      return { status: "unexpected_response", httpStatus: res.status, ...(code ? { code } : {}) };
    }
    if (res.status === 409 && code === "legacy_machine_key_migrated") {
      return { status: "legacy_machine_key_migrated" };
    }
    const accessResult = classifyAdoptLegacyAccessResponse(res.status, code);
    if (accessResult) return accessResult;
    if (!code) return { status: "unexpected_response", httpStatus: res.status };
    return { status: "error", code };
  }

  /**
   * POST /internal/computer/preflight — §9 READ-ONLY, side-effect-free.
   * Authenticated with the freshly-issued sk_computer_* (NOT the user
   * session). Proves surface + auth-registry + principal split alignment
   * before any local attachment state is committed.
   */
  async preflight(apiKey: string): Promise<PreflightResult> {
    const res = await computerFetch(this.url("/internal/computer/preflight"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: "{}",
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.status === 200 && body && body.ok === true) {
      return {
        ok: true,
        serverSlug: typeof body.serverSlug === "string" && body.serverSlug.length > 0 ? body.serverSlug : undefined,
      };
    }
    const code =
      body && typeof body.code === "string" ? (body.code as string) : `http_${res.status}`;
    return { ok: false, code };
  }
}

/** A migrate token (`dvmt_*`) the server refused as expired, used or unknown. */
function isMigrateTokenRefusal(code: unknown): boolean {
  return code === "migrate_token_invalid" || code === "migrate_token_expired" || code === "migrate_token_consumed";
}

// --- Legacy machine roster (RFC v9.9 §X.2) ---
// `GET /api/computer/legacy-machines?serverSlug=<slug>` — user-authed
// fetch of the caller's legacy `sk_machine_*` daemon rows on the target
// server, scoped to (userId, serverId) and filtered to non-NULL
// fingerprint. The setup picker intersects this
// roster with local `<installRoot>/machines/machine-<fp>/owner.json`
// evidence on `apiKeyFingerprint` to surface mutually-known migration
// targets. Already-migrated rows are included so interrupted adoption can
// resume the linked Computer instead of fresh-attaching a duplicate.
//
// Cody msg=ec68c27f redline: apiKeyFingerprint is sensitive identity —
// scoped endpoint only, never logged. Server enforces SELECT-whitelist
// and cloak symmetry on missing/deleted/non-member.

export interface LegacyMachineRosterEntry {
  daemonId: string;
  apiKeyFingerprint: string;
  machineName: string;
  hostname: string | null;
  lastSeenAt: string | null;
  legacyKeyMigratedAt: string | null;
}

export interface LegacyMachineManualEntry {
  daemonId: string;
  machineName: string;
  hostname: string | null;
  lastSeenAt: string | null;
  legacyKeyMigratedAt: string | null;
  hasFingerprint: boolean;
}

export type LegacyMachineRosterResult =
  | { status: "success"; entries: LegacyMachineRosterEntry[] }
  | { status: "auth_required" }
  | { status: "not_authorized" }
  | { status: "disabled" }
  | { status: "error"; code: string };

export type LegacyMachineManualRosterResult =
  | { status: "success"; entries: LegacyMachineManualEntry[] }
  | { status: "auth_required" }
  | { status: "not_authorized" }
  | { status: "disabled" }
  | { status: "error"; code: string };

// --- User servers roster (GET /api/servers/) ---
// Lists the servers the logged-in user is a member of, WITH the user's
// role on each. Authenticated with the user session access_token (same
// Bearer convention as LegacyMachinesClient). Used by GUI adapters (the
// Computer desktop app's attach screen) to present a multi-select server
// list where owner/admin rows are attachable and member rows are shown
// but disabled. The setup CLI also uses the same list to fail fast before
// migration work when the target server is absent or not attachable by the
// signed-in user's role.

/** A server the user belongs to. `role` stays open to future server-side
 * values; consumers must explicitly narrow the roles they authorize. */
export interface UserServerEntry {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export type UserServersResult =
  | { status: "success"; servers: UserServerEntry[] }
  | { status: "auth_required" }
  | { status: "error"; code: string };

export class ServersClient {
  constructor(
    private readonly baseUrl: string,
    private readonly accessToken: string,
  ) {}

  private url(p: string): string {
    return new URL(p, this.baseUrl).toString();
  }

  async list(): Promise<UserServersResult> {
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await computerFetch(this.url("/api/servers/"), {
        method: "GET",
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
    } catch {
      return { status: "error", code: "request_failed" };
    }
    if (res.status === 401) return { status: "auth_required" };
    const body = (await res.json().catch(() => null)) as unknown;
    if (res.status === 200 && Array.isArray(body)) {
      const servers: UserServerEntry[] = [];
      for (const raw of body as unknown[]) {
        if (!raw || typeof raw !== "object") {
          return { status: "error", code: "unexpected_shape" };
        }
        const e = raw as Record<string, unknown>;
        if (
          typeof e.id !== "string" ||
          typeof e.slug !== "string" ||
          typeof e.role !== "string"
        ) {
          return { status: "error", code: "unexpected_shape" };
        }
        servers.push({
          id: e.id,
          name: typeof e.name === "string" ? e.name : e.slug,
          slug: e.slug,
          role: e.role,
        });
      }
      return { status: "success", servers };
    }
    const errBody = body as Record<string, unknown> | null;
    const code =
      errBody && typeof errBody.code === "string"
        ? (errBody.code as string)
        : `http_${res.status}`;
    return { status: "error", code };
  }
}

/** The signed-in user's display identity, from `GET /api/auth/me`. Only the
 *  presentation fields the menu-bar needs — `name`/`displayName` are what the
 *  user recognizes; `email` is the stable fallback. (`#wg-raft-computer` task
 *  #112: menu showed a raw UUID / "Signed in" because the session stored only
 *  the user id.) */
export interface UserIdentity {
  id: string;
  email: string;
  name: string;
  displayName: string | null;
}

export type UserIdentityResult =
  | { status: "success"; user: UserIdentity }
  | { status: "auth_required" }
  | { status: "error"; code: string };

/** Reads the signed-in user's profile for display. Mirrors `ServersClient`:
 *  bearer the user access token, never throws — failures map to the closed
 *  result union so the caller (login-time enrichment) can degrade gracefully. */
export class AuthClient {
  constructor(
    private readonly baseUrl: string,
    private readonly accessToken: string,
  ) {}

  private url(p: string): string {
    return new URL(p, this.baseUrl).toString();
  }

  async me(): Promise<UserIdentityResult> {
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await computerFetch(this.url("/api/auth/me"), {
        method: "GET",
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
    } catch {
      return { status: "error", code: "request_failed" };
    }
    if (res.status === 401) return { status: "auth_required" };
    const body = (await res.json().catch(() => null)) as unknown;
    if (res.status === 200 && body && typeof body === "object") {
      const u = body as Record<string, unknown>;
      if (typeof u.id === "string" && typeof u.email === "string" && typeof u.name === "string") {
        return {
          status: "success",
          user: {
            id: u.id,
            email: u.email,
            name: u.name,
            displayName: typeof u.displayName === "string" ? u.displayName : null,
          },
        };
      }
      return { status: "error", code: "unexpected_shape" };
    }
    const errBody = body as Record<string, unknown> | null;
    const code = errBody && typeof errBody.code === "string" ? (errBody.code as string) : `http_${res.status}`;
    return { status: "error", code };
  }
}

export class LegacyMachinesClient {
  readonly targetServerUrl: string;

  constructor(
    private readonly baseUrl: string,
    private readonly accessToken: string,
  ) {
    this.targetServerUrl = baseUrl;
  }

  private url(p: string): string {
    return new URL(p, this.baseUrl).toString();
  }

  async list(serverSlug: string): Promise<LegacyMachineRosterResult> {
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await computerFetch(
        this.url(`/api/computer/legacy-machines?serverSlug=${encodeURIComponent(serverSlug)}`),
        {
          method: "GET",
          headers: { Authorization: `Bearer ${this.accessToken}` },
        },
      );
    } catch {
      return { status: "error", code: "request_failed" };
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.status === 200 && body && Array.isArray(body.entries)) {
      const entries = (body.entries as unknown[])
        .map((raw) => {
          if (!raw || typeof raw !== "object") return null;
          const e = raw as Record<string, unknown>;
          if (
            typeof e.daemonId !== "string" ||
            typeof e.apiKeyFingerprint !== "string" ||
            typeof e.machineName !== "string"
          ) {
            return null;
          }
          return {
            daemonId: e.daemonId,
            apiKeyFingerprint: e.apiKeyFingerprint,
            machineName: e.machineName,
            hostname: typeof e.hostname === "string" ? e.hostname : null,
            lastSeenAt: typeof e.lastSeenAt === "string" ? e.lastSeenAt : null,
            legacyKeyMigratedAt: typeof e.legacyKeyMigratedAt === "string" ? e.legacyKeyMigratedAt : null,
          } satisfies LegacyMachineRosterEntry;
        })
        .filter((entry): entry is LegacyMachineRosterEntry => entry !== null);
      return { status: "success", entries };
    }
    if (res.status === 401 || isMigrateTokenRefusal(body?.code)) return { status: "auth_required" };
    if (res.status === 403) return { status: "not_authorized" };
    if (res.status === 404) return { status: "disabled" };
    const code = body && typeof body.code === "string" ? (body.code as string) : `http_${res.status}`;
    return { status: "error", code };
  }

  async listAll(serverSlug: string): Promise<LegacyMachineManualRosterResult> {
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await computerFetch(
        this.url(`/api/computer/legacy-machines?serverSlug=${encodeURIComponent(serverSlug)}&includeAll=1`),
        {
          method: "GET",
          headers: { Authorization: `Bearer ${this.accessToken}` },
        },
      );
    } catch {
      return { status: "error", code: "request_failed" };
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.status === 200 && body && Array.isArray(body.entries)) {
      const entries = (body.entries as unknown[])
        .map((raw) => {
          if (!raw || typeof raw !== "object") return null;
          const e = raw as Record<string, unknown>;
          if (
            typeof e.daemonId !== "string" ||
            typeof e.machineName !== "string"
          ) {
            return null;
          }
          return {
            daemonId: e.daemonId,
            machineName: e.machineName,
            hostname: typeof e.hostname === "string" ? e.hostname : null,
            lastSeenAt: typeof e.lastSeenAt === "string" ? e.lastSeenAt : null,
            legacyKeyMigratedAt: typeof e.legacyKeyMigratedAt === "string" ? e.legacyKeyMigratedAt : null,
            hasFingerprint: e.hasFingerprint === true,
          } satisfies LegacyMachineManualEntry;
        })
        .filter((entry): entry is LegacyMachineManualEntry => entry !== null);
      return { status: "success", entries };
    }
    if (res.status === 401 || isMigrateTokenRefusal(body?.code)) return { status: "auth_required" };
    if (res.status === 403) return { status: "not_authorized" };
    if (res.status === 404) return { status: "disabled" };
    const code = body && typeof body.code === "string" ? (body.code as string) : `http_${res.status}`;
    return { status: "error", code };
  }
}

// --- Server machines roster (GET /api/servers/:id/machines) ---
// User-authenticated read used by Computer recovery flows to compare the
// currently attached Computer row with locally-known legacy candidates. The
// response is identity-only: no credentials, no owner ids.

export interface ServerMachineEntry {
  id: string;
  name: string;
  createdAt: string | null;
  isComputer: boolean;
  computerAttachedByCurrentUser: boolean;
  agentCount: number;
}

export type ServerMachinesResult =
  | { status: "success"; machines: ServerMachineEntry[] }
  | { status: "auth_required" }
  | { status: "not_authorized" }
  | { status: "error"; code: string };

export class ServerMachinesClient {
  constructor(
    private readonly baseUrl: string,
    private readonly accessToken: string,
  ) {}

  private url(p: string): string {
    return new URL(p, this.baseUrl).toString();
  }

  async list(serverId: string): Promise<ServerMachinesResult> {
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await computerFetch(this.url(`/api/servers/${encodeURIComponent(serverId)}/machines`), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "X-Server-Id": serverId,
        },
      });
    } catch {
      return { status: "error", code: "request_failed" };
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.status === 200 && body && Array.isArray(body.machines)) {
      const machines = (body.machines as unknown[])
        .map((raw) => {
          if (!raw || typeof raw !== "object") return null;
          const m = raw as Record<string, unknown>;
          if (typeof m.id !== "string" || typeof m.name !== "string") return null;
          return {
            id: m.id,
            name: m.name,
            createdAt: typeof m.createdAt === "string" ? m.createdAt : null,
            isComputer: m.isComputer === true,
            computerAttachedByCurrentUser: m.computerAttachedByCurrentUser === true,
            agentCount: typeof m.agentCount === "number" && Number.isFinite(m.agentCount)
              ? Math.max(0, Math.trunc(m.agentCount))
              : 0,
          } satisfies ServerMachineEntry;
        })
        .filter((entry): entry is ServerMachineEntry => entry !== null);
      return { status: "success", machines };
    }
    if (res.status === 401) return { status: "auth_required" };
    if (res.status === 403 || res.status === 404) return { status: "not_authorized" };
    const code = body && typeof body.code === "string" ? (body.code as string) : `http_${res.status}`;
    return { status: "error", code };
  }
}

// --- Computer runner control plane (RFC v0.8 §12) ---
// Authenticated with the sk_computer_* from runner.state.json (NOT the
// user session). The server enforces the §12 whitelist; the client
// only renders what the server returned — it never re-derives fields.

export interface RunnerListItem {
  agentId: string;
  name: string;
  status: string;
  model: string;
  runtime: string;
}

export type RunnerListResult =
  | { status: "success"; whitelist: string[]; runners: RunnerListItem[] }
  | { status: "unauthorized" }
  | { status: "error"; code: string };

export type RunnerStopResult =
  | { status: "success" }
  | { status: "not_found" }
  | { status: "unauthorized" }
  | { status: "error"; code: string };

export class RunnersClient {
  constructor(
    private readonly baseUrl: string,
    private readonly computerApiKey: string,
  ) {}

  private url(p: string): string {
    return new URL(p, this.baseUrl).toString();
  }

  async list(opts: { all?: boolean } = {}): Promise<RunnerListResult> {
    const path = opts.all ? "/internal/computer/runners?scope=server" : "/internal/computer/runners";
    const res = await computerFetch(this.url(path), {
      method: "GET",
      headers: { Authorization: `Bearer ${this.computerApiKey}` },
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.status === 200 && body && Array.isArray(body.runners)) {
      return {
        status: "success",
        whitelist: Array.isArray(body.whitelist) ? (body.whitelist as string[]) : [],
        runners: body.runners as RunnerListItem[],
      };
    }
    if (res.status === 401 || res.status === 403) return { status: "unauthorized" };
    const code = body && typeof body.code === "string" ? (body.code as string) : `http_${res.status}`;
    return { status: "error", code };
  }

  async stop(agentId: string): Promise<RunnerStopResult> {
    const res = await computerFetch(this.url(`/internal/computer/runners/${encodeURIComponent(agentId)}/stop`), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.computerApiKey}`, "Content-Type": "application/json" },
      body: "{}",
    });
    if (res.status === 200) return { status: "success" };
    if (res.status === 404) return { status: "not_found" };
    if (res.status === 401 || res.status === 403) return { status: "unauthorized" };
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const code = body && typeof body.code === "string" ? (body.code as string) : `http_${res.status}`;
    return { status: "error", code };
  }
}

// --- This Computer's own row and detach (device-auth PR 3c) ---
// Authenticated with the server's own sk_computer_* from runner.state.json,
// never a person's session. The server answers for the key's own Computer
// only.

/**
 * An older server has no such route: under the claimed `/internal/computer/`
 * prefix its auth registry answers 401 `auth_policy_unregistered_path`; any
 * other path answers 404. Never a reason to try another credential on its own:
 * a plain 401 means the key itself was refused.
 */
export function isMachineKeyRouteUnavailable(status: number, body: Record<string, unknown> | null): boolean {
  return status === 404 || (status === 401 && body?.code === "auth_policy_unregistered_path");
}

export interface ComputerSelf {
  computerId: string;
  computerName: string;
  serverId: string;
  machineId: string;
  machineName: string;
  agentCount: number;
}

export type ComputerSelfResult =
  | { status: "success"; computer: ComputerSelf }
  /** An older server without GET /internal/computer/self. */
  | { status: "route_unavailable" }
  | { status: "unauthorized"; code: string }
  | { status: "error"; code: string };

/** Someone else's agent on this machine that refused a detach (409 `others_agents_on_computer`). */
export interface DetachBlockingAgent {
  id: string;
  name: string;
  /** Who it belongs to; null when nobody can be asked (an agent made it, or its person left). */
  ownerName: string | null;
}

export type ComputerDetachResult =
  | { status: "detached" }
  /**
   * Other people's agents run on this machine (409 `others_agents_on_computer`):
   * nothing was revoked until they are moved or named in `forceAgentIds`.
   */
  | { status: "others_agents"; agents: DetachBlockingAgent[] }
  /** An older server without POST /internal/computer/detach. */
  | { status: "route_unavailable" }
  /** The server refused this key (revoked, unknown, or a legacy machine key). */
  | { status: "unauthorized"; httpStatus: number; code: string }
  | { status: "error"; code: string };

function bodyCode(status: number, body: Record<string, unknown> | null): string {
  return body && typeof body.code === "string" ? body.code : `http_${status}`;
}

export class ComputerSelfClient {
  constructor(
    private readonly baseUrl: string,
    private readonly computerApiKey: string,
  ) {}

  private url(p: string): string {
    return new URL(p, this.baseUrl).toString();
  }

  async self(): Promise<ComputerSelfResult> {
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await computerFetch(this.url("/internal/computer/self"), {
        method: "GET",
        headers: { Authorization: `Bearer ${this.computerApiKey}` },
      });
    } catch {
      return { status: "error", code: "request_failed" };
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (isMachineKeyRouteUnavailable(res.status, body)) return { status: "route_unavailable" };
    const raw = body?.computer;
    if (res.status === 200 && raw && typeof raw === "object") {
      const c = raw as Record<string, unknown>;
      if (typeof c.computerId === "string" && typeof c.machineId === "string" && typeof c.serverId === "string") {
        return {
          status: "success",
          computer: {
            computerId: c.computerId,
            computerName: typeof c.computerName === "string" ? c.computerName : "",
            serverId: c.serverId,
            machineId: c.machineId,
            machineName: typeof c.machineName === "string" ? c.machineName : "",
            agentCount: typeof c.agentCount === "number" && Number.isFinite(c.agentCount)
              ? Math.max(0, Math.trunc(c.agentCount))
              : 0,
          },
        };
      }
      return { status: "error", code: "invalid_response" };
    }
    if (res.status === 401 || res.status === 403) return { status: "unauthorized", code: bodyCode(res.status, body) };
    return { status: "error", code: bodyCode(res.status, body) };
  }

  /**
   * POST /internal/computer/detach: revoke this key and the runner keys its
   * machine minted. `forceAgentIds`: other people's agents on this machine to
   * unbind and stop with it (the ids a previous `others_agents` answer listed).
   */
  async detach(forceAgentIds: readonly string[] = []): Promise<ComputerDetachResult> {
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await computerFetch(this.url("/internal/computer/detach"), {
        method: "POST",
        headers: { Authorization: `Bearer ${this.computerApiKey}`, "Content-Type": "application/json" },
        body: forceAgentIds.length > 0 ? JSON.stringify({ forceAgentIds }) : "{}",
      });
    } catch {
      return { status: "error", code: "request_failed" };
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (isMachineKeyRouteUnavailable(res.status, body)) return { status: "route_unavailable" };
    if (res.status === 200 && body?.ok === true) return { status: "detached" };
    if (res.status === 409 && body?.code === "others_agents_on_computer" && Array.isArray(body.agents)) {
      return { status: "others_agents", agents: parseDetachBlockingAgents(body.agents) };
    }
    if (res.status === 401 || res.status === 403) {
      return { status: "unauthorized", httpStatus: res.status, code: bodyCode(res.status, body) };
    }
    return { status: "error", code: bodyCode(res.status, body) };
  }
}

function parseDetachBlockingAgents(raw: unknown[]): DetachBlockingAgent[] {
  const agents: DetachBlockingAgent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const agent = item as Record<string, unknown>;
    if (typeof agent.id !== "string" || agent.id.length === 0) continue;
    const owner = agent.owner && typeof agent.owner === "object" ? agent.owner as Record<string, unknown> : null;
    agents.push({
      id: agent.id,
      name: typeof agent.name === "string" ? agent.name : "",
      ownerName: owner && typeof owner.name === "string" ? owner.name : null,
    });
  }
  return agents;
}

// Minimal HTTP client for the PR-A2 shared device-code grant
// (`/api/auth/device/*`, RFC v0.8 contract v3 §3). undici fetch.
// Errors are mapped to ACTIONABLE codes — the caller renders guidance,
// never a raw server body (binding constraint).
import { fetch } from "undici";
import { computerFetch } from "./proxy.js";
import { classifyAdoptLegacyAccessResponse, type AdoptLegacyAccessResult } from "./lib/adoptLegacyResponse.js";

export interface DeviceAuthorizeResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export type DeviceTokenResult =
  | { status: "success"; accessToken: string; refreshToken: string; userId: string }
  | { status: "pending" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "error"; code: string };

export class DeviceAuthClient {
  constructor(private readonly baseUrl: string) {}

  private url(p: string): string {
    return new URL(p, this.baseUrl).toString();
  }

  async authorize(clientName: string): Promise<DeviceAuthorizeResult> {
    const res = await computerFetch(this.url("/api/auth/device/authorize"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientName }),
    });
    if (res.status === 404) {
      throw new Error(
        "device login is not enabled on this server (ask an admin to unset SLOCK_DEVICE_LOGIN_ENABLED or set it back to a non-false value; this surface is on by default since PR-G — upgrade the server if you are on an older build)",
      );
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

  async token(deviceCode: string): Promise<DeviceTokenResult> {
    const res = await computerFetch(this.url("/api/auth/device/token"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceCode }),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
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
   * The target Server's `manageMachines` permission authorizes a row bound to
   * that Server; caller row ownership and local fingerprint bytes are not required.
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
    if (res.status === 401) return { status: "auth_required" };
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
    if (res.status === 401) return { status: "auth_required" };
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

// Raft Desktop adds its own machine to a server with a one-time approval
// (device-auth design v2 §3.3), never by handing the Computer a session:
//
//   1. POST /auth/device/authorize with a `computer_attach` grant (this
//      machine's name, hostname and OS, from the shell);
//   2. POST /auth/device/describe with the code, as the signed-in person: the
//      approval ticket (#11891) and the servers this person may add it to;
//   3. POST /auth/device/approve with the ticket and the EXPLICIT server id
//      the person confirmed in the app ("Add this computer to <server>"; the
//      caller shows that before calling this);
//   4. POST /auth/device/token: the single-use `dvat_*` attach token for that
//      server, which the caller hands to the shell in memory.
//
// A server older than one-time grants answers describe without a `grant` (or
// does not know the device flow at all): the result is `legacy_server`, the
// code is denied when possible so it cannot be approved later, and nothing is
// approved here. The caller refuses to add it (it never copies a session).
//
// The device code and the attach token live only in this call and its result:
// never stored, logged, traced or put in an error message.

/** One POST: the status and body, for any HTTP status. Network failures throw. */
export type AttachGrantPost = (url: string, body: Record<string, unknown>) => Promise<{ status: number; data: unknown }>;

export interface AttachGrantInput {
  /** The server the person confirmed, by slug (as the UI names it). */
  serverSlug: string;
  /** This machine, as the shell describes it. */
  machineName: string;
  hostname: string;
  os: string;
}

export type AttachGrantResult =
  | { kind: "token"; attachToken: string; serverId: string; serverSlug: string }
  /** The server has no one-time grants: nothing was approved. */
  | { kind: "legacy_server" };

const ATTACH_TOKEN_RE = /^dvat_[A-Za-z0-9_-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TOKEN_POLLS = 5;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function codeOf(data: unknown): string {
  const code = record(data)?.code;
  return typeof code === "string" && /^[a-z_]{1,64}$/i.test(code) ? code : "unexpected_response";
}

/** A failure the UI words (localComputerLogic.classifyHostError); never carries a secret. */
function failure(code: string): Error {
  // "requires_admin" reads as admin_required; everything else as generic.
  return new Error(code === "requires_admin" ? "attach_grant_requires_admin" : `attach_grant_failed:${code}`);
}

function normalizeSlug(slug: string): string {
  return slug.trim().replace(/^\/+/, "").toLowerCase();
}

export async function obtainDesktopAttachToken(
  post: AttachGrantPost,
  input: AttachGrantInput,
  deps: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<AttachGrantResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const wantedSlug = normalizeSlug(input.serverSlug);
  if (!wantedSlug) throw failure("server_required");

  const authorized = await post("/auth/device/authorize", {
    clientName: "Raft Desktop",
    grant: { kind: "computer_attach", machineName: input.machineName, hostname: input.hostname, os: input.os },
  });
  // 404 from a server that does not know the device flow: nothing was
  // started. A server that has it but has turned it off (the kill switch,
  // `device_login_disabled`) is not an older server: say so.
  if (authorized.status === 404) {
    if (codeOf(authorized.data) === "device_login_disabled") throw failure("device_login_disabled");
    return { kind: "legacy_server" };
  }
  const auth = record(authorized.data);
  const deviceCode = auth?.deviceCode;
  const userCode = auth?.userCode;
  if (authorized.status !== 201 || typeof deviceCode !== "string" || typeof userCode !== "string") {
    throw failure(authorized.status === 201 ? "unexpected_response" : codeOf(authorized.data));
  }
  const interval = typeof auth?.interval === "number" && auth.interval > 0 ? Math.min(auth.interval, 10) : 1;

  const described = await post("/auth/device/describe", { userCode });
  const request = record(described.data);
  if (described.status !== 200 || !request) throw failure(codeOf(described.data));
  const grant = record(request.grant);
  const approvalTicket = request.approvalTicket;
  if (!grant) {
    // An older server ignored the grant: this code would sign a device
    // session in. Deny it so nobody can approve it later, and approve nothing.
    await post("/auth/device/approve", { userCode, approve: false }).catch(() => undefined);
    return { kind: "legacy_server" };
  }
  if (grant.kind !== "computer_attach" || typeof approvalTicket !== "string") throw failure("unexpected_response");
  const servers = Array.isArray(grant.servers) ? grant.servers.map(record) : [];
  const server = servers.find((s) => typeof s?.slug === "string" && normalizeSlug(s.slug) === wantedSlug);
  const serverId = server?.id;
  if (!server || typeof serverId !== "string" || !UUID_RE.test(serverId)) {
    // Not a server this person may add computers to (or a malformed answer).
    await post("/auth/device/approve", { userCode, approve: false }).catch(() => undefined);
    throw failure(server ? "unexpected_response" : "requires_admin");
  }

  const approved = await post("/auth/device/approve", { userCode, approve: true, approvalTicket, serverId });
  if (approved.status !== 200) {
    throw failure(codeOf(approved.data) === "grant_selection_not_allowed" ? "requires_admin" : codeOf(approved.data));
  }

  for (let poll = 0; poll < MAX_TOKEN_POLLS; poll += 1) {
    const answered = await post("/auth/device/token", { deviceCode });
    const body = record(answered.data);
    if (answered.status === 200 && body?.kind === "computer_attach") {
      const { attachToken, serverId: tokenServerId, serverSlug } = body;
      if (
        typeof attachToken !== "string" || !ATTACH_TOKEN_RE.test(attachToken) ||
        tokenServerId !== serverId ||
        typeof serverSlug !== "string" || normalizeSlug(serverSlug) !== wantedSlug
      ) {
        throw failure("unexpected_response");
      }
      return { kind: "token", attachToken, serverId, serverSlug };
    }
    // Anything else at 200 (a session, say) is never taken.
    if (answered.status === 200) throw failure("unexpected_response");
    if (codeOf(answered.data) !== "authorization_pending") throw failure(codeOf(answered.data));
    await sleep(interval * 1000);
  }
  throw failure("token_timeout");
}

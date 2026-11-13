import { axSurface } from "../../core/renderer";
import type {
  AgentLoginIntegrationInventoryProjection,
  AppSetupState,
} from "@botiverse/raft-shared";
import {
  AGENT_LOGIN_INTEGRATION_INVENTORY_PROJECTION,
  foldAgentOneLineText,
  formatManagedMcpPromptName,
} from "@botiverse/raft-shared/src/agentCliSurface";

export interface RegisteredIntegrationService {
  id: string;
  clientId: string;
  appType?: "server_local" | "slock_builtin" | "third_party_global";
  name: string;
  description: string | null;
  homepageUrl: string | null;
  returnUrl: string | null;
  agentManifestUrl: string | null;
  agentManifestUrlSource?: "explicit" | "well_known" | null;
  allowedScopes?: string[];
  setupUrl?: string | null;
  setupDescription?: string | null;
  setup?: AppSetupState | null;
  createdAt: string;
  updatedAt: string;
  /** Set by the platform's official-app judgment (contract rev3.1), never by the app. Absent/false = ordinary service. */
  official?: boolean;
  /** One-line purpose the platform records for an official app; empty for ordinary services. */
  purpose?: string;
}

export interface ActiveAgentLogin {
  id: string;
  serviceId: string;
  clientId: string;
  appType?: "server_local" | "slock_builtin" | "third_party_global";
  name: string;
  description: string | null;
  homepageUrl: string | null;
  returnUrl: string | null;
  agentManifestUrl: string | null;
  agentManifestUrlSource?: "explicit" | "well_known" | null;
  scopes: string[];
  createdAt: string;
}

/**
 * An MCP App this Agent has. MCP Apps and Agent Login services are all Raft Apps, of different
 * types: an MCP App is used through the MCP tools it gives the runtime, never through
 * `raft integration login` / `invoke`. Mirrors the server's `agentApiIntegrationMcpAppSchema`;
 * `state` is kept open (`string`) so a state a newer server adds is shown rather than dropped.
 */
export interface IntegrationMcpApp {
  type: "mcp";
  id: string;
  name: string;
  description: string | null;
  homepageUrl: string | null;
  state: "ready" | "login_required" | "authorization_expired" | "disabled" | (string & {});
  access: "mcp_tools";
  toolCount: number;
  toolNames: string[];
  /** Whether this Agent has the App; absent from older servers, which listed only Apps it has. */
  grant?: "granted" | "revoked" | "not_granted" | (string & {});
}

export interface IntegrationListResponse {
  services: RegisteredIntegrationService[];
  activeLogins: ActiveAgentLogin[];
  /** Absent from servers older than MCP Apps in this list. */
  mcpApps?: IntegrationMcpApp[];
}

export function projectCurrentIntegrationList(data: IntegrationListResponse): IntegrationListResponse {
  const services = data.services.filter((service) => service.appType !== "slock_builtin");
  const serviceIds = new Set(services.map((service) => service.id));
  return {
    services,
    activeLogins: data.activeLogins.filter((login) => (
      login.appType !== "slock_builtin" && serviceIds.has(login.serviceId)
    )),
    ...(Array.isArray(data.mcpApps) ? { mcpApps: data.mcpApps } : {}),
  };
}

function normalizeServiceQuery(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The MCP App a `--service` argument names (by id, or by name, case-insensitive), so `login`,
 * `invoke` and `env` can say what it is instead of "not found".
 */
export function findMcpAppForService(data: Pick<IntegrationListResponse, "mcpApps">, service: string): IntegrationMcpApp | null {
  const query = service.trim();
  if (!query) return null;
  const apps = data.mcpApps ?? [];
  return apps.find((app) => app.id === query)
    ?? apps.find((app) => normalizeServiceQuery(app.name) === normalizeServiceQuery(query))
    ?? null;
}

const MCP_APP_STATE_LABEL: Record<string, string> = {
  ready: "ready",
  login_required: "needs sign-in",
  authorization_expired: "sign-in expired",
  disabled: "disabled on this server",
};

const MCP_APP_GRANT_LABEL: Record<string, string> = {
  granted: "granted",
  revoked: "revoked",
  not_granted: "not granted",
};

function mcpAppGranted(app: IntegrationMcpApp): boolean {
  return app.grant === undefined || app.grant === "granted";
}

/**
 * The next step for an MCP App. Anything missing (access, or a connection) is asked for with
 * `raft integration login --service <id> --target <conversation>`, which posts the App's Connect
 * card there, as an ordinary App's login posts its approval card.
 */
function mcpAppNextStep(app: IntegrationMcpApp): string {
  if (app.state === "disabled") return "a server owner/admin can switch it on; until then its tools are unavailable";
  if (app.state === "ready" && mcpAppGranted(app)) {
    return "call its MCP tools from your runtime; they are in your tool list (if not yet, use raft_app_tools / raft_app_call)";
  }
  const login = `raft integration login --service ${JSON.stringify(app.id)} --target <channel-or-thread>`;
  if (!mcpAppGranted(app)) {
    return `run \`${login}\` to post a request card in that conversation for a person who can grant you this App; use its tools after they have`;
  }
  return `run \`${login}\` to post a request card in that conversation for a person who can connect it (calling any of its tools from a conversation raises the same card there); use its tools after they have`;
}

/** The message `login` / `invoke` / `env` give for an MCP App: there is no Agent Login for it. */
export function mcpAppIsNotAgentLoginMessage(app: IntegrationMcpApp, command: string): string {
  // App and tool names reach the model quoted on one line (formatManagedMcpPromptName).
  return `${formatManagedMcpPromptName(app.name)} is an MCP App (type: MCP), not an Agent Login service: \`raft integration ${command}\` does not apply to it. `
    + `It is used through the MCP tools it gives your runtime. State: ${MCP_APP_STATE_LABEL[app.state] ?? app.state}; next: ${mcpAppNextStep(app)}.`;
}

function pushMcpAppBlock(lines: string[], app: IntegrationMcpApp): void {
  lines.push(`- ${foldAgentOneLineText(app.name)}`);
  lines.push("  type: MCP");
  lines.push(`  id: ${app.id}`);
  if (app.grant !== undefined) lines.push(`  grant: ${MCP_APP_GRANT_LABEL[app.grant] ?? app.grant}`);
  lines.push(`  state: ${MCP_APP_STATE_LABEL[app.state] ?? app.state}`);
  // Tool names come from the remote MCP server: each quoted on one line (formatManagedMcpPromptName).
  const shown = app.toolNames.slice(0, 10).map(formatManagedMcpPromptName);
  const more = app.toolNames.length - shown.length;
  lines.push(`  tools: ${app.toolCount}${shown.length > 0 ? ` (${shown.join(", ")}${more > 0 ? `, +${more} more` : ""})` : ""}`);
  if (app.homepageUrl) lines.push(`  homepage: ${app.homepageUrl}`);
  if (app.description) lines.push(`  description: ${foldAgentOneLineText(app.description)}`);
  lines.push(`  next: ${mcpAppNextStep(app)}`);
}

export interface IntegrationLoginResponse {
  status: "logged_in" | "already_logged_in" | "approval_required" | "install_required";
  nextAction?: "install_from_marketplace";
  /** Supplied only by Raft's login response; absent on older Servers. */
  agentHandoffProtocol?: string;
  service: RegisteredIntegrationService;
  scopes: string[];
  requestId?: string;
  session?: {
    status: "stored";
    authentication?: "unverified" | "verified";
    source: "cache" | "fresh";
    path: string | null;
  };
  approval?: {
    requestId: string;
    target: string | null;
    actionCardMessageId: string | null;
  };
  installation?: {
    serverSlug: string;
    serverName: string;
    marketplaceUrl: string;
    target: string | null;
    actionCardMessageId: string | null;
  };
}

// The platform response describes the Raft grant. The CLI cannot infer an
// authenticated application session from arbitrary Set-Cookie headers.
export type IntegrationLoginOutput = Omit<IntegrationLoginResponse, "status"> & {
  status: IntegrationLoginResponse["status"] | "grant_active";
};

function formatMaybe(value: string | null | undefined): string {
  return value?.trim() || "-";
}

export function buildAgentCallbackHandoffUrl(returnUrl: string | null | undefined, requestId: string): string | null {
  if (!returnUrl?.trim()) return null;
  try {
    const url = new URL(returnUrl);
    url.searchParams.set("code", requestId);
    return url.toString();
  } catch {
    return null;
  }
}

function pushServiceBlock(
  lines: string[],
  service: RegisteredIntegrationService,
  active: ActiveAgentLogin | undefined,
): void {
  lines.push(`- ${foldAgentOneLineText(service.name)}`);
  lines.push(`  service: ${service.clientId}`);
  lines.push(`  id: ${service.id}`);
  lines.push(`  session: ${active ? "active login" : "not logged in"}`);
  lines.push(`  return URL: ${formatMaybe(service.returnUrl)}`);
  if (service.agentManifestUrl) {
    lines.push(`  agent behavior manifest: ${service.agentManifestUrl}`);
    lines.push(`  local CLI env: raft integration env --service ${JSON.stringify(service.clientId)}`);
    lines.push(`  for login_with_raft HTTP API action manifests: raft integration invoke --service ${JSON.stringify(service.clientId)} --list-actions`);
  }
  if (service.setup) {
    lines.push(`  installation setup: ${service.setup.status}`);
    if (service.setup.url) lines.push(`  setup link for a Server administrator: ${service.setup.url}`);
  } else if (service.setupUrl) lines.push("  post-install setup: required");
  if (service.homepageUrl) lines.push(`  homepage: ${service.homepageUrl}`);
  if (service.description) lines.push(`  description: ${foldAgentOneLineText(service.description)}`);
  // Contract rev3.1 §4b: the `official` mark is platform-set, never app-supplied, and
  // the list shows installed services only. Ordinary services print neither line.
  if (service.official === true) lines.push("  official: yes (set by the platform, never by the app)");
  if (service.official === true && service.purpose && service.purpose.trim()) lines.push(`  purpose: ${service.purpose.trim()}`);
  if (!active) lines.push(`  next: raft integration login --service ${JSON.stringify(service.clientId)}`);
}

export const formatIntegrationList = axSurface(
  "Agent Login inventory with scope preamble (shared projection with the system prompt).",
  (
  data: IntegrationListResponse,
  inventoryProjection: AgentLoginIntegrationInventoryProjection =
    AGENT_LOGIN_INTEGRATION_INVENTORY_PROJECTION,
): string => {
  const inventoryCopy = inventoryProjection.copy;
  // Older Servers may still return historical tombstone rows. Never project
  // them as an available service or active Agent Login.
  const { services: visibleServices, activeLogins: visibleActiveLogins } = projectCurrentIntegrationList(data);
  const activeByServiceId = new Map(visibleActiveLogins.map((login) => [login.serviceId, login]));
  const lines: string[] = [
    inventoryCopy.heading,
    inventoryCopy.scope,
    inventoryCopy.exclusion,
    inventoryCopy.boundary,
    inventoryCopy.reference,
    "",
  ];

  lines.push("Registered services:");
  if (visibleServices.length === 0) {
    lines.push("- none");
  } else {
    for (const service of visibleServices) {
      pushServiceBlock(lines, service, activeByServiceId.get(service.id));
    }
  }

  lines.push("");
  lines.push("Active agent logins:");
  if (visibleActiveLogins.length === 0) {
    lines.push("- none");
  } else {
    for (const login of visibleActiveLogins) {
      lines.push(`- ${foldAgentOneLineText(login.name)}`);
      lines.push(`  service: ${login.clientId}`);
      lines.push(`  grant id: ${login.id}`);
      lines.push("  session: active login");
      lines.push(`  scopes: ${login.scopes.length > 0 ? login.scopes.join(", ") : "-"}`);
      lines.push(`  return URL: ${formatMaybe(login.returnUrl)}`);
      if (login.agentManifestUrl) {
        lines.push(`  agent behavior manifest: ${login.agentManifestUrl}`);
        lines.push(`  local CLI env: raft integration env --service ${JSON.stringify(login.clientId)}`);
        lines.push(`  for login_with_raft HTTP API action manifests: raft integration invoke --service ${JSON.stringify(login.clientId)} --list-actions`);
      }
      lines.push(`  created: ${login.createdAt}`);
    }
  }

  lines.push("");
  lines.push("MCP Apps (used through their MCP tools, not `invoke`; `login` asks a person for access or a connection):");
  if (data.mcpApps === undefined) {
    lines.push("- not reported: this server predates MCP Apps in this list; see your Apps tab");
  } else if (data.mcpApps.length === 0) {
    lines.push("- none");
  } else {
    for (const app of data.mcpApps) pushMcpAppBlock(lines, app);
  }

  return (lines.join("\n"));
},
  {
    examples: [{ args: [{ services: [{ id: "svc-2", clientId: "lens", name: "lens", appType: "third_party_global", description: "trajectory viewer", returnUrl: "https://lens.example/callback", homepageUrl: "https://lens.example", agentManifestUrl: null }], activeLogins: [{ id: "grant-00000001", serviceId: "svc-2", clientId: "lens", name: "lens", description: "trajectory viewer", homepageUrl: "https://lens.example", returnUrl: "https://lens.example/callback", agentManifestUrl: null, scopes: ["identity", "openid"], createdAt: "2026-08-31T08:00:00.000Z" }], mcpApps: [{ type: "mcp", id: "mcp-1", name: "Team Notion", description: "Workspace pages", homepageUrl: "https://notion.example", state: "login_required", access: "mcp_tools", toolCount: 2, toolNames: ["notion-search", "notion-fetch"] }] } as never] }],
  },
);

/**
 * `raft integration login` on an MCP App: the server's own answer (a request card posted or reused,
 * already usable, or --target needed), printed as is. It is written for an Agent and carries the
 * next step, and is what older CLIs print too.
 */
export const formatIntegrationMcpLoginOutcome = axSurface(
  "raft integration login on an MCP App: the server's answer (request card posted or reused, already usable, or rerun with --target), with the next step.",
  (message: string) => message,
  {
    examples: [{ args: ["\"Team Notion\" is an MCP App, used through its MCP tools rather than Agent Login. A request card was posted to #apps for a person who can connect it. Wait for them to grant it in the card, then call its MCP tools (if they are not in your tool list yet, use raft_app_tools / raft_app_call)."] }],
  },
);

export const formatIntegrationLogin = axSurface(
  "Login outcome incl. approval/installation requirement shapes.",
  (data: IntegrationLoginOutput): string => {
  if (data.status === "install_required") {
    const lines = [
      `Marketplace install required: ${foldAgentOneLineText(data.service.name)}`,
      `service: ${data.service.clientId}`,
      `id: ${data.service.id}`,
      `server: ${data.installation?.serverName ?? "-"}`,
      `scopes: ${data.scopes.length > 0 ? data.scopes.join(", ") : "-"}`,
      `next action: ${data.nextAction ?? "install_from_marketplace"}`,
      `marketplace: ${data.installation?.marketplaceUrl ?? "-"}`,
    ];
    if (data.service.setupUrl) lines.push("post-install configuration is required; an administrator can continue from the installed App details");
    if (data.installation?.actionCardMessageId) {
      lines.push(`install card: ${data.installation.actionCardMessageId}`);
      lines.push(`target: ${data.installation.target ?? "-"}`);
      lines.push("next: ask a server owner/admin to install the app with this card, then rerun this command");
    } else {
      lines.push("install card: not posted");
      lines.push("next: ask a server owner/admin to install this public Marketplace app on the named Server, or rerun with --target <channel-or-thread> to post an install card");
    }
    lines.push("note: the app exists; it is not installed on this Server yet. This command did not install it.");
    return (lines.join("\n"));
  }
  if (data.status === "approval_required") {
    const lines = [
      `Human approval required: ${foldAgentOneLineText(data.service.name)}`,
      `service: ${data.service.clientId}`,
      `id: ${data.service.id}`,
      `scopes: ${data.scopes.length > 0 ? data.scopes.join(", ") : "-"}`,
      `request id: ${data.approval?.requestId ?? data.requestId}`,
    ];
    if (data.approval?.actionCardMessageId) {
      lines.push(`approval card: ${data.approval.actionCardMessageId}`);
      lines.push(`target: ${data.approval.target ?? "-"}`);
      lines.push("next: ask a server owner/admin to approve the card, then rerun this command");
    } else {
      lines.push("approval card: not posted");
      lines.push("next: rerun with --target <channel-or-thread> to post a human approval card, or ask a server owner/admin to approve this request");
    }
    return (lines.join("\n"));
  }

  const verb = "Raft grant active";
  const lines = [
    `${verb}: ${foldAgentOneLineText(data.service.name)}`,
    `service: ${data.service.clientId}`,
    `id: ${data.service.id}`,
    `scopes: ${data.scopes.length > 0 ? data.scopes.join(", ") : "-"}`,
    `return URL: ${formatMaybe(data.service.returnUrl)}`,
  ];
  if (data.service.agentManifestUrl) {
    lines.push(`agent behavior manifest: ${data.service.agentManifestUrl}`);
    lines.push(`local CLI env: raft integration env --service ${JSON.stringify(data.service.clientId)}`);
    lines.push(`for login_with_raft HTTP API action manifests: raft integration invoke --service ${JSON.stringify(data.service.clientId)} --list-actions`);
  }
  lines.push("grant: this agent is authorized in Raft; application authentication has not been verified");
  if (data.service.setup) {
    lines.push(`installation setup: ${data.service.setup.status}`);
    if (data.service.setup.url) lines.push(`setup link for a Server administrator: ${data.service.setup.url}`);
  }
  lines.push("identity: run `raft profile show` if the service or human asks for your Raft Agent identity card");
  if (data.session) {
    lines.push(data.session.authentication === "verified"
      ? "session: the App confirmed this Agent and Server"
      : "session: callback cookies stored for this agent; application authentication unverified");
    if (data.session.path) lines.push(`session store: ${data.session.path}`);
    lines.push(data.session.authentication === "verified"
      ? `next: use \`raft integration invoke --service ${JSON.stringify(data.service.clientId)} --list-actions\` for login_with_raft HTTP API action manifests`
      : `next: use \`raft integration invoke --service ${JSON.stringify(data.service.clientId)} --list-actions\` only for login_with_raft HTTP API action manifests; for session-cookie services, verify authentication with a documented read-only service check before use`);
  } else {
    lines.push("session: no service callback session was established; Raft grant is active");
    lines.push("next: follow the service documentation to establish and verify application authentication");
  }
  return (lines.join("\n"));
},
  {
    examples: [{ args: [{ status: "logged_in", service: { id: "svc-2", clientId: "lens", name: "lens", appType: "third_party_global", description: "trajectory viewer", returnUrl: "https://lens.example/callback", homepageUrl: null, agentManifestUrl: null }, scopes: ["identity"], session: { status: "stored", source: "fresh", path: null } } as never] }],
  },
);

// --- v1 invoke error/receipt surfaces (moved from invokeV1.ts, error-face AX coverage) ---
import type { IntegrationActionReceiptV1, IntegrationErrorV1 } from "./invokeV1";

export const formatIntegrationReceiptV1 = axSurface(
  "v1 action receipt block: operation/authority/transport/schema/readback/rollback statuses and next action.",
  (input: {
    receipt: IntegrationActionReceiptV1;
    value?: unknown;
  }): string => {
  const lines = [
    `Action receipt: ${input.receipt.operation.status}`,
    `service: ${input.receipt.target.service_id}`,
    `action: ${input.receipt.action.name}`,
    `effect: ${input.receipt.action.effect}`,
    `receipt id: ${input.receipt.receipt_id}`,
    `invocation id: ${input.receipt.invocation.id}`,
    `attempt: ${input.receipt.invocation.attempt}`,
    `authority: ${input.receipt.authority.status}`,
    `transport: ${input.receipt.transport.status}`,
    `HTTP status: ${input.receipt.transport.http_status ?? "-"}`,
    `response schema: ${input.receipt.response_schema.status}`,
    `readback: ${input.receipt.readback.status}`,
    `rollback: ${input.receipt.rollback.mode}/${input.receipt.rollback.status}`,
    `retryable: ${input.receipt.retryable ? "yes" : "no"}`,
    `next: ${input.receipt.next_action}`,
  ];
  if (input.value !== undefined) {
    lines.push("result:");
    lines.push(JSON.stringify(input.value, null, 2));
  }
  return lines.join("\n");
},
  {
    examples: [{
      args: [{
        receipt: {
          receipt_id: "rcpt-00000001",
          target: { service_id: "lens" },
          action: { name: "list_trajectories", effect: "read" },
          operation: { status: "succeeded" },
          invocation: { id: "inv-00000001", attempt: 1 },
          authority: { status: "granted" },
          transport: { status: "ok", http_status: 200 },
          response_schema: { status: "valid" },
          readback: { status: "confirmed" },
          rollback: { mode: "none", status: "not_needed" },
          retryable: false,
          next_action: "none",
        } as never,
        value: { count: 2 },
      }],
    }],
  },
);

export const formatIntegrationErrorV1 = axSurface(
  "v1 invoke typed error text: labelled evidence block (manifest/auth/authority/transport/schema/readback) plus optional appended receipt.",
  (error: IntegrationErrorV1, receipt?: IntegrationActionReceiptV1): string => {
    const base = (() => {
  return [
    `Error: ${error.message}`,
    `Code: ${error.code}`,
    `Service: ${error.service_id}`,
    `Action: ${error.action ?? "-"}`,
    `Effect: ${error.effect ?? "-"}`,
    `Fault domain: ${error.fault_domain}`,
    `Retryable: ${error.retryable ? "yes" : "no"}`,
    `Manifest: ${error.evidence.manifest}`,
    `Auth: ${error.evidence.auth}`,
    `Authority: ${error.evidence.authority}`,
    `Transport: ${error.evidence.transport}`,
    `Response schema: ${error.evidence.response_schema}`,
    `Readback: ${error.evidence.readback}`,
    `Schema path: ${error.schema_path ?? "-"}`,
    `HTTP status: ${error.http_status ?? "-"}`,
    `Request id: ${error.request_id ?? "-"}`,
    `Next action: ${error.next_action}`,
  ].join("\n");
})();
    return base + (receipt ? `\nReceipt:\n${formatIntegrationReceiptV1({ receipt })}` : "");
  },
  {
    examples: [{
      args: [{
        message: "Upstream schema mismatch",
        code: "INVOKE_SCHEMA_INVALID",
        service_id: "lens",
        action: "list_trajectories",
        effect: "read",
        fault_domain: "service",
        retryable: false,
        evidence: { manifest: "ok", auth: "ok", authority: "ok", transport: "ok", response_schema: "failed", readback: "not_reached" },
        schema_path: "$.items[0].id",
        http_status: 200,
        request_id: "req-00000001",
        next_action: "Report the schema mismatch to the service owner.",
      } as never],
    }],
  },
);

export const formatIntegrationTokenReceiverOutput = axSurface(
  "JWT-redacted output forwarded from the caller-selected receiving process.",
  (redactedOutput: string) => redactedOutput,
  { examples: [{ args: ["receiver result: <redacted>"] }] },
);

export const formatIntegrationTokenReceipt = axSurface(
  "Audience JWT private process delivery receipt; does not assert service authentication.",
  (result: { audience: string; expiresAt: string }) =>
    `Agent JWT delivered for ${result.audience}; expires ${result.expiresAt}. Service authentication is determined by the receiver.`,
  { examples: [{ args: [{ audience: "example-service", expiresAt: "2026-10-05T00:05:00Z" }] }] },
);

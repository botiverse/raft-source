import { isSafeOAuthReturnUrl } from "./oauthRedirect";

/** Configuration progress is separate from every installation permission. */
export type AppSetupState = {
  status: "not_required" | "pending" | "complete";
  url: string | null;
  description: string | null;
  revision: number;
  completedAt: string | null;
};

/**
 * Which of a Server's agents can use an App (Raft App or MCP App): the agents member lists show,
 * oldest first. `allAgents` when none is excepted. Ids only: no Connection, account or creator.
 */
export type AppAgentAccess = {
  allAgents: boolean;
  agentIds: string[];
  exceptAgentIds: string[];
};

export class AppSetupValidationError extends Error {}

export function normalizeAppSetupUrl(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string" || raw.length > 2000) throw new AppSetupValidationError("setupUrl must be a URL of at most 2000 characters");
  const value = raw.trim();
  if (!value) return null;
  if (!isSafeOAuthReturnUrl(value)) throw new AppSetupValidationError("setupUrl must be HTTPS (or loopback HTTP), without credentials or fragment");
  return new URL(value).toString();
}

export function normalizeAppSetupDescription(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string" || raw.length > 500 || /[\x00-\x1f\x7f]/.test(raw)) {
    throw new AppSetupValidationError("setupDescription must be a single line of at most 500 characters");
  }
  return raw.trim() || null;
}

export type AppSetupInstallationId = string & { readonly __appSetupInstallationId: unique symbol };
/** The HTTP/DB adapter is the only place raw installation IDs enter this contract. */
export function asAppSetupInstallationId(raw: string): AppSetupInstallationId {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    throw new AppSetupValidationError("installation_id must be an installation UUID");
  }
  return raw.toLowerCase() as AppSetupInstallationId;
}

export function projectAppSetup(input: {
  setupUrl: string | null;
  setupDescription: string | null;
  setupRevision: number;
  installationId: AppSetupInstallationId;
  serverId: string;
  completedRevision: number | null;
  completedAt: Date | string | null;
}): AppSetupState {
  if (!input.setupUrl) return { status: "not_required", url: null, description: null, revision: input.setupRevision, completedAt: null };
  const url = new URL(normalizeAppSetupUrl(input.setupUrl)!);
  // These are context identifiers, never credentials or proof of user authority.
  url.searchParams.set("installation_id", input.installationId);
  url.searchParams.set("server_id", input.serverId);
  url.searchParams.set("setup_revision", String(input.setupRevision));
  const complete = input.completedRevision === input.setupRevision;
  return {
    status: complete ? "complete" : "pending",
    url: url.toString(),
    description: input.setupDescription,
    revision: input.setupRevision,
    completedAt: complete && input.completedAt ? new Date(input.completedAt).toISOString() : null,
  };
}

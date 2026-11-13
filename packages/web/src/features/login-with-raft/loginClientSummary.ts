import type { Server } from "../../store/serverStore";

/** One Server's answer to GET /oauth/clients/lookup: the App as the setup page shows it there. */
export type LoginClientSummary = {
  id?: string;
  clientId: string;
  appType: "server_local" | "third_party_global";
  name: string;
  description: string | null;
  homepageUrl: string | null;
  returnUrl: string | null;
  logoUrl?: string | null;
  setupUrl?: string | null;
  setupDescription?: string | null;
  allowedScopes?: string[] | null;
  /** Data groups the app reads; installing approves them with its login scopes. */
  appNotificationGroups?: string[];
  whenToUse?: string | null;
  /** The text revision name / description / whenToUse are (app_prompt_text_consent); installing confirms it. */
  promptTextRevisionId?: string | null;
  scopeValidation?: {
    allowed: boolean;
    reason: "not_allowed" | "unsupported" | "mixed" | null;
    disallowedScopes: string[];
  };
  marketplace?: boolean;
  /** "suspended": installed on that Server, but the installation is suspended; no login there. */
  availability?: "ready" | "install_required" | "suspended";
  installation?: {
    serverId: string;
    canInstall: boolean;
  };
  /**
   * While the App is install_required on that Server and ships a bot: the
   * bot's handle, so Install and Continue can offer "Also add @handle".
   * Absent otherwise, or from an older server.
   */
  bot?: { handle: string };
  /**
   * RFC 079 phase 3a: "account" when the App signs people in with their Raft
   * account and no Server (POST /oauth/authorize/account). Absent for every
   * server-mode App, whose page stays the Server picker.
   */
  loginMode?: "account";
};

export type AvailableServerClient = {
  server: Server;
  client: LoginClientSummary;
};

/** The App signs in with the person's Raft account, not on a chosen Server. */
export function isAccountLoginEntry(entry: AvailableServerClient): boolean {
  return entry.client.loginMode === "account";
}

/** Login can continue on this Server (installed and not suspended, or server-local). */
export function isLoginAvailable(client: Pick<LoginClientSummary, "availability">): boolean {
  return client.availability !== "install_required" && client.availability !== "suspended";
}

/** The order the page lists and picks Servers in: ready, installable, needs an admin, suspended. */
export function marketplaceServerRank(entry: AvailableServerClient | undefined) {
  if (!entry || entry.client.availability === "suspended") return 3;
  if (entry.client.availability !== "install_required") return 0;
  return entry.client.installation?.canInstall ? 1 : 2;
}

/** The Server the page picks first among these (`ordered[0]` by rank, then name). */
export function firstServerByRank(entries: AvailableServerClient[]): string {
  return [...entries].sort((left, right) => (
    marketplaceServerRank(left) - marketplaceServerRank(right)
    || left.server.name.localeCompare(right.server.name)
  ))[0]?.server.id ?? "";
}

/**
 * Login with Raft answered installation_suspended (every installation went
 * suspended after the lookup): these entries as a lookup would now return them.
 */
export function withAccountInstallationsSuspended(entries: AvailableServerClient[]): AvailableServerClient[] {
  return entries.map((entry) => (
    isAccountLoginEntry(entry) && isLoginAvailable(entry.client)
      ? { ...entry, client: { ...entry.client, availability: "suspended" } }
      : entry
  ));
}

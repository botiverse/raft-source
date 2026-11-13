import { managedMcpOAuthClientPolicy, type ManagedMcpOAuthClientMode } from "@botiverse/raft-shared";
import { ManagedMcpGatewayError } from "./managedMcpGateway";
import type { managedMcpServers } from "../db/schema";
import { mcpAppSourceKind } from "./managedMcpService";
import { findMcpAppTemplateRow } from "./mcpAppTemplates";

type ModeApp = Pick<typeof managedMcpServers.$inferSelect, "endpointUrl" | "templateKey" | "sourceKind" | "provider">;

/**
 * How an App's OAuth Connections get a client. A provider policy in code (Google Workspace) always
 * means a registered client; an App added by URL accepts either; a template App follows its
 * catalog row's admin-set mode (older Notion/Linear Apps name the template only in `provider`).
 * `null` when that row cannot be read or is gone: never the bundled default, which could quietly
 * loosen an admin's `registered`.
 */
export async function managedMcpOAuthClientModeForApp(app: ModeApp): Promise<ManagedMcpOAuthClientMode | null> {
  if (managedMcpOAuthClientPolicy(app.endpointUrl)) return "registered";
  const templateKey = app.templateKey ?? (mcpAppSourceKind(app) === "template" ? app.provider : null);
  if (!templateKey) return "either";
  const template = await findMcpAppTemplateRow(templateKey);
  return template === "unavailable" || !template ? null : template.oauthClientMode;
}

/** The mode a sign-in must follow: an unconfirmed one refuses new sign-ins; existing tokens keep refreshing. */
export async function requireManagedMcpOAuthClientModeForApp(app: ModeApp): Promise<ManagedMcpOAuthClientMode> {
  const mode = await managedMcpOAuthClientModeForApp(app);
  if (!mode) throw new ManagedMcpGatewayError("This App's sign-in settings could not be read; try again shortly", "managed_mcp_unreachable");
  return mode;
}

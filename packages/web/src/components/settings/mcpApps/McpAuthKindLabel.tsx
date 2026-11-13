import type { ManagedMcpAuthMode } from "@botiverse/raft-shared";
import { Badge } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";
import type { MessageId } from "../../../i18n/messages";

export const MCP_AUTH_KIND_MESSAGE_ID: Record<ManagedMcpAuthMode, MessageId> = {
  none: "settings.mcpApp.authKind.none",
  oauth: "settings.mcpApp.authKind.oauth",
  headers: "settings.mcpApp.authKind.headers",
};

/** How an App (or a Connection) signs in: none, OAuth, or API-key headers. */
export function McpAuthKindLabel({ authKind }: { authKind: ManagedMcpAuthMode }) {
  const { formatMessage } = useIntl();
  return <Badge appearance="outline">{formatMessage({ id: MCP_AUTH_KIND_MESSAGE_ID[authKind] })}</Badge>;
}

import { RefreshCw } from "lucide-react";
import { Badge, Button, DescriptionDetails, DescriptionItem, DescriptionList, DescriptionTerm, Input, TextLink } from "@botiverse/raft-ui";
import { useCallback, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import Banner from "../../ui/Banner";
import FormField from "../../ui/FormField";
import { McpAuthKindLabel } from "./McpAuthKindLabel";
import { McpHeaderNameList } from "./McpHeaderNameList";
import { McpServerUrlForm } from "./McpServerUrlForm";
import type { McpAppView, McpProbeResult } from "./mcpAppApi";
import type { MessageId } from "../../../i18n/messages";

/**
 * Create mode: a Custom MCP App is a server by its URL. The MCP Apps Raft maintains are installed
 * from the Marketplace; the line above the URL says so and links there.
 */
export function McpAppServerCreate({
  onBrowseMarketplace,
  endpointUrl,
  onEndpointUrlChange,
  onValidate,
  probing,
  probe,
  probeError,
  headerNames,
  onHeaderNamesChange,
  useWithoutSignIn,
  onUseWithoutSignInChange,
}: {
  onBrowseMarketplace: () => void;
  endpointUrl: string;
  onEndpointUrlChange: (value: string) => void;
  onValidate: () => void;
  probing: boolean;
  probe: McpProbeResult | null;
  probeError: string;
  headerNames: string[];
  onHeaderNamesChange: (names: string[]) => void;
  useWithoutSignIn: boolean;
  onUseWithoutSignInChange: (value: boolean) => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <div className="stack-y-4">
      {/* The way to Raft's own MCP Apps, as a link alone: no sentence naming them (HelperText step 1). */}
      <p className="text-footnote" data-testid="mcp-app-marketplace-hint">
        <TextLink onClick={onBrowseMarketplace} variant="strong" data-testid="mcp-app-browse-marketplace">
          {formatMessage({ id: "apps.installed.browseMarketplace" })}
        </TextLink>
      </p>
      <McpServerUrlForm
        endpointUrl={endpointUrl}
        onEndpointUrlChange={onEndpointUrlChange}
        onValidate={onValidate}
        probing={probing}
        probe={probe}
        probeError={probeError}
        headerNames={headerNames}
        onHeaderNamesChange={onHeaderNamesChange}
        useWithoutSignIn={useWithoutSignIn}
        onUseWithoutSignInChange={onUseWithoutSignInChange}
      />
    </div>
  );
}

const HEALTH_MESSAGE_ID: Record<McpAppView["server"]["health"]["status"], MessageId> = {
  reachable: "settings.mcpApp.server.healthReachable",
  unreachable: "settings.mcpApp.server.healthUnreachable",
  unknown: "settings.mcpApp.server.healthUnknown",
};

const CHECKED_AT_FORMAT = { dateStyle: "medium", timeStyle: "short" } as const;

function FactRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DescriptionItem>
      <DescriptionTerm className="font-bold text-foreground-muted">{label}</DescriptionTerm>
      <DescriptionDetails className="text-foreground">{children}</DescriptionDetails>
    </DescriptionItem>
  );
}

/**
 * Edit mode: the server's facts. The URL can be changed only for an App from a pasted URL; a Raft
 * template's server and sign-in are maintained by Raft. The sign-in kind never changes after create.
 */
export function McpAppServerFacts({
  view,
  endpointUrl,
  onEndpointUrlChange,
  headerNames,
  onHeaderNamesChange,
  canManage,
  onRefresh,
  refreshing,
}: {
  view: McpAppView;
  endpointUrl: string;
  onEndpointUrlChange: (value: string) => void;
  /** An API-key App's required header names being edited (URL Apps only). */
  headerNames: string[];
  onHeaderNamesChange: (names: string[]) => void;
  canManage: boolean;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const { formatMessage, formatDate } = useIntl();
  const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => onEndpointUrlChange(event.target.value), [onEndpointUrlChange]);
  const locked = view.source.maintainedByRaft;
  const urlEditable = canManage && !locked;
  const endpointChanged = endpointUrl.trim() !== view.server.endpointUrl;
  const { health } = view.server;
  return (
    <div className="stack-y-3" data-testid="mcp-app-server-facts">
      {urlEditable ? (
        <FormField label={formatMessage({ id: "settings.mcpApp.server.urlLabel" })} size="compact">
          <Input
            type="url"
            value={endpointUrl}
            onChange={handleChange}
            className="w-full font-mono"
            data-testid="mcp-server-url-input"
          />
        </FormField>
      ) : null}
      {urlEditable && endpointChanged ? (
        <Banner intent="warning" density="sm" data-testid="mcp-server-url-change-warning">
          {formatMessage({ id: "settings.mcpApp.server.urlChangeWarning" })}
        </Banner>
      ) : null}
      {urlEditable && view.server.authKind === "headers" ? (
        <div className="stack-y-2" data-testid="mcp-app-header-names-edit">
          {view.server.requiredHeaderNames.length === 0 ? (
            <Banner intent="warning" density="sm">{formatMessage({ id: "settings.mcpApp.headers.unsetWarning" })}</Banner>
          ) : null}
          <McpHeaderNameList names={headerNames} onChange={onHeaderNamesChange} />
        </div>
      ) : null}
      <DescriptionList direction="horizontal" className="gap-x-4 gap-y-3">
        {urlEditable ? null : (
          <FactRow label={formatMessage({ id: "settings.mcpApp.server.urlLabel" })}>
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-mono break-all" data-testid="mcp-server-url-locked">{view.server.endpointUrl}</span>
              {locked ? <Badge variant="success">{formatMessage({ id: "settings.connectedApps.mcp.maintainedByRaft" })}</Badge> : null}
            </span>
          </FactRow>
        )}
        <FactRow label={formatMessage({ id: "settings.mcpApp.server.transport" })}>
          <span className="flex flex-wrap gap-x-2">
            <span>{formatMessage({ id: "settings.mcpApp.server.transportStreamableHttp" })}</span>
            {view.server.serverInfo?.protocolVersion ? <span className="font-mono text-mono-meta text-foreground-muted">{view.server.serverInfo.protocolVersion}</span> : null}
          </span>
        </FactRow>
        <FactRow label={formatMessage({ id: "settings.mcpApp.server.signIn" })}>
          <span className="flex flex-wrap items-center gap-2">
            <McpAuthKindLabel authKind={view.server.authKind} />
            {view.server.authKind === "headers" && view.server.requiredHeaderNames.length > 0 ? (
              <span className="font-mono text-mono-meta" data-testid="mcp-app-required-headers">{view.server.requiredHeaderNames.join(", ")}</span>
            ) : null}
          </span>
        </FactRow>
        <FactRow label={formatMessage({ id: "settings.mcpApp.server.health" })}>
          <span className="flex flex-wrap gap-x-2" data-testid="mcp-app-health">
            <span className="font-bold">{formatMessage({ id: HEALTH_MESSAGE_ID[health.status] })}</span>
            {health.latencyMs !== null ? <span className="text-foreground-muted">{formatMessage({ id: "settings.mcpApp.probe.latency" }, { ms: health.latencyMs })}</span> : null}
            {health.checkedAt ? (
              <span className="text-foreground-muted">
                {formatMessage({ id: "settings.mcpApp.server.checkedAt" }, { when: formatDate(health.checkedAt, CHECKED_AT_FORMAT) })}
              </span>
            ) : null}
          </span>
          {health.error ? <span className="mt-1 block text-caption text-danger">{health.error}</span> : null}
        </FactRow>
        <FactRow label={formatMessage({ id: "settings.mcpApp.server.tools" })}>
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span>{formatMessage({ id: "settings.connectedApps.mcp.toolCount" }, { count: view.server.toolCount })}</span>
            {canManage ? (
              <Button type="button" size="md" variant="outline" onClick={onRefresh} disabled={refreshing} data-testid="mcp-app-refresh">
                <RefreshCw size={13} />
                {formatMessage({ id: refreshing ? "settings.mcpApp.server.refreshing" : "settings.mcpApp.server.refresh" })}
              </Button>
            ) : null}
          </span>
          <McpAppToolList tools={view.server.tools} />
        </FactRow>
      </DescriptionList>
    </div>
  );
}

/** How many tools are shown before "Show all": a large catalogue (Notion has 65) is otherwise a wall. */
export const MCP_APP_TOOL_PREVIEW_COUNT = 8;

function McpAppToolList({ tools }: { tools: McpAppView["server"]["tools"] }) {
  const { formatMessage } = useIntl();
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  if (tools.length === 0) return null;
  const collapsible = tools.length > MCP_APP_TOOL_PREVIEW_COUNT;
  const shown = collapsible && !expanded ? tools.slice(0, MCP_APP_TOOL_PREVIEW_COUNT) : tools;
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1.5" data-testid="mcp-app-tools">
      {shown.map((tool) => (
        <Badge key={tool.name} appearance="outline">{tool.title || tool.name}</Badge>
      ))}
      {collapsible ? (
        <Button type="button" size="md" variant="ghost" onClick={toggle} aria-expanded={expanded} data-testid="mcp-app-tools-toggle">
          {expanded
            ? formatMessage({ id: "settings.mcpApp.server.toolsCollapse" })
            : formatMessage({ id: "settings.mcpApp.server.toolsShowAll" }, { count: tools.length })}
        </Button>
      ) : null}
    </span>
  );
}

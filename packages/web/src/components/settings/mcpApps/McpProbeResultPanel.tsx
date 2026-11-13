import { Badge, Checkbox } from "@botiverse/raft-ui";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import Banner from "../../ui/Banner";
import { McpHeaderNameList } from "./McpHeaderNameList";
import type { McpOAuthRegistration, McpProbeResult } from "./mcpAppApi";
import type { MessageId } from "../../../i18n/messages";

const REGISTRATION_MESSAGE_ID: Record<McpOAuthRegistration, MessageId> = {
  dcr: "settings.mcpApp.probe.oauthDcr",
  cimd: "settings.mcpApp.probe.oauthCimd",
  manual_required: "settings.mcpApp.probe.oauthManual",
};

const TOOL_NAMES_SHOWN = 12;

/** What validating a pasted server URL found, and what the App will need because of it. */
export function McpProbeResultPanel({
  probe,
  headerNames,
  onHeaderNamesChange,
  useWithoutSignIn,
  onUseWithoutSignInChange,
}: {
  probe: McpProbeResult;
  headerNames: string[];
  onHeaderNamesChange: (names: string[]) => void;
  /** A server that offers OAuth but also listed its tools without a token: add it without sign-in. */
  useWithoutSignIn: boolean;
  onUseWithoutSignInChange: (value: boolean) => void;
}) {
  const { formatMessage } = useIntl();
  const serverLabel = probe.serverInfo?.name
    ? [probe.serverInfo.name, probe.serverInfo.version].filter(Boolean).join(" ")
    : null;
  const blocked = probe.error?.code === "managed_mcp_endpoint_blocked";
  const handleUseWithoutSignIn = useCallback((checked: boolean) => onUseWithoutSignInChange(checked), [onUseWithoutSignInChange]);
  return (
    <div className="stack-y-3" data-testid="mcp-probe-result" data-outcome={probe.outcome}>
      {probe.outcome === "ready" ? (
        <Banner intent="success" density="sm" title={formatMessage({ id: "settings.mcpApp.probe.readyTitle" }, { count: probe.tools?.count ?? 0 })}>
          {formatMessage({ id: "settings.mcpApp.probe.readyDescription" })}
        </Banner>
      ) : null}
      {probe.outcome === "oauth" ? (
        <Banner
          intent={probe.oauth?.registration === "manual_required" ? "warning" : "info"}
          density="sm"
          title={formatMessage({ id: "settings.mcpApp.probe.oauthTitle" })}
        >
          {formatMessage({ id: REGISTRATION_MESSAGE_ID[probe.oauth?.registration ?? "manual_required"] })}
        </Banner>
      ) : null}
      {/* The issuer is data, not the banner's message: a mono line of its own under it (HelperText step 1). */}
      {probe.outcome === "oauth" && probe.oauth?.issuer ? (
        <p className="font-mono text-mono-meta [overflow-wrap:anywhere]" data-testid="mcp-probe-oauth-issuer">
          {formatMessage({ id: "settings.mcpApp.probe.oauthIssuer" }, { issuer: probe.oauth.issuer })}
        </p>
      ) : null}
      {probe.outcome === "oauth" && probe.tools ? (
        <label className="flex items-start gap-2 text-footnote" data-testid="mcp-probe-use-without-sign-in">
          <Checkbox checked={useWithoutSignIn} onCheckedChange={handleUseWithoutSignIn} className="mt-0.5" />
          <span className="stack-y-0.5">
            <span className="block text-foreground">{formatMessage({ id: "settings.mcpApp.probe.useWithoutSignIn" })}</span>
            <span className="block text-caption text-foreground-muted">{formatMessage({ id: "settings.mcpApp.probe.useWithoutSignInHint" }, { count: probe.tools.count })}</span>
          </span>
        </label>
      ) : null}
      {probe.outcome === "headers" ? (
        <>
          {/* The list under it names the headers; the banner says where their values come from (Kirby). */}
          <Banner intent="info" density="sm" title={formatMessage({ id: "settings.mcpApp.probe.headersTitle" })}>
            {formatMessage({ id: "settings.mcpApp.probe.headersDescription" })}
          </Banner>
          <McpHeaderNameList names={headerNames} onChange={onHeaderNamesChange} />
        </>
      ) : null}
      {probe.outcome === "unreachable" ? (
        <Banner intent="destructive" density="sm" title={formatMessage({ id: blocked ? "settings.mcpApp.probe.blockedTitle" : "settings.mcpApp.probe.unreachableTitle" })}>
          {blocked ? formatMessage({ id: "settings.mcpApp.error.endpointBlocked" }) : probe.error?.message || formatMessage({ id: "settings.mcpApp.probe.unreachableDescription" })}
        </Banner>
      ) : null}
      {probe.outcome !== "unreachable" && (serverLabel || probe.latencyMs !== null) ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-caption text-foreground-muted">
          {serverLabel ? <span>{formatMessage({ id: "settings.mcpApp.probe.serverName" }, { name: serverLabel })}</span> : null}
          {probe.latencyMs !== null ? <span>{formatMessage({ id: "settings.mcpApp.probe.latency" }, { ms: probe.latencyMs })}</span> : null}
        </div>
      ) : null}
      {(probe.outcome === "ready" || (probe.outcome === "oauth" && useWithoutSignIn)) && probe.tools && probe.tools.names.length > 0 ? (
        <div className="flex flex-wrap gap-1.5" data-testid="mcp-probe-tools">
          {probe.tools.names.slice(0, TOOL_NAMES_SHOWN).map((name) => (
            <Badge key={name} appearance="outline">{name}</Badge>
          ))}
          {probe.tools.names.length > TOOL_NAMES_SHOWN ? (
            <span className="text-caption text-foreground-muted">{formatMessage({ id: "settings.mcpApp.probe.moreTools" }, { count: probe.tools.names.length - TOOL_NAMES_SHOWN })}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

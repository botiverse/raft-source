import { Button, Input } from "@botiverse/raft-ui";
import { useCallback } from "react";
import type { ChangeEvent } from "react";
import { useIntl } from "react-intl";
import Banner from "../../ui/Banner";
import FormField from "../../ui/FormField";
import { McpProbeResultPanel } from "./McpProbeResultPanel";
import type { McpProbeResult } from "./mcpAppApi";

/** Paste a server URL, Validate (POST /mcp/probe), and see what the App will need. */
export function McpServerUrlForm({
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
  const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => onEndpointUrlChange(event.target.value), [onEndpointUrlChange]);
  return (
    <div className="stack-y-3" data-testid="mcp-server-url-form">
      <FormField
        label={formatMessage({ id: "settings.mcpApp.server.urlLabel" })}
       
        size="compact"
        required
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            type="url"
            value={endpointUrl}
            onChange={handleChange}
            className="min-w-0 flex-1 font-mono"
            placeholder={formatMessage({ id: "settings.mcpApp.server.urlPlaceholder" })}
            data-testid="mcp-server-url-input"
          />
          <Button type="button" size="md" variant="primary" onClick={onValidate} disabled={probing || !endpointUrl.trim()} data-testid="mcp-server-validate">
            {formatMessage({ id: probing ? "settings.mcpApp.server.validating" : "settings.mcpApp.server.validate" })}
          </Button>
        </div>
      </FormField>
      {probeError ? <Banner intent="warning" density="sm">{probeError}</Banner> : null}
      {probe ? <McpProbeResultPanel probe={probe} headerNames={headerNames} onHeaderNamesChange={onHeaderNamesChange} useWithoutSignIn={useWithoutSignIn} onUseWithoutSignInChange={onUseWithoutSignInChange} /> : null}
    </div>
  );
}

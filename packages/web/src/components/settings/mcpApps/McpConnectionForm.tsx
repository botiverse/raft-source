import type { ManagedMcpOAuthClientInput, ManagedMcpOAuthClientMode, ManagedMcpOAuthClientPolicy } from "@botiverse/raft-shared";
import { McpOAuthClientFields } from "./McpOAuthClientFields";
import { emptyOAuthClientDraft, editOAuthClientDraft, oauthClientPayload } from "./managedMcpOAuthClient";
import { Button, Checkbox, Input } from "@botiverse/raft-ui";
import { useCallback, useId, useState } from "react";
import type { ChangeEvent } from "react";
import { useIntl } from "react-intl";
import Banner from "../../ui/Banner";
import FormField from "../../ui/FormField";

function HeaderValueInput({
  name,
  value,
  onChange,
}: {
  name: string;
  value: string;
  onChange: (name: string, value: string) => void;
}) {
  const { formatMessage } = useIntl();
  const id = useId();
  const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => onChange(name, event.target.value), [name, onChange]);
  return (
    <FormField label={<span className="font-mono">{name}</span>} size="compact" htmlFor={id} required>
      <Input
        id={id}
        type="password"
        autoComplete="new-password"
        value={value}
        onChange={handleChange}
        className="w-full font-mono"
        aria-label={formatMessage({ id: "settings.mcpApp.connections.headerValueLabel" }, { name })}
        placeholder={formatMessage({ id: "settings.mcpApp.connections.headerValuePlaceholder" })}
      />
    </FormField>
  );
}

export interface McpConnectionFormValues {
  name: string;
  headers: Record<string, string>;
  makeDefault: boolean;
  oauthClient?: ManagedMcpOAuthClientInput | null;
}

/**
 * Add a Connection (`mode="add"`: a name, and for an API-key App one value per required header) or
 * replace an API-key Connection's key (`mode="replace"`). Header values are write-only: the inputs
 * start empty, and a stored value is never shown again. The header names are exactly the App's.
 */
export function McpConnectionForm({
  mode,
  title,
  authKind,
  headerNames,
  defaultMakeDefault,
  hasConfiguredOAuthClient,
  oauthClientPolicy = null,
  raftOAuthClient = false,
  oauthClientMode = "either",
  busy,
  waiting = false,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  mode: "add" | "replace";
  title?: string;
  authKind: "headers" | "oauth";
  headerNames: string[];
  defaultMakeDefault: boolean;
  hasConfiguredOAuthClient?: boolean;
  /** Provider settings Raft fixes (Google): only the Client ID and secret are asked for. */
  oauthClientPolicy?: ManagedMcpOAuthClientPolicy | null;
  /** Raft's own client is available for that provider: signing in needs nothing from the user. */
  raftOAuthClient?: boolean;
  /** The App template's client mode: automatic registration, a registered client, or either; null while it cannot be confirmed. */
  oauthClientMode?: ManagedMcpOAuthClientMode | null;
  busy: boolean;
  /** Waiting for an OAuth sign-in elsewhere: submitting is off, Cancel (which ends the wait) is not. */
  waiting?: boolean;
  submitLabel: string;
  onSubmit: (values: McpConnectionFormValues) => void;
  onCancel: () => void;
}) {
  const { formatMessage } = useIntl();
  // The server refuses sign-in until it can confirm the template's mode; say so instead of a form it would reject.
  const clientModeUnknown = authKind === "oauth" && oauthClientMode === null;
  const clientMode = oauthClientMode ?? "either";
  const [oauthClient, setOAuthClient] = useState(() => mode === "replace" ? editOAuthClientDraft(hasConfiguredOAuthClient, oauthClientPolicy, raftOAuthClient, clientMode) : emptyOAuthClientDraft(false, oauthClientPolicy, raftOAuthClient, clientMode));
  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [makeDefault, setMakeDefault] = useState(defaultMakeDefault);
  const handleName = useCallback((event: ChangeEvent<HTMLInputElement>) => setName(event.target.value), []);
  const handleValue = useCallback((header: string, value: string) => setValues((current) => ({ ...current, [header]: value })), []);
  const handleMakeDefault = useCallback((checked: boolean) => setMakeDefault(checked), []);
  const needsHeaders = authKind === "headers";
  const complete = !clientModeUnknown && (mode === "replace" || name.trim().length > 0)
    && (needsHeaders || oauthClient.mode !== "custom" || (oauthClient.clientId.trim().length > 0 && (oauthClient.method === "none" || oauthClient.clientSecret.trim().length > 0)))
    && (!needsHeaders || headerNames.every((header) => (values[header] ?? "").trim().length > 0));
  const handleSubmit = useCallback(() => {
    if (!complete || busy || waiting) return;
    onSubmit({
      name: name.trim(),
      headers: needsHeaders ? Object.fromEntries(headerNames.map((header) => [header, values[header] ?? ""])) : {},
      makeDefault,
      ...(!needsHeaders ? { oauthClient: oauthClientPayload(oauthClient) } : {}),
    });
  }, [busy, complete, headerNames, makeDefault, name, needsHeaders, oauthClient, onSubmit, values, waiting]);

  return (
    <div className={mode === "add" ? "stack-y-3 border border-line-hairline bg-layer-sidebar p-3" : "stack-y-3"} data-testid={`mcp-connection-form-${mode}`}>
      {title ? <h4 className="text-subhead font-bold text-foreground">{title}</h4> : null}

      {mode === "add" ? (
        <FormField label={formatMessage({ id: "settings.mcpApp.connections.nameLabel" })} size="compact" required>
          <Input
            type="text"
            value={name}
            onChange={handleName}
            className="w-full"
            placeholder={formatMessage({ id: "settings.mcpApp.connections.namePlaceholder" })}
            data-testid="mcp-connection-name"
          />
        </FormField>
      ) : null}
      {needsHeaders ? (
        <div className="stack-y-2">
          <p className="text-caption text-foreground-muted">{formatMessage({ id: "settings.mcpApp.connections.headersWriteOnly" })}</p>
          {headerNames.map((header) => (
            <HeaderValueInput key={header} name={header} value={values[header] ?? ""} onChange={handleValue} />
          ))}
        </div>
      ) : clientModeUnknown ? (
        <Banner intent="warning" density="sm" data-testid="mcp-oauth-client-mode-unavailable">
          {formatMessage({ id: "settings.mcpApp.connections.clientModeUnavailable" })}
        </Banner>
      ) : (
        <>
          <McpOAuthClientFields value={oauthClient} onChange={setOAuthClient} policy={oauthClientPolicy} raftClient={raftOAuthClient} clientMode={clientMode} />
        </>
      )}
      {mode === "add" ? (
        <label className="flex items-start gap-2 text-caption">
          <Checkbox checked={makeDefault} onCheckedChange={handleMakeDefault} aria-label={formatMessage({ id: "settings.mcpApp.connections.makeDefaultLabel" })} />
          {/* Kept (access): whose account Agents call the App as when this becomes the default. */}
          <span>
            <span className="block font-bold text-foreground">{formatMessage({ id: "settings.mcpApp.connections.makeDefaultLabel" })}</span>
            <span className="block leading-relaxed text-foreground-muted" data-testid="mcp-connection-make-default-hint">{formatMessage({ id: "settings.mcpApp.connections.makeDefaultHint" })}</span>
          </span>
        </label>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" size="md" variant="outline" onClick={onCancel} disabled={busy} data-testid={`mcp-connection-cancel-${mode}`}>
          {formatMessage({ id: "settings.mcpApp.cancel" })}
        </Button>
        <Button type="button" size="md" variant="primary" onClick={handleSubmit} disabled={!complete || busy || waiting} data-testid={`mcp-connection-submit-${mode}`}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

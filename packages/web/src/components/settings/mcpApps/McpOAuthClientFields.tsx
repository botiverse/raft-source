import type { ManagedMcpOAuthClientMode, ManagedMcpOAuthClientPolicy } from "@botiverse/raft-shared";
import { InlineCode, Input, Select, SelectContent, SelectIcon, SelectItem, SelectItemIndicator, SelectItemText, SelectList, SelectTrigger, SelectValue, TextLink, TextLinkExternalIcon } from "@botiverse/raft-ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import { useIntl } from "react-intl";
import api from "../../../api/client";
import CopyButton from "../../ui/CopyButton";
import CopyIconButton from "../../ui/CopyIconButton";
import FormField from "../../ui/FormField";
import { opensInNewTabAriaLabel } from "../../ui/LeavingRaftMark";
import type { OAuthClientDraft } from "./managedMcpOAuthClient";

export function McpOAuthClientFields({ value, onChange, policy = null, raftClient = false, clientMode = "either" }: {
  value: OAuthClientDraft;
  onChange: (value: OAuthClientDraft) => void;
  /** Provider settings Raft fixes: no automatic registration, and only the Client ID and secret to enter. */
  policy?: ManagedMcpOAuthClientPolicy | null;
  /** Under a policy, Raft's own client takes the "automatic" choice: sign in with nothing to set up. */
  raftClient?: boolean;
  /** The App template's client mode; a provider policy above takes precedence. */
  clientMode?: ManagedMcpOAuthClientMode;
}) {
  const { formatMessage: t } = useIntl();
  const modes = useMemo(() => [
    ...(value.mode === "keep" ? [{ value: "keep", label: t({ id: "settings.mcpApp.oauthClient.keep" }) }] : []),
    ...(!policy
      ? clientMode === "registered" ? [] : [{ value: "automatic", label: t({ id: "settings.mcpApp.oauthClient.automatic" }) }]
      : raftClient ? [{ value: "automatic", label: t({ id: "settings.mcpApp.google.raftClient" }) }] : []),
    ...(!policy && clientMode === "automatic" ? [] : [{ value: "custom", label: t({ id: "settings.mcpApp.oauthClient.custom" }) }]),
  ], [clientMode, policy, raftClient, t, value.mode]);
  const methods = useMemo(() => ["none", "client_secret_post", "client_secret_basic"].map((method) => ({ value: method, label: method })), []);
  const offlineOptions = useMemo(() => [{ value: "no", label: t({ id: "settings.mcpApp.oauthClient.offlineNo" }) }, { value: "yes", label: t({ id: "settings.mcpApp.oauthClient.offlineYes" }) }], [t]);
  const handleModeChange = useCallback((mode: string) => onChange({
    ...value,
    mode: mode as OAuthClientDraft["mode"],
    preserveAutomatic: false,
    clientSecret: "",
    ...(policy ? { method: policy.tokenEndpointAuthMethod, offline: policy.requestOfflineAccess, scope: "" } : {}),
  }), [onChange, policy, value]);
  const handleMethodChange = useCallback((method: string) => onChange({ ...value, method: method as OAuthClientDraft["method"], clientSecret: "" }), [onChange, value]);
  const handleOfflineChange = useCallback((offline: string) => onChange({ ...value, offline: offline === "yes" }), [onChange, value]);
  const handleClientIdChange = useCallback((event: ChangeEvent<HTMLInputElement>) => onChange({ ...value, clientId: event.target.value }), [onChange, value]);
  const handleClientSecretChange = useCallback((event: ChangeEvent<HTMLInputElement>) => onChange({ ...value, clientSecret: event.target.value }), [onChange, value]);
  const handleScopeChange = useCallback((event: ChangeEvent<HTMLInputElement>) => onChange({ ...value, scope: event.target.value }), [onChange, value]);
  const redirectUrl = useOAuthRedirectUrl(value.mode === "custom");
  if (policy) {
    return <div className="stack-y-3">
      {modes.length > 1 && <OAuthClientSelect label={t({ id: "settings.mcpApp.oauthClient.label" })} selected={value.mode} items={modes} onChange={handleModeChange} />}
      {value.mode === "keep" && <p className="text-caption text-foreground-muted">{t({ id: "settings.mcpApp.oauthClient.savedHint" })}</p>}
      {value.mode === "custom" && <>
        <GoogleOAuthClientSetup policy={policy} redirectUrl={redirectUrl} />
        <FormField label={t({ id: "settings.mcpApp.oauthClient.clientId" })} size="compact"><Input required maxLength={2000} value={value.clientId} onChange={handleClientIdChange} /></FormField>
        <FormField label={t({ id: "settings.mcpApp.oauthClient.clientSecret" })} size="compact"><Input required type="password" autoComplete="new-password" maxLength={16000} value={value.clientSecret} onChange={handleClientSecretChange} /></FormField>
        <p className="text-caption text-foreground-muted" data-testid="mcp-oauth-client-fixed">
          {t({ id: "settings.mcpApp.google.fixed" }, {
            method: <InlineCode key="method">{policy.tokenEndpointAuthMethod}</InlineCode>,
            scopes: <InlineCode key="scopes">{policy.scopes.map(googleScopeName).join(" ")}</InlineCode>,
          })}
        </p>
      </>}
    </div>;
  }
  return <div className="stack-y-3">
    {modes.length > 1 && <OAuthClientSelect label={t({ id: "settings.mcpApp.oauthClient.label" })} selected={value.mode} items={modes} onChange={handleModeChange} />}
    {value.mode === "keep" && <p className="text-caption text-foreground-muted">{t({ id: "settings.mcpApp.oauthClient.savedHint" })}</p>}
    {value.mode === "custom" && <>
      <p className="text-caption text-foreground-muted">{t({ id: "settings.mcpApp.oauthClient.hint" })}</p>
      {redirectUrl && <OAuthRedirectUrlField url={redirectUrl} />}
      <FormField label={t({ id: "settings.mcpApp.oauthClient.clientId" })} size="compact"><Input required maxLength={2000} value={value.clientId} onChange={handleClientIdChange} /></FormField>
      <OAuthClientSelect label={t({ id: "settings.mcpApp.oauthClient.method" })} selected={value.method} items={methods} onChange={handleMethodChange} />
      {value.method !== "none" && <FormField label={t({ id: "settings.mcpApp.oauthClient.clientSecret" })} size="compact"><Input required type="password" autoComplete="new-password" maxLength={16000} value={value.clientSecret} onChange={handleClientSecretChange} /></FormField>}
      <FormField label={t({ id: "settings.mcpApp.oauthClient.scope" })} size="compact" optional><Input maxLength={4000} value={value.scope} onChange={handleScopeChange} /></FormField>
      <OAuthClientSelect label={t({ id: "settings.mcpApp.oauthClient.offline" })} selected={value.offline ? "yes" : "no"} items={offlineOptions} onChange={handleOfflineChange} />
    </>}
  </div>;
}

function OAuthClientSelect({ label, selected, items, onChange }: {
  label: string;
  selected: string;
  items: Array<{ value: string; label: string }>;
  onChange: (next: string) => void;
}) {
  const handleValueChange = useCallback((next: string | null) => {
    if (typeof next === "string") onChange(next);
  }, [onChange]);
  return <FormField label={label} size="compact"><Select value={selected} items={items} onValueChange={handleValueChange}>
    <SelectTrigger className="w-full"><SelectValue /><SelectIcon /></SelectTrigger>
    <SelectContent><SelectList>{items.map((item) => <SelectItem key={item.value} value={item.value}><SelectItemText>{item.label}</SelectItemText><SelectItemIndicator /></SelectItem>)}</SelectList></SelectContent>
  </Select></FormField>;
}

/**
 * The callback address a hand-registered client must allow. Read from this deployment's client
 * metadata document, so it is the exact value the server sends (staging and production differ).
 */
function useOAuthRedirectUrl(enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    api.get<{ redirect_uris?: unknown }>("/mcp/oauth/client-metadata").then(({ data }) => {
      const first = Array.isArray(data?.redirect_uris) ? data.redirect_uris[0] : null;
      if (current && typeof first === "string") setUrl(first);
    }, () => undefined);
    return () => { current = false; };
  }, [enabled]);
  return url;
}

function OAuthRedirectUrlField({ url }: { url: string }) {
  const { formatMessage: t } = useIntl();
  return <FormField label={t({ id: "settings.mcpApp.oauthClient.redirectUrl" })} hint={t({ id: "settings.mcpApp.oauthClient.redirectUrlHint" })} size="compact">
    <div className="flex items-center gap-1">
      <Input readOnly value={url} className="font-mono" />
      <CopyButton text={url} resetKey={url}>
        {({ copied, disabled, onClick, onMouseDown }) => <CopyIconButton
          onClick={onClick}
          onMouseDown={onMouseDown}
          disabled={disabled}
          copied={copied}
          copiedLabel={t({ id: "settings.mcpApp.oauthClient.redirectUrlCopied" })}
          copyLabel={t({ id: "settings.mcpApp.oauthClient.redirectUrlCopy" })}
          surface="light"
        />}
      </CopyButton>
    </div>
  </FormField>;
}

const GOOGLE_CONSOLE = "https://console.cloud.google.com";
/** `https://www.googleapis.com/auth/documents` as Google's consent screen lists it: `.../auth/documents`. */
function googleScopeName(scope: string): string {
  return scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//u, ".../auth/");
}

/** What a Google Workspace MCP sign-in needs from the user's Cloud project, in order, each with its console page. */
function GoogleOAuthClientSetup({ policy, redirectUrl }: { policy: ManagedMcpOAuthClientPolicy; redirectUrl: string | null }) {
  const { formatMessage: t } = useIntl();
  const apis = `${policy.productApiService},${policy.apiService}`;
  const steps = [
    { id: "project", href: `${GOOGLE_CONSOLE}/projectselector2/home/dashboard`, values: {} },
    { id: "preview", href: "https://developers.google.com/workspace/preview", values: {} },
    {
      id: "api",
      href: `${GOOGLE_CONSOLE}/flows/enableapi?apiid=${encodeURIComponent(apis)}`,
      values: { product: <InlineCode key="product">{policy.productApiService}</InlineCode>, service: <InlineCode key="service">{policy.apiService}</InlineCode> },
    },
    { id: "branding", href: `${GOOGLE_CONSOLE}/auth/branding`, values: {} },
    { id: "audience", href: `${GOOGLE_CONSOLE}/auth/audience`, values: {} },
    { id: "client", href: `${GOOGLE_CONSOLE}/auth/clients/create`, values: {} },
  ] as const;
  return <section className="stack-y-2" aria-label={t({ id: "settings.mcpApp.google.title" })} data-testid="mcp-google-oauth-setup">
    <h5 className="text-caption font-bold text-foreground">{t({ id: "settings.mcpApp.google.title" })}</h5>
    <ol className="stack-y-2 list-decimal pl-5 text-caption text-foreground-muted">
      {steps.map((step) => <li key={step.id} data-testid={`mcp-google-oauth-step-${step.id}`}>
        {t({ id: `settings.mcpApp.google.step.${step.id}` }, step.values)}
        <TextLink className="ml-1" render={<a href={step.href} target="_blank" rel="noopener noreferrer" aria-label={opensInNewTabAriaLabel(t, t({ id: `settings.mcpApp.google.link.${step.id}` }))} />}>
          {t({ id: `settings.mcpApp.google.link.${step.id}` })}
          <TextLinkExternalIcon label={t({ id: "common.opensInNewTab" })} />
        </TextLink>
        {step.id === "client" && redirectUrl ? <div className="mt-2"><OAuthRedirectUrlField url={redirectUrl} /></div> : null}
      </li>)}
      <li data-testid="mcp-google-oauth-step-paste">{t({ id: "settings.mcpApp.google.step.paste" })}</li>
    </ol>
  </section>;
}

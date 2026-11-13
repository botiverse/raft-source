import { useCallback, useEffect, useState } from "react";
import type { ChangeEvent } from "react";
import { useIntl } from "react-intl";
import { Badge, Button, Card, Checkbox, Input, Status } from "@botiverse/raft-ui";
import { normalizeAppSetupUrl } from "@botiverse/raft-shared";
import type { AppSetupState } from "@botiverse/raft-shared";
import LeavingRaftMark, { opensInNewTabAriaLabel } from "../ui/LeavingRaftMark";
import api from "../../api/client";
import FormField from "../ui/FormField";

export function AppSetupFields({ required, url, description, onRequiredChange, onUrlChange, onDescriptionChange }: {
  required: boolean; url: string; description: string;
  onRequiredChange: (value: boolean) => void;
  onUrlChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onDescriptionChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const { formatMessage } = useIntl();
  return <div className="stack-y-3">
    {/* A yes/no saved with the form is a checkbox (a switch acts at once). */}
    <label className="flex items-start gap-3">
      <Checkbox checked={required} onCheckedChange={onRequiredChange} />
      <span className="text-subhead font-semibold text-foreground">{formatMessage({ id: "appSetup.requiresConfiguration" })}</span>
    </label>
    {required ? <>
      <FormField label={formatMessage({ id: "appSetup.urlLabel" })} htmlFor="app-setup-url" hint={formatMessage({ id: "appSetup.urlHint" })} required>
        <Input id="app-setup-url" type="url" value={url} onChange={onUrlChange} maxLength={2000} required />
      </FormField>
      <FormField label={formatMessage({ id: "appSetup.descriptionLabel" })} htmlFor="app-setup-description" optional>
        <Input id="app-setup-description" value={description} onChange={onDescriptionChange} maxLength={500} />
      </FormField>
    </> : null}
  </div>;
}

/** Publisher-authored text is rendered as text; it is not a permission grant. */
export function AppSetupRequirement({ url, description }: { url?: string | null; description?: string | null }) {
  const { formatMessage } = useIntl();
  if (!url) return null;
  let domain: string;
  try { domain = new URL(normalizeAppSetupUrl(url)!).host; } catch { return null; }
  return <Card className="stack-y-2 p-3" data-testid="app-setup-requirement">
    <Badge appearance="soft" variant="warning"><Status variant="warning" aria-hidden="true" />{formatMessage({ id: "appSetup.requiredAfterInstall" })}</Badge>
    <p className="text-callout text-foreground-muted">{formatMessage({ id: "appSetup.beforeInstall" }, { domain })}</p>
    {description ? <p className="break-words text-callout text-foreground">{description}</p> : null}
  </Card>;
}

/** Per-installation state. Returning from the App only refreshes; it never writes completion. */
export function AppSetupPanel({ clientId, serverId }: { clientId: string; serverId: string }) {
  return <AppSetupSnapshot key={`${clientId}:${serverId}`} clientId={clientId} serverId={serverId} />;
}

function AppSetupSnapshot({ clientId, serverId }: { clientId: string; serverId: string }) {
  const { formatMessage } = useIntl();
  const [result, setResult] = useState<{ data: AppSetupState & { canConfigure: boolean }; error: false } | { data: null; error: true } | null>(null);
  const state = result?.data ?? null;
  const error = result?.error ?? false;
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh((value) => value + 1), []);
  useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);
  useEffect(() => {
    let active = true;
    void api.get<AppSetupState & { canConfigure: boolean }>(`/integrations/clients/${clientId}/setup`, { headers: { "X-Server-Id": serverId } })
      .then(({ data }) => {
        if (!active) return;
        if (!["not_required", "pending", "complete"].includes(data.status) || typeof data.canConfigure !== "boolean"
          || (data.description !== null && typeof data.description !== "string")
          || !Number.isSafeInteger(data.revision) || data.revision < 1
          || (data.completedAt !== null && typeof data.completedAt !== "string")
          || (data.canConfigure && data.status !== "not_required" && !data.url)) throw new Error("invalid setup state");
        const url = data.url ? normalizeAppSetupUrl(data.url) : null;
        setResult({ data: { status: data.status, description: data.description, revision: data.revision, completedAt: data.completedAt, canConfigure: data.canConfigure, url }, error: false });
      }).catch(() => { if (active) setResult({ data: null, error: true }); });
    return () => { active = false; };
  }, [clientId, serverId, refresh]);
  if (state?.status === "not_required") return null;
  const actionLabel = formatMessage({ id: state?.status === "complete" ? "appSetup.manage" : "appSetup.continue" });
  return <Card className="stack-y-3 p-4" data-testid="app-installation-setup" aria-live="polite">
    <div className="text-subhead font-semibold text-foreground">{formatMessage({ id: "appSetup.title" })}</div>
    {error ? <p role="alert" className="text-footnote font-semibold text-warning-strong">{formatMessage({ id: "appSetup.loadFailed" })}</p>
      : !state ? <p className="text-callout text-foreground-muted">{formatMessage({ id: "common.loadingLabel" })}</p>
      : <>
        <Badge appearance="soft" variant={state.status === "complete" ? "success" : "warning"}>
          <Status variant={state.status === "complete" ? "success" : "warning"} aria-hidden="true" />
          {formatMessage({ id: state.status === "complete" ? "appSetup.complete" : "appSetup.pending" })}
        </Badge>
        {state.description ? <p className="break-words text-callout text-foreground">{state.description}</p> : null}
        {state.canConfigure && state.url ? <div className="stack-y-2">
          <Button size="md" render={<a href={state.url} target="_blank" rel="noopener noreferrer" aria-label={opensInNewTabAriaLabel(formatMessage, actionLabel)} />} nativeButton={false} role="link">
            {actionLabel}
            <LeavingRaftMark data-icon="inline-end" />
          </Button>
          <p className="break-words text-caption text-foreground-hint">{formatMessage({ id: "appSetup.opensAt" }, { domain: new URL(state.url).host })}</p>
        </div> : <p className="text-callout text-foreground-muted">{formatMessage({ id: state.status === "complete" ? "appSetup.adminManage" : "appSetup.adminRequired" })}</p>}
      </>}
    <Button size="md" variant="outline" onClick={reload}>{formatMessage({ id: "appSetup.refresh" })}</Button>
  </Card>;
}

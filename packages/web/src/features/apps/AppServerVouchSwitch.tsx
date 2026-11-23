import { ListRow, ListRowBody, ListRowDescription, ListRowTitle, Switch } from "@botiverse/raft-ui";
import { useCallback, useState } from "react";
import { useIntl } from "react-intl";

import api from "../../api/client";
import { isSecondFactorStepUpCancelled, withSecondFactorStepUp } from "../../components/settings/secondFactorStepUp";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import type { OAuthClientRecord } from "./connected-apps/oauthClientRecords";

/**
 * An App editor's server vouch: on, every agent of this Server can use the App with no one's
 * approval, whoever made it. Owners and admins only (manageExternalAuth, as approving an agent's App
 * access); nothing for other viewers. Takes effect when flipped (`PUT <path>` with `{ vouched }`;
 * turning it on asks the approver's second step) and hands the answer to `onUpdated`; a failure
 * leaves it as it was and goes to `onError`. Shared by a Raft App's editor (AppServerVouchSwitch)
 * and an MCP App's (McpAppEditor, `PUT /mcp/apps/:id/server-vouch`).
 */
export function ServerVouchSwitch<T>({
  vouched,
  path,
  onUpdated,
  onError,
}: {
  vouched: boolean;
  /** The App's server-vouch endpoint. */
  path: string;
  onUpdated: (updated: T) => void;
  onError: (message: string) => void;
}) {
  const { formatMessage } = useIntl();
  const { capabilities } = useServerPermissions();
  const [saving, setSaving] = useState(false);
  const handleCheckedChange = useCallback(async (next: boolean) => {
    setSaving(true);
    onError("");
    try {
      const { data } = await withSecondFactorStepUp(() => api.put<T>(path, { vouched: next }), "agentAccess");
      onUpdated(data);
    } catch (err: unknown) {
      if (isSecondFactorStepUpCancelled(err)) return;
      const axiosErr = err as { response?: { data?: { error?: string } } };
      onError(axiosErr.response?.data?.error || formatMessage({ id: "settings.connectedApps.failedUpdateApp" }));
    } finally {
      setSaving(false);
    }
  }, [formatMessage, onError, onUpdated, path]);
  const handleSwitch = useCallback((checked: boolean) => { void handleCheckedChange(checked); }, [handleCheckedChange]);

  if (!capabilities.manageExternalAuth) return null;
  return (
    <ListRow variant="plain" interactive={false} data-testid="connected-app-server-vouch">
      <ListRowBody>
        <ListRowTitle id="connected-app-server-vouch-label">{formatMessage({ id: "settings.connectedApps.serverVouch.title" })}</ListRowTitle>
        <ListRowDescription wrap>{formatMessage({ id: "settings.connectedApps.serverVouch.description" })}</ListRowDescription>
      </ListRowBody>
      <Switch
        checked={vouched}
        disabled={saving}
        onCheckedChange={handleSwitch}
        aria-labelledby="connected-app-server-vouch-label"
        data-testid="connected-app-server-vouch-switch"
      />
    </ListRow>
  );
}

/** A Raft App's server vouch: only for a server_local App (a published one is installed, not vouched). */
export function AppServerVouchSwitch({
  client,
  onUpdated,
  onError,
}: {
  client: OAuthClientRecord;
  onUpdated: (client: OAuthClientRecord) => void;
  onError: (message: string) => void;
}) {
  if (client.appType !== "server_local") return null;
  return (
    <ServerVouchSwitch<OAuthClientRecord>
      vouched={client.serverVouched === true}
      path={`/integrations/clients/${client.id}/server-vouch`}
      onUpdated={onUpdated}
      onError={onError}
    />
  );
}

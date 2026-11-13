import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import api from "../../api/client";
import { isAppBotHandleConflictError } from "../../components/settings/ConnectedAppBot";
import type { AppBotOffer } from "../../components/settings/ConnectedAppBot";
import { isSecondFactorStepUpCancelled, withSecondFactorStepUp } from "../../components/settings/secondFactorStepUp";

/**
 * The App's bot on this Server, added or removed from the installed-app
 * detail (f2/f3) on every Server, the App's own included. The banner's Add
 * and the section's Add are this one action; both read the bot from the
 * App lists, which `onBotChanged` updates, so they change together.
 */
export function useInstalledAppBot({
  setError,
  onBotChanged,
}: {
  setError: (error: string) => void;
  onBotChanged: (clientRowId: string, bot: AppBotOffer) => void;
}) {
  const { formatMessage } = useIntl();
  const [botBusyClientId, setBotBusyClientId] = useState<string | null>(null);
  const [botRemoveTarget, setBotRemoveTarget] = useState<{ clientId: string; appName: string; bot: AppBotOffer } | null>(null);
  const handleInstalledBotAction = useCallback(async (clientRowId: string, bot: AppBotOffer, action: "grant" | "revoke") => {
    setBotBusyClientId(clientRowId);
    setError("");
    try {
      // Granting the bot is refused until a sign-in passed the second step
      // (approver check); revoking never is.
      const { data } = await withSecondFactorStepUp(() => api.post<{ botGrant: "granted" | "revoked"; bot: { agentId: string; handle: string } | null }>(
        `/integrations/clients/${clientRowId}/install/bot`,
        { action },
      ), "appAccess");
      onBotChanged(clientRowId, {
        offered: true,
        grant: data.botGrant,
        handle: data.bot?.handle ?? bot.handle,
        ...(data.botGrant === "granted" && data.bot?.agentId ? { agentId: data.bot.agentId } : {}),
      });
    } catch (err: unknown) {
      if (isSecondFactorStepUpCancelled(err)) return;
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(isAppBotHandleConflictError(err)
        ? formatMessage({ id: "settings.connectedApps.appIdentity.handleConflict" }, { handle: bot.handle })
        : axiosErr.response?.data?.error || formatMessage({ id: "settings.connectedApps.appIdentityGrantFailed" }));
    } finally {
      setBotBusyClientId(null);
    }
  }, [formatMessage, onBotChanged, setError]);
  const handleCloseBotRemove = useCallback(() => setBotRemoveTarget(null), []);
  const handleConfirmBotRemove = useCallback(
    () => (botRemoveTarget ? handleInstalledBotAction(botRemoveTarget.clientId, botRemoveTarget.bot, "revoke") : Promise.resolve()),
    [botRemoveTarget, handleInstalledBotAction],
  );
  return { botBusyClientId, botRemoveTarget, setBotRemoveTarget, handleInstalledBotAction, handleCloseBotRemove, handleConfirmBotRemove };
}

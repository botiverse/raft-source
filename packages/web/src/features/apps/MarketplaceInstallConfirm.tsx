import { useCallback, useId } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { Button, Dialog, DialogBody, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@botiverse/raft-ui";
import { effectiveAllowedOAuthScopes } from "@botiverse/raft-shared";
import { AppPermissionSetList } from "../../components/integrations/AppPermissionSetList";
import { AppPromptTextSection } from "../../components/integrations/AppPromptText";
import { ConnectedAppBotInstallOption } from "../../components/settings/ConnectedAppBot";
import { DialogActions, DialogCommit, NarrowDialogContent } from "../../components/ui/NarrowDialog";
import type { ConnectedAppListing } from "./connected-apps/connectedAppTypes";

/**
 * A Raft App's install confirmation, opened by its card's Add (Discover and
 * its Recommended cards): what installing approves on this Server, exactly
 * as the Marketplace detail's "Installing approves" section lists it and
 * Add sends it (the permissions, "Also add @bot to …" when the App ships a
 * bot, and the agent text with the consent flag on), then Cancel or Add. The
 * same parts as an install card's dialog (`InstallAppCardDialog`), which
 * installs through the card instead. The caller installs (`onConfirm`) and
 * shows a refusal in `errorBanner`; a 409 updates `listing` in place, so the
 * next Add sends what the admin now sees.
 */
export function MarketplaceInstallConfirm({
  listing,
  serverName,
  promptTextConsent,
  saving,
  errorBanner,
  installWithBot,
  onBotCheckedChange,
  onCancel,
  onConfirm,
}: {
  listing: ConnectedAppListing;
  serverName: string;
  promptTextConsent: boolean;
  /** The install is running: nothing closes it and Add says Adding…. */
  saving: boolean;
  errorBanner: ReactNode;
  /** "Also add @bot": what Add sends. */
  installWithBot: boolean;
  onBotCheckedChange: (checked: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { formatMessage } = useIntl();
  const titleId = useId();
  const title = formatMessage({ id: "apps.addDialog.title" }, { name: listing.name });
  const handleOpenChange = useCallback((open: boolean) => {
    if (!open && !saving) onCancel();
  }, [onCancel, saving]);
  return (
    <Dialog open onOpenChange={handleOpenChange} disablePointerDismissal>
      <NarrowDialogContent
        narrow="sheet"
        aria-labelledby={titleId}
        data-testid="apps-install-confirm"
        title={title}
        titleId={titleId}
        closeLabel={formatMessage({ id: "common.close" })}
        closeDisabled={saving}
        header={(
          <DialogHeader>
            <DialogTitle id={titleId}>{title}</DialogTitle>
            <DialogClose aria-label={formatMessage({ id: "common.close" })} />
          </DialogHeader>
        )}
      >
        <DialogBody className="grid gap-4">
          <DialogDescription>{formatMessage({ id: "settings.connectedApps.detail.installApprovesDescription" })}</DialogDescription>
          <AppPermissionSetList scopes={effectiveAllowedOAuthScopes(listing.allowedScopes)} groups={listing.appNotificationGroups} />
          {listing.bot ? (
            <ConnectedAppBotInstallOption
              appName={listing.name}
              bot={listing.bot}
              serverName={serverName}
              checked={installWithBot}
              disabled={saving}
              onCheckedChange={onBotCheckedChange}
            />
          ) : null}
          {promptTextConsent && listing.promptTextRevisionId ? (
            <AppPromptTextSection fields={listing.promptTextFields} service={listing.clientId} />
          ) : null}
          {errorBanner}
        </DialogBody>
        <DialogActions as={DialogFooter}>
          <Button type="button" variant="ghost" size="lg" onClick={onCancel} disabled={saving}>
            {formatMessage({ id: "common.confirm.cancel" })}
          </Button>
          <DialogCommit>
            {(inHead) => (
              <Button
                type="button"
                variant="primary"
                size={inHead ? "md" : "lg"}
                loading={saving}
                disabled={saving}
                onClick={onConfirm}
                data-testid="apps-install-confirm-add"
              >
                {formatMessage({ id: "apps.card.add" })}
              </Button>
            )}
          </DialogCommit>
        </DialogActions>
      </NarrowDialogContent>
    </Dialog>
  );
}

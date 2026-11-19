import { effectiveAllowedOAuthScopes } from "@botiverse/raft-shared";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { AppPermissionSetList } from "../../components/integrations/AppPermissionSetList";
import { AppPromptTextSection } from "../../components/integrations/AppPromptText";
import { AppSetupRequirement } from "../../components/integrations/AppSetup";
import { ConnectedAppBotInstallOption } from "../../components/settings/ConnectedAppBot";
import type { AppPromptTextFields } from "../../lib/appPromptText";
import type { Server } from "../../store/serverStore";
import type { AvailableServerClient, LoginClientSummary } from "./loginClientSummary";
import type { useLoginInstallBotOffer } from "./useLoginInstallBotOffer";

/**
 * What the Marketplace commit of the Login with Raft setup says about the
 * Server picked, above its button: it is selected, what installing there
 * approves (the App's whole set, its text, its bot), or why it can't go on
 * (suspended, an admin is needed, the status didn't load). The setup page
 * draws it in its commit zone; Raft Desktop's sheet in its body, the button
 * in the dialog's footer (EmbeddedLoginSetup.tsx).
 */
export function LoginMarketplaceCommitBody({ server, entry, installed, canInstall, suspended, needsAdmin, text, installBot, installing, setupClient, notice }: {
  /** The Server picked, when it is one of the rows. */
  server: Server | null;
  entry: AvailableServerClient | null;
  installed: boolean;
  canInstall: boolean;
  suspended: boolean;
  needsAdmin: boolean;
  /** The App's prompt text the install approves, when that consent is on for the Server. */
  text: AppPromptTextFields | null;
  installBot: Pick<ReturnType<typeof useLoginInstallBotOffer>, "bot" | "checked" | "onCheckedChange">;
  installing: boolean;
  /** The App whose setup step an install needs said first. */
  setupClient: LoginClientSummary | null;
  /** Something the install wants said (the App's bot didn't join). */
  notice: ReactNode;
}) {
  const { formatMessage } = useIntl();
  return (
    <>
      {installed && server ? (
        <p className="text-callout text-foreground">
          {formatMessage(
            { id: "pages.humanLogin.selectedServerCommit" },
            { serverName: server.name, b: (chunks) => <strong key="server">{chunks}</strong> },
          )}
        </p>
      ) : canInstall && entry && server ? (
        <>
          <p className="text-callout text-foreground">
            {formatMessage(
              { id: "pages.humanLogin.installCommitBody" },
              {
                serverName: server.name,
                appName: entry.client.name,
                b: (chunks) => <strong key="server">{chunks}</strong>,
              },
            )}
          </p>
          {/* Exactly what the install sends as expected_scopes /
              expected_groups: the app's whole set, not just this
              login's scopes. */}
          <p className="mt-3 text-footnote font-semibold text-foreground">
            {formatMessage({ id: "pages.humanLogin.installCommitPermissions" })}
          </p>
          <AppPermissionSetList
            className="mt-2"
            scopes={effectiveAllowedOAuthScopes(entry.client.allowedScopes)}
            groups={entry.client.appNotificationGroups}
          />
          {text ? (
            <AppPromptTextSection
              className="mt-3"
              fields={text}
              service={entry.client.clientId}
            />
          ) : null}
          {/* Under what the install approves, above Install and Continue, as the install dialog has it. */}
          {installBot.bot ? (
            <ConnectedAppBotInstallOption
              appName={entry.client.name}
              bot={installBot.bot}
              serverName={server.name}
              checked={installBot.checked}
              disabled={installing}
              onCheckedChange={installBot.onCheckedChange}
            />
          ) : null}
        </>
      ) : suspended ? (
        <p className="text-callout text-foreground">
          {formatMessage({ id: "pages.humanLogin.installationSuspended" })}
        </p>
      ) : needsAdmin && entry && server ? (
        <p className="text-callout text-foreground">
          {formatMessage(
            { id: "pages.humanLogin.adminCommitBody" },
            {
              serverName: server.name,
              appName: entry.client.name,
              b: (chunks) => <strong key="server">{chunks}</strong>,
            },
          )}
        </p>
      ) : (
        <p className="text-callout text-foreground">
          {formatMessage({ id: "pages.humanLogin.serverStatusUnavailable" })}
        </p>
      )}

      {canInstall && setupClient?.setupUrl ? <AppSetupRequirement url={setupClient.setupUrl} description={setupClient.setupDescription} /> : null}

      {notice ? <div className="mt-3">{notice}</div> : null}
    </>
  );
}

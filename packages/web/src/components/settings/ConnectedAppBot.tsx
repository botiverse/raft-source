import { Badge, Button, Card, Checkbox, Separator } from "@botiverse/raft-ui";
import { DirectMessageIcon } from "@botiverse/ricons";
import { EyeOff, Hash } from "lucide-react";
import { useCallback, useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import AppBadge from "../agent/AppBadge";
import ConfirmDialog from "../ConfirmDialog";
import Banner from "../ui/Banner";
import SectionEyebrow from "../ui/SectionEyebrow";
import { ConnectedAppLogo } from "./ConnectedAppLogo";

/**
 * An App's bot on the current Server, as the App lists carry it
 * (`bot` on GET /integrations/marketplace and /integrations/clients): absent
 * when the App ships no bot. An installation that never chose reads "pending".
 */
export type AppBotOffer = {
  offered: true;
  grant: "pending" | "granted" | "revoked";
  handle: string;
  /** The bot agent, while it is in the Server. */
  agentId?: string;
};

/** The warning code an install (or a grant) answers with when the bot's handle is taken. */
export const APP_BOT_HANDLE_CONFLICT = "app_bot_handle_conflict";

export function isAppBotHandleConflictError(err: unknown): boolean {
  const response = (err as { response?: { status?: number; data?: { code?: unknown } } } | null)?.response;
  return response?.status === 409 && response.data?.code === APP_BOT_HANDLE_CONFLICT;
}

/**
 * f2: the top of an installed App's detail, while its bot hasn't been added or
 * declined. Its Add and the bot section's Add are the same action.
 */
export function ConnectedAppBotPendingBanner({
  appName,
  bot,
  serverName,
  busy,
  onAdd,
  onDecline,
}: {
  appName: string;
  bot: AppBotOffer;
  serverName: string;
  busy: boolean;
  onAdd: () => void;
  onDecline: () => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <Banner
      intent="info"
      withIcon
      density="sm"
      live={false}
      data-testid="connected-app-bot-pending-banner"
      actions={(
        <>
          <Button type="button" variant="ghost" size="md" disabled={busy} onClick={onDecline} data-testid="connected-app-bot-decline">
            {formatMessage({ id: "settings.connectedApps.appIdentity.decline" })}
          </Button>
          <Button type="button" variant="default" size="md" disabled={busy} onClick={onAdd} data-testid="connected-app-bot-banner-add">
            {formatMessage({ id: "settings.connectedApps.appIdentity.addHandle" }, { handle: bot.handle })}
          </Button>
        </>
      )}
    >
      {formatMessage({ id: "settings.connectedApps.appIdentity.pendingBanner" }, { app: appName, handle: bot.handle, server: serverName })}
    </Banner>
  );
}

function BotCapability({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <span className="flex shrink-0 text-foreground-hint" aria-hidden="true">{icon}</span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/**
 * f2/f3: the "Posts as" section (the App's identity) of an installed App's detail, first in the modal,
 * on every Server the App is installed on. Members see it read-only.
 */
export function ConnectedAppBotSection({
  appName,
  logoUrl,
  logoSeed,
  bot,
  serverName,
  canManage,
  busy,
  onAdd,
  onRequestRemove,
  onViewProfile,
  addLink,
}: {
  appName: string;
  logoUrl: string | null;
  logoSeed: string;
  bot: AppBotOffer;
  serverName: string;
  canManage: boolean;
  busy: boolean;
  onAdd: () => void;
  onRequestRemove: () => void;
  onViewProfile: (agentId: string) => void;
  /**
   * Opened from the App's add link (`?app_bot=`): the section scrolls into
   * view and takes focus, and a member who can't add the bot reads who can,
   * with a way to find them.
   */
  addLink?: { onFindAdmin: () => void };
}) {
  const { formatMessage } = useIntl();
  const granted = bot.grant === "granted";
  const agentId = bot.agentId;
  const handleViewProfile = useCallback(() => {
    if (agentId) onViewProfile(agentId);
  }, [agentId, onViewProfile]);
  const titleId = useId();
  const sectionRef = useRef<HTMLElement | null>(null);
  const fromAddLink = addLink !== undefined;
  useEffect(() => {
    if (!fromAddLink) return;
    sectionRef.current?.scrollIntoView?.({ block: "center" });
    sectionRef.current?.focus({ preventScroll: true });
  }, [fromAddLink]);
  return (
    <section
      ref={sectionRef}
      // The focus ring (taken only when the add link opened it) is drawn 8px
      // outside the section, so it doesn't touch the heading and nothing moves.
      className="relative stack-y-2 outline-none after:pointer-events-none after:absolute after:-inset-2 after:rounded-container focus-visible:after:shadow-focus"
      aria-labelledby={titleId}
      tabIndex={fromAddLink ? -1 : undefined}
      data-testid="connected-app-bot-section"
      data-bot-grant={bot.grant}
    >
      <SectionEyebrow as="div" id={titleId}>{formatMessage({ id: "settings.connectedApps.appIdentity.title" })}</SectionEyebrow>
      {/* Kept (access): who decides whether the App gets in. "The name this app posts under" stays cut. */}
      <div className="text-footnote text-foreground-muted" data-testid="connected-app-bot-who-decides">{formatMessage({ id: "settings.connectedApps.appIdentity.description" })}</div>
      <Card className="block p-3">
        <div className="flex items-start gap-3">
          <ConnectedAppLogo name={appName} logoUrl={logoUrl} seed={logoSeed} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="min-w-0 break-words text-subhead font-semibold text-foreground">{appName}</span>
              <AppBadge className="shrink-0" />
            </div>
            <div className="mt-0.5 break-all font-mono text-mono-meta text-foreground-muted">{formatMessage({ id: "common.handle" }, { name: bot.handle })}</div>
          </div>
          {granted ? (
            <Badge appearance="soft" variant="success" className="shrink-0">
              {formatMessage({ id: "settings.connectedApps.appIdentity.joined" })}
            </Badge>
          ) : null}
        </div>
        {granted ? (
          // What removing does is said once, in the confirmation, not on the card.
          agentId || canManage ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {agentId ? (
                <Button type="button" variant="default" size="md" onClick={handleViewProfile}>
                  {formatMessage({ id: "settings.connectedApps.appIdentity.viewProfile" })}
                </Button>
              ) : null}
              {canManage ? (
                <Button type="button" variant="ghost" size="md" disabled={busy} onClick={onRequestRemove} data-testid="connected-app-bot-remove">
                  {formatMessage({ id: "settings.connectedApps.appIdentity.remove" })}
                </Button>
              ) : null}
            </div>
          ) : null
        ) : (
          <>
            <Separator className="my-3" />
            <ul className="stack-y-1.5 text-footnote text-foreground-muted">
              <BotCapability icon={<DirectMessageIcon width={14} height={14} />}>
                {formatMessage({ id: "settings.connectedApps.appIdentity.capabilityDm" }, { app: appName })}
              </BotCapability>
              <BotCapability icon={<Hash size={14} />}>
                {formatMessage({ id: "settings.connectedApps.appIdentity.capabilityChannels" })}
              </BotCapability>
              <BotCapability icon={<EyeOff size={14} />}>
                {formatMessage({ id: "settings.connectedApps.appIdentity.capabilityPrivacy" })}
              </BotCapability>
            </ul>
            {canManage ? (
              <Button type="button" variant="default" size="md" className="mt-3" disabled={busy} onClick={onAdd} data-testid="connected-app-bot-add">
                {formatMessage({ id: "settings.connectedApps.appIdentity.addToServer" }, { handle: bot.handle, server: serverName })}
              </Button>
            ) : addLink ? (
              <div className="mt-3" data-testid="connected-app-bot-admin-only">
                <div className="text-footnote text-foreground-muted">
                  {formatMessage({ id: "settings.connectedApps.appIdentity.adminOnlyAdd" }, { handle: bot.handle })}
                </div>
                <Button type="button" variant="outline" size="md" className="mt-2" onClick={addLink.onFindAdmin} data-testid="connected-app-bot-find-admin">
                  {formatMessage({ id: "pages.humanLogin.findServerAdmin" })}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </Card>
    </section>
  );
}

/**
 * f3: confirm removing the bot. Removing can be undone (adding it again
 * re-activates the same bot, back in its channels), so this is an ordinary
 * confirmation: plain text and a default (ink) confirm, not the red one.
 */
export function ConnectedAppBotRemoveDialog({
  appName,
  handle,
  onConfirm,
  onClose,
}: {
  appName: string;
  handle: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <ConfirmDialog
      title={formatMessage({ id: "settings.connectedApps.appIdentity.removeTitle" }, { handle })}
      message={formatMessage({ id: "settings.connectedApps.appIdentity.removeDescription" }, { handle, app: appName })}
      confirmLabel={formatMessage({ id: "settings.connectedApps.appIdentity.remove" })}
      confirmVariant="warning"
      confirmTestId="connected-app-bot-remove-confirm"
      layer={1}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

/**
 * f4: in the install dialog, below the permissions it approves and above the
 * Install button. Checked by default; unchecked declines the bot for this Server.
 */
export function ConnectedAppBotInstallOption({
  appName,
  bot,
  serverName,
  checked,
  disabled,
  onCheckedChange,
}: {
  appName: string;
  /** Only the handle is shown: the Login with Raft lookup carries no more than that. */
  bot: Pick<AppBotOffer, "handle">;
  serverName: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <label className="mt-3 flex items-start gap-2" data-testid="connected-app-bot-install-option">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        data-testid="connected-app-bot-install-checkbox"
      />
      <span className="min-w-0">
        <span className="block text-callout font-semibold text-foreground">
          {formatMessage({ id: "settings.connectedApps.appIdentity.installOption" }, { handle: bot.handle, server: serverName })}
        </span>
        <span className="mt-0.5 block text-footnote text-foreground-muted">
          {formatMessage({ id: "settings.connectedApps.appIdentity.installOptionDescription" }, { app: appName })}
        </span>
      </span>
    </label>
  );
}

/**
 * f4: the install went through, only the bot didn't join (its handle is
 * taken; the install answered app_bot_handle_conflict). The notice the
 * marketplace install shows, for the installs that keep their own page.
 */
export function ConnectedAppBotHandleConflictNotice({ handle }: { handle: string }) {
  const { formatMessage } = useIntl();
  return (
    <Banner intent="warning" density="sm" data-testid="connected-app-bot-handle-conflict">
      {formatMessage({ id: "settings.connectedApps.appIdentity.handleConflict" }, { handle })}
    </Banner>
  );
}

/**
 * The Marketplace's hint for an App this Server has installed whose bot is
 * still undecided (#proj-apps:#35 layer 2), on its card and in its listing:
 * owners and admins get the Add of Settings › Apps (with its second step), a
 * member reads who can add it. Not a badge, and nothing counts it as unread.
 */
export function ConnectedAppBotMarketplaceHint({
  appId,
  bot,
  serverName,
  canManage,
  busy,
  onAdd,
}: {
  /** The installed App's row id, which the add call takes. */
  appId: string;
  bot: AppBotOffer;
  serverName: string;
  canManage: boolean;
  busy: boolean;
  onAdd: (appId: string, bot: AppBotOffer) => void;
}) {
  const { formatMessage } = useIntl();
  const handleAdd = useCallback(() => onAdd(appId, bot), [appId, bot, onAdd]);
  return canManage ? (
    <Button type="button" variant="default" size="md" disabled={busy} onClick={handleAdd} data-testid="connected-app-bot-marketplace-add">
      {formatMessage({ id: "settings.connectedApps.appIdentity.addToServer" }, { handle: bot.handle, server: serverName })}
    </Button>
  ) : (
    <div className="text-footnote font-normal text-foreground-muted" data-testid="connected-app-bot-marketplace-admin-only">
      {formatMessage({ id: "settings.connectedApps.appIdentity.adminOnlyAdd" }, { handle: bot.handle })}
    </div>
  );
}

/**
 * The bot add link (`?app_bot=<client_id>`) named an App this Server doesn't
 * have installed, or no App at all: the one notice for both, so the link
 * can't be used to find out whether a private App exists.
 */
export function ConnectedAppBotLinkNotInstalledNotice({ onClose }: { onClose: () => void }) {
  const { formatMessage } = useIntl();
  return (
    <Banner
      intent="info"
      density="sm"
      onClose={onClose}
      closeLabel={formatMessage({ id: "common.close" })}
      data-testid="connected-apps-bot-link-not-installed"
    >
      {formatMessage({ id: "settings.connectedApps.appIdentity.linkNotInstalled" })}
    </Banner>
  );
}

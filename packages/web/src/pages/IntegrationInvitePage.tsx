import { effectiveAllowedOAuthScopes } from "@botiverse/raft-shared";
import { AppSetupPanel, AppSetupRequirement } from "../components/integrations/AppSetup";
import { useCallback, useEffect, useEffectEvent, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowRight, Check, Plug } from "lucide-react";
import {
  Button,
  Card,
  Separator,
  IconTile,
  ScrollArea,
} from "@botiverse/raft-ui";
import api from "../api/client";
import { isSecondFactorStepUpCancelled, withSecondFactorStepUp } from "../components/settings/secondFactorStepUp";
import {
  APP_BOT_HANDLE_CONFLICT,
  ConnectedAppBotHandleConflictNotice,
  ConnectedAppBotInstallOption,
} from "../components/settings/ConnectedAppBot";
import type { AppBotOffer } from "../components/settings/ConnectedAppBot";
import Banner from "../components/ui/Banner";
import SectionEyebrow from "../components/ui/SectionEyebrow";
import { AppPermissionSetList } from "../components/integrations/AppPermissionSetList";
import { AppPromptTextSection } from "../components/integrations/AppPromptText";
import {
  appPermissionsChangedCurrentSet,
  expectedAppPermissionsBody,
  isAppPermissionsChangedError,
  isExpectedPermissionsRequiredError,
} from "../lib/appPermissionExpectation";
import { appTextChangedCurrent, expectedTextRevisionBody, installEntryPromptText, readPromptTextRevisionId } from "../lib/appPromptText";
import { APP_PROMPT_TEXT_CONSENT_FEATURE_FLAG_KEY, useServerFeatureFlag } from "../store/serverFeatureFlags";

type OAuthClientShareInvite = {
  client: {
    id: string;
    clientId: string;
    name: string;
    description: string | null;
    homepageUrl: string | null;
    returnUrl: string | null;
    allowedScopes: string[] | null;
    /** Data groups an install approves; absent on an older server. */
    appNotificationGroups?: string[];
    logoUrl: string | null;
    publisherName: string | null;
    sourceServerName: string | null;
    installedAt: string | null;
    setupUrl?: string | null;
    setupDescription?: string | null;
    whenToUse?: string | null;
    /** The text revision name / description / whenToUse are (app_prompt_text_consent); installing confirms it. */
    promptTextRevisionId?: string | null;
    /** The App's bot on the link's target Server, as the App lists carry it; absent when it ships none (or an older server). */
    bot?: AppBotOffer;
  };
  link: {
    id: string;
    /** The slug the link was made for; absent from older servers. */
    targetServerSlug?: string | null;
    expiresAt: string | null;
  };
  /** The link's one target Server, which the viewer owns or administers. */
  manageableServers: Array<{
    id: string;
    name: string;
    slug: string;
    role: string;
    installedAt: string | null;
  }>;
  /** On the install's answer: app_bot_handle_conflict when the App installed but its bot didn't join. */
  warnings?: string[];
};

/**
 * The server's one answer for a link that can't install for this viewer
 * (unknown, revoked, used, expired, or for a Server they aren't in): never which.
 */
const PRIVATE_APP_INVITE_INVALID = "private_app_invite_invalid";
/** A member of the link's target Server without owner/admin: the server names that Server. */
const PRIVATE_APP_INVITE_ADMIN_REQUIRED = "private_app_invite_admin_required";

type InviteErrorBody = { code?: unknown; targetServer?: { name?: unknown } };

function inviteErrorBody(err: unknown): InviteErrorBody | undefined {
  return (err as { response?: { data?: InviteErrorBody } } | null)?.response?.data;
}

/** The localized explanation for the server's two invite refusals, or null for any other error. */
function inviteRefusalMessage(err: unknown, formatMessage: IntlShape["formatMessage"]): string | null {
  const body = inviteErrorBody(err);
  if (body?.code === PRIVATE_APP_INVITE_INVALID) {
    return formatMessage({ id: "pages.integrationInvite.inviteInvalid" });
  }
  if (body?.code === PRIVATE_APP_INVITE_ADMIN_REQUIRED && typeof body.targetServer?.name === "string") {
    return formatMessage({ id: "pages.integrationInvite.needTargetAdmin" }, { server: body.targetServer.name });
  }
  return null;
}

function getDomain(raw: string | null | undefined, notConfiguredLabel: string) {
  if (!raw) return notConfiguredLabel;
  try {
    return new URL(raw).hostname;
  } catch {
    return raw;
  }
}

export default function IntegrationInvitePage() {
  const { formatDate, formatMessage } = useIntl();
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const [invite, setInvite] = useState<OAuthClientShareInvite | null>(null);
  const [selectedServerId, setSelectedServerId] = useState("");
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState("");
  const [installed, setInstalled] = useState(false);
  // f4: "Also add @bot", checked by default; unchecked declines the bot for this Server.
  const [installWithBot, setInstallWithBot] = useState(true);
  // The handle of a bot the install couldn't add (taken on the Server).
  const [botConflictHandle, setBotConflictHandle] = useState<string | null>(null);

  // Effect Event: the fetch re-runs only when the token changes, while still
  // reading the current formatMessage for its fallback copy.
  const loadInvite = useEffectEvent(async () => {
    setLoading(true);
    setError("");
    try {
      const { data } = await api.get(`/integration-invites/${encodeURIComponent(token)}`);
      setInvite(data);
      // A link installs on one Server: the server sends only that one.
      const target = (data as OAuthClientShareInvite).manageableServers[0];
      setSelectedServerId(target?.id ?? "");
      setInstalled(Boolean(target?.installedAt));
    } catch (err: any) {
      setError(inviteRefusalMessage(err, formatMessage)
        ?? (err.response?.data?.error || formatMessage({ id: "pages.integrationInvite.inviteNotFound" })));
    } finally {
      setLoading(false);
    }
  });

  useEffect(() => {
    void loadInvite();
  }, [token]);

  const selectedServer = invite?.manageableServers.find((server) => server.id === selectedServerId) ?? null;
  // The app's whole declared set, unfiltered: what the list shows is what the
  // install sends as expected_scopes / expected_groups.
  const installScopes = useMemo(() => effectiveAllowedOAuthScopes(invite?.client.allowedScopes), [invite?.client.allowedScopes]);
  const installGroups = useMemo(() => invite?.client.appNotificationGroups ?? [], [invite?.client.appNotificationGroups]);
  // The flag of the Server picked as the install target.
  const promptTextConsent = useServerFeatureFlag(APP_PROMPT_TEXT_CONSENT_FEATURE_FLAG_KEY, { serverId: selectedServerId || null }).enabled;
  const shownTextRevisionId = promptTextConsent && invite ? readPromptTextRevisionId(invite.client) : null;
  const shownText = shownTextRevisionId && invite ? installEntryPromptText(invite.client) : null;
  // As the marketplace install: offered for an App that ships a bot. Not
  // offered, the install sends no `bot`.
  const offeredBot = invite?.client.bot ?? null;
  const botChoice = offeredBot ? installWithBot : undefined;
  const install = useCallback(async () => {
    if (!selectedServerId) return;
    setInstalling(true);
    setError("");
    setBotConflictHandle(null);
    try {
      // Sends back exactly the set listed below; the server records it only
      // while it still equals the app's declaration.
      // Two-step verification on: a sign-in that passed it (approver check).
      const { data } = await withSecondFactorStepUp(() => api.post<OAuthClientShareInvite>(`/integration-invites/${encodeURIComponent(token)}/install`, {
        serverId: selectedServerId,
        ...expectedAppPermissionsBody(installScopes, installGroups),
        ...expectedTextRevisionBody(shownTextRevisionId),
        // Unchecked declines the bot here ("revoked"), so this Server isn't asked again.
        ...(botChoice !== undefined ? { bot: botChoice } : {}),
      }), "appAccess");
      setInvite(data);
      setInstalled(true);
      // The install went through; only the bot didn't join (its handle is taken).
      const handle = data.client?.bot?.handle ?? offeredBot?.handle;
      if (botChoice && handle && data.warnings?.includes(APP_BOT_HANDLE_CONFLICT)) {
        setBotConflictHandle(handle);
      }
    } catch (err: any) {
      // Closing "Verify it's you" cancels: nothing to report.
      if (isSecondFactorStepUpCancelled(err)) return;
      if (isAppPermissionsChangedError(err)) {
        // Show the app's current set and text in place, so the next click
        // sends what the admin now sees. The response carries both.
        const current = appPermissionsChangedCurrentSet(err);
        const text = shownTextRevisionId ? appTextChangedCurrent(err, shownTextRevisionId) : null;
        setInvite((value) => value && {
          ...value,
          client: {
            ...value.client,
            ...(current ? { allowedScopes: current.scopes, appNotificationGroups: current.groups } : {}),
            ...(text ? { promptTextRevisionId: text.revisionId, ...(text.fields ?? {}) } : {}),
          },
        });
        setError(formatMessage({ id: text ? "appPromptText.textChanged" : "pages.integrationInvite.permissionsChanged" }));
        return;
      }
      if (isExpectedPermissionsRequiredError(err)) {
        setError(formatMessage({ id: "appPermissionSet.reloadRequired" }));
        return;
      }
      const refusal = inviteRefusalMessage(err, formatMessage);
      if (refusal) {
        // Used, revoked or expired since the page loaded, or not this person's
        // to install: nothing left to install here.
        setInvite(null);
        setError(refusal);
        return;
      }
      setError(err.response?.data?.error || formatMessage({ id: "pages.integrationInvite.installFailed" }));
    } finally {
      setInstalling(false);
    }
  }, [botChoice, formatMessage, installGroups, installScopes, offeredBot?.handle, selectedServerId, shownTextRevisionId, token]);
  const handleInstallClick = useCallback(() => {
    void install();
  }, [install]);
  const selectedServerSlug = selectedServer?.slug;
  const openSelectedServerSettings = useCallback(() => {
    navigate(`/s/${selectedServerSlug}/settings`);
  }, [navigate, selectedServerSlug]);

  return (
    // raft-ui ScrollArea: the page's scroller. The safe areas pad its
    // full-height content; the card's column fills what they leave (flex-1).
    <ScrollArea
      className="h-full min-h-0 bg-layer-sidebar font-display text-foreground"
      contentClassName="flex min-h-full flex-col safe-top safe-bottom"
      data-testid="integration-invite-page"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-8">
        <Card className="p-5">
          <div className="flex items-start justify-between gap-4 pb-4">
            <div>
              <SectionEyebrow as="div">{formatMessage({ id: "pages.integrationInvite.eyebrow" })}</SectionEyebrow>
              <h1 className="mt-1 text-title">{formatMessage({ id: "pages.integrationInvite.title" })}</h1>
            </div>
            <IconTile size="lg">
              <Plug />
            </IconTile>
          </div>
          <Separator />

          {loading ? (
            <div className="py-12 text-center text-callout text-foreground-muted">{formatMessage({ id: "pages.integrationInvite.loading" })}</div>
          ) : error && !invite ? (
            <Banner intent="warning" className="mt-4">{error}</Banner>
          ) : invite ? (
            <div className="stack-y-4 pt-4">
              {error && <Banner intent="warning">{error}</Banner>}
              {botConflictHandle ? <ConnectedAppBotHandleConflictNotice handle={botConflictHandle} /> : null}
              {installed && (
                <Banner intent="success">
                  {invite.client.name} {formatMessage({ id: "pages.integrationInvite.installedBannerMid" })} {selectedServer?.name ?? formatMessage({ id: "pages.integrationInvite.installedBannerFallbackServer" })}.
                </Banner>
              )}

              {invite.client.setupUrl ? installed && selectedServerId
                ? <AppSetupPanel clientId={invite.client.id} serverId={selectedServerId} />
                : <AppSetupRequirement url={invite.client.setupUrl} description={invite.client.setupDescription} /> : null}

              <div className="rounded-container border border-line-hairline p-4">
                <div className="text-headline">{invite.client.name}</div>
                <div className="mt-1 text-caption text-foreground-hint">
                  {formatMessage({ id: "pages.integrationInvite.sharedByPrefix" })} {invite.client.publisherName ?? formatMessage({ id: "pages.integrationInvite.sharedByPublisherFallback" })} {formatMessage({ id: "pages.integrationInvite.sharedByServerMid" })} {invite.client.sourceServerName ?? formatMessage({ id: "pages.integrationInvite.sharedByServerFallback" })}
                </div>
                {invite.client.description && (
                  <p className="mt-3 text-callout text-foreground-muted">{invite.client.description}</p>
                )}
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div>
                    <div className="text-footnote font-medium text-foreground-hint">{formatMessage({ id: "pages.integrationInvite.clientIdLabel" })}</div>
                    <div className="break-all font-mono text-mono-meta text-foreground">{invite.client.clientId}</div>
                  </div>
                  <div>
                    <div className="text-footnote font-medium text-foreground-hint">{formatMessage({ id: "pages.integrationInvite.homepageLabel" })}</div>
                    <div className="break-all font-mono text-mono-meta text-foreground">{getDomain(invite.client.homepageUrl, formatMessage({ id: "pages.integrationInvite.notConfigured" }))}</div>
                  </div>
                  <div>
                    <div className="text-footnote font-medium text-foreground-hint">{formatMessage({ id: "pages.integrationInvite.callbackLabel" })}</div>
                    <div className="break-all font-mono text-mono-meta text-foreground">{getDomain(invite.client.returnUrl, formatMessage({ id: "pages.integrationInvite.notConfigured" }))}</div>
                  </div>
                  <div>
                    <div className="text-footnote font-medium text-foreground-hint">{formatMessage({ id: "pages.integrationInvite.inviteExpiryLabel" })}</div>
                    <div className="text-callout text-foreground">{invite.link.expiresAt ? formatDate(invite.link.expiresAt) : formatMessage({ id: "pages.integrationInvite.noExpiry" })}</div>
                  </div>
                </div>
              </div>

              {!selectedServer?.installedAt && (
                <div className="rounded-container border border-line-hairline p-4">
                  <p className="text-footnote font-semibold text-foreground">
                    {formatMessage({ id: "pages.integrationInvite.installCommitPermissions" })}
                  </p>
                  <AppPermissionSetList className="mt-2" scopes={installScopes} groups={installGroups} />
                  {/* Below the permissions it approves, above Install App, as the install dialog has it. */}
                  {offeredBot && selectedServer ? (
                    <ConnectedAppBotInstallOption
                      appName={invite.client.name}
                      bot={offeredBot}
                      serverName={selectedServer.name}
                      checked={installWithBot}
                      disabled={installing}
                      onCheckedChange={setInstallWithBot}
                    />
                  ) : null}
                </div>
              )}

              {shownText && !installed ? (
                <AppPromptTextSection
                  fields={shownText}
                  service={invite.client.clientId}
                  className="rounded-container border border-line-hairline p-4"
                />
              ) : null}

              {!selectedServer ? (
                <Banner intent="warning" className="font-bold">
                  {formatMessage({ id: "pages.integrationInvite.needAdmin" })}
                </Banner>
              ) : (
                <div className="rounded-container border border-line-hairline p-4">
                  <SectionEyebrow as="div">{formatMessage({ id: "pages.integrationInvite.installTargetLabel" })}</SectionEyebrow>
                  <div className="mt-3 grid gap-3 md:grid-cols-[1fr_auto] md:items-center">
                    {/* The link's one target: nothing to choose. */}
                    <div className="min-w-0" data-testid="integration-invite-target">
                      <div className="truncate text-headline">
                        {selectedServer.name}
                        {selectedServer.installedAt ? formatMessage({ id: "pages.integrationInvite.installedSuffix" }) : ""}
                      </div>
                      <div className="truncate font-mono text-mono-meta text-foreground-hint">/{selectedServer.slug}</div>
                    </div>
                    {selectedServer.installedAt ? (
                      <Button type="button" onClick={openSelectedServerSettings} size="lg" className="w-full md:w-auto">
                        {formatMessage({ id: "pages.integrationInvite.openSettings" })}
                        {/* Settings is inside Raft: an arrow, never ↗. */}
                        <ArrowRight data-icon="inline-end" aria-hidden="true" />
                      </Button>
                    ) : (
                      <Button type="button" onClick={handleInstallClick} disabled={installing || !selectedServerId} size="lg" variant="accent" className="w-full md:w-auto">
                        <Check size={14} />
                        {installing ? formatMessage({ id: "pages.integrationInvite.installing" }) : formatMessage({ id: "pages.integrationInvite.installApp" })}
                      </Button>
                    )}
                  </div>
                  {!installed ? (
                    <p className="mt-3 text-caption text-foreground-hint">{formatMessage({ id: "pages.integrationInvite.singleUseNote" })}</p>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}
        </Card>
      </div>
    </ScrollArea>
  );
}

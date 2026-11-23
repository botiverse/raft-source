import { appendOAuthAuthorizationParams, effectiveAllowedOAuthScopes } from "@botiverse/raft-shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import { useIntl } from "react-intl";
import {
  Select,
  SelectContent,
  SelectIcon,
  SelectList,
  SelectTrigger,
  SelectValue, Button, Card, Input, ScrollArea
} from "@botiverse/raft-ui";
import api from "../api/client";
import { isSecondFactorStepUpCancelled, withSecondFactorStepUp } from "../components/settings/secondFactorStepUp";
import { APP_BOT_HANDLE_CONFLICT, ConnectedAppBotHandleConflictNotice } from "../components/settings/ConnectedAppBot";
import { useAuthStore } from "../store/authStore";
import { useServerStore } from "../store/serverStore";
import type { Server } from "../store/serverStore";
import SignedInAs from "../components/auth/SignedInAs";
import RequestedScopeConsent from "../components/oauth/RequestedScopeConsent";
import { hasAgentInboundOAuthScope } from "../lib/oauthScopePresentation";
import {
  appPermissionsChangedCurrentSet,
  expectedAppPermissionsBody,
  isAppPermissionsChangedError,
  isExpectedPermissionsRequiredError,
} from "../lib/appPermissionExpectation";
import { appTextChangedCurrent, expectedTextRevisionBody, installEntryPromptText, readPromptTextRevisionId } from "../lib/appPromptText";
import { APP_PROMPT_TEXT_CONSENT_FEATURE_FLAG_KEY, readServerFeatureFlag, useServerFeatureFlag } from "../store/serverFeatureFlags";
import { MarketplaceServerRow } from "./MarketplaceServerRow";
import { AccountLoginPanel } from "../features/login-with-raft/AccountLoginPanel";
import { EmbeddedLoginSetup } from "../features/login-with-raft/EmbeddedLoginSetup";
import { LoginMarketplaceCommitBody } from "../features/login-with-raft/LoginMarketplaceCommitBody";
import { LoginAppDetailsCard } from "../features/login-with-raft/LoginAppDetailsCard";
import { LoginFaqCard } from "../features/login-with-raft/LoginFaqCard";
import { LoginLookupLoadingCard } from "../features/login-with-raft/LoginLookupLoadingCard";
import { LoginScopeConfigurationAlert } from "../features/login-with-raft/LoginScopeConfigurationAlert";
import {
  initialServerPick,
  isAccountLoginEntry,
  isLoginAvailable,
  marketplaceServerRank,
  withAccountInstallationsSuspended,
} from "../features/login-with-raft/loginClientSummary";
import { LoginSetupHeader } from "../features/login-with-raft/LoginSetupHeader";
import type { AvailableServerClient, LoginClientSummary } from "../features/login-with-raft/loginClientSummary";
import { authorizationErrorRedirectUrl, isAppNotAvailableError, isLoginModeChangedError } from "../features/login-with-raft/loginErrors";
import { AccountLoginRefusalBanner } from "../features/login-with-raft/AccountLoginRefusalBanner";
import { APP_DETAILS_CARD_CLASS, FIELD_HELP_CLASS, FIELD_LABEL_CLASS, LOGIN_STATUS_CLASS, TITLE_CLASS } from "../features/login-with-raft/loginSetupClassNames";
import { useAccountAuthorization } from "../features/login-with-raft/useAccountAuthorization";
import { useLoginSetupHost } from "../features/login-with-raft/loginSetupHost";
import { renderSelectItems } from "../features/login-with-raft/loginServerSelectItems";
import { useApproveLock } from "../features/login-with-raft/useApproveLock";
import { useLoginInstallBotOffer } from "../features/login-with-raft/useLoginInstallBotOffer";
import { useTitleFocusRequest } from "../features/login-with-raft/useTitleFocusRequest";

/** One Server's lookup: the App's summary there, not open to this person, or failed (outage, network). */
type ServerLookup =
  | ({ status: "ok" } & AvailableServerClient)
  | { status: "notAvailable"; server: Server }
  | { status: "failed"; server: Server };

// A read-only stand-in where the server picker would be (none available).
const FIELD_PLACEHOLDER_CLASS = "flex min-h-control items-center rounded-(--control-radius) border border-line-hairline bg-fill-muted px-3 text-callout text-foreground-muted";
// DS Button drawn on a link, so it stays a link for assistive tech.
const OUTLINE_LINK_BUTTON_CLASS = "mt-3 flex h-control w-full items-center justify-center rounded-(--control-radius) border-[1.5px] border-line-strong bg-layer-card px-4 text-center text-subhead font-bold text-foreground no-underline outline-none hover:overlay-medium active:overlay-medium focus-visible:shadow-focus";

export default function HumanLoginSetupPage() {
  const { formatMessage } = useIntl();
  const user = useAuthStore((s) => s.user);
  const servers = useServerStore((s) => s.servers);
  const serversLoading = useServerStore((s) => s.loading);
  // The address bar on the page; the shell's request in Raft Desktop's sheet (loginSetupHost.ts).
  const { search: hostSearch, deliver, source, embedded, notice, preferredServerId, registeredReturnOnly = false, approveAfterMs } = useLoginSetupHost();
  const params = useMemo(() => new URLSearchParams(hostSearch), [hostSearch]);
  const configuredReturnUrl = params.get("return_to") || params.get("redirect_uri") || "";
  const setupState = params.get("state") || "";
  const oidcFlow = params.get("flow") === "oidc";
  const oidcNonce = params.get("nonce") || "";
  const oidcCodeChallenge = params.get("code_challenge") || "";
  const oidcCodeChallengeMethod = params.get("code_challenge_method") || "";
  const requestedServerHint = params.get("server") || "";
  const clientId = params.get("client_id") || "";
  const scopes = useMemo(() => {
    const raw = params.get("scope") || "openid profile";
    return raw.split(/\s+/).map((scope) => scope.trim()).filter(Boolean);
  }, [params]);
  const candidateServers = useMemo(() => (
    requestedServerHint
      ? servers.filter((server) => server.id === requestedServerHint || server.slug === requestedServerHint)
      : servers
  ), [requestedServerHint, servers]);
  const [selectedServerId, setSelectedServerId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState("");
  // What the lookups found, one entry per Server where the App is open to
  // this person. One list, so every later change (an install, a refusal)
  // updates the latest one; ready / to install / suspended derive from it.
  const [foundEntries, setFoundEntries] = useState<AvailableServerClient[]>([]);
  const [someLookupFailed, setSomeLookupFailed] = useState(false);
  // Servers whose lookup said the App is not open to this person: never listed.
  const [notAvailableServerIds, setNotAvailableServerIds] = useState<string[]>([]);
  // Continue answered app_not_available (the audience changed after the lookup).
  const [continueDenied, setContinueDenied] = useState(false);
  // Loading from the first paint, so the page never flashes the denial.
  const [clientLoading, setClientLoading] = useState(() => !!clientId.trim());
  const [installingServerId, setInstallingServerId] = useState("");
  const [serverQuery, setServerQuery] = useState("");
  // Bumped by a 409 login_mode_changed: the App switched to account mode after this page opened; look it up again.
  const [lookupRound, setLookupRound] = useState(0);
  const { titleRef, requestTitleFocus } = useTitleFocusRequest();
  const handleServerQueryChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setServerQuery(event.target.value);
  }, []);

  const availableServerClients = useMemo(() => foundEntries.filter((entry) => isLoginAvailable(entry.client)), [foundEntries]);
  const installRequiredServerClients = useMemo(() => foundEntries.filter((entry) => entry.client.availability === "install_required"), [foundEntries]);
  // Installed but suspended: listed as unavailable with the reason, never continuable.
  const suspendedServerClients = useMemo(() => foundEntries.filter((entry) => entry.client.availability === "suspended"), [foundEntries]);
  // With nothing ready or installable, the refusal: suspended, or, if a
  // lookup failed, an outage (offer a reload).
  const clientError = availableServerClients.length > 0 || installRequiredServerClients.length > 0
    ? ""
    : suspendedServerClients.length > 0
      ? formatMessage({ id: suspendedServerClients.some(isAccountLoginEntry)
        ? "pages.humanLogin.account.installationSuspended"
        : "pages.humanLogin.installationSuspended" })
      : someLookupFailed ? formatMessage({ id: "pages.humanLogin.serverStatusUnavailable" }) : "";

  const handleAccountNotAvailable = useCallback(() => setContinueDenied(true), []);
  // Login with Raft answered installation_suspended: every installation was
  // suspended after the lookup (the answer comes after an await: the latest
  // list, not the one the press saw). The page then reads as that lookup
  // would have (the App's Suspended badge, no Login button), and a Server
  // left suspended isn't kept picked: the next render picks again by
  // initialServerPick (none when several remain). The refusal stays first in whichever card shows.
  const [reselectAfterSuspend, setReselectAfterSuspend] = useState(false);
  const handleAccountSuspended = useCallback(() => {
    setFoundEntries(withAccountInstallationsSuspended);
    setReselectAfterSuspend(true);
  }, []);
  if (reselectAfterSuspend) {
    setReselectAfterSuspend(false);
    if (!foundEntries.some((entry) => entry.server.id === selectedServerId && entry.client.availability !== "suspended")) {
      setSelectedServerId(initialServerPick(foundEntries));
    }
  }
  const account = useAccountAuthorization({
    returnUrl: configuredReturnUrl,
    scopes,
    setupState,
    oidcFlow,
    oidcNonce,
    oidcCodeChallenge,
    oidcCodeChallengeMethod,
    onNotAvailable: handleAccountNotAvailable,
    onSuspended: handleAccountSuspended,
  });
  const { authorize: authorizeAccount } = account;
  const { clearRefusal: clearAccountRefusal } = account;

  // Async-loader: OAuth client availability by clientId across the user's servers.
  // Unavailable servers are hidden from the selector instead of surfacing a dead option.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    setFoundEntries([]);
    setSomeLookupFailed(false);
    setNotAvailableServerIds([]);

    if (serversLoading && clientId.trim()) {
      setClientLoading(true);
      return;
    }

    // No App asked for, or no Server to look on (no Servers reads as "not available").
    if (!clientId.trim() || candidateServers.length === 0) {
      setClientLoading(false);
      setSelectedServerId("");
      return;
    }

    let cancelled = false;
    setClientLoading(true);

    void Promise.all(candidateServers.map((server) =>
      api.get("/oauth/clients/lookup", {
        params: {
          client_id: clientId,
          server_id: server.id,
          scope: scopes.join(" "),
        },
      }).then((res): ServerLookup => ({
        status: "ok",
        server,
        client: res.data as LoginClientSummary,
      })).catch((err: unknown): ServerLookup => ({
        status: isAppNotAvailableError(err) ? "notAvailable" : "failed",
        server,
      }))
    )).then((lookups) => {
      if (cancelled) return;
      // In the desktop sheet, the App registered with another return address than the request's is not this App.
      const results = lookups.map((result): ServerLookup => (
        result.status === "ok" && registeredReturnOnly && result.client.returnUrl !== configuredReturnUrl
          ? { status: "notAvailable", server: result.server }
          : result
      ));
      const found = results.flatMap((result) => (
        result.status === "ok" ? [{ server: result.server, client: result.client }] : []
      ));
      setNotAvailableServerIds(results.filter((result) => result.status === "notAvailable").map((result) => result.server.id));
      setFoundEntries(found);
      // A fresh lookup is the page's answer now: a press's refusal (say,
      // suspended, before an admin restored it) gives way to what it found.
      clearAccountRefusal();
      setSomeLookupFailed(results.some((result) => result.status === "failed"));
      // The host's Server (the conversation the built-in browser sits beside) is picked first when
      // the App can be used or installed there; never over a choice the person already made.
      const preferred = found.find((entry) => entry.server.id === preferredServerId
        && (isLoginAvailable(entry.client) || entry.client.availability === "install_required"));
      setSelectedServerId((current) => (
        found.some((entry) => entry.server.id === current) ? current : preferred?.server.id ?? initialServerPick(found)
      ));
    }).finally(() => {
      if (!cancelled) {
        setClientLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [candidateServers, clientId, scopes, serversLoading, lookupRound, clearAccountRefusal, preferredServerId, registeredReturnOnly, configuredReturnUrl]);

  const selectedServerClient = availableServerClients.find((entry) => entry.server.id === selectedServerId);
  const client = selectedServerClient?.client ?? null;
  const marketplaceClient = [
    ...availableServerClients,
    ...installRequiredServerClients,
  ].find((entry) => entry.client.marketplace || entry.client.availability === "install_required")?.client ?? null;
  const marketplaceServerRows = candidateServers.filter((server) => !notAvailableServerIds.includes(server.id)).map((server) => {
    const entry = availableServerClients.find((candidate) => candidate.server.id === server.id)
      ?? installRequiredServerClients.find((candidate) => candidate.server.id === server.id)
      ?? suspendedServerClients.find((candidate) => candidate.server.id === server.id);
    return { server, entry };
  }).sort((left, right) => (
    marketplaceServerRank(left.entry) - marketplaceServerRank(right.entry)
    || left.server.name.localeCompare(right.server.name)
  ));
  const normalizedServerQuery = serverQuery.trim().toLocaleLowerCase();
  const filteredMarketplaceServerRows = marketplaceServerRows.filter(({ server }) => (
    !normalizedServerQuery
    || server.name.toLocaleLowerCase().includes(normalizedServerQuery)
    || server.slug.toLocaleLowerCase().includes(normalizedServerQuery)
  ));
  const isMarketplaceApp = marketplaceClient !== null;
  const selectedMarketplaceRow = marketplaceServerRows.find(({ server }) => server.id === selectedServerId);
  const selectedMarketplaceEntry = selectedMarketplaceRow?.entry ?? null;
  // The flag of the Server this page would install on, not the current one.
  const selectedServerPromptTextConsent = useServerFeatureFlag(
    APP_PROMPT_TEXT_CONSENT_FEATURE_FLAG_KEY,
    { serverId: selectedMarketplaceRow?.server.id ?? null },
  ).enabled;
  const selectedMarketplaceText = selectedServerPromptTextConsent && selectedMarketplaceEntry
    && readPromptTextRevisionId(selectedMarketplaceEntry.client)
    ? installEntryPromptText(selectedMarketplaceEntry.client)
    : null;
  const selectedMarketplaceInstalled = selectedMarketplaceEntry != null
    && isLoginAvailable(selectedMarketplaceEntry.client);
  const selectedMarketplaceSuspended = selectedMarketplaceEntry?.client.availability === "suspended";
  const selectedMarketplaceCanInstall = selectedMarketplaceEntry?.client.installation?.canInstall === true;
  const selectedMarketplaceNeedsAdmin = selectedMarketplaceEntry?.client.availability === "install_required"
    && !selectedMarketplaceCanInstall;
  const installBot = useLoginInstallBotOffer(selectedMarketplaceEntry, selectedMarketplaceCanInstall);
  const { setConflict: setBotConflict } = installBot;
  // The App's details (name, description, what it asks for) are the App's, not a Server's: with
  // several Servers and none picked yet (initialServerPick), they come from the first lookup answer.
  const detailsClient = marketplaceClient ?? client ?? availableServerClients[0]?.client ?? null;
  const availableServerOptions = useMemo(() => availableServerClients.map(({ server }) => ({
    value: server.id,
    label: `${server.name} (${server.slug})`,
  })), [availableServerClients]);

  const serviceName = detailsClient?.name || (clientId.trim() ? formatMessage({ id: "pages.humanLogin.thisApp" }) : formatMessage({ id: "pages.humanLogin.thisService" }));
  const selectedServerName = selectedMarketplaceRow?.server.name
    ?? selectedServerClient?.server.name
    ?? formatMessage({ id: "pages.humanLogin.thisServerFallback" });
  const hasAgentInboundRequest = hasAgentInboundOAuthScope(scopes);
  // The App's scope check is the App's, not a Server's: shown before a Server is picked too.
  const scopeValidationClient = selectedMarketplaceEntry?.client ?? client ?? detailsClient;
  const disallowedScopes = scopeValidationClient?.scopeValidation?.disallowedScopes ?? [];
  const scopeValidationReason = scopeValidationClient?.scopeValidation?.reason ?? null;
  const hasDisallowedScopes = disallowedScopes.length > 0;
  // Not while busy: the button's raft-ui `loading` blocks a second press and,
  // unlike `disabled`, keeps focus on it.
  const canContinue = !!client && !clientLoading && !clientError && !!configuredReturnUrl.trim() && !!selectedServerId && !hasAgentInboundRequest && !hasDisallowedScopes;
  const canInstallAndContinue = isMarketplaceApp
    && selectedMarketplaceCanInstall
    && !!selectedMarketplaceEntry?.client.id
    && !clientLoading
    && !!configuredReturnUrl.trim()
    && !hasAgentInboundRequest
    && !hasDisallowedScopes;
  // No Servers, or every one answered "not available" (a failed lookup never
  // counts), or Continue said so.
  const appNotAvailable = continueDenied || (!!clientId.trim() && !serversLoading && !clientLoading
    && candidateServers.every((server) => notAvailableServerIds.includes(server.id)));

  // RFC 079 phase 3a (design §4.1): an App in account mode signs in with the
  // person's Raft account, no Server chosen. Lookups without loginMode keep
  // the picker. With nothing ready yet but install targets, the Marketplace
  // rows install it, then sign in without a Server (D5).
  const accountEntries = [...availableServerClients, ...installRequiredServerClients, ...suspendedServerClients].filter(isAccountLoginEntry);
  const accountMode = accountEntries.length > 0;
  const accountReady = availableServerClients.find(isAccountLoginEntry) ?? null;
  const accountClient = accountReady?.client ?? accountEntries[0]?.client ?? null;
  const accountView = accountMode && (!!requestedServerHint || !!accountReady || installRequiredServerClients.length === 0);
  // A Server-scoped issuer's link (`server=`) can't sign in to an account-mode App: refused before any request.
  const accountRefusal = requestedServerHint ? "rootIssuerRequired" as const : account.refusal;
  // Signing in shows `loading`, which blocks a second press and keeps focus (not `disabled`).
  const canLoginWithAccount = !!accountReady && !installingServerId && !clientLoading && !clientError
    && !!configuredReturnUrl.trim() && !hasAgentInboundRequest && !accountReady.client.scopeValidation?.disallowedScopes.length && !accountRefusal;
  // Raft Desktop's sheet: the one approving button shown takes no press for a moment after it can first be pressed.
  const approveLocked = useApproveLock(approveAfterMs, accountView ? canLoginWithAccount : selectedMarketplaceCanInstall ? canInstallAndContinue : canContinue);
  const handleAccountLogin = useCallback(() => {
    if (accountReady) void authorizeAccount(accountReady.client.clientId);
  }, [accountReady, authorizeAccount]);

  const authorizeWithClient = useCallback(async (serverId: string, loginClient: LoginClientSummary) => {
    setSubmitting(true);
    setStatus("");
    try {
      const { data } = await withSecondFactorStepUp(() => api.post("/oauth/authorize/human", {
        clientId: loginClient.clientId,
        serverId,
        returnUrl: configuredReturnUrl,
        scopes,
        ...(oidcFlow ? {
          oidc: true,
          nonce: oidcNonce || undefined,
          codeChallenge: oidcCodeChallenge || undefined,
          codeChallengeMethod: oidcCodeChallengeMethod || undefined,
          server: requestedServerHint || undefined,
        } : {}),
        ...(source ? { source } : {}),
      }), "appAccess");
      deliver(appendOAuthAuthorizationParams(data.returnUrl, data.code, setupState));
    } catch (err: any) {
      // Closing "Verify it's you" cancels: stay on the page, nothing to report.
      if (isSecondFactorStepUpCancelled(err)) return;
      if (isLoginModeChangedError(err)) {
        // Shown here only if the new lookup still reads server mode (a switch in flight).
        setStatus(formatMessage({ id: "pages.humanLogin.account.loginModeChanged" }, { serviceName: loginClient.name }));
        // Loading from this render, so the title asked for is the new card's.
        setClientLoading(true);
        requestTitleFocus();
        setLookupRound((round) => round + 1);
        return;
      }
      const appErrorUrl = authorizationErrorRedirectUrl(err.response?.data, setupState);
      if (appErrorUrl) {
        deliver(appErrorUrl);
        return;
      }
      if (isAppNotAvailableError(err)) {
        setContinueDenied(true);
        return;
      }
      setStatus(err.response?.data?.error_description || err.response?.data?.error || formatMessage({ id: "pages.humanLogin.continueFailed" }));
    } finally {
      setSubmitting(false);
    }
  }, [
    configuredReturnUrl,
    deliver,
    formatMessage,
    oidcCodeChallenge,
    oidcCodeChallengeMethod,
    oidcFlow,
    oidcNonce,
    requestTitleFocus,
    requestedServerHint,
    scopes,
    setupState,
    source,
  ]);

  /** `bot`: the "Also add @bot" choice, when it was offered; undefined sends none. */
  const installMarketplaceApp = useCallback(async (entry: AvailableServerClient, bot?: boolean) => {
    if (!entry.client.id || !entry.client.installation?.canInstall) return;
    setInstallingServerId(entry.server.id);
    setStatus("");
    setBotConflict(null);
    const shownTextRevisionId = readServerFeatureFlag(entry.server.id, APP_PROMPT_TEXT_CONSENT_FEATURE_FLAG_KEY)
      ? readPromptTextRevisionId(entry.client)
      : null;
    try {
      const { data } = await api.post<{ warnings?: string[] } | undefined>(
        `/integrations/marketplace/${entry.client.id}/install`,
        {
          ...expectedAppPermissionsBody(effectiveAllowedOAuthScopes(entry.client.allowedScopes), entry.client.appNotificationGroups ?? []),
          ...expectedTextRevisionBody(shownTextRevisionId),
          // Unchecked declines the bot here ("revoked"), so this Server isn't asked again.
          ...(bot !== undefined ? { bot } : {}),
        },
        { headers: { "X-Server-Id": entry.server.id } },
      );
      // The install went through; only the bot didn't join (its handle is
      // taken). Said, and the login goes on.
      if (bot && entry.client.bot && data?.warnings?.includes(APP_BOT_HANDLE_CONFLICT)) {
        setBotConflict({ serverId: entry.server.id, handle: entry.client.bot.handle });
      }
      const installedEntry: AvailableServerClient = {
        server: entry.server,
        client: {
          ...entry.client,
          availability: "ready",
          installation: undefined,
        },
      };
      setFoundEntries((current) => [
        ...current.filter((candidate) => candidate.server.id !== entry.server.id),
        installedEntry,
      ]);
      setSelectedServerId(entry.server.id);
      if (isAccountLoginEntry(installedEntry)) {
        await authorizeAccount(installedEntry.client.clientId);
      } else {
        await authorizeWithClient(entry.server.id, installedEntry.client);
      }
    } catch (err: unknown) {
      if (isAppPermissionsChangedError(err)) {
        // Show the app's current set and text in place, so the next click
        // sends what the admin now sees. The response carries both.
        const current = appPermissionsChangedCurrentSet(err);
        const text = shownTextRevisionId ? appTextChangedCurrent(err, shownTextRevisionId) : null;
        setFoundEntries((entries) => entries.map((candidate) => (
          candidate.client.availability === "install_required" && candidate.client.id === entry.client.id
            ? {
              ...candidate,
              client: {
                ...candidate.client,
                ...(current ? { allowedScopes: current.scopes, appNotificationGroups: current.groups } : {}),
                ...(text ? { promptTextRevisionId: text.revisionId, ...(text.fields ?? {}) } : {}),
              },
            }
            : candidate
        )));
        setStatus(formatMessage({ id: text ? "appPromptText.textChanged" : "pages.humanLogin.permissionsChanged" }));
        return;
      }
      if (isExpectedPermissionsRequiredError(err)) {
        setStatus(formatMessage({ id: "appPermissionSet.reloadRequired" }));
        return;
      }
      const apiError = err as { response?: { data?: { error?: string } } };
      setStatus(apiError.response?.data?.error || formatMessage({ id: "pages.humanLogin.installFailed" }));
    } finally {
      setInstallingServerId("");
    }
  }, [authorizeAccount, authorizeWithClient, formatMessage, setBotConflict]);

  const continueToApp = useCallback(async () => {
    if (!clientId.trim()) {
      setStatus(formatMessage({ id: "pages.humanLogin.missingClientId" }));
      return;
    }
    if (!configuredReturnUrl.trim()) {
      setStatus(formatMessage({ id: "pages.humanLogin.missingReturnUrl" }));
      return;
    }
    if (!selectedServerId) {
      setStatus(formatMessage({ id: "pages.humanLogin.chooseServer" }));
      return;
    }
    if (!client) {
      setStatus(clientError || formatMessage({ id: "pages.humanLogin.notRegisteredForServer" }));
      return;
    }

    await authorizeWithClient(selectedServerId, client);
  }, [authorizeWithClient, client, clientError, clientId, configuredReturnUrl, formatMessage, selectedServerId]);

  const handleCommit = useCallback(() => {
    if (selectedMarketplaceCanInstall && selectedMarketplaceEntry) {
      void installMarketplaceApp(selectedMarketplaceEntry, installBot.bot ? installBot.checked : undefined);
      return;
    }
    void continueToApp();
  }, [continueToApp, installBot.bot, installBot.checked, installMarketplaceApp, selectedMarketplaceCanInstall, selectedMarketplaceEntry]);
  const botConflictNotice = installBot.conflictHandle ? <ConnectedAppBotHandleConflictNotice handle={installBot.conflictHandle} /> : null;

  const handleSelectServerRow = useCallback((serverId: string) => {
    if (installingServerId) return;
    setSelectedServerId(serverId);
  }, [installingServerId]);

  const handleServerChange = useCallback((value: string | null) => {
    if (value == null) return;
    setSelectedServerId(value);
  }, []);

  const accountPanel = {
    serviceName: accountClient?.name || serviceName,
    client: accountClient,
    scopes,
    refusal: accountRefusal,
    refusalAfterLogin: !!account.refusal,
    error: clientError,
    loginModeChanged: lookupRound > 0,
    titleRef,
    canLogin: canLoginWithAccount && !approveLocked,
    submitting: account.submitting,
    status: account.status,
    notice: botConflictNotice,
    onLogin: handleAccountLogin,
  };
  // The Server choice: the Marketplace rows, the picker, or a stand-in where there is none.
  const serverChoice = isMarketplaceApp ? (
    <div role="group" aria-labelledby="slock-login-server-label">
      <Card>
        {marketplaceServerRows.length > 5 && (
          <div className="border-b border-line-hairline p-2">
            <Input
              type="search"
              value={serverQuery}
              onChange={handleServerQueryChange}
              disabled={!!installingServerId}
              placeholder={formatMessage({ id: "pages.humanLogin.searchServers" })}
              aria-label={formatMessage({ id: "pages.humanLogin.searchServers" })}
              className="w-full"
            />
          </div>
        )}
        {/* The rows (buttons, no tab stop here) scroll in a ScrollArea and hand a scroll past its end to the page. */}
        <ScrollArea tabIndex={-1} overscroll="auto" className="max-h-72">
      {/* raft-ui ListRows: the hairline between two rows is theirs. */}
      {filteredMarketplaceServerRows.map(({ server, entry }) => (
        <MarketplaceServerRow
          key={server.id}
          server={server}
          entry={entry}
          selected={selectedServerId === server.id}
          installPending={installingServerId === server.id}
          installInFlight={!!installingServerId}
          onSelect={handleSelectServerRow}
        />
      ))}
        {filteredMarketplaceServerRows.length === 0 && (
          <div className="px-3 py-6 text-center text-callout text-foreground-hint">
            {formatMessage({ id: "pages.humanLogin.noServerSearchResults" })}
          </div>
        )}
        </ScrollArea>
      </Card>
    </div>
  ) : availableServerClients.length > 0 ? (
    <Select
      value={selectedServerId}
      onValueChange={handleServerChange}
      items={availableServerOptions}
    >
      <SelectTrigger className="w-full">
        <SelectValue placeholder={formatMessage({ id: "pages.humanLogin.raftServerLabel" })} />
        <SelectIcon />
      </SelectTrigger>
      <SelectContent>
        <SelectList>{renderSelectItems(availableServerOptions)}</SelectList>
      </SelectContent>
    </Select>
  ) : (
    <div className={FIELD_PLACEHOLDER_CLASS}>
      {formatMessage({ id: "pages.humanLogin.noAvailableServers" })}
    </div>
  );
  const serverHelp = accountMode ? formatMessage({ id: "pages.humanLogin.account.installHelp" }, { serviceName }) : null;
  const scopeAlert = hasDisallowedScopes ? <LoginScopeConfigurationAlert reason={scopeValidationReason} appName={serviceName} scopeList={disallowedScopes.join(", ")} /> : null;
  // What the Marketplace commit says about the Server picked, above its button.
  const commitBody = isMarketplaceApp ? (
    <LoginMarketplaceCommitBody
      server={selectedMarketplaceRow?.server ?? null}
      entry={selectedMarketplaceEntry}
      installed={selectedMarketplaceInstalled}
      canInstall={selectedMarketplaceCanInstall}
      suspended={selectedMarketplaceSuspended}
      needsAdmin={selectedMarketplaceNeedsAdmin}
      text={selectedMarketplaceText}
      installBot={installBot}
      installing={!!installingServerId}
      setupClient={detailsClient}
      notice={botConflictNotice}
    />
  ) : null;
  // The one approving button (raft-ui Button `loading` for every wait: the spinner in place of the label, which
  // loadingLabel says); none where only a Server admin can install.
  const commitDisabled = approveLocked || (isMarketplaceApp && selectedMarketplaceCanInstall ? !canInstallAndContinue : !canContinue);
  const installing = !!installingServerId;
  const commit = useMemo(() => (isMarketplaceApp ? (selectedMarketplaceNeedsAdmin ? null : {
    disabled: commitDisabled,
    loading: installing || submitting,
    loadingLabel: formatMessage({ id: installing ? "pages.humanLogin.installingAndContinuing" : "pages.humanLogin.continuing" }),
    onClick: handleCommit,
    children: formatMessage({ id: selectedMarketplaceCanInstall ? "pages.humanLogin.installAndContinue" : "pages.humanLogin.continueLogin" }),
    "data-testid": "marketplace-login-commit",
  }) : {
    disabled: commitDisabled,
    loading: submitting,
    loadingLabel: formatMessage({ id: "pages.humanLogin.continuing" }),
    onClick: continueToApp,
    children: formatMessage({ id: "pages.humanLogin.loginWithRaft" }),
  }), [commitDisabled, continueToApp, formatMessage, handleCommit, installing, isMarketplaceApp, selectedMarketplaceCanInstall, selectedMarketplaceNeedsAdmin, submitting]);

  // In a sheet (loginSetupHost.ts `embedded`) the same facts and the same button are laid out as a dialog's parts.
  if (embedded) {
    return (
      <EmbeddedLoginSetup
        notice={notice}
        loading={clientLoading}
        notAvailable={appNotAvailable}
        serviceName={detailsClient?.name ?? null}
        account={accountView ? accountPanel : null}
        accountRefusal={accountMode ? account.refusal : null}
        client={detailsClient}
        clientError={clientError}
        serverChoice={serverChoice}
        onlyServer={!isMarketplaceApp && availableServerOptions.length === 1 ? availableServerOptions[0]!.label : null}
        serverHelp={serverHelp}
        scopes={scopes}
        scopeAlert={scopeAlert}
        commitBody={commitBody}
        commitBusy={!!installingServerId}
        commit={commit}
        status={status}
        titleRef={titleRef}
      />
    );
  }
  return (
    // raft-ui ScrollArea: the page's scroller (scrollbar while pointed at or scrolling).
    <ScrollArea className="h-full min-h-0 bg-layer-sidebar font-display text-foreground" data-testid="human-login-setup-scroller">
      <LoginSetupHeader />

      {appNotAvailable ? (
        <main className="mx-auto max-w-2xl px-4 py-6 pb-10 sm:px-5 sm:py-8 sm:pb-12 md:py-10 md:pb-14">
          {/* One sentence, the same for everyone: no Server, count, role or
              way to get access (RFC 079 §5.6). */}
          <Card render={<section />} className="p-4 sm:p-6" data-testid="app-not-available">
            <h1 className="text-title sm:text-display">
              {formatMessage({ id: "pages.humanLogin.appNotAvailable" })}
            </h1>
            <p className="mt-5 text-caption text-foreground-hint">
              <SignedInAs user={user} prefix={formatMessage({ id: "pages.humanLogin.signedInAsPrefix" })} />
            </p>
          </Card>
        </main>
      ) : (
        <main className="mx-auto grid max-w-5xl gap-5 px-4 py-6 pb-10 sm:gap-6 sm:px-5 sm:py-8 sm:pb-12 md:grid-cols-[1fr_360px] md:py-10 md:pb-14" aria-busy={clientLoading}>
        {/* Until the lookup answers, the App's mode is unknown: neither the
            Server picker nor the account card, just the loading card. */}
        {clientLoading ? (
          <LoginLookupLoadingCard />
        ) : accountView ? (
          <AccountLoginPanel {...accountPanel} />
        ) : (
        <Card render={<section />} className="p-4 sm:p-6">
          <h1 ref={titleRef} tabIndex={-1} className={TITLE_CLASS}>
            <span className="block text-headline sm:text-title">{formatMessage({ id: accountMode ? "pages.humanLogin.account.title" : "pages.humanLogin.connectTitle" }, { serviceName, serverName: selectedServerName })}</span>
            <span className="mt-1 block break-words text-display sm:text-hero">{serviceName}</span>
          </h1>
          {/* An account-mode refusal of a press (the account card gave way to
              the install rows, or Install and Continue's sign-in): first, with focus. */}
          {accountMode ? <AccountLoginRefusalBanner refusal={account.refusal} error="" takeFocus /> : null}
          <p className="text-callout text-foreground-muted">
            {formatMessage({ id: accountMode ? "pages.humanLogin.account.body" : "pages.humanLogin.useAccountWith" }, { serviceName, b: (chunks) => <strong key="service">{chunks}</strong> })}
          </p>
          <p className="mt-2 text-caption text-foreground-hint">
            <SignedInAs user={user} prefix={formatMessage({ id: "pages.humanLogin.signedInAsPrefix" })} />
          </p>

          <div className="mt-5">
            <div className={FIELD_LABEL_CLASS}>{formatMessage({ id: "pages.humanLogin.appDetailsLabel" })}</div>
            {detailsClient ? (
              <LoginAppDetailsCard client={detailsClient} />
            ) : (
              <Card className={APP_DETAILS_CARD_CLASS}>
                <span className="text-foreground-muted">
                  {clientError || formatMessage({ id: "pages.humanLogin.selectServerFallback" })}
                </span>
              </Card>
            )}
            <p className={FIELD_HELP_CLASS}>
              {formatMessage({ id: "pages.humanLogin.appDetailsHelp" })}
            </p>
          </div>

          <div className="mt-5">
            <div className={FIELD_LABEL_CLASS} id="slock-login-server-label">
              {formatMessage({ id: "pages.humanLogin.raftServerLabel" })}
            </div>
            <div id="slock-login-server" className="mt-1.5">
              {serverChoice}
            </div>
            <p className={FIELD_HELP_CLASS}>
              {serverHelp ?? formatMessage({ id: isMarketplaceApp ? "pages.humanLogin.marketplaceServerHelp" : "pages.humanLogin.serverHelp" })}
            </p>
          </div>

          <RequestedScopeConsent scopes={scopes} />

          {scopeAlert}

          {isMarketplaceApp ? (
            <div
              className="mt-6 rounded-container border border-line-hairline bg-fill-muted p-4"
              data-testid="marketplace-login-commit-zone"
              aria-busy={!!installingServerId}
            >
              {commitBody}

              {commit ? <Button {...commit} size="xl" variant="accent" className="mt-4 w-full" /> : null}

              {/* A link into the app: in a sheet it would reload the app's own page under it, so the page only. */}
              {selectedMarketplaceNeedsAdmin && selectedMarketplaceRow ? (
                <a
                  href={`/s/${encodeURIComponent(selectedMarketplaceRow.server.slug)}/members`}
                  className={OUTLINE_LINK_BUTTON_CLASS}
                >
                  {formatMessage({ id: "pages.humanLogin.findServerAdmin" })}
                </a>
              ) : null}
            </div>
          ) : (
            <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
              {commit ? <Button {...commit} size="lg" variant="accent" className="w-full sm:w-auto" /> : null}
            </div>
          )}

          {status && <ScrollArea render={<pre />} orientation="horizontal" overscroll="auto" role="region" aria-label={formatMessage({ id: "pages.humanLogin.loginStatus" })} className={LOGIN_STATUS_CLASS}>{status}</ScrollArea>}
        </Card>
        )}

        <LoginFaqCard />
      </main>
      )}
    </ScrollArea>
  );
}

import { appendOAuthAuthorizationParams } from "@botiverse/raft-shared";
import { useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import {
  Badge,
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
  SelectValue,
} from "raft-ui";
import api from "../api/client";
import { useAuthStore } from "../store/authStore";
import { useServerStore } from "../store/serverStore";
import type { Server } from "../store/serverStore";
import AvatarSlot from "../components/ui/AvatarSlot";
import AvatarListRow from "../components/ui/AvatarListRow";
import Button from "../components/ui/Button";
import Spinner from "../components/ui/Spinner";
import SignedInAs from "../components/auth/SignedInAs";
import RaftBrandLockup from "../components/brand/RaftBrandLockup";
import RequestedScopeConsent from "../components/oauth/RequestedScopeConsent";
import { hasAgentInboundOAuthScope } from "../lib/oauthScopePresentation";

type LoginClientSummary = {
  id?: string;
  clientId: string;
  appType: "server_local" | "slock_builtin" | "third_party_global";
  name: string;
  description: string | null;
  homepageUrl: string | null;
  returnUrl: string | null;
  logoUrl?: string | null;
  allowedScopes?: string[] | null;
  scopeValidation?: {
    allowed: boolean;
    reason: "not_allowed" | "unsupported" | "mixed" | null;
    disallowedScopes: string[];
  };
  marketplace?: boolean;
  availability?: "ready" | "install_required";
  installation?: {
    serverId: string;
    canInstall: boolean;
  };
};

type AvailableServerClient = {
  server: Server;
  client: LoginClientSummary;
};

type SelectOption = {
  value: string;
  label: string;
};

function marketplaceServerRank(entry: AvailableServerClient | undefined) {
  if (!entry) return 3;
  if (entry.client.availability !== "install_required") return 0;
  return entry.client.installation?.canInstall ? 1 : 2;
}


function renderSelectItems(options: readonly SelectOption[]) {
  return options.map((option) => (
    <SelectItem key={option.value} value={option.value}>
      <SelectItemText>{option.label}</SelectItemText>
      <SelectItemIndicator />
    </SelectItem>
  ));
}

function readyChipClassName() {
  return "border-2 border-black bg-brutal-lime/70 px-2 py-0.5 text-[10px] font-black uppercase tracking-widest";
}

function appDetailsCardClassName(clickable: boolean) {
  const base = "mt-1 border-2 border-black bg-white px-3 py-2 text-sm";
  return clickable
    ? `${base} block text-black no-underline shadow-brutal-sm transition-all duration-100 hover:-translate-y-[1px] hover:shadow-brutal active:translate-x-[1px] active:translate-y-[1px] active:shadow-brutal-active`
    : base;
}

function LoginAppDetailsCard({ client }: { client: LoginClientSummary }) {
  const { formatMessage } = useIntl();
  const content = (
    <div className="flex min-w-0 items-start gap-3">
      <AvatarSlot
        context="surface-list"
        type="app"
        appAvatarUrl={client.logoUrl}
        appInitials={initialsForApp(client.name)}
        className="shadow-brutal-sm"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 break-words font-black">{client.name}</span>
          <span className={readyChipClassName()}>{formatMessage({
            id: client.marketplace || client.availability === "install_required"
              ? "pages.humanLogin.marketplace"
              : "pages.humanLogin.ready",
          })}</span>
        </div>
        {client.description && <div className="text-xs text-black/60">{client.description}</div>}
      </div>
    </div>
  );

  if (!client.homepageUrl) {
    return <div className={appDetailsCardClassName(false)}>{content}</div>;
  }

  return (
    <a
      href={client.homepageUrl}
      target="_blank"
      rel="noreferrer"
      aria-label={`${formatMessage({ id: "pages.humanLogin.openAppAriaPrefix" })} ${client.name}`}
      className={appDetailsCardClassName(true)}
    >
      {content}
    </a>
  );
}

export function initialsForApp(name: string) {
  const parts = name.split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return "A";
  const second = parts[1];
  return (second ? `${first[0]}${second[0]}` : first.slice(0, 2)).toUpperCase();
}

export default function HumanLoginSetupPage() {
  const { formatMessage } = useIntl();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const servers = useServerStore((s) => s.servers);
  const serversLoading = useServerStore((s) => s.loading);
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
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
  const [availableServerClients, setAvailableServerClients] = useState<AvailableServerClient[]>([]);
  const [installRequiredServerClients, setInstallRequiredServerClients] = useState<AvailableServerClient[]>([]);
  const [clientLoading, setClientLoading] = useState(false);
  const [clientError, setClientError] = useState("");
  const [installingServerId, setInstallingServerId] = useState("");
  const [serverQuery, setServerQuery] = useState("");

  // Async-loader: OAuth client availability by clientId across the user's servers.
  // Unavailable servers are hidden from the selector instead of surfacing a dead option.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    if (!clientId.trim()) {
      setAvailableServerClients([]);
      setInstallRequiredServerClients([]);
      setClientError("");
      setClientLoading(false);
      setSelectedServerId("");
      return;
    }

    if (serversLoading) {
      setAvailableServerClients([]);
      setInstallRequiredServerClients([]);
      setClientError("");
      setClientLoading(true);
      return;
    }

    if (candidateServers.length === 0) {
      setAvailableServerClients([]);
      setInstallRequiredServerClients([]);
      setClientError(formatMessage({ id: "pages.humanLogin.noServerAccess" }));
      setClientLoading(false);
      setSelectedServerId("");
      return;
    }

    let cancelled = false;
    setClientLoading(true);
    setClientError("");
    setAvailableServerClients([]);
    setInstallRequiredServerClients([]);

    void Promise.all(candidateServers.map((server) =>
      api.get("/oauth/clients/lookup", {
        params: {
          client_id: clientId,
          server_id: server.id,
          scope: scopes.join(" "),
        },
      }).then((res) => ({
        server,
        client: res.data as LoginClientSummary,
      })).catch(() => null)
    )).then((results) => {
      if (cancelled) return;
      const found = results.filter((result): result is AvailableServerClient => result !== null);
      const available = found.filter((result) => result.client.availability !== "install_required");
      const installRequired = found.filter((result) => result.client.availability === "install_required");
      setAvailableServerClients(available);
      setInstallRequiredServerClients(installRequired);
      const ordered = [...found].sort((left, right) => (
        marketplaceServerRank(left) - marketplaceServerRank(right)
        || left.server.name.localeCompare(right.server.name)
      ));
      setSelectedServerId((current) => (
        found.some((entry) => entry.server.id === current) ? current : ordered[0]?.server.id ?? ""
      ));
      if (available.length === 0 && installRequired.length === 0) {
        setClientError(formatMessage({ id: "pages.humanLogin.notRegisteredForAny" }));
      }
    }).finally(() => {
      if (!cancelled) {
        setClientLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [candidateServers, clientId, scopes, serversLoading, formatMessage]);

  const selectedServerClient = availableServerClients.find((entry) => entry.server.id === selectedServerId);
  const client = selectedServerClient?.client ?? null;
  const marketplaceClient = [
    ...availableServerClients,
    ...installRequiredServerClients,
  ].find((entry) => entry.client.marketplace || entry.client.availability === "install_required")?.client ?? null;
  const marketplaceServerRows = candidateServers.map((server) => {
    const entry = availableServerClients.find((candidate) => candidate.server.id === server.id)
      ?? installRequiredServerClients.find((candidate) => candidate.server.id === server.id);
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
  const selectedMarketplaceInstalled = selectedMarketplaceEntry != null
    && selectedMarketplaceEntry.client.availability !== "install_required";
  const selectedMarketplaceCanInstall = selectedMarketplaceEntry?.client.installation?.canInstall === true;
  const selectedMarketplaceNeedsAdmin = selectedMarketplaceEntry?.client.availability === "install_required"
    && !selectedMarketplaceCanInstall;
  const detailsClient = marketplaceClient ?? client;
  const availableServerOptions = availableServerClients.map(({ server }) => ({
    value: server.id,
    label: `${server.name} (${server.slug})`,
  }));

  const serviceName = detailsClient?.name || (clientId.trim() ? formatMessage({ id: "pages.humanLogin.thisApp" }) : formatMessage({ id: "pages.humanLogin.thisService" }));
  const selectedServerName = selectedMarketplaceRow?.server.name
    ?? selectedServerClient?.server.name
    ?? formatMessage({ id: "pages.humanLogin.thisServerFallback" });
  const hasAgentInboundRequest = hasAgentInboundOAuthScope(scopes);
  const scopeValidationClient = selectedMarketplaceEntry?.client ?? client;
  const disallowedScopes = scopeValidationClient?.scopeValidation?.disallowedScopes ?? [];
  const scopeValidationReason = scopeValidationClient?.scopeValidation?.reason ?? null;
  const hasDisallowedScopes = disallowedScopes.length > 0;
  const canContinue = !!client && !submitting && !installingServerId && !clientLoading && !clientError && !!configuredReturnUrl.trim() && !!selectedServerId && !hasAgentInboundRequest && !hasDisallowedScopes;
  const canInstallAndContinue = isMarketplaceApp
    && selectedMarketplaceCanInstall
    && !!selectedMarketplaceEntry?.client.id
    && !submitting
    && !installingServerId
    && !clientLoading
    && !!configuredReturnUrl.trim()
    && !hasAgentInboundRequest
    && !hasDisallowedScopes;
  const scopeSummary = scopes.join(" · ");
  const unavailableAfterLookup = !!clientId.trim() && !serversLoading && !clientLoading
    && availableServerClients.length === 0 && installRequiredServerClients.length === 0;

  async function authorizeWithClient(serverId: string, loginClient: LoginClientSummary) {
    setSubmitting(true);
    setStatus("");
    try {
      const { data } = await api.post("/oauth/authorize/human", {
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
      });
      window.location.assign(appendOAuthAuthorizationParams(data.returnUrl, data.code, setupState));
    } catch (err: any) {
      setStatus(err.response?.data?.error_description || err.response?.data?.error || formatMessage({ id: "pages.humanLogin.continueFailed" }));
    } finally {
      setSubmitting(false);
    }
  }

  async function installMarketplaceApp(entry: AvailableServerClient) {
    if (!entry.client.id || !entry.client.installation?.canInstall) return;
    setInstallingServerId(entry.server.id);
    setStatus("");
    try {
      await api.post(`/integrations/marketplace/${entry.client.id}/install`, undefined, {
        headers: { "X-Server-Id": entry.server.id },
      });
      const installedEntry: AvailableServerClient = {
        server: entry.server,
        client: {
          ...entry.client,
          availability: "ready",
          installation: undefined,
        },
      };
      setInstallRequiredServerClients((current) => (
        current.filter((candidate) => candidate.server.id !== entry.server.id)
      ));
      setAvailableServerClients((current) => (
        current.some((candidate) => candidate.server.id === entry.server.id)
          ? current
          : [...current, installedEntry]
      ));
      setSelectedServerId(entry.server.id);
      await authorizeWithClient(entry.server.id, installedEntry.client);
    } catch (err: unknown) {
      const apiError = err as { response?: { data?: { error?: string } } };
      setStatus(apiError.response?.data?.error || formatMessage({ id: "pages.humanLogin.installFailed" }));
    } finally {
      setInstallingServerId("");
    }
  }

  async function continueToApp() {
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
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-brutal-cream font-display text-black">
      <header className="border-b-2 border-black bg-white">
        <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 font-black sm:gap-2">
            <span className="shrink-0 text-xs font-bold uppercase tracking-widest text-black/55 sm:text-sm">{formatMessage({ id: "pages.humanLogin.loginWith" })}</span>
            <RaftBrandLockup className="h-5 w-auto shrink-0 sm:h-6" adaptToDarkMode />
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:gap-4">
            <a className="btn-flat-sm px-2.5 py-1.5 text-xs no-underline sm:text-sm" href="/">{formatMessage({ id: "pages.humanLogin.back" })}</a>
            <Button
              onClick={() => logout()}
              size="sm"
              tone="white"
              className="font-black sm:text-sm"
            >
              {formatMessage({ id: "pages.humanLogin.logOut" })}
            </Button>
          </div>
        </div>
      </header>

      {unavailableAfterLookup ? (
        <main className="mx-auto max-w-2xl px-4 py-6 pb-10 sm:px-5 sm:py-8 sm:pb-12 md:py-10 md:pb-14">
          <section className="border-2 border-black bg-white p-4 shadow-brutal sm:p-6">
            <h1 className="text-3xl font-black leading-none sm:text-4xl">
              {formatMessage({ id: "pages.humanLogin.notAccessibleTitle" })}
            </h1>
            <p className="mt-4 text-sm leading-6 text-black/70">
              {formatMessage({ id: "pages.humanLogin.notAccessibleBody" })}
            </p>
            <div className="mt-5 border-2 border-black bg-brutal-blue/20 p-4 text-sm leading-6">
              <h2 className="font-black">{formatMessage({ id: "pages.humanLogin.howToGetAccessTitle" })}</h2>
              <p className="mt-1 text-black/70">
                {formatMessage({ id: "pages.humanLogin.howToGetAccessBody" })}
              </p>
            </div>
            <p className="mt-5 text-xs leading-5 text-black/60">
              <SignedInAs user={user} prefix={formatMessage({ id: "pages.humanLogin.signedInAsPrefix" })} />
            </p>
          </section>
        </main>
      ) : (
        <main className="mx-auto grid max-w-5xl gap-5 px-4 py-6 pb-10 sm:gap-6 sm:px-5 sm:py-8 sm:pb-12 md:grid-cols-[1fr_360px] md:py-10 md:pb-14">
        <section className="border-2 border-black bg-white p-4 shadow-brutal sm:p-6">
          <h1 className="mb-3 leading-none">
            <span className="block text-lg font-bold sm:text-2xl">{formatMessage({ id: "pages.humanLogin.connectTitle" }, { serviceName, serverName: selectedServerName })}</span>
            <span className="mt-1 block break-words text-3xl font-black sm:text-5xl">{serviceName}</span>
          </h1>
          <p className="text-sm leading-6 text-black/70">
            {formatMessage({ id: "pages.humanLogin.useAccountWith" }, { serviceName, b: (chunks) => <strong key="service">{chunks}</strong> })}
          </p>
          <p className="mt-2 text-xs leading-5 text-black/60">
            <SignedInAs user={user} prefix={formatMessage({ id: "pages.humanLogin.signedInAsPrefix" })} />
          </p>

          <div className="mt-5">
            <div className="text-xs font-black uppercase tracking-widest">{formatMessage({ id: "pages.humanLogin.appDetailsLabel" })}</div>
            <div className={detailsClient ? "contents" : appDetailsCardClassName(false)}>
              {clientLoading ? (
                <span className="font-bold text-black/60">{formatMessage({ id: "pages.humanLogin.loadingServers" })}</span>
              ) : detailsClient ? (
                <LoginAppDetailsCard client={detailsClient} />
              ) : (
                <span className="font-bold text-black/60">
                  {clientError || formatMessage({ id: "pages.humanLogin.selectServerFallback" })}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs leading-5 text-black/60">
              {formatMessage({ id: "pages.humanLogin.appDetailsHelp" })}
            </p>
          </div>

          <div className="mt-5">
            <div className="text-xs font-black uppercase tracking-widest" id="slock-login-server-label">
              {formatMessage({ id: "pages.humanLogin.raftServerLabel" })}
            </div>
            <div id="slock-login-server" className="mt-1">
              {clientLoading ? (
                <div className="border-2 border-black bg-white px-3 py-2 text-sm font-bold shadow-brutal-sm">
                  {formatMessage({ id: "pages.humanLogin.loadingServers" })}
                </div>
              ) : isMarketplaceApp ? (
                <div role="group" aria-labelledby="slock-login-server-label">
                  <div className="overflow-hidden border-2 border-black bg-white shadow-brutal-sm">
                    {marketplaceServerRows.length > 5 && (
                      <div className="border-b-2 border-black bg-brutal-cream p-2">
                        <input
                          type="search"
                          value={serverQuery}
                          onChange={(event) => setServerQuery(event.target.value)}
                          disabled={!!installingServerId}
                          placeholder={formatMessage({ id: "pages.humanLogin.searchServers" })}
                          aria-label={formatMessage({ id: "pages.humanLogin.searchServers" })}
                          className="input-brutal w-full px-3 py-2 text-sm"
                        />
                      </div>
                    )}
                    <div className="max-h-72 divide-y-2 divide-black overflow-y-auto">
                  {filteredMarketplaceServerRows.map(({ server, entry }) => {
                    const installed = entry?.client.availability !== "install_required" && entry != null;
                    const selected = selectedServerId === server.id;
                    const canInstall = entry?.client.installation?.canInstall === true;
                    const rowTitle = formatMessage({ id: installed
                      ? "pages.humanLogin.serverInstalledReady"
                      : canInstall
                        ? "pages.humanLogin.serverNotInstalledCanInstall"
                        : entry
                          ? "pages.humanLogin.serverNotInstalledAskAdmin"
                          : "pages.humanLogin.serverStatusUnavailable" });
                    return (
                      <AvatarListRow
                        key={server.id}
                        avatar={(
                          <AvatarSlot
                            context="surface-list"
                            type="server"
                            serverAvatarUrl={server.avatarUrl}
                            serverInitial={server.name.slice(0, 1)}
                            className="mt-1"
                          />
                        )}
                        name={server.name}
                        subtitle={server.slug}
                        rightContent={installingServerId === server.id ? (
                          <Spinner
                            size="sm"
                            aria-hidden="true"
                            data-testid="marketplace-install-pending-row-spinner"
                          />
                        ) : !installed ? (
                          <Badge appearance="outline" uppercase>
                            {formatMessage({ id: !entry
                              ? "pages.humanLogin.serverUnavailableCompact"
                              : canInstall
                                ? "pages.humanLogin.notInstalledCompact"
                                : "pages.humanLogin.adminNeededCompact" })}
                          </Badge>
                        ) : null}
                        align="start"
                        selected={selected}
                        onClick={() => {
                          if (installingServerId) return;
                          setSelectedServerId(server.id);
                        }}
                        className={`min-h-14 ${installingServerId ? "opacity-60" : ""}`}
                        buttonProps={{
                          "data-testid": `login-server-status-${server.id}`,
                          disabled: !!installingServerId,
                          "aria-pressed": selected,
                          "aria-disabled": !!installingServerId,
                          "aria-label": `${formatMessage({ id: "pages.humanLogin.useThisServer" })}: ${server.name}`,
                          title: rowTitle,
                        }}
                      />
                    );
                  })}
                    {filteredMarketplaceServerRows.length === 0 && (
                      <div className="px-3 py-6 text-center text-sm font-bold text-black/55">
                        {formatMessage({ id: "pages.humanLogin.noServerSearchResults" })}
                      </div>
                    )}
                    </div>
                  </div>
                </div>
              ) : availableServerClients.length > 0 ? (
                <Select
                  value={selectedServerId}
                  onValueChange={(value) => {
                    if (value == null) return;
                    setSelectedServerId(value);
                  }}
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
                <div className="border-2 border-black bg-white px-3 py-2 text-sm font-bold shadow-brutal-sm">
                  {formatMessage({ id: "pages.humanLogin.noAvailableServers" })}
                </div>
              )}
            </div>
            <p className="mt-1 text-xs leading-5 text-black/60">
              {formatMessage({ id: isMarketplaceApp
                ? "pages.humanLogin.marketplaceServerHelp"
                : "pages.humanLogin.serverHelp" })}
            </p>
          </div>

          <RequestedScopeConsent scopes={scopes} />

          {hasDisallowedScopes ? (
            <div
              role="alert"
              data-testid="oauth-scope-configuration-error"
              className="mt-4 border-2 border-black bg-brutal-pink/20 p-4 shadow-brutal-sm"
            >
              <div className="text-sm font-black">
                {formatMessage({ id: scopeValidationReason === "unsupported"
                  ? "pages.humanLogin.unsupportedScopeTitle"
                  : scopeValidationReason === "mixed"
                    ? "pages.humanLogin.invalidScopeTitle"
                    : "pages.humanLogin.scopeConfigurationTitle" })}
              </div>
              <p className="mt-1 text-sm leading-6 text-black/75">
                {formatMessage(
                  { id: scopeValidationReason === "unsupported"
                    ? "pages.humanLogin.unsupportedScopeBody"
                    : scopeValidationReason === "mixed"
                      ? "pages.humanLogin.invalidScopeBody"
                      : "pages.humanLogin.scopeConfigurationBody" },
                  { appName: serviceName, scopes: disallowedScopes.join(", ") },
                )}
              </p>
            </div>
          ) : null}

          {isMarketplaceApp ? (
            <div
              className="mt-6 border-2 border-black bg-brutal-cream p-4"
              data-testid="marketplace-login-commit-zone"
              aria-busy={!!installingServerId}
            >
              {selectedMarketplaceInstalled && selectedMarketplaceRow ? (
                <p className="text-sm leading-6 text-black/80">
                  {formatMessage(
                    { id: "pages.humanLogin.selectedServerCommit" },
                    { serverName: selectedMarketplaceRow.server.name, b: (chunks) => <strong key="server">{chunks}</strong> },
                  )}
                </p>
              ) : selectedMarketplaceCanInstall && selectedMarketplaceEntry && selectedMarketplaceRow ? (
                <>
                  <p className="text-sm leading-6 text-black/80">
                    {formatMessage(
                      { id: "pages.humanLogin.installCommitBody" },
                      {
                        serverName: selectedMarketplaceRow.server.name,
                        appName: selectedMarketplaceEntry.client.name,
                        b: (chunks) => <strong key="server">{chunks}</strong>,
                      },
                    )}
                  </p>
                  <p className="mt-2 font-mono text-xs text-black/55">
                    {formatMessage({ id: "pages.humanLogin.installCommitScopes" }, { scopes: scopeSummary })}
                  </p>
                </>
              ) : selectedMarketplaceNeedsAdmin && selectedMarketplaceEntry && selectedMarketplaceRow ? (
                <p className="text-sm leading-6 text-black/80">
                  {formatMessage(
                    { id: "pages.humanLogin.adminCommitBody" },
                    {
                      serverName: selectedMarketplaceRow.server.name,
                      appName: selectedMarketplaceEntry.client.name,
                      b: (chunks) => <strong key="server">{chunks}</strong>,
                    },
                  )}
                </p>
              ) : (
                <p className="text-sm leading-6 text-black/80">
                  {formatMessage({ id: "pages.humanLogin.serverStatusUnavailable" })}
                </p>
              )}

              {!selectedMarketplaceNeedsAdmin ? (
                <Button
                  disabled={selectedMarketplaceCanInstall ? !canInstallAndContinue : !canContinue}
                  onClick={() => {
                    if (selectedMarketplaceCanInstall && selectedMarketplaceEntry) {
                      void installMarketplaceApp(selectedMarketplaceEntry);
                      return;
                    }
                    void continueToApp();
                  }}
                  size="lg"
                  tone="pink"
                  className="mt-4 w-full font-black disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {installingServerId ? (
                    <Spinner
                      size="sm"
                      aria-hidden="true"
                      className="mr-2"
                      data-testid="marketplace-install-pending-button-spinner"
                    />
                  ) : null}
                  {selectedMarketplaceCanInstall
                    ? installingServerId
                      ? formatMessage({ id: "pages.humanLogin.installingAndContinuing" })
                      : formatMessage({ id: "pages.humanLogin.installAndContinue" })
                    : submitting
                      ? formatMessage({ id: "pages.humanLogin.continuing" })
                      : formatMessage({ id: "pages.humanLogin.continueLogin" })}
                </Button>
              ) : null}

              {selectedMarketplaceNeedsAdmin && selectedMarketplaceRow ? (
                <a
                  href={`/s/${encodeURIComponent(selectedMarketplaceRow.server.slug)}/members`}
                  className="btn-brutal-sm mt-3 flex w-full items-center justify-center bg-white px-4 py-2 text-center no-underline shadow-brutal-sm"
                >
                  {formatMessage({ id: "pages.humanLogin.findServerAdmin" })}
                </a>
              ) : null}
            </div>
          ) : (
            <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
              <Button
                disabled={!canContinue}
                onClick={continueToApp}
                size="lg"
                tone="pink"
                className="font-black disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? formatMessage({ id: "pages.humanLogin.continuing" }) : formatMessage({ id: "pages.humanLogin.loginWithRaft" })}
              </Button>
            </div>
          )}

          {status && <pre className="mt-4 min-h-16 overflow-auto bg-black p-3 text-xs text-white">{status}</pre>}
        </section>

        <aside className="border-2 border-black bg-white p-5 shadow-brutal-sm">
          <h2 className="mb-4 text-xl font-black">{formatMessage({ id: "pages.humanLogin.faqTitle" })}</h2>
          <div className="space-y-5 text-sm leading-6 text-black/70">
            <section>
              <h3 className="font-black text-black">{formatMessage({ id: "pages.humanLogin.faqWhatTitle" })}</h3>
              <p>
                {formatMessage({ id: "pages.humanLogin.faqWhatBody" })}
              </p>
            </section>
            <section>
              <h3 className="font-black text-black">{formatMessage({ id: "pages.humanLogin.faqRegisterTitle" })}</h3>
              <p>
                {formatMessage({ id: "pages.humanLogin.faqRegisterBody" })}
              </p>
            </section>
            <section>
              <h3 className="font-black text-black">{formatMessage({ id: "pages.humanLogin.faqAgentTitle" })}</h3>
              <p>
                {formatMessage({ id: "pages.humanLogin.faqAgentBody" })}
              </p>
            </section>
          </div>
        </aside>
      </main>
      )}
    </div>
  );
}

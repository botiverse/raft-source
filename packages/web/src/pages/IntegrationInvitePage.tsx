import { useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { useNavigate, useParams } from "react-router-dom";
import { Check, ExternalLink, Link2 } from "lucide-react";
import {
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
import Banner from "../components/ui/Banner";
import Button from "../components/ui/Button";
import RequestedScopeConsent from "../components/oauth/RequestedScopeConsent";
import SectionEyebrow from "../components/ui/SectionEyebrow";
import { DEFAULT_DECLARED_OAUTH_SCOPES } from "../lib/oauthScopePresentation";

type OAuthClientShareInvite = {
  client: {
    id: string;
    clientId: string;
    name: string;
    description: string | null;
    homepageUrl: string | null;
    returnUrl: string | null;
    allowedScopes: string[] | null;
    logoUrl: string | null;
    publisherName: string | null;
    sourceServerName: string | null;
    installedAt: string | null;
  };
  link: {
    id: string;
    expiresAt: string | null;
  };
  manageableServers: Array<{
    id: string;
    name: string;
    slug: string;
    role: string;
    installedAt: string | null;
  }>;
};

type SelectOption = {
  value: string;
  label: string;
};

function renderSelectItems(options: readonly SelectOption[]) {
  return options.map((option) => (
    <SelectItem key={option.value} value={option.value}>
      <SelectItemText>{option.label}</SelectItemText>
      <SelectItemIndicator />
    </SelectItem>
  ));
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

  const loadInvite = async () => {
    setLoading(true);
    setError("");
    try {
      const { data } = await api.get(`/integration-invites/${encodeURIComponent(token)}`);
      setInvite(data);
      const firstUninstalled = data.manageableServers.find((server: OAuthClientShareInvite["manageableServers"][number]) => !server.installedAt);
      setSelectedServerId(firstUninstalled?.id ?? data.manageableServers[0]?.id ?? "");
      setInstalled(!!data.client.installedAt);
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "pages.integrationInvite.inviteNotFound" }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadInvite();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const selectedServer = invite?.manageableServers.find((server) => server.id === selectedServerId) ?? null;
  const manageableServerOptions = invite?.manageableServers.map((server) => ({
    value: server.id,
    label: `${server.name}${server.installedAt ? formatMessage({ id: "pages.integrationInvite.installedSuffix" }) : ""}`,
  })) ?? [];

  const install = async () => {
    if (!selectedServerId) return;
    setInstalling(true);
    setError("");
    try {
      const { data } = await api.post(`/integration-invites/${encodeURIComponent(token)}/install`, {
        serverId: selectedServerId,
      });
      setInvite(data);
      setInstalled(true);
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "pages.integrationInvite.installFailed" }));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div
      className="h-full min-h-0 overflow-y-auto bg-brutal-cream font-display text-black safe-top safe-bottom"
      data-testid="integration-invite-page"
    >
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center px-4 py-8">
        <div className="border-2 border-black bg-white p-5 shadow-brutal">
          <div className="flex items-start justify-between gap-4 border-b-2 border-black pb-4">
            <div>
              <SectionEyebrow as="div">{formatMessage({ id: "pages.integrationInvite.eyebrow" })}</SectionEyebrow>
              <h1 className="mt-2 text-2xl font-black">{formatMessage({ id: "pages.integrationInvite.title" })}</h1>
            </div>
            <div className="flex size-12 items-center justify-center border-2 border-black bg-brutal-cyan shadow-brutal-sm">
              <Link2 size={22} />
            </div>
          </div>

          {loading ? (
            <div className="py-12 text-center text-sm font-bold text-black/55">{formatMessage({ id: "pages.integrationInvite.loading" })}</div>
          ) : error && !invite ? (
            <Banner intent="warning" className="mt-4 font-bold">{error}</Banner>
          ) : invite ? (
            <div className="space-y-4 pt-4">
              {error && <Banner intent="warning" className="font-bold">{error}</Banner>}
              {installed && (
                <Banner intent="success" className="font-bold">
                  {invite.client.name} {formatMessage({ id: "pages.integrationInvite.installedBannerMid" })} {selectedServer?.name ?? formatMessage({ id: "pages.integrationInvite.installedBannerFallbackServer" })}.
                </Banner>
              )}

              <div className="border-2 border-black bg-brutal-cream p-4">
                <div className="text-xl font-black">{invite.client.name}</div>
                <div className="mt-1 text-xs font-bold text-black/55">
                  {formatMessage({ id: "pages.integrationInvite.sharedByPrefix" })} {invite.client.publisherName ?? formatMessage({ id: "pages.integrationInvite.sharedByPublisherFallback" })} {formatMessage({ id: "pages.integrationInvite.sharedByServerMid" })} {invite.client.sourceServerName ?? formatMessage({ id: "pages.integrationInvite.sharedByServerFallback" })}
                </div>
                {invite.client.description && (
                  <p className="mt-3 text-sm leading-relaxed text-black/70">{invite.client.description}</p>
                )}
                <div className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
                  <div>
                    <div className="font-bold text-black/45">{formatMessage({ id: "pages.integrationInvite.clientIdLabel" })}</div>
                    <div className="break-all font-mono font-bold">{invite.client.clientId}</div>
                  </div>
                  <div>
                    <div className="font-bold text-black/45">{formatMessage({ id: "pages.integrationInvite.homepageLabel" })}</div>
                    <div className="break-all font-mono font-bold">{getDomain(invite.client.homepageUrl, formatMessage({ id: "pages.integrationInvite.notConfigured" }))}</div>
                  </div>
                  <div>
                    <div className="font-bold text-black/45">{formatMessage({ id: "pages.integrationInvite.callbackLabel" })}</div>
                    <div className="break-all font-mono font-bold">{getDomain(invite.client.returnUrl, formatMessage({ id: "pages.integrationInvite.notConfigured" }))}</div>
                  </div>
                  <div>
                    <div className="font-bold text-black/45">{formatMessage({ id: "pages.integrationInvite.inviteExpiryLabel" })}</div>
                    <div className="font-bold">{invite.link.expiresAt ? formatDate(invite.link.expiresAt) : formatMessage({ id: "pages.integrationInvite.noExpiry" })}</div>
                  </div>
                </div>
              </div>

              <RequestedScopeConsent
                scopes={invite.client.allowedScopes?.length ? invite.client.allowedScopes : DEFAULT_DECLARED_OAUTH_SCOPES}
                className="border-2 border-black bg-brutal-cream p-4"
              />

              {invite.manageableServers.length === 0 ? (
                <Banner intent="warning" className="font-bold">
                  {formatMessage({ id: "pages.integrationInvite.needAdmin" })}
                </Banner>
              ) : (
                <div className="border-2 border-black bg-white p-4 shadow-brutal-sm">
                  <SectionEyebrow as="div">{formatMessage({ id: "pages.integrationInvite.installTargetLabel" })}</SectionEyebrow>
                  <div className="mt-3 grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
                    <div className="min-w-0">
                      <Select
                        value={selectedServerId}
                        onValueChange={(value) => {
                          if (value == null) return;
                          setSelectedServerId(value);
                        }}
                        items={manageableServerOptions}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder={formatMessage({ id: "pages.integrationInvite.installTargetLabel" })} />
                          <SelectIcon />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectList>{renderSelectItems(manageableServerOptions)}</SelectList>
                        </SelectContent>
                      </Select>
                    </div>
                    {selectedServer?.installedAt ? (
                      <Button type="button" onClick={() => navigate(`/s/${selectedServer.slug}/settings`)} size="lg" shape="iconText" className="w-full md:w-auto">
                        <ExternalLink size={14} />
                        {formatMessage({ id: "pages.integrationInvite.openSettings" })}
                      </Button>
                    ) : (
                      <Button type="button" onClick={() => void install()} disabled={installing || !selectedServerId} size="lg" tone="pink" shape="iconText" className="w-full md:w-auto">
                        <Check size={14} />
                        {installing ? formatMessage({ id: "pages.integrationInvite.installing" }) : formatMessage({ id: "pages.integrationInvite.installApp" })}
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

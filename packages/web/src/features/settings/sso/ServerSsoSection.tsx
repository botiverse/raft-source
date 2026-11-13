import { ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useIntl } from "react-intl";
import Banner from "../../../components/ui/Banner";
import SectionHeader from "../../../components/ui/SectionHeader";
import { useServerStore } from "../../../store/serverStore";
import { getServerSso } from "./ssoApi";
import type { ServerSsoSettings, SsoConnectionView, SsoDomainView } from "./ssoApi";
import { SsoConnectionCard } from "./SsoConnectionCard";
import { SsoDomainsCard } from "./SsoDomainsCard";
import { SsoRulesCard } from "./SsoRulesCard";
import { readSsoTestResult } from "./ssoTestResult";
import type { SsoTestResult } from "./ssoTestResult";

/**
 * Settings › Administration › Single sign-on (rfcs/083-server-sso.md): the
 * Server's identity provider, its verified email domains and the rules. It
 * renders only when GET /servers/:id/sso answers (404 while `server_sso_v1`
 * is off for the Server, 403 for a member who is not an admin: nothing), and
 * shows the owner's test sign-in outcome once when the IdP round-trip lands
 * here with `?sso_test=`.
 */
export function ServerSsoSection() {
  const { formatMessage } = useIntl();
  const current = useServerStore((s) => s.current);
  const serverId = current?.id;
  const serverName = current?.name ?? "";
  const [settings, setSettings] = useState<ServerSsoSettings | null>(null);
  // Read once on mount: the address loses the parameters as they are read.
  const [testResult, setTestResult] = useState<SsoTestResult | null>(readSsoTestResult);

  // Load only when the active server id changes.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    if (!serverId) return;
    let cancelled = false;
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setSettings(null);
    getServerSso(serverId).then((next) => {
      if (!cancelled) setSettings(next);
    }, () => {
      // Nothing to show: the section stays hidden.
    });
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  const handleConnectionChange = useCallback((connection: SsoConnectionView | null) => {
    setSettings((prev) => (prev ? { ...prev, connection } : prev));
  }, []);
  const handleDomainsChange = useCallback((update: (domains: SsoDomainView[]) => SsoDomainView[]) => {
    setSettings((prev) => (prev ? { ...prev, domains: update(prev.domains) } : prev));
  }, []);
  const handleDismissTestResult = useCallback(() => setTestResult(null), []);

  if (!serverId || !settings) return null;
  const { connection, domains, canManageConnection, canManageDomains } = settings;
  const shownTestResult = testResult?.serverId === serverId ? testResult : null;

  return (
    <div id="single-sign-on" className="mb-6" data-testid="server-sso-section">
      <SectionHeader
        className="mb-3"
        icon={<ShieldCheck size={16} />}
        label={formatMessage({ id: "settings.sso.sectionLabel" })}
      />

      <div className="stack-y-4">
        {shownTestResult && (
          <Banner
            intent={shownTestResult.outcome === "ok" ? "success" : "warning"}
            density="sm"
            withIcon
            title={shownTestResult.outcome === "ok"
              ? formatMessage({ id: "settings.sso.testOkTitle" })
              : formatMessage({ id: "settings.sso.testFailedTitle" })}
            onClose={handleDismissTestResult}
            closeLabel={formatMessage({ id: "settings.sso.dismiss" })}
            data-testid={`sso-test-result-${shownTestResult.outcome}`}
          >
            {shownTestResult.outcome === "ok"
              ? formatMessage({ id: "settings.sso.testOkMessage" })
              : formatMessage({ id: "settings.sso.testFailedMessage" })}
          </Banner>
        )}

        <SsoConnectionCard
          // A new form when the connection is created or deleted.
          key={`connection-${connection?.id ?? "new"}`}
          serverId={serverId}
          connection={connection}
          canManage={canManageConnection}
          secretStoreConfigured={settings.secretStoreConfigured}
          defaultDisplayName={serverName}
          onConnectionChange={handleConnectionChange}
        />

        <SsoDomainsCard
          serverId={serverId}
          domains={domains}
          canManage={canManageDomains}
          onDomainsChange={handleDomainsChange}
        />

        {connection && (
          <SsoRulesCard
            key={`rules-${connection.id}`}
            serverId={serverId}
            connection={connection}
            canManage={canManageConnection}
            requireReviewed={settings.requireReviewed !== false}
            onConnectionChange={handleConnectionChange}
          />
        )}
      </div>
    </div>
  );
}

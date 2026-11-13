import { Button, Card, Input } from "@botiverse/raft-ui";
import { Plus } from "lucide-react";
import { useCallback, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { useIntl } from "react-intl";
import ConfirmDialog from "../../../components/ConfirmDialog";
import Banner from "../../../components/ui/Banner";
import FormField from "../../../components/ui/FormField";
import { addSsoDomain, removeSsoDomain, ssoErrorMessage, verifySsoDomain } from "./ssoApi";
import type { SsoDomainView } from "./ssoApi";
import { SsoDomainRow } from "./SsoDomainRow";

/**
 * The company's email domains, each proven by a DNS TXT record (RFC 083
 * §5.3, §5.5). Owners and admins add, check and remove them; only people on
 * a verified domain are linked, created or auto-joined by SSO.
 */
export function SsoDomainsCard({ serverId, domains, canManage, onDomainsChange }: {
  serverId: string;
  domains: SsoDomainView[];
  canManage: boolean;
  onDomainsChange: (update: (domains: SsoDomainView[]) => SsoDomainView[]) => void;
}) {
  const { formatMessage } = useIntl();
  const [newDomain, setNewDomain] = useState("");
  const [adding, setAdding] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<SsoDomainView | null>(null);
  const [error, setError] = useState("");

  const handleNewDomainChange = useCallback((event: ChangeEvent<HTMLInputElement>) => setNewDomain(event.target.value), []);

  const handleAdd = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    const domain = newDomain.trim();
    if (!domain) return;
    setAdding(true);
    setError("");
    try {
      const added = await addSsoDomain(serverId, domain);
      // Adding a domain the Server already has answers that row.
      onDomainsChange((current) => [...current.filter((row) => row.id !== added.id), added]);
      setNewDomain("");
    } catch (err) {
      setError(ssoErrorMessage(err, formatMessage({ id: "settings.sso.failedAddDomain" })));
    } finally {
      setAdding(false);
    }
  }, [formatMessage, newDomain, onDomainsChange, serverId]);

  const handleVerify = useCallback(async (domain: SsoDomainView) => {
    setVerifyingId(domain.id);
    setError("");
    try {
      const checked = await verifySsoDomain(serverId, domain.id);
      onDomainsChange((current) => current.map((row) => (row.id === checked.id ? checked : row)));
    } catch (err) {
      setError(ssoErrorMessage(err, formatMessage({ id: "settings.sso.failedVerifyDomain" })));
    } finally {
      setVerifyingId(null);
    }
  }, [formatMessage, onDomainsChange, serverId]);

  const handleCloseRemove = useCallback(() => setRemoveTarget(null), []);
  const handleConfirmRemove = useCallback(async () => {
    if (!removeTarget) return;
    setError("");
    try {
      await removeSsoDomain(serverId, removeTarget.id);
      onDomainsChange((current) => current.filter((row) => row.id !== removeTarget.id));
    } catch (err) {
      setError(ssoErrorMessage(err, formatMessage({ id: "settings.sso.failedRemoveDomain" })));
    }
  }, [formatMessage, onDomainsChange, removeTarget, serverId]);

  return (
    <Card className="stack-y-4 p-4" data-testid="sso-domains">
      <h3 className="text-subhead font-semibold text-foreground">
        {formatMessage({ id: "settings.sso.domainsTitle" })}
      </h3>

      {domains.length > 0 ? (
        <div className="rule-y rule-line-hairline">
          {domains.map((domain) => (
            <SsoDomainRow
              key={domain.id}
              domain={domain}
              verifying={verifyingId === domain.id}
              canManage={canManage}
              onVerify={handleVerify}
              onRequestRemove={setRemoveTarget}
            />
          ))}
        </div>
      ) : (
        <p className="text-footnote text-foreground-hint">{formatMessage({ id: "settings.sso.domainsEmpty" })}</p>
      )}

      <div className="stack-y-1 text-caption text-foreground-hint">
        <p>{formatMessage({ id: "settings.sso.domainsLapseNote" })}</p>
        <p>{formatMessage({ id: "settings.sso.domainsReassignNote" })}</p>
      </div>

      {canManage && (
        <form onSubmit={handleAdd} className="flex flex-wrap items-end gap-2">
          <FormField
            label={formatMessage({ id: "settings.sso.addDomainLabel" })}
            size="compact"
            htmlFor="sso-add-domain"
            className="min-w-0 flex-1"
          >
            <Input
              id="sso-add-domain"
              value={newDomain}
              onChange={handleNewDomainChange}
              placeholder={formatMessage({ id: "settings.sso.addDomainPlaceholder" })}
              autoComplete="off"
              className="w-full"
            />
          </FormField>
          <Button
            variant="outline" size="lg"
            type="submit"
            disabled={!newDomain.trim()}
            loading={adding}
            loadingLabel={formatMessage({ id: "settings.sso.addingDomain" })}
            data-testid="sso-add-domain-submit"
          >
            <Plus size={14} />
            {formatMessage({ id: "settings.sso.addDomain" })}
          </Button>
        </form>
      )}

      {error && (
        <Banner intent="warning" density="sm">
          {error}
        </Banner>
      )}

      {removeTarget && (
        <ConfirmDialog
          chromeLocale="active"
          title={formatMessage({ id: "settings.sso.removeDomainTitle" })}
          message={formatMessage({ id: "settings.sso.removeDomainMessage" }, { domain: removeTarget.domain })}
          confirmLabel={formatMessage({ id: "settings.sso.domainRemove" })}
          loadingLabel={formatMessage({ id: "settings.sso.removingDomain" })}
          confirmVariant="danger"
          onConfirm={handleConfirmRemove}
          onClose={handleCloseRemove}
        />
      )}
    </Card>
  );
}

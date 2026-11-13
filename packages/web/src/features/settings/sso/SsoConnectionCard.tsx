import {
  Badge,
  Button,
  Card,
  Input,
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlLabel,
} from "@botiverse/raft-ui";
import { useCallback, useState } from "react";
import type { ChangeEvent } from "react";
import { useIntl } from "react-intl";
import ConfirmDialog from "../../../components/ConfirmDialog";
import Banner from "../../../components/ui/Banner";
import FormField from "../../../components/ui/FormField";
import { useTimeFormatter } from "../../../hooks/useTimeFormatter";
import type { MessageId } from "../../../i18n/messages";
import { deleteSsoConnection, saveSsoConnection, ssoErrorMessage, startSsoTest } from "./ssoApi";
import type { SsoCertificateView, SsoConnectionStatus, SsoConnectionView, SsoProtocol } from "./ssoApi";
import {
  editedSsoConfig,
  sameSsoConnectionForm,
  ssoConnectionFormComplete,
  ssoConnectionFormFrom,
  ssoConnectionInputFrom,
} from "./ssoConnectionForm";
import type { SsoConnectionForm } from "./ssoConnectionForm";
import { SsoOidcFields } from "./SsoOidcFields";
import { SsoSamlFields } from "./SsoSamlFields";
import { SsoServiceProviderDetails } from "./SsoServiceProviderDetails";

const NO_CERTIFICATES: SsoCertificateView[] = [];

const STATUS_BADGE: Record<SsoConnectionStatus, { variant: "muted" | "success" | "warning"; label: MessageId }> = {
  draft: { variant: "muted", label: "settings.sso.statusDraft" },
  active: { variant: "success", label: "settings.sso.statusActive" },
  disabled: { variant: "warning", label: "settings.sso.statusDisabled" },
};

/**
 * The Server's identity provider (RFC 083 §4): OIDC or SAML. The owner edits
 * it; admins see it read-only. A saved edit of an active connection waits as
 * its draft and goes live only after a successful test sign-in, which also
 * activates a new connection.
 */
export function SsoConnectionCard({
  serverId,
  connection,
  canManage,
  secretStoreConfigured,
  defaultDisplayName,
  onConnectionChange,
}: {
  serverId: string;
  connection: SsoConnectionView | null;
  /** The owner: may save, test and delete. */
  canManage: boolean;
  /** Without the deployment's secret key an OIDC connection cannot be saved. */
  secretStoreConfigured: boolean;
  /** What the sign-in page shows when nothing is saved yet: the Server's name. */
  defaultDisplayName: string;
  onConnectionChange: (connection: SsoConnectionView | null) => void;
}) {
  const { formatMessage } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  const [saved, setSaved] = useState(() => ssoConnectionFormFrom(connection, defaultDisplayName));
  const [form, setForm] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const disabled = !canManage || saving;
  const dirty = !sameSsoConnectionForm(form, saved);
  const complete = ssoConnectionFormComplete(form);
  const hasClientSecret = connection
    ? connection.hasClientSecret || connection.draft?.replacesClientSecret === true
    : false;
  const savedConfig = connection ? editedSsoConfig(connection) : null;
  const pendingDraft = connection?.status === "active" && connection.draft !== null;
  // An OIDC connection needs its secret before a test sign-in can work.
  const testable = connection !== null && !dirty
    && (savedConfig?.protocol !== "oidc" || hasClientSecret);

  const handleChange = useCallback((patch: Partial<SsoConnectionForm>) => {
    setForm((current) => ({ ...current, ...patch }));
  }, []);
  const handleProtocolChange = useCallback((protocol: SsoProtocol) => handleChange({ protocol }), [handleChange]);
  const handleDisplayNameChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => handleChange({ displayName: event.target.value }),
    [handleChange],
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError("");
    try {
      const next = await saveSsoConnection(serverId, ssoConnectionInputFrom(form));
      const nextForm = ssoConnectionFormFrom(next, defaultDisplayName);
      setSaved(nextForm);
      setForm(nextForm);
      onConnectionChange(next);
    } catch (err) {
      setError(ssoErrorMessage(err, formatMessage({ id: "settings.sso.failedSave" })));
    } finally {
      setSaving(false);
    }
  }, [defaultDisplayName, form, formatMessage, onConnectionChange, serverId]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setError("");
    try {
      window.location.assign(await startSsoTest(serverId));
    } catch (err) {
      setError(ssoErrorMessage(err, formatMessage({ id: "settings.sso.failedTest" })));
      setTesting(false);
    }
  }, [formatMessage, serverId]);

  const handleRequestDelete = useCallback(() => setConfirmingDelete(true), []);
  const handleCloseDelete = useCallback(() => setConfirmingDelete(false), []);
  const handleConfirmDelete = useCallback(async () => {
    setError("");
    try {
      await deleteSsoConnection(serverId);
      const empty = ssoConnectionFormFrom(null, defaultDisplayName);
      setSaved(empty);
      setForm(empty);
      onConnectionChange(null);
    } catch (err) {
      setError(ssoErrorMessage(err, formatMessage({ id: "settings.sso.failedDelete" })));
    }
  }, [defaultDisplayName, formatMessage, onConnectionChange, serverId]);

  return (
    <Card className="stack-y-4 p-4" data-testid="sso-connection">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-subhead font-semibold text-foreground">
            {formatMessage({ id: "settings.sso.connectionTitle" })}
          </h3>
          {/* Who may change it, for one who can't; no describing sentence for one who can (HelperText step 1). */}
          {canManage ? null : (
            <p className="mt-1 text-footnote text-foreground-muted">
              {formatMessage({ id: "settings.sso.connectionOwnerOnly" })}
            </p>
          )}
        </div>
        {connection && (
          <Badge appearance="soft" variant={STATUS_BADGE[connection.status].variant} data-testid="sso-connection-status">
            {formatMessage({ id: STATUS_BADGE[connection.status].label })}
          </Badge>
        )}
      </div>

      {pendingDraft && (
        <Banner intent="info" density="sm" live={false} data-testid="sso-pending-draft">
          {formatMessage({ id: "settings.sso.pendingDraft" })}
        </Banner>
      )}
      {connection?.status === "draft" && (
        <Banner intent="info" density="sm" live={false}>
          {formatMessage({ id: "settings.sso.draftNeedsTest" })}
        </Banner>
      )}
      {canManage && !secretStoreConfigured && form.protocol === "oidc" && (
        <Banner intent="warning" density="sm" live={false}>
          {formatMessage({ id: "settings.sso.secretStoreMissing" })}
        </Banner>
      )}

      <FormField label={formatMessage({ id: "settings.sso.protocol" })} size="compact">
        <SegmentedControl
          value={form.protocol}
          onValueChange={handleProtocolChange}
          disabled={disabled}
          aria-label={formatMessage({ id: "settings.sso.protocol" })}
        >
          <SegmentedControlItem value="oidc" data-testid="sso-protocol-oidc">
            <SegmentedControlLabel>{formatMessage({ id: "settings.sso.protocolOidc" })}</SegmentedControlLabel>
          </SegmentedControlItem>
          <SegmentedControlItem value="saml" data-testid="sso-protocol-saml">
            <SegmentedControlLabel>{formatMessage({ id: "settings.sso.protocolSaml" })}</SegmentedControlLabel>
          </SegmentedControlItem>
        </SegmentedControl>
      </FormField>

      <FormField
        label={formatMessage({ id: "settings.sso.displayName" })}
        size="compact"
        htmlFor="sso-display-name"
      >
        <Input
          id="sso-display-name"
          value={form.displayName}
          onChange={handleDisplayNameChange}
          disabled={disabled}
          maxLength={80}
          className="w-full"
        />
      </FormField>

      {form.protocol === "oidc" ? (
        <SsoOidcFields
          form={form}
          disabled={disabled}
          hasClientSecret={hasClientSecret && savedConfig?.protocol === "oidc"}
          onChange={handleChange}
        />
      ) : (
        <SsoSamlFields
          form={form}
          disabled={disabled}
          savedCertificates={savedConfig?.protocol === "saml" ? savedConfig.idpCertificates : NO_CERTIFICATES}
          onChange={handleChange}
        />
      )}

      {connection ? (
        <SsoServiceProviderDetails protocol={form.protocol} details={connection.serviceProvider} />
      ) : (
        <p className="text-footnote text-foreground-hint">{formatMessage({ id: "settings.sso.spAfterSave" })}</p>
      )}

      {error && (
        <Banner intent="warning" density="sm">
          {error}
        </Banner>
      )}

      {connection?.lastTestedAt && (
        <p className="text-caption text-foreground-hint">
          {formatMessage({ id: "settings.sso.lastTested" }, { when: formatShortDateTime(connection.lastTestedAt) })}
        </p>
      )}

      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="accent" size="md"
            type="button"
            onClick={handleSave}
            disabled={!dirty || !complete}
            loading={saving}
            loadingLabel={formatMessage({ id: "settings.common.saving" })}
            data-testid="sso-connection-save"
          >
            {formatMessage({ id: "settings.common.save" })}
          </Button>
          {connection && (
            <Button
              variant="outline" size="md"
              type="button"
              onClick={handleTest}
              disabled={!testable}
              loading={testing}
              loadingLabel={formatMessage({ id: "settings.sso.testing" })}
              data-testid="sso-connection-test"
            >
              {formatMessage({ id: "settings.sso.testSignIn" })}
            </Button>
          )}
          {connection && (
            <Button
              variant="danger-outline" size="md"
              type="button"
              onClick={handleRequestDelete}
              data-testid="sso-connection-delete"
            >
              {formatMessage({ id: "settings.sso.deleteConnection" })}
            </Button>
          )}
          {connection && dirty && (
            <span className="text-caption text-foreground-hint">{formatMessage({ id: "settings.sso.saveBeforeTest" })}</span>
          )}
        </div>
      )}

      {confirmingDelete && (
        <ConfirmDialog
          chromeLocale="active"
          title={formatMessage({ id: "settings.sso.deleteConfirmTitle" })}
          message={formatMessage({ id: "settings.sso.deleteConfirmMessage" })}
          confirmLabel={formatMessage({ id: "settings.sso.deleteConnection" })}
          loadingLabel={formatMessage({ id: "settings.sso.deleting" })}
          confirmVariant="danger"
          onConfirm={handleConfirmDelete}
          onClose={handleCloseDelete}
        />
      )}
    </Card>
  );
}

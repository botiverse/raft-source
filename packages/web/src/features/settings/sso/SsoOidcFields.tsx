import { Input } from "@botiverse/raft-ui";
import { useCallback } from "react";
import type { ChangeEvent } from "react";
import { useIntl } from "react-intl";
import Banner from "../../../components/ui/Banner";
import FormField from "../../../components/ui/FormField";
import { isEntraIssuer } from "./ssoConnectionForm";
import type { SsoConnectionForm } from "./ssoConnectionForm";

/**
 * The OIDC connection's fields. The client secret is write-only: the page
 * only knows whether one is stored, and an empty field keeps it.
 */
export function SsoOidcFields({ form, disabled, hasClientSecret, onChange }: {
  form: SsoConnectionForm;
  disabled: boolean;
  /** A secret is stored (or waits in the draft) for this connection. */
  hasClientSecret: boolean;
  onChange: (patch: Partial<SsoConnectionForm>) => void;
}) {
  const { formatMessage } = useIntl();
  const handleIssuerChange = useCallback((event: ChangeEvent<HTMLInputElement>) => onChange({ issuer: event.target.value }), [onChange]);
  const handleClientIdChange = useCallback((event: ChangeEvent<HTMLInputElement>) => onChange({ clientId: event.target.value }), [onChange]);
  const handleClientSecretChange = useCallback((event: ChangeEvent<HTMLInputElement>) => onChange({ clientSecret: event.target.value }), [onChange]);

  return (
    <>
      <FormField
        label={formatMessage({ id: "settings.sso.oidcIssuer" })}
        size="compact"
        htmlFor="sso-oidc-issuer"
      >
        <Input
          id="sso-oidc-issuer"
          type="url"
          // The issuer's shape as an example in the field itself, not a hint line under it (HelperText step 1);
          // a technical URL, the same in every locale.
          placeholder="https://acme.okta.com"
          value={form.issuer}
          onChange={handleIssuerChange}
          disabled={disabled}
          className="w-full"
        />
      </FormField>

      {isEntraIssuer(form.issuer) && (
        <Banner intent="info" density="sm" live={false} title={formatMessage({ id: "settings.sso.entraTitle" })} data-testid="sso-entra-guide">
          <ul className="list-disc stack-y-1 pl-4">
            <li>{formatMessage({ id: "settings.sso.entraTenantIssuer" })}</li>
            <li>{formatMessage({ id: "settings.sso.entraOptionalClaim" })}</li>
          </ul>
        </Banner>
      )}

      <FormField label={formatMessage({ id: "settings.sso.oidcClientId" })} size="compact" htmlFor="sso-oidc-client-id">
        <Input
          id="sso-oidc-client-id"
          value={form.clientId}
          onChange={handleClientIdChange}
          disabled={disabled}
          autoComplete="off"
          className="w-full"
        />
      </FormField>

      <FormField
        label={formatMessage({ id: "settings.sso.oidcClientSecret" })}
        hint={hasClientSecret
          ? formatMessage({ id: "settings.sso.oidcClientSecretStored" })
          : formatMessage({ id: "settings.sso.oidcClientSecretMissing" })}
        size="compact"
        htmlFor="sso-oidc-client-secret"
      >
        <Input
          id="sso-oidc-client-secret"
          type="password"
          value={form.clientSecret}
          onChange={handleClientSecretChange}
          disabled={disabled}
          autoComplete="new-password"
          placeholder={hasClientSecret ? formatMessage({ id: "settings.sso.oidcClientSecretStoredPlaceholder" }) : undefined}
          className="w-full"
          data-testid="sso-oidc-client-secret"
        />
      </FormField>
    </>
  );
}

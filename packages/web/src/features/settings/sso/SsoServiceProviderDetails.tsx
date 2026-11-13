import { useIntl } from "react-intl";
import type { SsoProtocol, SsoServiceProviderDetails as Details } from "./ssoApi";
import { SsoCopyValue } from "./SsoCopyValue";

/** What the identity provider's admin enters on their side for this connection (RFC 083 §5.1). */
export function SsoServiceProviderDetails({ protocol, details }: { protocol: SsoProtocol; details: Details }) {
  const { formatMessage } = useIntl();
  return (
    <div className="stack-y-3 rounded-container border border-line-hairline bg-layer-canvas p-3" data-testid="sso-service-provider">
      {/* The heading says what these are for; no sentence restating it (HelperText step 1). */}
      <h4 className="text-subhead font-semibold text-foreground">
        {formatMessage({ id: "settings.sso.spTitle" })}
      </h4>
      {protocol === "oidc" ? (
        <SsoCopyValue label={formatMessage({ id: "settings.sso.spRedirectUri" })} value={details.oidcRedirectUri} testId="sso-sp-redirect-uri" />
      ) : (
        <>
          <SsoCopyValue label={formatMessage({ id: "settings.sso.spEntityId" })} value={details.samlEntityId} testId="sso-sp-entity-id" />
          <SsoCopyValue label={formatMessage({ id: "settings.sso.spAcsUrl" })} value={details.samlAcsUrl} testId="sso-sp-acs-url" />
          <SsoCopyValue label={formatMessage({ id: "settings.sso.spMetadataUrl" })} value={details.samlMetadataUrl} testId="sso-sp-metadata-url" />
        </>
      )}
    </div>
  );
}

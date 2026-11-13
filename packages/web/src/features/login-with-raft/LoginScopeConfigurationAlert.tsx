import { useIntl } from "react-intl";
import type { LoginClientSummary } from "./loginClientSummary";

type ScopeValidation = NonNullable<LoginClientSummary["scopeValidation"]>;

/** The App asked for scopes it may not request: why, and which (the login can't continue). */
export function LoginScopeConfigurationAlert({
  reason,
  appName,
  scopeList,
}: {
  reason: ScopeValidation["reason"];
  appName: string;
  /** The refused scopes, comma-joined. */
  scopeList: string;
}) {
  const { formatMessage } = useIntl();
  return (
    <div
      role="alert"
      data-testid="oauth-scope-configuration-error"
      className="mt-4 rounded-container border border-line-hairline bg-warning-soft p-4 text-foreground"
    >
      <div className="text-callout font-bold">
        {formatMessage({ id: reason === "unsupported"
          ? "pages.humanLogin.unsupportedScopeTitle"
          : reason === "mixed"
            ? "pages.humanLogin.invalidScopeTitle"
            : "pages.humanLogin.scopeConfigurationTitle" })}
      </div>
      <p className="mt-1 text-callout">
        {formatMessage(
          { id: reason === "unsupported"
            ? "pages.humanLogin.unsupportedScopeBody"
            : reason === "mixed"
              ? "pages.humanLogin.invalidScopeBody"
              : "pages.humanLogin.scopeConfigurationBody" },
          { appName, scopes: scopeList },
        )}
      </p>
    </div>
  );
}

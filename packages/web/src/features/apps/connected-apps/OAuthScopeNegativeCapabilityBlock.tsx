import { useIntl } from "react-intl";
import { AGENT_INBOUND_NEGATIVE_CAPABILITY_ID } from "../../../lib/oauthScopePresentation";

export function OAuthScopeNegativeCapabilityBlock({ className = "" }: { className?: string }) {
  const { formatMessage } = useIntl();
  return (
    <div className={`rounded-container bg-warning-soft px-3 py-2.5 text-footnote font-semibold text-foreground ${className}`.trim()}>
      {formatMessage({ id: AGENT_INBOUND_NEGATIVE_CAPABILITY_ID })}
    </div>
  );
}

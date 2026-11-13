import { useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { useLocation, useNavigate } from "react-router-dom";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";

import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import Banner from "../ui/Banner";
import SectionEyebrow from "../ui/SectionEyebrow";
import SlackBridgeSetupWizard from "./SlackBridgeSetupWizard";
import type { SlackBridgeProvisioningProvider } from "./slackBridgeProvisioning";
import { slackBridgeProvisioningProvider } from "./slackBridgeProvisioningApi";
import { isSlackBridgeSurfaceEnabled } from "./slackBridgeVisibility";
import { readSlackOAuthReturnError, stripSlackOAuthReturnParams } from "./slackOAuthReturn";
import type { SlackOAuthReturnError } from "./slackOAuthReturn";

export { isSlackBridgeSurfaceEnabled } from "./slackBridgeVisibility";

export function IMBridgesSection({
  canManage,
  provider,
  oauthReturnError = null,
}: {
  canManage: boolean;
  provider: SlackBridgeProvisioningProvider;
  /** Set when Slack's OAuth callback sent the installer back with a failure. */
  oauthReturnError?: SlackOAuthReturnError | null;
}) {
  const { formatMessage } = useIntl();

  return (
    <div className="stack-y-4" data-testid="im-bridges-section">
      <section aria-labelledby="im-bridges-providers-heading">
        <SectionEyebrow as="div">{formatMessage({ id: "settings.imBridges.eyebrow" })}</SectionEyebrow>
        <h2 id="im-bridges-providers-heading" className="mt-1 text-headline text-foreground">
          {formatMessage({ id: "settings.imBridges.title" })}
        </h2>
      </section>

      {oauthReturnError && (
        <Banner
          intent="warning"
          density="lg"
          withIcon
          title={formatMessage({ id: "settings.slackBridge.oauthReturn.title" })}
          data-testid="slack-oauth-return-error"
        >
          {formatMessage({ id: oauthReturnError.messageId }, { code: oauthReturnError.code })}
        </Banner>
      )}

      <SlackBridgeSetupWizard canManage={canManage} provider={provider} />
    </div>
  );
}

export default function IMBridgesSettingsSection() {
  const { capabilities } = useServerPermissions();
  const slackBridge = useServerFeatureFlag(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master);
  const location = useLocation();
  const navigate = useNavigate();
  // Read once on arrival from Slack, then drop the params so a refresh or a
  // shared link does not replay the failure.
  const [oauthReturnError] = useState(() => readSlackOAuthReturnError(location.search));
  useEffect(() => {
    if (!readSlackOAuthReturnError(location.search)) return;
    navigate(
      { pathname: location.pathname, search: stripSlackOAuthReturnParams(location.search), hash: location.hash },
      { replace: true },
    );
  }, [location.hash, location.pathname, location.search, navigate]);

  // Feature-flag reads are server-scoped and fail closed while unresolved.
  // The route remains addressable for deep links, but must not expose a
  // provider setup surface without an explicit server allow rule.
  if (!isSlackBridgeSurfaceEnabled(slackBridge)) return null;

  return (
    <IMBridgesSection
      canManage={capabilities.manageIntegrations}
      provider={slackBridgeProvisioningProvider}
      oauthReturnError={oauthReturnError}
    />
  );
}

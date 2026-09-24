import { useIntl } from "react-intl";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";

import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import SectionEyebrow from "../ui/SectionEyebrow";
import SlackBridgeSetupWizard from "./SlackBridgeSetupWizard";
import type { SlackBridgeProvisioningProvider } from "./slackBridgeProvisioning";
import { slackBridgeProvisioningProvider } from "./slackBridgeProvisioningApi";
import { isSlackBridgeSurfaceEnabled } from "./slackBridgeVisibility";

export { isSlackBridgeSurfaceEnabled } from "./slackBridgeVisibility";

export function IMBridgesSection({
  canManage,
  provider,
}: {
  canManage: boolean;
  provider: SlackBridgeProvisioningProvider;
}) {
  const { formatMessage } = useIntl();

  return (
    <div className="space-y-4" data-testid="im-bridges-section">
      <section className="border-2 border-black bg-brutal-cream p-4 shadow-brutal-sm" aria-labelledby="im-bridges-providers-heading">
        <SectionEyebrow as="div">{formatMessage({ id: "settings.imBridges.eyebrow" })}</SectionEyebrow>
        <h2 id="im-bridges-providers-heading" className="mt-1 text-lg font-black">
          {formatMessage({ id: "settings.imBridges.title" })}
        </h2>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-black/60">
          {formatMessage({ id: "settings.imBridges.description" })}
        </p>
      </section>

      <SlackBridgeSetupWizard canManage={canManage} provider={provider} />
    </div>
  );
}

export default function IMBridgesSettingsSection() {
  const { capabilities } = useServerPermissions();
  const slackBridge = useServerFeatureFlag(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master);

  // Feature-flag reads are server-scoped and fail closed while unresolved.
  // The route remains addressable for deep links, but must not expose a
  // provider setup surface without an explicit server allow rule.
  if (!isSlackBridgeSurfaceEnabled(slackBridge)) return null;

  return (
    <IMBridgesSection
      canManage={capabilities.manageIntegrations}
      provider={slackBridgeProvisioningProvider}
    />
  );
}

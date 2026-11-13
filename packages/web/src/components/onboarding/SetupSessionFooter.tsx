import { useCallback } from "react";
import { useIntl } from "react-intl";
import { useServerStore } from "../../store/serverStore";
import { TextLink } from "@botiverse/raft-ui";

/**
 * Shared escape links for every blocking server-setup surface. Setup may make
 * you finish before chatting, but it must never lock the owner out of the
 * server's own settings, where Delete lives. The setup gate stays down on
 * settings routes, so this link actually lands somewhere usable (task #246;
 * replaces the in-modal Delete from task #141).
 */
export default function SetupSessionFooter({
  disabled = false,
  showServerSettings = false,
  onUseCloudAgent,
  useCloudAgentBusy = false,
  onLeave,
}: {
  disabled?: boolean;
  /** Only the steps before the server works (Connect computer, Meet Cindy): that
   * is where a half-built server needs a way to Settings > Delete (cindyz). */
  showServerSettings?: boolean;
  /**
   * The staging-only way out of "Connect computer" for the owner of a server that has no
   * onboarding agent: have Cindy run in the cloud instead (tygg, #raft-antiproton:f5f3e410).
   * The caller passes this only when the server says the entry applies
   * (`hostedCindyTestEntry`), so the link never exists outside staging.
   */
  onUseCloudAgent?: () => void;
  useCloudAgentBusy?: boolean;
  /** Told which way out was taken, before leaving (the setup funnel counts it). */
  onLeave?: (way: "switch_server" | "server_settings") => void;
}) {
  const { formatMessage } = useIntl();
  const clearCurrent = useServerStore((state) => state.clearCurrent);
  const serverSlug = useServerStore((state) => state.current?.slug ?? null);

  const handleSwitchServer = useCallback(() => {
    onLeave?.("switch_server");
    clearCurrent();
    window.history.pushState({}, "", "/servers");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, [clearCurrent, onLeave]);
  const handleOpenSettings = useCallback(() => {
    if (!serverSlug) return;
    onLeave?.("server_settings");
    window.history.pushState({}, "", `/s/${serverSlug}/settings/server`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, [onLeave, serverSlug]);

  return (
    <div className="flex items-center gap-4 text-footnote" data-testid="setup-session-footer">
      <TextLink
        onClick={handleSwitchServer}
        disabled={disabled}
        data-testid="setup-switch-server"
      >
        {formatMessage({ id: "layout.onboarding.switchServer" })}
      </TextLink>
      {onUseCloudAgent ? (
        <TextLink
          onClick={onUseCloudAgent}
          disabled={disabled || useCloudAgentBusy}
          data-testid="setup-use-cloud-agent"
        >
          {formatMessage({ id: useCloudAgentBusy
            ? "onboarding.computerRuntime.useCloudAgentBusy"
            : "onboarding.computerRuntime.useCloudAgent" })}
        </TextLink>
      ) : null}
      {showServerSettings && serverSlug ? (
        <TextLink
          onClick={handleOpenSettings}
          disabled={disabled}
          data-testid="setup-server-settings"
        >
          {formatMessage({ id: "layout.onboarding.serverSettings" })}
        </TextLink>
      ) : null}
    </div>
  );
}

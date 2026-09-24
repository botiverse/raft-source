import { useIntl } from "react-intl";
import { useServerStore } from "../../store/serverStore";
import TextLink from "../ui/TextLink";

/** Shared escape links for every blocking server-setup surface. */
export default function SetupSessionFooter({ disabled = false }: { disabled?: boolean }) {
  const { formatMessage } = useIntl();
  const clearCurrent = useServerStore((state) => state.clearCurrent);

  const handleSwitchServer = () => {
    clearCurrent();
    window.history.pushState({}, "", "/servers");
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  return (
    <div className="flex items-center gap-4 text-sm" data-testid="setup-session-footer">
      <TextLink
        variant="muted"
        onClick={handleSwitchServer}
        disabled={disabled}
        data-testid="setup-switch-server"
      >
        {formatMessage({ id: "layout.onboarding.switchServer" })}
      </TextLink>
    </div>
  );
}

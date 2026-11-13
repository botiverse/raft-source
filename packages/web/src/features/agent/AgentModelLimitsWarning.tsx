import { useIntl } from "react-intl";
import Banner from "../../components/ui/Banner";

/**
 * task #1357 item 1: the agent's Computer has reported that the current
 * session registered at least one Raft default limit for its Built-in custom
 * gateway model (`agent.modelLimits.defaultsReported`, derived by the server).
 * Only a warning: no values and no per-field source are shown, and nothing is
 * shown otherwise (no report never reads as "confirmed"). Copy owner: Cat.
 */
export function AgentModelLimitsWarning({ className }: { className?: string }) {
  const { formatMessage } = useIntl();
  return (
    <Banner
      intent="warning"
      density="sm"
      withIcon
      className={className}
      title={formatMessage({ id: "agent.modelLimits.defaultsWarningTitle" })}
      data-testid="agent-model-limits-defaults-warning"
    >
      {formatMessage({ id: "agent.modelLimits.defaultsWarningBody" })}
    </Banner>
  );
}

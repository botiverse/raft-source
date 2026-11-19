import { useIntl } from "react-intl";
import { getRuntimeInfo } from "@botiverse/raft-shared";
import type { SuggestedRuntimeUnavailableCause } from "./pickCreateAgentRuntime";

/**
 * Under Create Agent's runtime picker, for a card's suggested runtime: where
 * the chosen computer cannot run it (and nothing is picked), why: the computer
 * lacks it, or this server does not offer it for new agents. A suggestion that
 * was preselected needs no note (cindyz, #customer-support:11e49258).
 */
export function SuggestedRuntimeNotice({ suggestedRuntime, runtime, unavailable, computerName }: {
  suggestedRuntime: string | undefined;
  runtime: string;
  unavailable: SuggestedRuntimeUnavailableCause | null;
  computerName: string;
}) {
  const { formatMessage } = useIntl();
  if (!suggestedRuntime) return null;
  if (runtime === suggestedRuntime || !unavailable) return null;
  return (
    <p className="mt-1 text-caption text-warning-strong" role="status" data-testid="create-agent-suggested-runtime-unavailable">
      {formatMessage(
        { id: unavailable === "not_admitted" ? "agent.create.suggestedRuntimeNotAdmitted" : "agent.create.suggestedRuntimeUnavailable" },
        { runtime: getRuntimeInfo(suggestedRuntime)?.displayName ?? suggestedRuntime, computer: computerName },
      )}
    </p>
  );
}

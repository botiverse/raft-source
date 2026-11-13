import { useCallback, useEffect, useState } from "react";
import { useIntl } from "react-intl";
import api from "../../api/client";
import type { Agent } from "../../store/agentStore";
import { useAgentStore } from "../../store/agentStore";
import { useServerStore } from "../../store/serverStore";
import Banner from "../ui/Banner";
import { Button } from "@botiverse/raft-ui";
import { CreateAgentDialog } from "./DeferredCreateAgentDialog";
import { startVisiblePoll } from "../../utils/visiblePoll";

/** Re-read the setup state now and then: the server flips it to `failed` after its timeout and retry. */
const RECHECK_MS = 60_000;

/**
 * In a hosted Cindy's DM, once she could not start (the server's 3-minute timeout and its one
 * automatic retry are both behind her): say so and offer the computer path. The button opens
 * the onboarding Create Cindy dialog, which connects a computer first when there is none; its
 * create converts her in place into a computer Cindy (#raft-antiproton:8008c6f0).
 */
export default function HostedCindyFailedBanner({ agent }: { agent: Agent }) {
  const { formatMessage } = useIntl();
  const onboardingAgentId = useServerStore((s) => s.current?.onboardingAgentId ?? null);
  const eligible = onboardingAgentId === agent.id && agent.external === true && !agent.machineId;
  const [failed, setFailed] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const recheck = useCallback(async () => {
    if (!eligible) {
      setFailed(false);
      return;
    }
    try {
      const { data } = await api.get<{ onboardingSetup?: "usable" | "failed" | null }>(`/agents/${agent.id}/hosted-runtime`);
      setFailed(data.onboardingSetup === "failed");
    } catch {
      // Not a manager of this agent, or the status is unavailable: no banner.
      setFailed(false);
    }
  }, [eligible, agent.id]);

  useEffect(() => {
    void recheck();
    if (!eligible) return;
    // Paused while the page is hidden; one recheck when it shows again.
    return startVisiblePoll(() => void recheck(), { intervalMs: RECHECK_MS });
  }, [eligible, recheck]);

  const openDialog = useCallback(() => setDialogOpen(true), []);
  const closeDialog = useCallback(() => {
    setDialogOpen(false);
    void useAgentStore.getState().loadAgents();
    void recheck();
  }, [recheck]);

  if (!eligible || (!failed && !dialogOpen)) return null;
  return (
    <>
      {failed ? (
        <Banner
          intent="warning"
          withIcon
          data-testid="hosted-cindy-failed-banner"
          actions={(
            <Button size="md" onClick={openDialog}>
              {formatMessage({ id: "agent.hostedCindy.failed.connectComputer" })}
            </Button>
          )}
        >
          {formatMessage({ id: "agent.hostedCindy.failed.body" }, { name: agent.displayName || agent.name })}
        </Banner>
      ) : null}
      {dialogOpen ? (
        <CreateAgentDialog onboarding onClose={closeDialog} onOnboardingComplete={closeDialog} />
      ) : null}
    </>
  );
}

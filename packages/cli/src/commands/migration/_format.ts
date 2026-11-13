// `raft migration retry`: the agent-facing text of an accepted retry.
import type { AgentApiMigrationRetryResponse } from "@botiverse/raft-shared";
import { foldAgentOneLineText } from "@botiverse/raft-shared/src/agentCliSurface";

import { axSurface } from "../../core/renderer";

function formatMigrationRetryStartedText(response: AgentApiMigrationRetryResponse): string {
  // The target's name is set by a person: one line, never a line of its own.
  const target = foldAgentOneLineText(response.targetMachineName);
  return [
    `Retrying your move to ${target} (${response.supportRef}).`,
    foldAgentOneLineText(response.note),
    "Next: nothing to run; finish your current work. If this move fails too, a person needs to start the next one.",
  ].join("\n");
}

export const formatMigrationRetryStarted = axSurface(
  "migration retry: the retried move started (target Computer, support ref), the Server's note that the source stops the agent once idle, and one Next line.",
  formatMigrationRetryStartedText,
  {
    examples: [
      {
        title: "started",
        args: [{
          migrationId: "11111111-1111-4111-8111-111111111111",
          supportRef: "mig_7f3k2q",
          targetMachineName: "studio-mac",
          note: "The source will stop you once you are idle, then move you.",
        }],
      },
    ],
  },
);

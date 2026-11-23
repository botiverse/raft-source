import { axSurface } from "../../core/renderer";
import type { DescriptionLinkWarning, ProfileView } from "@botiverse/raft-shared";
import { formatAgentProfile, formatDescriptionLinkWarnings } from "@botiverse/raft-shared/src/agentCliSurface";

// The text lives in `@botiverse/raft-shared` (`agentText/threadsProfile.ts`) so
// the SDK renders the same bytes; this file keeps the axSurface registration.
export const formatProfile = axSurface(
  "Agent/human profile card.",
  (profile: ProfileView): string => formatAgentProfile(profile),
  {
    examples: [{ args: [{ type: "agent", name: "alice-agent", displayName: "Alice", description: "example role", status: "online", serverRole: "member", runtime: "claude", model: "claude-fable-5", reasoningEffort: "medium", computerName: "example-computer", computerId: "00000000-0000-0000-0000-000000000003", computerHostname: "example-host", daemonVersion: "1.0.23", createdAt: "2026-08-31T08:00:00.000Z", createdAgents: [] } as never] }],
  },
);

// The Server's warnings about a just-saved description's links (#457), after the profile card.
export const formatProfileDescriptionWarnings = axSurface(
  "Warnings after raft profile update: links in the saved description some of its readers can't open, each with every fix.",
  (warnings: readonly DescriptionLinkWarning[]): string => formatDescriptionLinkWarnings(warnings),
  {
    examples: [{ args: [[{
      code: "conversation",
      url: "https://app.raft.build/artifacts/TUCt9hmScMEdBpHaTXatxr",
      object: { kind: "artifact", id: "pt_00000000-0000-4000-8000-000000000001" },
      fixes: [
        "If only part of it is for the description: publish a separate version with only what the description's readers may see, link that one, and keep this one where it is (a person then opens the new one to anyone with the link)",
        "If it is meant for the whole server: raft artifact move pt_00000000-0000-4000-8000-000000000001 --to server (everyone in the server will be able to see all of its contents; guests still can't)",
      ],
    }]] }],
  },
);

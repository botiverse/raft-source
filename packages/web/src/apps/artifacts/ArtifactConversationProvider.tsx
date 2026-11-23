import { useMemo } from "react";
import type { ReactNode } from "react";

import type { ArtifactId } from "@botiverse/raft-shared";

import { ArtifactConversationContext } from "./artifactRecentConversation";

/**
 * Around a conversation's side card (ChatPanel): which conversation it is, its name and how to open its Files card,
 * for the viewer's recent Artifacts title (ArtifactRecentTitle, #proj-workspace:#291); also around the App's Artifact page
 * opened from a conversation (`hostConversation=`, #proj-workspace:#309). `onShowAll` should be stable.
 */
export function ArtifactConversationProvider({ conversationId, name, onShowAll, onPick, children }: {
  conversationId: string;
  name: string;
  onShowAll?: () => void;
  /** Where a picked one opens, when not in the same side card (the App's Artifact page). Should be stable. */
  onPick?: (id: ArtifactId) => void;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ conversationId, name, onShowAll, onPick }), [conversationId, name, onShowAll, onPick]);
  return <ArtifactConversationContext.Provider value={value}>{children}</ArtifactConversationContext.Provider>;
}

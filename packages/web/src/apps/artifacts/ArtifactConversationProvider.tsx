import { useMemo } from "react";
import type { ReactNode } from "react";

import { ArtifactConversationContext } from "./artifactRecentConversation";

/**
 * Around a conversation's side card (ChatPanel): which conversation it is, its name and how to open its Files card,
 * for the viewer's recent Artifacts title (ArtifactRecentTitle, #proj-workspace:#291). `onShowAll` should be stable.
 */
export function ArtifactConversationProvider({ conversationId, name, onShowAll, children }: {
  conversationId: string;
  name: string;
  onShowAll?: () => void;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ conversationId, name, onShowAll }), [conversationId, name, onShowAll]);
  return <ArtifactConversationContext.Provider value={value}>{children}</ArtifactConversationContext.Provider>;
}

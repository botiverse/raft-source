import { useCallback, useEffect, useState } from "react";
import type { ArtifactCard, ArtifactId, ChannelId } from "@botiverse/raft-shared";

import { artifactErrorCode } from "./artifactApi";
import { rememberArtifactCard } from "./artifactOpenIntent";
import { artifactSource } from "./artifactSource";
import { useArtifactViewerStore } from "./artifactViewerStore";
import { openArtifactInPlace } from "./openArtifactInPlace";
import { useWorkspaceArtifactsEnabled } from "./useWorkspaceArtifactsEnabled";

/**
 * A conversation's own Artifacts as its Files tab shows them:
 * - `hidden`: the flag is off, or Artifacts are off for the server (403 ARTIFACTS_NOT_ENABLED);
 * - `loading`: the first page is on its way;
 * - `failed`: it couldn't be read (429 RATE_LIMITED, a network error, ...): an error with Retry;
 * - `ready`: the cards so far (none for 404 TARGET_NOT_FOUND), `nextCursor` for Show More,
 *   `more` how the next page is doing.
 */
export type ConversationArtifactsView =
  | { status: "hidden" }
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; cards: ArtifactCard[]; nextCursor: string | null; more: "idle" | "loading" | "failed" };

const HIDDEN: ConversationArtifactsView = { status: "hidden" };
const LOADING: ConversationArtifactsView = { status: "loading" };

function viewOfError(error: unknown): ConversationArtifactsView {
  const code = artifactErrorCode(error);
  if (code === "ARTIFACTS_NOT_ENABLED") return HIDDEN;
  if (code === "TARGET_NOT_FOUND") return { status: "ready", cards: [], nextCursor: null, more: "idle" };
  return { status: "failed" };
}

/**
 * The Artifacts whose home is this conversation, for its Files tab: the first
 * page when shown (and again on Retry), the next on Show More. An answer for
 * another conversation or an earlier attempt is dropped.
 */
export function useConversationArtifacts(conversationId: ChannelId): { view: ConversationArtifactsView; retry: () => void; showMore: () => void } {
  const enabled = useWorkspaceArtifactsEnabled();
  const [attempt, setAttempt] = useState(0);
  // `load`: one object per first-page load, so a Show More answer lands only on the list it paged
  // (not on a later load of the same conversation, after A → B → A).
  const [state, setState] = useState<{ conversationId: ChannelId; attempt: number; load: object; view: ConversationArtifactsView } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let ignore = false;
    const load = {};
    void artifactSource().conversationArtifacts(conversationId).then(
      (page) => {
        if (!ignore) setState({ conversationId, attempt, load, view: { status: "ready", cards: page.rows.map((row) => row.card), nextCursor: page.nextCursor, more: "idle" } });
      },
      (error: unknown) => { if (!ignore) setState({ conversationId, attempt, load, view: viewOfError(error) }); },
    );
    return () => { ignore = true; };
  }, [enabled, conversationId, attempt]);

  const current = state && state.conversationId === conversationId && state.attempt === attempt ? state : null;
  const view = !enabled ? HIDDEN : current?.view ?? LOADING;
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const cursor = view.status === "ready" && view.more !== "loading" ? view.nextCursor : null;
  const load = current?.load ?? null;
  const showMore = useCallback(() => {
    if (!cursor || !load) return;
    // Only onto the list it was asked for: the same load, still at this cursor.
    const update = (next: (view: Extract<ConversationArtifactsView, { status: "ready" }>) => ConversationArtifactsView) => setState((now) => (
      now && now.load === load && now.view.status === "ready" && now.view.nextCursor === cursor
        ? { ...now, view: next(now.view) }
        : now
    ));
    update((ready) => ({ ...ready, more: "loading" }));
    void artifactSource().conversationArtifacts(conversationId, { cursor }).then(
      (page) => update((ready) => ({ status: "ready", cards: [...ready.cards, ...page.rows.map((row) => row.card)], nextCursor: page.nextCursor, more: "idle" })),
      () => update((ready) => ({ ...ready, more: "failed" })),
    );
  }, [conversationId, cursor, load]);
  return { view, retry, showMore };
}

/**
 * Opens it the way an Artifact card does (openArtifactInPlace): beside the
 * messages of the channel panel on screen; where none is, with `sideCard`
 * (the Files card, which covers the conversation on a phone), in this
 * conversation's side card; else (the legacy Files tab, which replaces the
 * messages and has no side card) in the app shell's place beside it.
 */
export function openConversationArtifact(card: ArtifactCard, from: HTMLElement, conversationId: string, { sideCard }: { sideCard: boolean }): void {
  // The viewer's header until its own data is in.
  rememberArtifactCard(card);
  openArtifactInPlace({ id: card.id, version: null }, from, "other", sideCard ? conversationId : null);
}

/**
 * A channel's announcement (#proj-chat:#29; its strip under the channel
 * header, its row in channel details): opened as an Artifact card opens, at
 * its latest version, beside that channel's messages (the channel's own place
 * where the opener is outside its panel, as the details drawer is). False only
 * outside the app shell: the link is then followed.
 */
export function openChannelAnnouncement(id: ArtifactId, from: HTMLElement, conversationId: string): boolean {
  return openArtifactInPlace({ id, version: null }, from, "other", conversationId);
}

/** Whether the Artifact column beside `conversationId` shows this Artifact now (the announcement strip keeps its open look). */
export function useArtifactOpenBeside(conversationId: string | null, id: string | null): boolean {
  return useArtifactViewerStore((s) => id !== null && s.open !== null && s.open.id === id && s.open.conversationId === conversationId);
}

// A `feedback:submit` action card opened from the mobile app. Tapping the card
// opens this page as /feedback/?actionCard=<message id>&server=<server id>:
// the page reads the card's draft (GET /api/product-feedback/action-card/:id,
// as operated from that server) and shows the shared card form prefilled and
// editable. Sending it is the card's submission; the page then opens the new
// ticket in the ordinary workspace. If the draft cannot be read for any reason
// (already sent, no access, offline), the page opens as usual.

import { useCallback, useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import type { AxiosInstance } from "axios";
import { Button } from "@botiverse/raft-ui";
import type { FeedbackSubmitType } from "@botiverse/raft-shared";
import { sendFeedbackCard } from "../agentFeedbackCard";
import { FeedbackCardFields, FeedbackCardSubmitButton, useFeedbackCardForm } from "../FeedbackCardForm";
import type { FeedbackCardSent, FeedbackCardSubmission } from "../FeedbackCardForm";
import type { FeedbackCardCopy } from "../feedbackCardCopy";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The card a page link names, and the server it is operated from. */
export type FeedbackActionCardLink = { messageId: string; serverId: string };

export type FeedbackActionCardDraft = {
  feedbackType: FeedbackSubmitType;
  message: string;
  /** Sent back with the submission, which the server checks against the card. */
  confirmationVersion: number;
};

/** Both ids, well formed, or no card at all. */
export function readFeedbackActionCardLink(search: string): FeedbackActionCardLink | null {
  const params = new URLSearchParams(search);
  const messageId = params.get("actionCard") ?? "";
  const serverId = params.get("server") ?? "";
  return UUID.test(messageId) && UUID.test(serverId) ? { messageId, serverId } : null;
}

/** The card's draft, or null whenever it cannot be read: the server refuses with one 404 whatever the reason. */
export async function loadFeedbackActionCardDraft(
  client: AxiosInstance,
  link: FeedbackActionCardLink,
  signal?: AbortSignal,
): Promise<FeedbackActionCardDraft | null> {
  try {
    const { data } = await client.get<unknown>(`/product-feedback/action-card/${link.messageId}`, {
      headers: { "X-Server-Id": link.serverId },
      signal,
    });
    const draft = (data ?? {}) as { message_id?: unknown; feedback_type?: unknown; message?: unknown; confirmation_version?: unknown };
    const version = draft.confirmation_version;
    if (
      draft.message_id !== link.messageId
      || (draft.feedback_type !== "idea" && draft.feedback_type !== "problem")
      || typeof draft.message !== "string"
      || typeof version !== "number" || !Number.isSafeInteger(version) || version < 1
    ) return null;
    return { feedbackType: draft.feedback_type, message: draft.message, confirmationVersion: version };
  } catch {
    return null;
  }
}

type EntryState =
  | { phase: "loading" }
  | { phase: "form"; draft: FeedbackActionCardDraft }
  | { phase: "workspace"; ticketId?: string };

export function FeedbackActionCardEntry({
  client,
  link,
  metadata,
  copy,
  renderWorkspace,
}: {
  /** The native client: the host's token and client kind on every request. */
  client: AxiosInstance;
  link: FeedbackActionCardLink;
  /** The host's client facts, as the workspace sends them. */
  metadata: () => Promise<Record<string, string> | null>;
  copy: FeedbackCardCopy;
  /** The ordinary page, opened on the card's ticket once it is filed. */
  renderWorkspace: (initialTicketId?: string) => ReactNode;
}) {
  const [state, setState] = useState<EntryState>({ phase: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    void loadFeedbackActionCardDraft(client, link, controller.signal).then((draft) => {
      if (!controller.signal.aborted) setState(draft ? { phase: "form", draft } : { phase: "workspace" });
    });
    return () => controller.abort();
  }, [client, link]);
  const openWorkspace = useCallback(() => setState({ phase: "workspace" }), []);
  // Already sent by this person (no ticket named): the list, where it is.
  const handleSent = useCallback((sent: FeedbackCardSent) => {
    setState({ phase: "workspace", ticketId: sent.ticketId ?? undefined });
  }, []);

  if (state.phase === "workspace") return renderWorkspace(state.ticketId);
  if (state.phase === "loading") return <p className="feedback-host-status" role="status">{copy("common.loading")}</p>;
  return (
    <FeedbackActionCardForm
      client={client}
      link={link}
      draft={state.draft}
      metadata={metadata}
      copy={copy}
      onSent={handleSent}
      onCancel={openWorkspace}
    />
  );
}

function FeedbackActionCardForm({
  client,
  link,
  draft,
  metadata,
  copy,
  onSent,
  onCancel,
}: {
  client: AxiosInstance;
  link: FeedbackActionCardLink;
  draft: FeedbackActionCardDraft;
  metadata: () => Promise<Record<string, string> | null>;
  copy: FeedbackCardCopy;
  onSent: (sent: FeedbackCardSent) => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const send = useCallback(async (submission: FeedbackCardSubmission) => sendFeedbackCard(client, {
    ...submission,
    messageId: link.messageId,
    confirmationVersion: draft.confirmationVersion,
    metadata: await metadata(),
    headers: { "X-Server-Id": link.serverId },
  }), [client, draft.confirmationVersion, link, metadata]);
  const form = useFeedbackCardForm({
    prefilledType: draft.feedbackType,
    prefilledMessage: draft.message,
    copy,
    send,
    onSubmitted: onSent,
  });
  return (
    <form className="feedback-card-entry" aria-labelledby={titleId} onSubmit={form.handleSubmit}>
      {/* The dialog's title and description, as a page. */}
      <h1 id={titleId} className="m-0 font-sans text-headline font-bold text-foreground">
        {copy("actionCard.feedback.dialogTitle")}
      </h1>
      <p className="m-0 font-sans text-subhead text-foreground-muted">{copy("actionCard.feedback.dialogDescription")}</p>
      <FeedbackCardFields form={form} copy={copy} />
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="lg" onClick={onCancel} disabled={form.sending}>
          {copy("common.confirm.cancel")}
        </Button>
        <FeedbackCardSubmitButton form={form} copy={copy} />
      </div>
    </form>
  );
}

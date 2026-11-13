// Connected Apps surfaces for the text apps add to agent prompts (#proj-apps
// task #4): Raft's review of a published app's text edit, the developer's view
// of that review, and an admin confirming a self-built app's agent-made edit.
// Both read GET /integrations/clients/:id/prompt-text. Rendered only with
// app_prompt_text_consent on; the callers gate them.
//
// While an edit is pending or rejected, agents keep the last confirmed text,
// and confirmed text reaches each agent the next time it starts.

import { useCallback, useEffect, useEffectEvent, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { Badge, Button, Textarea } from "@botiverse/raft-ui";
import api from "../../api/client";
import ConfirmDialog from "../ConfirmDialog";
import Banner from "../ui/Banner";
import FormField from "../ui/FormField";
import { AppPromptTextBlock, AppPromptTextComparison } from "../integrations/AppPromptText";
import {
  appTextChangedCurrent,
  clientPromptTextPath,
  isPromptTextReviewGoneError,
  isPromptTextReviewStaleError,
  readClientPromptTextState,
} from "../../lib/appPromptText";
import type { AppPromptTextFields, ClientPromptTextState } from "../../lib/appPromptText";

type ApiError = { response?: { data?: { error?: string } } } | null;

function errorText(error: unknown): string | undefined {
  return (error as ApiError)?.response?.data?.error;
}

/**
 * GET /integrations/clients/:id/prompt-text, refetchable. Null until loaded or
 * on failure. `onFirstLoad` runs once per app with the first state read.
 */
function useClientPromptText(clientId: string, onFirstLoad?: (state: ClientPromptTextState | null) => void) {
  const [state, setState] = useState<ClientPromptTextState | null>(null);
  const reload = useCallback(async () => {
    try {
      const { data } = await api.get(clientPromptTextPath(clientId));
      const next = readClientPromptTextState(data);
      setState(next);
      return next;
    } catch {
      // No text state (an older server, or no access): the surface shows nothing.
      setState(null);
      return null;
    }
  }, [clientId]);
  // Load once per app; parent re-renders must not refetch.
  const handleFirstLoad = useEffectEvent((loaded: ClientPromptTextState | null) => onFirstLoad?.(loaded));
  useEffect(() => {
    void reload().then(handleFirstLoad);
  }, [reload]);
  return { state, setState, reload };
}

/**
 * Raft's reviewer, in a Marketplace app's detail beside the data-permission
 * review: the live text against the submitted one, Approve, and Reject with a
 * required reason. Both bind to the revision shown.
 */
export function MarketplacePromptTextReview({
  clientId,
  service,
  frame,
  onReviewed,
}: {
  clientId: string;
  service: string;
  /** The detail section to draw the review in (only when there is one). */
  frame: (children: ReactNode) => ReactNode;
  onReviewed?: () => Promise<void> | void;
}) {
  const { formatMessage } = useIntl();
  const { state, reload } = useClientPromptText(clientId);
  const pending = state?.canReview ? state.pending : null;
  const [approving, setApproving] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  const review = useCallback(async (decision: "approve" | "reject", rejectReason?: string) => {
    if (!pending) return;
    await api.post(`${clientPromptTextPath(clientId)}/review`, {
      decision,
      expected_revision_id: pending.id,
      ...(decision === "reject" ? { reason: rejectReason } : {}),
    });
  }, [clientId, pending]);

  // A stale or vanished revision: reload so the reviewer sees what is there now.
  const staleMessage = useCallback(async (err: unknown): Promise<string | null> => {
    if (isPromptTextReviewStaleError(err)) {
      await reload();
      return formatMessage({ id: "appPromptText.revisionChanged" });
    }
    if (isPromptTextReviewGoneError(err)) {
      await reload();
      return formatMessage({ id: "appPromptText.reviewGone" });
    }
    return null;
  }, [formatMessage, reload]);

  const handleApprove = useCallback(async () => {
    setApproving(true);
    setError("");
    try {
      await review("approve");
      await reload();
      await onReviewed?.();
    } catch (err) {
      setError((await staleMessage(err)) ?? errorText(err) ?? formatMessage({ id: "appPromptText.reviewFailed" }));
    } finally {
      setApproving(false);
    }
  }, [formatMessage, onReviewed, reload, review, staleMessage]);

  const handleConfirmReject = useCallback(async () => {
    try {
      await review("reject", reason.trim());
    } catch (err) {
      throw new Error((await staleMessage(err)) ?? errorText(err) ?? formatMessage({ id: "appPromptText.reviewFailed" }));
    }
    setReason("");
    await reload();
    await onReviewed?.();
  }, [formatMessage, onReviewed, reason, reload, review, staleMessage]);

  const openReject = useCallback(() => {
    setError("");
    setRejectOpen(true);
  }, []);
  const closeReject = useCallback(() => setRejectOpen(false), []);
  const handleReasonChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => setReason(event.target.value), []);

  if (!pending) {
    return error ? frame(<Banner intent="warning" density="sm">{error}</Banner>) : null;
  }

  return frame(
    <div className="stack-y-3" data-testid="app-prompt-text-review">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="text-footnote text-foreground-muted">{formatMessage({ id: "appPromptText.reviewDescription" })}</div>
        <Badge appearance="soft" variant="warning">{formatMessage({ id: "appPromptText.pendingReview" })}</Badge>
      </div>
      <AppPromptTextComparison
        before={state?.current ?? null}
        after={pending}
        beforeTitle={formatMessage({ id: "appPromptText.liveNow" })}
        afterTitle={formatMessage({ id: "appPromptText.submittedForReview" })}
        service={service}
      />
      {error ? <Banner intent="warning" density="sm">{error}</Banner> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" size="md" variant="outline" onClick={openReject} disabled={approving}>
          {formatMessage({ id: "appPromptText.rejectTextUpdate" })}
        </Button>
        <Button type="button" size="md" variant="primary" onClick={handleApprove} loading={approving} disabled={approving}>
          {approving
            ? formatMessage({ id: "settings.connectedApps.appNotifications.approving" })
            : formatMessage({ id: "appPromptText.approveTextUpdate" })}
        </Button>
      </div>
      {rejectOpen ? (
        <ConfirmDialog
          // A dialog opened by a button takes that button's label.
          title={formatMessage({ id: "appPromptText.rejectTextUpdate" })}
          plainMessage
          message={(
            <FormField
              label={formatMessage({ id: "appPromptText.rejectReasonLabel" })}
              hint={formatMessage({ id: "appPromptText.rejectReasonHint" })}
              required
            >
              <Textarea value={reason} onChange={handleReasonChange} rows={3} maxLength={2000} className="resize-none" data-testid="app-prompt-text-reject-reason" />
            </FormField>
          )}
          confirmLabel={formatMessage({ id: "appPromptText.rejectConfirm" })}
          loadingLabel={formatMessage({ id: "appPromptText.rejecting" })}
          confirmVariant="warning"
          confirmDisabled={!reason.trim()}
          confirmTestId="app-prompt-text-reject-confirm"
          layer={1}
          maxWidthClass="max-w-md"
          onClose={closeReject}
          onConfirm={handleConfirmReject}
        />
      ) : null}
    </div>,
  );
}

/**
 * The developer's editor. A published app: edits to the three fields go
 * through Raft review, then each Server's admins; shows the pending or the
 * rejected revision. Any app whose current text this (source) Server hasn't
 * confirmed (an agent made the edit): a Confirm Text button, since a human
 * admin's own save counts as confirmed.
 */
export function DeveloperPromptTextPanel({
  clientId,
  service,
  published,
  canManage,
  onPendingText,
  onConfirmed,
}: {
  clientId: string;
  service: string;
  published: boolean;
  canManage: boolean;
  onConfirmed?: (clientId: string) => void;
  /** The text under review, once loaded, so the form edits from it. */
  onPendingText?: (fields: AppPromptTextFields) => void;
}) {
  const { formatMessage } = useIntl();
  // The text under review is what the developer last saved: hand it to the
  // form once, when it loads, so saving again doesn't put back the live text.
  const handleFirstLoad = useCallback((loaded: ClientPromptTextState | null) => {
    if (loaded?.pending) onPendingText?.(loaded.pending);
  }, [onPendingText]);
  const { state, setState, reload } = useClientPromptText(clientId, handleFirstLoad);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");

  const pending = state?.pending ?? null;
  const rejected = pending ? null : state?.rejected ?? null;
  const current = state?.current ?? null;
  const confirmationRequired = Boolean(state?.localConfirmationRequired && current);

  const handleConfirm = useCallback(async () => {
    if (!current) return;
    setConfirming(true);
    setError("");
    try {
      await api.put(`${clientPromptTextPath(clientId)}/confirm`, { expected_revision_id: current.id });
      setState((prev) => (prev ? { ...prev, localConfirmedRevisionId: current.id, localConfirmationRequired: false } : prev));
      onConfirmed?.(clientId);
    } catch (err) {
      const moved = appTextChangedCurrent(err, current.id);
      if (moved) {
        // Show the text the next click confirms, in place.
        setState((prev) => (prev && moved.fields
          ? { ...prev, current: { ...current, ...moved.fields, id: moved.revisionId }, localConfirmationRequired: prev.localConfirmedRevisionId !== moved.revisionId }
          : prev));
        if (!moved.fields) void reload();
        setError(formatMessage({ id: "appPromptText.revisionChanged" }));
      } else {
        setError(errorText(err) ?? formatMessage({ id: "appPromptText.confirmFailed" }));
      }
    } finally {
      setConfirming(false);
    }
  }, [clientId, current, formatMessage, onConfirmed, reload, setState]);

  if (!state || (!published && !pending && !rejected && !confirmationRequired)) return null;

  return (
    <div className="stack-y-3" data-testid="app-prompt-text-developer-status">
      {published ? (
        <Banner live={false} intent="info" density="sm">
          {formatMessage({ id: "appPromptText.developerReviewNotice" })}
        </Banner>
      ) : null}
      {pending ? (
        <div className="stack-y-2" data-testid="app-prompt-text-pending-review">
          <Badge appearance="soft" variant="warning">{formatMessage({ id: "appPromptText.pendingReview" })}</Badge>
          <AppPromptTextComparison
            before={current}
            after={pending}
            beforeTitle={formatMessage({ id: "appPromptText.liveNow" })}
            afterTitle={formatMessage({ id: "appPromptText.submittedForReview" })}
            service={service}
          />
        </div>
      ) : null}
      {rejected ? (
        <div className="stack-y-2" data-testid="app-prompt-text-rejected">
          <Banner live={false} intent="warning" density="sm">
            {formatMessage({ id: "appPromptText.rejected" }, { reason: rejected.rejectReason ?? "" })}
          </Banner>
          <AppPromptTextBlock
            fields={rejected}
            service={service}
            title={formatMessage({ id: "appPromptText.rejectedText" })}
            testId="app-prompt-text-rejected-text"
          />
        </div>
      ) : null}
      {confirmationRequired && current ? (
        <div className="stack-y-3" data-testid="app-prompt-text-self-built-confirm">
          <Banner
            live={false}
            intent="warning"
            density="sm"
            actions={canManage ? (
              <Button type="button" size="md" variant="outline" className="shrink-0" onClick={handleConfirm} loading={confirming} disabled={confirming}>
                {confirming ? formatMessage({ id: "appPromptText.confirming" }) : formatMessage({ id: "appPromptText.confirmText" })}
              </Button>
            ) : undefined}
          >
            {formatMessage({ id: "appPromptText.selfBuiltNotice" })}
          </Banner>
          <AppPromptTextBlock
            fields={current}
            service={service}
            title={formatMessage({ id: "appPromptText.pendingTitle" })}
            testId="app-prompt-text-after"
          />
          {error ? <Banner intent="warning" density="sm">{error}</Banner> : null}
        </div>
      ) : null}
    </div>
  );
}

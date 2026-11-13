import { useCallback, useEffect, useMemo } from "react";
import type { MouseEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { create } from "zustand";
import { Download, EllipsisVertical, TriangleAlert } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  MessageAttachmentAction,
  Spinner,
  TextLink,
} from "@botiverse/raft-ui";
import { ArtifactIcon } from "@botiverse/ricons";
import {
  ARTIFACT_SAVE_MAX_BINARY_BYTES,
  ARTIFACT_SAVE_MAX_TEXT_BYTES,
  artifactFileType,
  parseArtifactRef,
} from "@botiverse/raft-shared";
import type { ArtifactReference } from "@botiverse/raft-shared";

import { showToast } from "../../components/toastBridge";
import Tooltip from "../../components/ui/Tooltip";
import { eventServer, trackArtifactSavedFromAttachment } from "./artifactAnalytics";
import { artifactErrorCode, artifactErrorDetails } from "./artifactApi";
import { artifactUrl } from "./artifactLinks";
import { requestAttachmentSaves, resetAttachmentSaves, useAttachmentSaves } from "./artifactAttachmentSaves";
import { artifactSource, fakeArtifactStandIns } from "./artifactSource";
import { artifactShareHost } from "./artifactShareHost";
import { ArtifactVersionBadge } from "./ArtifactMessageCard";
import { openArtifactOnPlainClick } from "./openArtifactInPlace";

/** The i18n key of why a save failed (the app may not import core's message types). */
type SaveFailureReason =
  | "artifacts.attachment.uploading"
  | "artifacts.attachment.tooLarge"
  | "artifacts.attachment.notFound"
  | "upgradeDialog.uploadQuota.title"
  | "artifacts.attachment.saveFailed";
import { useWorkspaceArtifactsEnabled } from "./useWorkspaceArtifactsEnabled";

/** An attachment as the message list has it (MessageAttachment's fields this reads). */
export interface ArtifactAttachmentInput {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /**
   * What it was saved as, when the caller already knows (only the fake data
   * source's stand-in puts it on a message: the server never does). Absent:
   * asked of the source (`attachmentSaves`).
   */
  savedAsArtifact?: ArtifactReference | null;
}

/** Where the attachment is: its message and conversation, and core's download. */
export interface ArtifactAttachmentContext {
  messageId: string;
  conversationId: string;
  onDownload: () => void;
}

/**
 * The saver's own line, from the save's answer, until `attachmentSaves`
 * (asked again after the save) answers. The server's answer always wins;
 * this only bridges the round trip. Kept for one server and person
 * (`setArtifactSessionScope`): a switch forgets it.
 */
const useSavedThisSession = create<{ scope: string | null; saved: Record<string, ArtifactReference>; set: (attachmentId: string, ref: ArtifactReference) => void }>((set) => ({
  scope: null,
  saved: {},
  set: (attachmentId, ref) => set((state) => ({ saved: { ...state.saved, [attachmentId]: ref } })),
}));

/**
 * A save under way, or the last one that failed, per attachment: the line
 * under it says so ("Saving as Artifact…", or why it failed and Retry) until
 * the saved line takes its place. `retry` is set when trying again can help.
 */
type SaveAttempt =
  | { status: "saving" }
  | { status: "failed"; reason: SaveFailureReason; retry: { attachment: ArtifactAttachmentInput; context: ArtifactAttachmentContext } | null };

const useSaveAttempts = create<{ attempts: Record<string, SaveAttempt> }>(() => ({ attempts: {} }));
/** Bumped when the attempts are forgotten (a server or person switch): a save asked before answers no line. */
let attemptsGeneration = 0;

function forgetAttempts(): void {
  attemptsGeneration += 1;
  useSaveAttempts.setState({ attempts: {} });
}

function setAttempt(attachmentId: string, attempt: SaveAttempt | null): void {
  useSaveAttempts.setState((state) => {
    const { [attachmentId]: _previous, ...rest } = state.attempts;
    return { attempts: attempt ? { ...rest, [attachmentId]: attempt } : rest };
  });
}

/** Core sets the signed-in server and person; a change forgets what was saved under the last one. */
export function setArtifactSessionScope(scope: string | null): void {
  if (useSavedThisSession.getState().scope === scope) return;
  useSavedThisSession.setState({ scope, saved: {} });
  forgetAttempts();
  resetAttachmentSaves();
}

export function resetSavedAttachmentsForTests(): void {
  useSavedThisSession.setState({ scope: null, saved: {} });
  forgetAttempts();
  resetAttachmentSaves();
}

/** Still uploading: the message list's optimistic attachment (urlImageFallback's isOptimisticAttachment). */
function isUploading(attachment: ArtifactAttachmentInput): boolean {
  return attachment.id.startsWith("optimistic-att-");
}

/**
 * Can this attachment be saved as an Artifact? Any type, except one still
 * uploading or larger than an Artifact file may be (16 MiB text, 15 MiB
 * binary): the server would answer 422 ATTACHMENT_NOT_SAVABLE, so the action
 * isn't offered.
 */
export function canSaveAsArtifact(attachment: ArtifactAttachmentInput): boolean {
  if (isUploading(attachment)) return false;
  const limit = artifactFileType(attachment.filename).text ? ARTIFACT_SAVE_MAX_TEXT_BYTES : ARTIFACT_SAVE_MAX_BINARY_BYTES;
  return attachment.sizeBytes <= limit;
}

/**
 * Saves the attachment as an Artifact, no dialog (F14a): named after the
 * file, at home where the attachment is. The line under the attachment says
 * it is saving at once, then turns into the saved line, which opens it (F7);
 * a toast names it (#250: not who can see it, the attachment's own audience). A failure stays on that line, with Retry
 * where trying again can help. One save per attachment at a time.
 */
async function saveAttachment(attachment: ArtifactAttachmentInput, context: ArtifactAttachmentContext, formatMessage: IntlShape["formatMessage"]): Promise<void> {
  if (useSaveAttempts.getState().attempts[attachment.id]?.status === "saving") return;
  const generation = attemptsGeneration;
  setAttempt(attachment.id, { status: "saving" });
  // A server or person switch while it was out (even back again): its answer belongs to the last one.
  const switched = () => attemptsGeneration !== generation;
  try {
    const fake = fakeArtifactStandIns();
    if (fake) {
      // The server reads these from the message; the fake is told.
      const conversation = artifactShareHost().conversationOf(context.conversationId)
        ?? { id: context.conversationId, name: context.conversationId, type: "channel" as const };
      fake.rememberAttachment({ ...attachment, messageId: context.messageId, conversation });
    }
    const at = eventServer();
    const { artifact, created } = await artifactSource().saveAttachment({ attachmentId: attachment.id });
    // A new Artifact only: an attachment saved before answers the one it was saved as.
    if (created) trackArtifactSavedFromAttachment(at);
    if (switched()) return;
    // One batch: the saving line becomes the saved line in the same render, never neither.
    useSavedThisSession.getState().set(attachment.id, { status: "ok", card: artifact.card });
    setAttempt(attachment.id, null);
    // No event tells this client: ask the server's answer for the line.
    requestAttachmentSaves([attachment.id], { again: true });
    showToast({
      title: formatMessage({ id: created ? "artifacts.attachment.savedToast" : "artifacts.attachment.existingToast" }, { title: artifact.card.title }),
      type: "success",
    });
  } catch (error) {
    if (switched()) return;
    const code = artifactErrorCode(error);
    if (code === "ALREADY_SAVED") {
      // Not a failure: saved, as one this person can't see. Nothing to show under it.
      setAttempt(attachment.id, null);
      showToast({ title: formatMessage({ id: "artifacts.attachment.alreadySavedHidden" }), type: "info" });
      return;
    }
    // The copy counts against the monthly upload quota, as an upload does: on Free, the
    // upgrade dialog says so (cindyz, 2026-10-28), rather than a line under the file. Core
    // decides and opens it (the host: the app doesn't reach the quota or the dialog).
    if (
      code === "FILE_UPLOAD_QUOTA_EXCEEDED"
      && artifactShareHost().uploadLimits?.quotaRefused(
        artifactErrorDetails(error, "FILE_UPLOAD_QUOTA_EXCEEDED")?.quota,
        { name: attachment.filename, sizeBytes: attachment.sizeBytes },
      )
    ) {
      setAttempt(attachment.id, null);
      return;
    }
    const notSavable = artifactErrorDetails(error, "ATTACHMENT_NOT_SAVABLE");
    const uploading = notSavable?.reason === "uploading";
    const reason: SaveFailureReason = notSavable
      ? uploading ? "artifacts.attachment.uploading" : "artifacts.attachment.tooLarge"
      : code === "ATTACHMENT_NOT_FOUND"
        ? "artifacts.attachment.notFound"
        // The copy counts against the server's monthly file upload quota, as an upload does.
        : code === "FILE_UPLOAD_QUOTA_EXCEEDED"
          ? "upgradeDialog.uploadQuota.title"
          : "artifacts.attachment.saveFailed";
    // Too large, gone, or out of quota: the same save fails again, so no Retry.
    const retryable = uploading || reason === "artifacts.attachment.saveFailed";
    setAttempt(attachment.id, { status: "failed", reason, retry: retryable ? { attachment, context } : null });
  }
}

/**
 * The attachment's ⋯ (W15 2.7): Download and Save as Artifact. Shown only
 * while it can be saved; once saved, the line under it takes over (2.8).
 */
function AttachmentMenu({ attachment, context }: { attachment: ArtifactAttachmentInput; context: ArtifactAttachmentContext }) {
  const { formatMessage } = useIntl();
  const saving = useSaveAttempts((state) => state.attempts[attachment.id]?.status === "saving");
  const label = formatMessage({ id: "artifacts.attachment.more" }, { filename: attachment.filename });
  const save = useCallback(() => {
    // An upload entry like the composer's: a used-up month opens the upgrade dialog instead.
    if (artifactShareHost().uploadLimits?.openIfUsedUp(attachment.sizeBytes)) return;
    void saveAttachment(attachment, context, formatMessage);
  }, [attachment, context, formatMessage]);
  return (
    <DropdownMenu>
      <Tooltip content={label}>
        <DropdownMenuTrigger
          render={(
            // Over the card's meta row, where its own action sits (the card itself is a button).
            <MessageAttachmentAction
              aria-label={label}
              className="absolute bottom-[var(--control-embedded-inset)] right-[var(--control-embedded-inset)] m-0"
              data-testid="artifact-attachment-menu-trigger"
            >
              <EllipsisVertical />
            </MessageAttachmentAction>
          )}
        />
      </Tooltip>
      <DropdownMenuContent side="bottom" align="end" sideOffset={4} aria-label={label} data-testid="artifact-attachment-menu">
        <DropdownMenuItem onClick={context.onDownload}>
          <Download />
          {formatMessage({ id: "artifacts.attachment.download" })}
        </DropdownMenuItem>
        {/* While it saves, the line under the attachment says so; a second click starts nothing. */}
        <DropdownMenuItem onClick={save} disabled={saving} data-testid="artifact-attachment-save">
          <ArtifactIcon />
          {formatMessage({ id: "artifacts.attachment.save" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * "Saved as Artifact <title> v1" under the attachment (F7, W15 2.8); a click
 * opens it in place (openArtifactInPlace). One the viewer can't see has no title or
 * version (F11): only that it was saved, and the id-only link.
 */
function SavedLine({ reference, filename }: { reference: ArtifactReference; filename: string | null }) {
  const { formatMessage } = useIntl();
  const target = useMemo(() => {
    if (reference.status === "ok") return { id: reference.card.id, version: null };
    // Saves never list a deleted Artifact (ArtifactWebAttachmentSaves); any other status draws nothing.
    if (reference.status !== "unavailable") return null;
    const parsed = parseArtifactRef(reference.url);
    return parsed.kind === "id" ? { id: parsed.id, version: null } : null;
  }, [reference]);
  const handleClick = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (target) openArtifactOnPlainClick(event, target, "link");
  }, [target]);
  if (!target) return null;
  // Which attachment, where there are several: its file name, never the Artifact's title (F11).
  const unavailableText = filename
    ? formatMessage({ id: "artifacts.attachment.savedAsUnavailableNamed" }, { filename })
    : formatMessage({ id: "artifacts.attachment.savedAsUnavailable" });
  // Built from the id, never the payload's address.
  const href = artifactUrl(target.id, null);
  return (
    <p className="flex min-w-0 max-w-[22.5rem] items-center gap-1.5 text-footnote text-foreground-muted" data-testid="artifact-attachment-saved">
      {/* The Artifact icon says "saved as Artifact" (#250: no words before the title); a screen reader hears them. */}
      {reference.status === "ok" ? (
        <>
          <Tooltip content={formatMessage({ id: "artifacts.attachment.savedAs" })}>
            <span role="img" aria-label={formatMessage({ id: "artifacts.attachment.savedAs" })} className="flex shrink-0" data-testid="artifact-attachment-saved-mark">
              <ArtifactIcon width={14} height={14} aria-hidden="true" />
            </span>
          </Tooltip>
          <TextLink
            variant="strong"
            render={<a href={href} target="_blank" rel="noopener noreferrer" onClick={handleClick} aria-label={reference.card.title} data-testid="artifact-attachment-saved-link" />}
            className="min-w-0 truncate"
          >
            {reference.card.title}
          </TextLink>
          <ArtifactVersionBadge version={reference.card.version} />
        </>
      ) : (
        <>
          <ArtifactIcon width={14} height={14} className="shrink-0" aria-hidden="true" />
          <TextLink
            render={<a href={href} target="_blank" rel="noopener noreferrer" onClick={handleClick} aria-label={unavailableText} data-testid="artifact-attachment-saved-link" />}
            className="min-w-0 truncate"
          >
            {unavailableText}
          </TextLink>
        </>
      )}
    </p>
  );
}

/**
 * The Artifact an attachment was saved as, for this viewer: what the caller
 * knows, else the server's (`attachmentSaves`, asked once per attachment
 * while the flag is on), else what this session saved.
 */
function useSavedAs(attachment: ArtifactAttachmentInput, enabled: boolean): ArtifactReference | null {
  const savedHere = useSavedThisSession((state) => state.saved[attachment.id]);
  const fetched = useAttachmentSaves((state) => state.saves[attachment.id]);
  // Asked once it is on screen: not with the flag off, while it uploads, or when the caller knows.
  const askedId = enabled && attachment.savedAsArtifact === undefined && !isUploading(attachment) ? attachment.id : "";
  useEffect(() => {
    requestAttachmentSaves(askedId === "" ? [] : [askedId]);
  }, [askedId]);
  // The server's answer wins (it may be newer: deleted, moved out of reach); absent or null means "not known yet".
  return attachment.savedAsArtifact ?? fetched ?? savedHere ?? null;
}

/**
 * The attachment's ⋯ with Save as Artifact (S5, W15 2.7), drawn over the card
 * (AttachmentChip's `menu`), while it can be saved: null once saved, and with
 * workspace_artifacts_v0 off.
 */
export function useArtifactAttachmentMenu(attachment: ArtifactAttachmentInput, context: ArtifactAttachmentContext): ReactNode {
  const enabled = useWorkspaceArtifactsEnabled();
  const saved = useSavedAs(attachment, enabled);
  if (!enabled || saved || !canSaveAsArtifact(attachment)) return null;
  return <AttachmentMenu attachment={attachment} context={context} />;
}

function RetryLink({ retry }: { retry: { attachment: ArtifactAttachmentInput; context: ArtifactAttachmentContext } }) {
  const { formatMessage } = useIntl();
  const handleClick = useCallback(() => {
    void saveAttachment(retry.attachment, retry.context, formatMessage);
  }, [retry, formatMessage]);
  return (
    <TextLink variant="strong" className="shrink-0" onClick={handleClick} data-testid="artifact-attachment-save-retry">
      {formatMessage({ id: "artifacts.attachment.retry" })}
    </TextLink>
  );
}

/** The saving and failed lines keep the saved line's height (its version badge is 22px), so the turn doesn't move what is under it. */
const ATTEMPT_LINE = "flex min-h-[22px] min-w-0 max-w-[22.5rem] items-center gap-1.5 text-footnote text-foreground-muted";

/**
 * "Saving as Artifact…" with the spinner in the icon's place, or why the
 * save failed and Retry, in the place the saved line will take. No animation
 * of its own: the spinner is the only thing that moves (Motion), and the
 * saved line replaces it at once.
 */
function AttemptLine({ attempt, filename }: { attempt: SaveAttempt; filename: string | null }) {
  const { formatMessage } = useIntl();
  if (attempt.status === "saving") {
    return (
      <p className={ATTEMPT_LINE} role="status" data-testid="artifact-attachment-saving">
        <span className="flex size-3.5 shrink-0 items-center justify-center" aria-hidden="true"><Spinner size="xs" aria-hidden="true" /></span>
        <span className="min-w-0 truncate">
          {filename
            ? formatMessage({ id: "artifacts.attachment.savingNamed" }, { filename })
            : formatMessage({ id: "artifacts.attachment.saving" })}
        </span>
      </p>
    );
  }
  const reason = formatMessage({ id: attempt.reason });
  return (
    <p className={ATTEMPT_LINE} role="alert" data-testid="artifact-attachment-save-failed">
      <TriangleAlert size={14} className="shrink-0 text-warning-strong" aria-hidden="true" />
      <span className="min-w-0">
        {filename ? formatMessage({ id: "artifacts.attachment.failedNamed" }, { filename, reason }) : reason}
      </span>
      {attempt.retry ? <RetryLink retry={attempt.retry} /> : null}
    </p>
  );
}

function SavedLineFor({ attachment, many }: { attachment: ArtifactAttachmentInput; many: boolean }) {
  const saved = useSavedAs(attachment, true);
  const attempt = useSaveAttempts((state) => state.attempts[attachment.id]);
  const filename = many ? attachment.filename : null;
  if (saved) return <SavedLine reference={saved} filename={filename} />;
  return attempt ? <AttemptLine attempt={attempt} filename={filename} /> : null;
}

/**
 * The "Saved as Artifact" lines under a message's attachments (F7, W15 2.8),
 * one per saved attachment, after the group so the cards keep their row.
 * Nothing with workspace_artifacts_v0 off. This viewer's view of the
 * Artifacts: a share image never includes them (selectScreenshot.ts,
 * viewer-only previews).
 */
export function ArtifactSavedAttachments({ attachments }: { attachments: readonly ArtifactAttachmentInput[] }) {
  const enabled = useWorkspaceArtifactsEnabled();
  if (!enabled || attachments.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="artifact-attachment-saved-lines" data-select-screenshot-viewer-only="true">
      {attachments.map((attachment) => <SavedLineFor key={attachment.id} attachment={attachment} many={attachments.length > 1} />)}
    </div>
  );
}

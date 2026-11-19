import {
  FeedbackTransportError,
} from "@botiverse/hands-feedback-react";
import type {
  FeedbackAttachment,
  FeedbackClient,
  FeedbackComment,
  FeedbackKind,
  FeedbackTicketDetail,
  FeedbackTicketSummary,
  HandsFeedbackTransport,
} from "@botiverse/hands-feedback-react";
import type { ProductFeedbackAppSource } from "@botiverse/raft-shared";
import type { AxiosInstance } from "axios";
import {
  feedbackTicketPlatformOf,
  feedbackTicketPlatformParams,
  rememberFeedbackTicketPlatform,
} from "./feedbackTicketPlatform";
import { productFeedbackForm } from "./productFeedbackForm";
import {
  FEEDBACK_LIST_ALL_SOURCES,
  FEEDBACK_LIST_DEGRADED_OK,
  degradedRetryAfterMs,
  feedbackListUnread,
  isDegradedFeedbackPage,
  isProductFeedbackAppSource,
} from "./productFeedbackListContract";
import type { ApiDegradedTicketPage, FeedbackListUnread, FeedbackUnreadBySource } from "./productFeedbackListContract";

type ApiTicket = {
  id: string;
  kind: "feedback" | "bug" | "crash";
  status: "open" | "in_progress" | "resolved" | "closed";
  closure_reason: "completed" | "no_longer_needed" | "not_planned"
    | "cannot_reproduce" | "duplicate" | null;
  duplicate_of_ticket_id: string | null;
  message: string;
  created_at: number;
  updated_at: number;
  unread: boolean;
  unread_count: number;
  attachment_count: number;
  comment_count: number;
  /** The Hands app the ticket lives in (`?sources=all`, server #14722); absent from older servers. */
  source?: ProductFeedbackAppSource;
  /** The Raft client it was filed from, a label only (`web|desktop|android|ios|ohos`). */
  client?: string;
  /** List pages only; absent from detail responses and older servers. */
  latest_comment?: {
    author_type: "reporter" | "staff" | "system";
    body_preview: string;
    created_at: number;
  } | null;
};
type ApiComment = {
  id: string;
  author_type: "reporter" | "staff" | "system";
  body: string;
  created_at: number;
};

type ApiAttachment = {
  id: string;
  filename: string;
  content_type: string | null;
  size_bytes: number;
  created_at: number;
};

type ApiTicketPage = {
  tickets: ApiTicket[];
  next_cursor: string | null;
  /** Null or absent: not known on this page (a cursor page, an app that failed); keep the last value. */
  unread_total?: number | null;
  /** First page of `?sources=all` only, and not yet on every server (productFeedbackListContract.ts). */
  unread_by_source?: FeedbackUnreadBySource;
};

type ApiTicketDetail = {
  ticket: ApiTicket;
  comments: ApiComment[];
  attachments: ApiAttachment[];
  next_comment_cursor: string | null;
  unread_total: number;
};

/**
 * A degraded first page is retried, never shown: starting at the server's
 * `retry_after_seconds`, doubling up to this cap, until a real page arrives or
 * the list's signal aborts (unmount, a newer load).
 */
const DEGRADED_RETRY_MAX_MS = 60_000;

/** Resolves after `ms`; rejects (and clears the timer) as soon as `signal` aborts. */
function waitForRetry(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => signal?.reason ?? new DOMException("Aborted", "AbortError");
    if (signal?.aborted) {
      reject(aborted());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(aborted());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function ticketKind(kind: ApiTicket["kind"]): FeedbackKind {
  return kind === "feedback" ? "feedback" : "bug";
}

const FEEDBACK_CLIENTS: readonly FeedbackClient[] = ["web", "desktop", "android", "ios", "ohos"];

function feedbackClient(value: unknown): FeedbackClient | null {
  return (FEEDBACK_CLIENTS as readonly unknown[]).includes(value) ? (value as FeedbackClient) : null;
}

/**
 * Every call about a ticket goes to the app it lives in: a ticket of a mobile
 * App's carries `?platform=` from now on (feedbackTicketPlatform.ts).
 */
function rememberTicketApp(ticket: ApiTicket) {
  rememberFeedbackTicketPlatform(ticket.id, feedbackTicketPlatformOf(ticket.source));
}

function mapTicket(ticket: ApiTicket): FeedbackTicketSummary {
  const client = feedbackClient(ticket.client);
  return {
    id: ticket.id,
    kind: ticketKind(ticket.kind),
    status: ticket.status,
    closureReason: ticket.closure_reason,
    duplicateOfTicketId: ticket.duplicate_of_ticket_id,
    message: ticket.message,
    createdAt: ticket.created_at,
    updatedAt: ticket.updated_at,
    unread: ticket.unread,
    unreadCount: ticket.unread_count,
    attachmentCount: ticket.attachment_count,
    commentCount: ticket.comment_count,
    // A client this build doesn't know is dropped: the row then names none.
    ...(client ? { client } : {}),
    ...(ticket.latest_comment === undefined
      ? {}
      : {
          latestComment: ticket.latest_comment
            ? {
                authorType: ticket.latest_comment.author_type,
                bodyPreview: ticket.latest_comment.body_preview,
                createdAt: ticket.latest_comment.created_at,
              }
            : null,
        }),
  };
}

function mapComment(comment: ApiComment): FeedbackComment {
  return {
    id: comment.id,
    authorType: comment.author_type,
    body: comment.body,
    createdAt: comment.created_at,
  };
}

function mapAttachment(attachment: ApiAttachment): FeedbackAttachment {
  return {
    id: attachment.id,
    filename: attachment.filename,
    contentType: attachment.content_type ?? "application/octet-stream",
    sizeBytes: attachment.size_bytes,
    createdAt: attachment.created_at,
  };
}

function mapDetail(detail: ApiTicketDetail): FeedbackTicketDetail {
  return {
    ticket: mapTicket(detail.ticket),
    comments: detail.comments.map(mapComment),
    attachments: detail.attachments.map(mapAttachment),
    nextCommentCursor: detail.next_comment_cursor,
    unreadTotal: detail.unread_total,
  };
}

function responseCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const response = (error as { response?: { data?: unknown } }).response;
  if (!response?.data || typeof response.data !== "object") return null;
  const code = (response.data as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function responseStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as { response?: { status?: unknown } }).response?.status;
  return typeof status === "number" ? status : null;
}

export function feedbackTransportError(error: unknown): FeedbackTransportError {
  if (error instanceof FeedbackTransportError) return error;
  const code = responseCode(error);
  if (code === "feedback_submission_conflict" || code === "feedback_comment_conflict") {
    return new FeedbackTransportError("conflict", { cause: error });
  }
  if (code === "feedback_not_found") {
    return new FeedbackTransportError("not_found", { cause: error });
  }
  if (code === "feedback_rate_limited") {
    return new FeedbackTransportError("rate_limited", { cause: error });
  }
  if (
    code === "feedback_invalid"
    || code === "feedback_attachment_too_large"
    || code === "feedback_attachment_type_invalid"
    || code === "feedback_attachment_count_invalid"
    || code === "feedback_upload_invalid"
  ) {
    return new FeedbackTransportError("invalid", { cause: error });
  }
  if (responseStatus(error) === 401 || responseStatus(error) === 403) {
    return new FeedbackTransportError("unauthorized", { cause: error });
  }
  return new FeedbackTransportError("unavailable", { cause: error });
}

function reportProgress(
  attachments: File[],
  progress: number,
  callback?: (input: { index: number; progress: number }) => void,
): void {
  attachments.forEach((_attachment, index) => callback?.({ index, progress }));
}

function createUploadProgressReporter(
  attachments: File[],
  callback?: (input: { index: number; progress: number }) => void,
) {
  let latest = 0;
  reportProgress(attachments, latest, callback);
  return (event: { loaded: number; total?: number; progress?: number }) => {
    const measured = typeof event.progress === "number"
      ? event.progress
      : event.total && event.total > 0
        ? event.loaded / event.total
        : null;
    if (measured === null || !Number.isFinite(measured)) return;
    const next = Math.max(latest, Math.min(0.99, Math.max(0, measured)));
    if (next === latest) return;
    latest = next;
    reportProgress(attachments, latest, callback);
  };
}

export function createHandsFeedbackTransport(api: AxiosInstance, options: {
  metadata?: () => Promise<Record<string, string> | null>;
  /**
   * List every Hands app's tickets (`?sources=all`), not just the caller's.
   * Only for a caller whose own app is the web's (the web and desktop app): a
   * ticket of the web's is then asked for without `?platform=`, which the
   * server answers from the caller's own app.
   */
  allSources?: boolean;
  /** Captured when a ticket read is sent; called with the total of the ticket's app. */
  captureUnread?: () => (count: number, source: ProductFeedbackAppSource) => void;
  /**
   * Like `captureUnread`, for the first list page's unread totals: captured
   * when the read is sent, called with a real page's (not a degraded page's).
   */
  captureListUnread?: () => (unread: FeedbackListUnread) => void;
  /**
   * The first page is degraded and being retried (true), or a retry ended:
   * a real page, an error, or the list went away (false). The host shows
   * "can't load right now, retrying" meanwhile.
   */
  onListDegradedChange?: (degraded: boolean) => void;
  diagnostics?: { r2_key: string; filename: string; content_type: string; size: number } | null;
} = {}): HandsFeedbackTransport {
async function getTicket(
  input: Parameters<HandsFeedbackTransport["getTicket"]>[0],
): Promise<FeedbackTicketDetail> {
  const updateUnread = options.captureUnread?.() ?? (() => {});
  const platformParams = feedbackTicketPlatformParams(input.ticketId);
  try {
    const { data } = await api.get<ApiTicketDetail>(
      `/product-feedback/tickets/${encodeURIComponent(input.ticketId)}`,
      {
        params: {
          comment_limit: input.commentLimit,
          ...(input.commentCursor ? { comment_cursor: input.commentCursor } : {}),
          ...platformParams,
        },
        signal: input.signal,
      },
    );
    rememberTicketApp(data.ticket);
    // The total is of the ticket's app (feedbackUnreadState.ts decides whether
    // the web's dot counts it).
    const source = data.ticket.source;
    updateUnread(data.unread_total, isProductFeedbackAppSource(source) ? source : platformParams.platform ?? "web");
    return mapDetail(data);
  } catch (error) {
    throw feedbackTransportError(error);
  }
}

// The first-page read currently waiting out a degraded answer, if any. Only
// that read may end the degraded state on abort or error; a real page from any
// read ends it.
let degradedRead: object | null = null;
function setListDegraded(read: object, degraded: boolean) {
  if (degraded) {
    const changed = degradedRead === null;
    degradedRead = read;
    if (changed) options.onListDegradedChange?.(true);
    return;
  }
  if (degradedRead !== read) return;
  degradedRead = null;
  options.onListDegradedChange?.(false);
}

/** How many empty pages with a next cursor one list read follows. */
const MAX_EMPTY_PAGE_HOPS = 5;

// The last total a list page knew, for a page that doesn't: the SDK takes a
// page's `unreadTotal` as a number.
let lastListUnreadTotal = 0;

return {
  async listTickets(input) {
    const read = {};
    const updateUnread = options.captureListUnread?.() ?? (() => {});
    let retryMs: number | null = null;
    // A merged page can come back with no tickets and a next cursor (an app's
    // page was all filtered out). The SDK would draw an empty first page as
    // "no feedback yet", so follow the cursor, a few pages at most, until a
    // page has tickets or the list ends.
    let cursor = input.cursor;
    let emptyHops = 0;
    try {
      for (;;) {
        const { data } = await api.get<ApiTicketPage | ApiDegradedTicketPage>("/product-feedback/tickets", {
          params: {
            limit: input.limit,
            ...(options.allSources ? FEEDBACK_LIST_ALL_SOURCES : {}),
            // Only the first page can degrade (server #12566); a later page
            // still 503s, since an empty page there would read as the end.
            ...(cursor ? { cursor } : FEEDBACK_LIST_DEGRADED_OK),
          },
          signal: input.signal,
        });
        if (!isDegradedFeedbackPage(data)) {
          if (degradedRead) setListDegraded(degradedRead, false);
          // A cursor page's totals are null or absent: nothing to update.
          const unread = feedbackListUnread(data);
          updateUnread(unread);
          // The SDK's total is the dot's number: with an app unavailable the
          // total is null but the answering apps' shares still add up.
          lastListUnreadTotal = unread.total
            ?? (unread.bySource ? Object.values(unread.bySource).reduce((sum, count) => sum + count, 0) : null)
            ?? lastListUnreadTotal;
          data.tickets.forEach(rememberTicketApp);
          if (data.tickets.length === 0 && data.next_cursor && emptyHops < MAX_EMPTY_PAGE_HOPS) {
            emptyHops += 1;
            cursor = data.next_cursor;
            continue;
          }
          return {
            tickets: data.tickets.map(mapTicket),
            nextCursor: data.next_cursor,
            unreadTotal: lastListUnreadTotal,
          };
        }
        // Not "no feedback", and unread_total is unknown (null): resolving
        // would draw the empty state and report an unread count. Keep the SDK
        // loading (or showing the list it has) and ask again.
        setListDegraded(read, true);
        retryMs = retryMs === null
          ? Math.min(degradedRetryAfterMs(data), DEGRADED_RETRY_MAX_MS)
          : Math.min(retryMs * 2, DEGRADED_RETRY_MAX_MS);
        await waitForRetry(retryMs, input.signal);
      }
    } catch (error) {
      setListDegraded(read, false);
      throw feedbackTransportError(error);
    }
  },

  getTicket,

  async getAttachment(input) {
    try {
      const { data } = await api.get<Blob>(
        `/product-feedback/tickets/${encodeURIComponent(input.ticketId)}/attachments/${encodeURIComponent(input.attachmentId)}`,
        { responseType: "blob", params: feedbackTicketPlatformParams(input.ticketId), signal: input.signal },
      );
      return data;
    } catch (error) {
      throw feedbackTransportError(error);
    }
  },

  async createTicket(input) {
    const form = productFeedbackForm({
      type: input.kind === "feedback" ? "idea" : "problem",
      message: input.message,
      submissionId: input.submissionId,
      metadata: await options.metadata?.(),
    });
    if (options.diagnostics) form.set("diagnostics", JSON.stringify(options.diagnostics));
    input.attachments.forEach((attachment) => {
      form.append("attachments", attachment, attachment.name);
    });
    const onUploadProgress = createUploadProgressReporter(
      input.attachments,
      input.onAttachmentProgress,
    );
    try {
      const { data } = await api.post<{ id: string }>("/product-feedback", form, {
        signal: input.signal,
        onUploadProgress,
      });
      reportProgress(input.attachments, 1, input.onAttachmentProgress);
      return await getTicket({
        ticketId: data.id,
        commentLimit: 100,
        signal: input.signal,
      });
    } catch (error) {
      throw feedbackTransportError(error);
    }
  },

  async addComment(input) {
    const form = new FormData();
    form.set("body", input.body);
    form.set("submission_id", input.submissionId);
    input.attachments.forEach((attachment) => {
      form.append("attachments", attachment, attachment.name);
    });
    const onUploadProgress = createUploadProgressReporter(
      input.attachments,
      input.onAttachmentProgress,
    );
    try {
      await api.post(
        `/product-feedback/tickets/${encodeURIComponent(input.ticketId)}/comments`,
        form,
        { params: feedbackTicketPlatformParams(input.ticketId), signal: input.signal, onUploadProgress },
      );
      reportProgress(input.attachments, 1, input.onAttachmentProgress);
      return await getTicket({
        ticketId: input.ticketId,
        commentLimit: 100,
        signal: input.signal,
      });
    } catch (error) {
      throw feedbackTransportError(error);
    }
  },

  async closeTicket(input) {
    try {
      await api.post(
        `/product-feedback/tickets/${encodeURIComponent(input.ticketId)}/close`,
        { reason: input.reason },
        { params: feedbackTicketPlatformParams(input.ticketId), signal: input.signal },
      );
      return await getTicket({
        ticketId: input.ticketId,
        commentLimit: 100,
        signal: input.signal,
      });
    } catch (error) {
      throw feedbackTransportError(error);
    }
  },
};

}

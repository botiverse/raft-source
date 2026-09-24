import {
  FeedbackTransportError,
} from "@botiverse/hands-feedback-react/source";
import type {
  FeedbackAttachment,
  FeedbackComment,
  FeedbackKind,
  FeedbackTicketDetail,
  FeedbackTicketSummary,
  HandsFeedbackTransport,
} from "@botiverse/hands-feedback-react/source";
import api from "../api/client";

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
  unread_total: number;
};

type ApiTicketDetail = {
  ticket: ApiTicket;
  comments: ApiComment[];
  attachments: ApiAttachment[];
  next_comment_cursor: string | null;
  unread_total: number;
};

function ticketKind(kind: ApiTicket["kind"]): FeedbackKind {
  return kind === "feedback" ? "feedback" : "bug";
}

function mapTicket(ticket: ApiTicket): FeedbackTicketSummary {
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

async function getTicket(
  input: Parameters<HandsFeedbackTransport["getTicket"]>[0],
): Promise<FeedbackTicketDetail> {
  try {
    const { data } = await api.get<ApiTicketDetail>(
      `/product-feedback/tickets/${encodeURIComponent(input.ticketId)}`,
      {
        params: {
          comment_limit: input.commentLimit,
          ...(input.commentCursor ? { comment_cursor: input.commentCursor } : {}),
        },
        signal: input.signal,
      },
    );
    return mapDetail(data);
  } catch (error) {
    throw feedbackTransportError(error);
  }
}

export const handsFeedbackTransport: HandsFeedbackTransport = {
  async listTickets(input) {
    try {
      const { data } = await api.get<ApiTicketPage>("/product-feedback/tickets", {
        params: {
          limit: input.limit,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        },
        signal: input.signal,
      });
      return {
        tickets: data.tickets.map(mapTicket),
        nextCursor: data.next_cursor,
        unreadTotal: data.unread_total,
      };
    } catch (error) {
      throw feedbackTransportError(error);
    }
  },

  getTicket,

  async getAttachment(input) {
    try {
      const { data } = await api.get<Blob>(
        `/product-feedback/tickets/${encodeURIComponent(input.ticketId)}/attachments/${encodeURIComponent(input.attachmentId)}`,
        { responseType: "blob", signal: input.signal },
      );
      return data;
    } catch (error) {
      throw feedbackTransportError(error);
    }
  },

  async createTicket(input) {
    const form = new FormData();
    form.set("type", input.kind === "feedback" ? "idea" : "problem");
    form.set("message", input.message);
    form.set("submission_id", input.submissionId);
    form.set("may_contact", "false");
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
        { signal: input.signal, onUploadProgress },
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
        { signal: input.signal },
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

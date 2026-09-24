import {
  FeedbackProvider,
  FeedbackWorkspace,
} from "@botiverse/hands-feedback-react/source";
import type {
  FeedbackTicketDetail,
  FeedbackTicketSummary,
  HandsFeedbackTransport,
} from "@botiverse/hands-feedback-react/source";
import "@botiverse/hands-feedback-react/source/styles.css";

const TRIAL_TICKET_ID = "feedback-sdk-trial-ticket";
const FIXTURE_NOW = Date.UTC(2026, 6, 25, 15, 0, 0);

const tickets: FeedbackTicketSummary[] = [
  {
    id: TRIAL_TICKET_ID,
    kind: "feedback",
    status: "in_progress",
    closureReason: null,
    duplicateOfTicketId: null,
    message: "Let me keep the app open when I switch workspaces",
    createdAt: FIXTURE_NOW - 3 * 86_400_000,
    updatedAt: FIXTURE_NOW - 18 * 60_000,
    unread: true,
    unreadCount: 2,
    attachmentCount: 1,
    commentCount: 3,
  },
  {
    id: "feedback-sdk-trial-resolved",
    kind: "bug",
    status: "resolved",
    closureReason: null,
    duplicateOfTicketId: null,
    message: "Notification badge did not clear after opening Activity",
    createdAt: FIXTURE_NOW - 8 * 86_400_000,
    updatedAt: FIXTURE_NOW - 2 * 86_400_000,
    unread: false,
    unreadCount: 0,
    attachmentCount: 0,
    commentCount: 2,
  },
];

function trialDetail(ticket = tickets[0]!): FeedbackTicketDetail {
  return {
    ticket: { ...ticket, unread: false, unreadCount: 0 },
    unreadTotal: 0,
    nextCommentCursor: null,
    attachments: [
      {
        id: "feedback-sdk-trial-attachment",
        filename: "workspace-switch.png",
        contentType: "image/png",
        sizeBytes: 184_320,
        createdAt: FIXTURE_NOW - 3 * 86_400_000,
      },
    ],
    comments: [
      {
        id: "feedback-sdk-trial-comment-1",
        authorType: "reporter",
        body: "The current workspace reloads whenever I switch away and come back.",
        createdAt: FIXTURE_NOW - 3 * 86_400_000,
      },
      {
        id: "feedback-sdk-trial-comment-2",
        authorType: "staff",
        body: "Thanks — we reproduced this and are testing a fix in preview.",
        createdAt: FIXTURE_NOW - 20 * 60_000,
      },
      {
        id: "feedback-sdk-trial-comment-3",
        authorType: "staff",
        body: "The fix is ready for the next desktop build. We will update this ticket when it ships.",
        createdAt: FIXTURE_NOW - 18 * 60_000,
      },
    ],
  };
}

const trialTransport: HandsFeedbackTransport = {
  async listTickets() {
    return { tickets, nextCursor: null, unreadTotal: 2 };
  },
  async getTicket({ ticketId }) {
    return trialDetail(
      tickets.find((ticket) => ticket.id === ticketId) ?? tickets[0],
    );
  },
  async createTicket({ kind, message, onAttachmentProgress }) {
    onAttachmentProgress?.({ index: 0, progress: 1 });
    return trialDetail({
      ...tickets[0]!,
      id: "feedback-sdk-trial-created",
      kind,
      message,
      createdAt: FIXTURE_NOW,
      updatedAt: FIXTURE_NOW,
    });
  },
  async addComment({ ticketId, body, onAttachmentProgress }) {
    onAttachmentProgress?.({ index: 0, progress: 1 });
    const detail = trialDetail(
      tickets.find((ticket) => ticket.id === ticketId) ?? tickets[0],
    );
    return {
      ...detail,
      comments: [
        ...detail.comments,
        {
          id: "feedback-sdk-trial-comment-new",
          authorType: "reporter",
          body,
          createdAt: FIXTURE_NOW,
        },
      ],
    };
  },
  async closeTicket({ ticketId, reason }) {
    const detail = trialDetail(
      tickets.find((ticket) => ticket.id === ticketId) ?? tickets[0],
    );
    return {
      ...detail,
      ticket: {
        ...detail.ticket,
        status: "closed",
        closureReason: reason,
        updatedAt: FIXTURE_NOW,
      },
    };
  },
};

export default function FeedbackSdkTrial({
  detail = false,
  narrow = false,
}: {
  detail?: boolean;
  narrow?: boolean;
}) {
  const caseId = narrow
    ? detail
      ? "screens.feedback-sdk.detail.narrow"
      : "screens.feedback-sdk.inbox.narrow"
    : detail
      ? "screens.feedback-sdk.detail"
      : "screens.feedback-sdk.inbox";
  return (
    <main className="min-h-screen bg-layer-page p-0 font-display text-foreground">
      <div
        data-visual-case={caseId}
        className="overflow-hidden bg-layer-page"
        style={{ width: narrow ? 390 : 760, height: narrow ? 844 : 720 }}
      >
        <FeedbackProvider transport={trialTransport} theme="brutal" locale="en">
          <FeedbackWorkspace
            {...(detail ? { initialTicketId: TRIAL_TICKET_ID } : {})}
          />
        </FeedbackProvider>
      </div>
    </main>
  );
}

// RFC 081 inbox items: the contract the server, the CLI and the shared
// formatter share (rows of `inbox check`, `inbox read`, `inbox dismiss`).
import { describe, expect, it } from "vitest";
import {
  AGENT_INBOX_OBJECT_REF_PATTERN,
  AGENT_INBOX_READ_MAX_ENTRIES,
  agentApiContract,
  agentApiInboxDismissBodySchema,
  agentApiInboxDismissResponseSchema,
  agentApiInboxErrorSchema,
  agentApiInboxItemRowSchema,
  agentApiInboxListQuerySchema,
  agentApiInboxListResponseSchema,
  agentApiInboxReadBodySchema,
  agentApiInboxReadResponseSchema,
  agentApiMessageEnvelopeSchema,
  type AgentApiInboxItemRow,
} from "./agentApiContract";
import { AGENT_API_ROUTE_META, getAgentApiRetryPolicy } from "./agentApiRouteMeta";
import { assistantDelegationCategory } from "./assistantDelegationPolicy";
import { AGENT_API_ROUTE_MANIFEST } from "./generated/agentApiRoutes";

const REMINDER_ID = "76d9397d-1111-4222-8333-444444444444";

/** A valid provenance: an entry carrying it must say `third_party_app`, as any envelope must. */
const agentApiMessageEnvelopeExternalFixture = {
  schema: "external-message-provenance.v1",
  provider: "slack",
  workspace_id: "T1",
  conversation_id: "C1",
  message_id: "1700000000.000100",
  actor_id: "U1",
  actor_kind: "human",
  projection_id: "99999999-9999-4999-8999-999999999999",
};

const rows: AgentApiInboxItemRow[] = [
  {
    target: "reminder:76d9397d",
    kind: "reminder",
    app: { key: "system.reminder", name: "Reminder" },
    ack: [
      { app: "system.reminder", id: REMINDER_ID, revision: "1" },
      { app: "system.reminder", id: REMINDER_ID, revision: "2" },
    ],
    unread: 2,
    latestSender: { name: "Reminder", type: "system" },
    preview: "Check the deploy",
    previewTruncated: false,
    firstUnreadAt: "2026-11-09T08:00:00.000Z",
    latestAt: "2026-11-09T09:00:00.000Z",
    preLaunch: false,
  },
  {
    target: "app:stamp/pr-13754",
    kind: "app",
    app: { key: "stamp", name: "Stamp" },
    objectRef: "pr-13754",
    related: { target: "#proj-workspace:#232" },
    unread: 3,
    latestSender: { name: "Stamp", type: "app" },
    preview: "checks failed on 3f4b1fd4 for the second time in a row, see th",
    previewTruncated: true,
    firstUnreadAt: "2026-11-09T10:00:00.000Z",
    latestAt: "2026-11-09T10:05:00.000Z",
    preLaunch: false,
  },
  {
    target: "app:stamp",
    kind: "app_fallback",
    app: { key: "stamp", name: "Stamp" },
    related: null,
    unread: 1,
    latestSender: { name: "Stamp", type: "app" },
    preview: null,
    previewTruncated: false,
    firstUnreadAt: "2026-11-09T10:01:00.000Z",
    latestAt: "2026-11-09T10:01:00.000Z",
    preLaunch: false,
  },
  {
    target: "#proj-workspace",
    kind: "conversation",
    conversationKind: "channel",
    mentions: 1,
    lastReadSeq: 1199,
    activitySeq: 1203,
    unread: 3,
    latestSender: { name: "Tenny", type: "agent" },
    preview: "the leased events come first on every page",
    previewTruncated: false,
    firstUnreadAt: "2026-11-01T10:00:00.000Z",
    latestAt: "2026-11-01T10:02:00.000Z",
    preLaunch: true,
  },
];

describe("RFC 081 inbox items contract", () => {
  it("round-trips every row kind", () => {
    for (const row of rows) expect(agentApiInboxItemRowSchema.parse(row)).toEqual(row);
  });

  it("refuses a row without previewTruncated, or of an unknown kind", () => {
    const { previewTruncated: _omit, ...withoutFlag } = rows[1]!;
    expect(agentApiInboxItemRowSchema.safeParse(withoutFlag).success).toBe(false);
    expect(agentApiInboxItemRowSchema.safeParse({ ...rows[1]!, kind: "cleaner" }).success).toBe(false);
  });

  it("keeps the items=false response unchanged and adds rows, preLaunch and omitted only beside it", () => {
    const old = {
      view: "unread",
      items: [{ target: "#proj-workspace", kind: "channel", unread: 3, mentions: 1, lastReadSeq: 1199, activitySeq: 1203, latestSenderName: "Tenny", latestAt: "2026-11-01T10:02:00.000Z" }],
      hasMore: false,
      nextBeforeSeq: null,
      totals: { conversations: 1, dms: 0, mentions: 1 },
    };
    expect(agentApiInboxListResponseSchema.parse(old)).toEqual(old);
    const withItems = { ...old, rows, preLaunch: { count: 1, before: "2026-11-10" }, omitted: null };
    expect(agentApiInboxListResponseSchema.parse(withItems)).toEqual(withItems);
    expect(agentApiInboxListQuerySchema.safeParse({ items: "true" }).success).toBe(true);
    expect(agentApiInboxListQuerySchema.safeParse({ items: "false" }).success).toBe(false);
    expect(agentApiInboxListResponseSchema.safeParse({ ...withItems, preLaunch: { count: 1, before: "11-10" } }).success).toBe(false);
  });

  it("bounds an inbox read request", () => {
    expect(agentApiInboxReadBodySchema.safeParse({ target: "app:stamp/pr-13754" }).success).toBe(true);
    expect(agentApiInboxReadBodySchema.safeParse({ target: "reminder:76d9397d", cursor: "c1", limit: AGENT_INBOX_READ_MAX_ENTRIES }).success).toBe(true);
    expect(agentApiInboxReadBodySchema.safeParse({ target: "app:stamp", limit: AGENT_INBOX_READ_MAX_ENTRIES + 1 }).success).toBe(false);
    expect(agentApiInboxReadBodySchema.safeParse({ target: "app:stamp", limit: 0 }).success).toBe(false);
    expect(agentApiInboxReadBodySchema.safeParse({ target: "  " }).success).toBe(false);
  });

  it("round-trips an inbox read page: an app item, a re-read consumed item, a reminder with an ack per entry", () => {
    const appPage = {
      target: "app:stamp/pr-13754",
      kind: "app",
      entries: [{ id: "77777777-7777-4777-8777-777777777777", senderType: "third_party_app", senderName: "Stamp", content: "checks failed", mentioned: false }],
      unreadBefore: 3,
      remaining: 2,
      remainingCapped: false,
      consumed: false,
      nextCursor: null,
      app: { key: "stamp", name: "Stamp" },
      related: { target: "#proj-workspace:#232" },
    };
    expect(agentApiInboxReadResponseSchema.parse(appPage)).toEqual(appPage);
    const reRead = { ...appPage, entries: [], unreadBefore: 0, remaining: 0, consumed: true };
    expect(agentApiInboxReadResponseSchema.parse(reRead)).toEqual(reRead);
    const reminderPage = {
      target: "reminder:76d9397d",
      kind: "reminder",
      entries: [{ id: "88888888-8888-4888-8888-888888888888", senderType: "system", senderName: "Reminder", content: "Check the deploy", ack: { app: "system.reminder", id: REMINDER_ID, revision: "2" } }],
      unreadBefore: 2,
      remaining: 2,
      remainingCapped: false,
      consumed: false,
      nextCursor: "1",
      ack: [{ app: "system.reminder", id: REMINDER_ID, revision: "2" }],
    };
    expect(agentApiInboxReadResponseSchema.parse(reminderPage)).toEqual(reminderPage);
    expect(agentApiInboxReadResponseSchema.safeParse({ ...appPage, remainingCapped: undefined }).success).toBe(false);
  });

  it("reads an entry whose body has a blank at either end (the 500 of 2026-11-11: an intersection threw on it)", () => {
    const page = (content: string) => ({
      target: "dm:@richard",
      kind: "conversation",
      entries: [{ id: "77777777-7777-4777-8777-777777777777", seq: 4, senderType: "user", senderName: "richard", content, channelId: "kept-as-sent" }],
      unreadBefore: 1,
      remaining: 0,
      remainingCapped: false,
      consumed: true,
      nextCursor: null,
    });
    for (const content of ["sent from a heredoc\n", "    indented first line\nsecond line\n", "\n\nblank lines first", "plain"]) {
      const parsed = agentApiInboxReadResponseSchema.safeParse(page(content));
      expect(parsed.success, JSON.stringify(content)).toBe(true);
      // Both ends, as every Server so far sent it: a CLI up to 1.0.69 fails on anything else.
      expect(parsed.data?.entries[0]).toEqual({ ...page(content).entries[0], content: content.trim() });
    }
    // The envelope's own checks still apply to an entry.
    const external = (senderType: string) => agentApiInboxReadResponseSchema.safeParse({
      ...page("x"),
      entries: [{ content: "x", senderType, mentioned: false, external_message: agentApiMessageEnvelopeExternalFixture }],
    }).success;
    expect([external("third_party_app"), external("user")]).toEqual([true, false]);
  });

  it("a message's body keeps its leading blanks and loses only trailing ones", () => {
    const body = (content: string) => agentApiMessageEnvelopeSchema.parse({ content }).content;
    expect(body("    indented first line\nsecond line\n")).toBe("    indented first line\nsecond line");
    expect(body("\n\nblank lines first  \n\n")).toBe("\n\nblank lines first");
    expect(body("plain")).toBe("plain");
  });

  it("no Agent API schema is an intersection: one throws instead of reporting issues when its sides disagree", () => {
    const found: string[] = [];
    const seen = new Set<unknown>();
    const visit = (value: unknown, path: string): void => {
      if (value === null || typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      const def = (value as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
      if (!def) {
        for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
        return;
      }
      if (def.type === "intersection") found.push(path);
      for (const [key, child] of Object.entries(def)) {
        if (key === "getter" && typeof child === "function") visit((child as () => unknown)(), `${path}.lazy`);
        else visit(child, `${path}.${key}`);
      }
    };
    for (const [key, route] of Object.entries(agentApiContract)) {
      visit((route as { request?: unknown }).request, `${key}.request`);
      visit((route as { response?: unknown }).response, `${key}.response`);
    }
    expect(found).toEqual([]);
    expect(seen.size).toBeGreaterThan(500);
  });

  it("round-trips a dismiss and accepts either form of its body", () => {
    const response = { dismissed: 2, conversations: 1, appItems: 1, skippedNeedsAck: 1, earliestActivityAt: "2026-11-01T00:00:00.000Z", remaining: 0 };
    expect(agentApiInboxDismissResponseSchema.parse(response)).toEqual(response);
    expect(agentApiInboxDismissBodySchema.safeParse({ target: "app:stamp" }).success).toBe(true);
    expect(agentApiInboxDismissBodySchema.safeParse({ before: "2026-11-01" }).success).toBe(true);
  });

  it("names every refusal code", () => {
    for (const errorCode of ["NOT_FOUND", "EXPIRED", "NEEDS_ACK", "INVALID_BEFORE", "BEFORE_TOO_RECENT", "INVALID_ARG", "INVALID_TARGET", "INVALID_CURSOR", "AMBIGUOUS_ID", "INBOX_ITEMS_DISABLED"]) {
      expect(agentApiInboxErrorSchema.safeParse({ error: "x", errorCode }).success).toBe(true);
    }
    expect(agentApiInboxErrorSchema.safeParse({ error: "x", errorCode: "NOPE" }).success).toBe(false);
  });

  it("accepts object refs in the restricted charset, case kept", () => {
    for (const ref of ["pr-13754", "K5P37S9XZRdMzW2ycfhh5P", "botiverse/slock#13754", "a", "v1.2:rc", "pt_3f4b1fd4-1111-4222-8333-444444444444"]) expect(AGENT_INBOX_OBJECT_REF_PATTERN.test(ref)).toBe(true);
    for (const ref of ["", "-x", "x-", "_x", "x_", "has space", "tab\tx", "ünï", "x\n"]) expect(AGENT_INBOX_OBJECT_REF_PATTERN.test(ref)).toBe(false);
  });
});

describe("RFC 081 inbox routes", () => {
  it("declares read and dismiss as POST routes beside the list", () => {
    expect(agentApiContract.inboxRead).toMatchObject({ method: "POST", fullPath: "/internal/agent-api/inbox/read", capability: "read", client: { resource: "inbox", method: "read" } });
    expect(agentApiContract.inboxDismiss).toMatchObject({ method: "POST", fullPath: "/internal/agent-api/inbox/dismiss", capability: "read", client: { resource: "inbox", method: "dismiss" } });
    const paths = AGENT_API_ROUTE_MANIFEST.map((route) => `${route.method} ${route.path}`);
    expect(paths).toEqual(expect.arrayContaining(["POST /inbox/read", "POST /inbox/dismiss"]));
  });

  it("classifies read as a destructive read and dismiss as a destructive write, neither retried", () => {
    expect(AGENT_API_ROUTE_META.inboxRead).toEqual({ sideEffect: "destructive_read", idempotency: "none", destructive: true, audience: "both" });
    expect(AGENT_API_ROUTE_META.inboxDismiss).toMatchObject({ sideEffect: "write", destructive: true, audience: "both" });
    expect(getAgentApiRetryPolicy(AGENT_API_ROUTE_META.inboxRead)).toBe("single_attempt");
  });

  it("delegates neither to an assistant", () => {
    expect(assistantDelegationCategory("inboxRead")).toBeNull();
    expect(assistantDelegationCategory("inboxDismiss")).toBeNull();
  });
});

// server.socket.sync_resume carries how long the resume took (duration_ms) and
// how long its query took (query_ms), on success and on failure, so a deploy's
// reconnect wave can be read in time and not only in rows. A failure also
// says which step failed and the codes from its cause chain (drizzle wraps the
// pg error), never its message.
import assert from "node:assert/strict";
import { vi } from "vitest";

const events: Array<{ name: string; attrs: Record<string, unknown> }> = [];
const sync = vi.fn();

vi.mock("../tracing/semanticTrace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tracing/semanticTrace")>()),
  recordTraceEvent: (name: string, attrs: Record<string, unknown>) => { events.push({ name, attrs }); },
}));
vi.mock("../services/messageService", () => ({
  syncMessagesWithHorizon: (...args: unknown[]) => sync(...args),
  withStorageConversationContexts: async (messages: unknown[]) => messages,
}));
vi.mock("../services/quoteReplyService", () => ({ attachResolvedInlineQuotesForViewer: async (messages: unknown[]) => messages }));
vi.mock("../services/planService", () => ({ getServerPlan: async () => "free", getHistoryCutoff: () => null }));
vi.mock("../metrics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../metrics")>()),
  observeSyncResumeReplay: () => {},
  syncResumeTotal: { labels: () => ({ inc: () => {} }) },
}));

const { attachSyncHandlers } = await import("./syncResume");

function resumeOnce(): Promise<void> {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
  const socket = { connected: true, emit: () => true, on: (event: string, fn: (...args: unknown[]) => Promise<void>) => { handlers.set(event, fn); } };
  attachSyncHandlers(socket as never, { userId: "u1", serverId: "s1" });
  return handlers.get("sync:resume")!({ lastSeq: 10 });
}

async function quietly(work: () => Promise<void>): Promise<void> {
  const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await work();
  } finally {
    quiet.mockRestore();
  }
}

const lastEvent = () => events.filter((event) => event.name === "server.socket.sync_resume").at(-1)!.attrs;

test("an answered resume records its total time and its query time", async () => {
  sync.mockImplementationOnce(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { messages: [{ seq: 11 }, { seq: 9 }], lateCount: 1, horizonReset: false, snapshotXidSpan: null, horizon: null };
  });
  await resumeOnce();
  const attrs = lastEvent();
  assert.equal(attrs.outcome, "ok");
  assert.equal(typeof attrs.duration_ms, "number");
  assert.equal(typeof attrs.query_ms, "number");
  assert.ok((attrs.query_ms as number) >= 25, `query_ms ${attrs.query_ms}`);
  assert.ok((attrs.duration_ms as number) >= (attrs.query_ms as number));
});

test("a failed query records the total time, its step and the codes from the cause chain, and no query time", async () => {
  // What drizzle throws: a bare Error whose cause is the pg error.
  const pgError = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
  sync.mockImplementationOnce(async () => { throw new Error("Failed query: select ...", { cause: pgError }); });
  await quietly(resumeOnce);
  const attrs = lastEvent();
  assert.equal(attrs.outcome, "error");
  assert.equal(typeof attrs.duration_ms, "number");
  assert.equal("query_ms" in attrs, false);
  assert.equal(attrs.failed_stage, "query");
  assert.equal(attrs.sqlstate, "57014");
  assert.equal(attrs.error_class, "Error");
  assert.ok(!JSON.stringify(attrs).includes("canceling"), "the message never rides on the event");
});

test("a connection error deep in the chain is its error_code", async () => {
  sync.mockImplementationOnce(async () => {
    throw new Error("Failed query", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
  });
  await quietly(resumeOnce);
  assert.equal(lastEvent().error_code, "ECONNRESET");
  assert.equal(lastEvent().sqlstate, "none");
});

test("a free-text code is not carried", async () => {
  sync.mockImplementationOnce(async () => { throw Object.assign(new Error("x"), { code: "some free text" }); });
  await quietly(resumeOnce);
  assert.equal(lastEvent().error_code, "none");
  assert.equal(lastEvent().sqlstate, "none");
});

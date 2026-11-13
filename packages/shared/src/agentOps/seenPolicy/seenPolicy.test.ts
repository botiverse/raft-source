import {
  ConsumedSeqLedger,
  canonicalizeConsumedTarget,
  createMemoryCommandStateStore,
  expectSync,
  getParentTargetForThread,
  isTrustedCanonicalTarget,
  lookupSavedDraft,
  normalizeExactSeqs,
  planHistoryReadRecording,
  recordHistoryRead,
  setSavedDraft,
  type HistoryReadRecordInput,
  type MemoryCommandStateStore,
} from "./index";

const msg = (seq: number) => ({ seq });

/** Plan and record one history window, as `raft message read` does. */
async function recordWindow(state: MemoryCommandStateStore, input: HistoryReadRecordInput): Promise<void> {
  await recordHistoryRead(new ConsumedSeqLedger(state), planHistoryReadRecording(input));
}

describe("recording a history read", () => {
  it("records the server boundary under the canonical target and books the typed spelling as an alias", async () => {
    const state = createMemoryCommandStateStore();
    await recordWindow(state, {
      requestedTarget: "#General",
      data: { target: "#general", messages: [msg(5), msg(6)], last_read_seq: 4, model_seen_up_to_seq: 6 },
    });
    expect(state.snapshot()).toEqual({
      streams: { "#general": { seq: 6, readOrder: 1, contextId: null } },
      exactSeqs: {},
      aliases: { "#General": "#general" },
      drafts: {},
    });
  });

  it("an --around window keeps exact seqs only; a gapped window without a server boundary too", async () => {
    const state = createMemoryCommandStateStore();
    await recordWindow(state, { requestedTarget: "#g", around: "12", data: { target: "#g", messages: [msg(11), msg(12)] } });
    await recordWindow(state, { requestedTarget: "#gap", data: { target: "#gap", messages: [msg(20), msg(21)], model_seen_up_to_seq: null } });
    expect(state.snapshot().streams).toEqual({});
    expect(state.snapshot().exactSeqs).toEqual({
      "#g": { seqs: [11, 12], contextId: null },
      "#gap": { seqs: [20, 21], contextId: null },
    });
  });

  it("books under the store's model context", async () => {
    const state = createMemoryCommandStateStore({ contextId: "ctx-A" });
    await recordWindow(state, { requestedTarget: "#g", data: { target: "#g", messages: [msg(3)], model_seen_up_to_seq: 3 } });
    expect(state.snapshot().streams).toEqual({ "#g": { seq: 3, readOrder: 1, contextId: "ctx-A" } });
  });

  it("a window without a trustworthy target records nothing, not even the alias", async () => {
    const state = createMemoryCommandStateStore();
    await recordWindow(state, { requestedTarget: "#undefined", data: { messages: [msg(3)], model_seen_up_to_seq: 3 } });
    expect(state.snapshot()).toEqual({ streams: {}, exactSeqs: {}, aliases: {}, drafts: {} });
  });
});

describe("history read recording rules", () => {
  const plan = (input: Partial<Parameters<typeof planHistoryReadRecording>[0]> & { data: Parameters<typeof planHistoryReadRecording>[0]["data"] }) =>
    planHistoryReadRecording({ requestedTarget: "#g", ...input });

  it("prefers the server's model_seen_up_to_seq boundary", () => {
    expect(plan({ data: { target: "#g", messages: [{ seq: 7 }, { seq: 9 }], has_older: true, model_seen_up_to_seq: 9 } })?.record).toEqual({ kind: "read", seq: 9 });
  });

  it("an explicit null boundary falls back to exact seqs, not the legacy inference", () => {
    expect(plan({ data: { messages: [{ seq: 7 }], has_older: false, model_seen_up_to_seq: null } })?.record).toEqual({ kind: "exact", seqs: [7] });
  });

  it("legacy servers: a window that joins the prior cursor is a boundary, a gapped one is not", () => {
    expect(plan({ data: { messages: [{ seq: 5 }, { seq: 6 }], has_older: true, last_read_seq: 5 } })?.record).toEqual({ kind: "read", seq: 6 });
    expect(plan({ data: { messages: [{ seq: 7 }, { seq: 9 }], has_older: true, last_read_seq: 6 } })?.record).toEqual({ kind: "exact", seqs: [7, 9] });
    expect(plan({ data: { messages: [{ seq: 7 }], has_older: false } })?.record).toEqual({ kind: "read", seq: 7 });
  });

  it("legacy servers: --after joins only from a numeric anchor at or below the prior cursor", () => {
    expect(plan({ after: "2", data: { messages: [{ seq: 3 }, { seq: 4 }], last_read_seq: 5 } })?.record).toEqual({ kind: "read", seq: 4 });
    expect(plan({ after: "9", data: { messages: [{ seq: 10 }], last_read_seq: 5 } })?.record).toEqual({ kind: "exact", seqs: [10] });
    expect(plan({ after: "abcd1234", data: { messages: [{ seq: 10 }], last_read_seq: 50 } })?.record).toEqual({ kind: "exact", seqs: [10] });
  });

  it("an empty window records a read without a boundary", () => {
    expect(plan({ data: { target: "#g", messages: [] } })?.record).toEqual({ kind: "read" });
  });

  it("--around never makes a boundary, even with a server boundary", () => {
    expect(plan({ around: "x", data: { messages: [{ seq: 4 }, { seq: 5 }], model_seen_up_to_seq: 5 } })?.record).toEqual({ kind: "exact", seqs: [4, 5] });
  });

  it("ignores non-positive and non-integer seqs", () => {
    expect(plan({ data: { messages: [{ seq: 0 }, { seq: 2.5 }, { seq: "3" }, {}, { seq: 4 }], model_seen_up_to_seq: null } })?.record).toEqual({ kind: "exact", seqs: [4] });
  });

  it("target identity comes from the server, falls back to the request, and refuses #undefined", () => {
    expect(plan({ requestedTarget: "#General", data: { target: "#general", messages: [] } })).toMatchObject({
      target: "#general",
      alias: { spelling: "#General", canonical: "#general" },
    });
    expect(plan({ requestedTarget: "#x", data: { messages: [] } })?.target).toBe("#x");
    expect(plan({ requestedTarget: "#x", data: { target: "#undefined", messages: [] } })).toBeNull();
    expect(plan({ requestedTarget: "#undefined", data: { messages: [] } })).toBeNull();
  });

});

describe("consumed-seq policy", () => {
  it("canonicalizes targets fail-closed", () => {
    expect(canonicalizeConsumedTarget("DM:@bob")).toBe("dm:@bob");
    expect(canonicalizeConsumedTarget(" #a")).toBeNull();
    expect(canonicalizeConsumedTarget("#")).toBeNull();
    expect(canonicalizeConsumedTarget("dm:@")).toBeNull();
    expect(canonicalizeConsumedTarget("#Undefined:abc")).toBeNull();
    expect(isTrustedCanonicalTarget("#a:undefined")).toBe(false);
    expect(getParentTargetForThread("#a:12345678")).toBe("#a");
    expect(getParentTargetForThread("dm:@bob:12345678")).toBe("dm:@bob");
    expect(getParentTargetForThread("#a")).toBeNull();
  });

  it("normalizes exact seqs: positive integers above the floor, sorted, unique, bounded", () => {
    expect(normalizeExactSeqs([5, 3, 3, 0, -1, 2.5, 9], 3)).toEqual([5, 9]);
    expect(normalizeExactSeqs(Array.from({ length: 2_600 }, (_, i) => i + 1))).toHaveLength(2_500);
    expect(normalizeExactSeqs("nope")).toEqual([]);
  });

  it("runs synchronously over a synchronous store", () => {
    const store = createMemoryCommandStateStore();
    const ledger = new ConsumedSeqLedger(store);
    expectSync(ledger.recordTargetAlias("#Room", "#room"));
    expectSync(ledger.recordConsumedRead("#Room", 50));
    expect(expectSync(ledger.getConsumedSeq("#room"))).toBe(50);
    expect(expectSync(ledger.getConsumedSeq("#Room"))).toBe(50);
  });

  it("a high-water read retires the exact seqs it covers; a lower read never lowers the mark", () => {
    const store = createMemoryCommandStateStore();
    const ledger = new ConsumedSeqLedger(store);
    expectSync(ledger.recordConsumedExactSeqs({ "#r": [40, 60] }));
    expectSync(ledger.recordConsumedRead("#r", 50));
    expect(expectSync(ledger.getConsumedExactSeqs("#r"))).toEqual([60]);
    expectSync(ledger.recordConsumedRead("#r", 30));
    expect(expectSync(ledger.getConsumedSeq("#r"))).toBe(50);
    expect(expectSync(ledger.getConsumedReadOrder("#r"))).toBe(2);
  });

  it("withholds evidence from another model context, per run", async () => {
    const store = createMemoryCommandStateStore({ contextId: "ctx-A" });
    await new ConsumedSeqLedger(store).recordConsumedRead("#r", 50);
    store.setContextId("ctx-B");
    const run = new ConsumedSeqLedger(store);
    expect(await run.wasEvidenceWithheldForContext("#r")).toBe(false);
    expect(await run.getConsumedSeq("#r")).toBeUndefined();
    expect(await run.wasEvidenceWithheldForContext("#r")).toBe(true);
    // A new run starts with an empty withheld set.
    expect(await new ConsumedSeqLedger(store).wasEvidenceWithheldForContext("#r")).toBe(false);
    // A read in the new context replaces the old record instead of keeping its max.
    await run.recordConsumedRead("#r", 10);
    expect(await run.getConsumedSeq("#r")).toBe(10);
  });

  it("finds the most recently read thread of a parent in this context", async () => {
    const store = createMemoryCommandStateStore();
    const ledger = new ConsumedSeqLedger(store);
    await ledger.recordConsumedRead("#p:aaaaaaaa", 5);
    await ledger.recordConsumedRead("#p:bbbbbbbb", 3);
    await ledger.recordConsumedRead("#q:cccccccc", 9);
    expect(await ledger.getMostRecentConsumedThreadForParent("#p")).toEqual({ target: "#p:bbbbbbbb", seq: 3, readOrder: 2 });
  });

  it("awaits an asynchronous store in the same order", async () => {
    const calls: string[] = [];
    const sync = createMemoryCommandStateStore();
    const asyncStore = new Proxy(sync, {
      get(target, key: string) {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          calls.push(key);
          return Promise.resolve((value as (...a: unknown[]) => unknown).apply(target, args));
        };
      },
    });
    const ledger = new ConsumedSeqLedger(asyncStore);
    await ledger.recordConsumedSeqs({ "#a": 2, "#b": 3 });
    expect(calls).toEqual(["resolveCanonicalTarget", "resolveCanonicalTarget", "currentContextId", "bookStreamEntries"]);
    expect(await ledger.getConsumedSeq("#b")).toBe(3);
    expect(() => expectSync(ledger.getConsumedSeq("#b"))).toThrow(/asynchronously/);
  });
});

describe("held-send drafts", () => {
  it("round-trips a draft and expires it after the TTL, deleting only that draft", async () => {
    const store = createMemoryCommandStateStore();
    await setSavedDraft(store, "#r", { content: "hi", attachmentIds: ["a"], savedAt: 1_000, reholdCount: 1, seenExactSeqs: [3, 3, 1] });
    expect(await lookupSavedDraft(store, "#r", () => 2_000)).toEqual({
      status: "found",
      draft: { content: "hi", attachmentIds: ["a"], savedAt: 1_000, reholdCount: 1, seenUpToSeq: undefined, seenExactSeqs: [1, 3] },
    });
    expect(await lookupSavedDraft(store, "#r", () => 1_000 + 10 * 60 * 1000 + 1)).toEqual({ status: "expired", savedAt: 1_000, content: "hi" });
    expect(await lookupSavedDraft(store, "#r", () => 0)).toEqual({ status: "missing" });
  });

  it("round-trips a known draft cause and reads an unknown one as absent", async () => {
    const store = createMemoryCommandStateStore();
    await setSavedDraft(store, "#r", { content: "hi", attachmentIds: [], savedAt: 1_000, reholdCount: 1, cause: "thread_confirmation" });
    expect(await lookupSavedDraft(store, "#r", () => 2_000)).toMatchObject({ status: "found", draft: { cause: "thread_confirmation" } });
    await store.writeDraft("#r", { content: "hi", attachmentIds: [], savedAt: 1_000, reholdCount: 1, cause: "from-a-newer-cli" });
    const lookup = await lookupSavedDraft(store, "#r", () => 2_000);
    expect(lookup.status).toBe("found");
    expect(lookup.status === "found" && "cause" in lookup.draft).toBe(false);
  });

  it("keeps a card message's card (RFC 082) and reads one that is not an object as absent", async () => {
    const store = createMemoryCommandStateStore();
    const card = { version: 1 as const, root: "t", elements: { t: { type: "Text" as const, props: { text: "In review" } } } };
    await setSavedDraft(store, "#r", { content: "", attachmentIds: [], card, savedAt: 1_000, reholdCount: 1 });
    expect(await lookupSavedDraft(store, "#r", () => 2_000)).toMatchObject({ status: "found", draft: { content: "", card } });
    await store.writeDraft("#r", { content: "hi", attachmentIds: [], card: "not a card", savedAt: 1_000, reholdCount: 1 });
    const lookup = await lookupSavedDraft(store, "#r", () => 2_000);
    expect(lookup.status === "found" && "card" in lookup.draft).toBe(false);
  });
});

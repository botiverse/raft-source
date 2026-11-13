// The ContinuationStore contract (store.ts) as a test suite, so every store
// runs the same cases: the memory store here (memoryStore.test.ts), the CLI's
// agent ledger and the SDK's file store in their own packages:
//
//   continuationStoreContract("agent ledger", () => openLedgerContinuationStore(dir));

import { describe, expect, test } from "vitest";
import type { MaybePromise } from "../maybePromise";
import { asContinuationId, CONTINUATION_FORMAT_VERSION, type ContinuationRecord, type ContinuationTombstone } from "./record";
import type { ContinuationStore } from "./store";

/** A complete pending record, with content that has to survive storage intact; `overrides` replace fields. */
export function sampleContinuationRecord(overrides: Partial<ContinuationRecord> = {}): ContinuationRecord {
  const id = overrides.id ?? asContinuationId("k7q2m3x9ab");
  return {
    formatVersion: CONTINUATION_FORMAT_VERSION,
    id,
    rootId: id,
    revision: 0,
    ownerAgentId: "agent-1",
    program: { name: "raft", version: "1.2.3" },
    command: "message send",
    args: { target: "#ops", body: "Line one\nline \"two\", ünïcode 🚀", flags: { list: [1, 2.5, true, null] } },
    journal: [{ kind: "step", id: "check", result: [{ seq: 12, text: "I already fixed it in #11290" }] }],
    pending: {
      askId: "fresh",
      spec: {
        question: "New replies arrived since you started.",
        preview: "@alice 13:02  I already fixed it in #11290",
        options: { a: "Send your original reply", b: { label: "Write a new reply", input: "stdin" }, c: "Cancel" },
      },
    },
    status: "pending",
    createdAt: 1_000,
    expiresAt: 601_000,
    deleteAfter: 601_000,
    ...overrides,
  };
}

export function sampleContinuationTombstone(overrides: Partial<ContinuationTombstone> = {}): ContinuationTombstone {
  const id = overrides.id ?? asContinuationId("k7q2m3x9ab");
  return {
    formatVersion: CONTINUATION_FORMAT_VERSION,
    id,
    rootId: id,
    ownerAgentId: "agent-1",
    command: "message send",
    finishedAt: 2_000,
    deleteAfter: 86_402_000,
    ...overrides,
  };
}

export function continuationStoreContract(name: string, makeStore: () => MaybePromise<ContinuationStore>): void {
  describe(`ContinuationStore contract: ${name}`, () => {
    const idA = asContinuationId("aaaaaaaaaa");
    const idB = asContinuationId("bbbbbbbbbb");
    const idC = asContinuationId("cccccccccc");

    test("put then get returns the record as written; an unknown id reads as undefined", async () => {
      const store = await makeStore();
      const record = sampleContinuationRecord({ id: idA });
      expect(await store.put(record)).toBe(true);
      expect(await store.get(idA)).toEqual(record);
      expect(await store.get(idB)).toBeUndefined();
    });

    test("what comes back is exactly what was written: no field added, none dropped or retyped", async () => {
      const store = await makeStore();
      // Every optional field set, none undefined: a strict comparison sees any metadata a store adds.
      const record = sampleContinuationRecord({
        id: idA,
        revision: 3,
        status: "answered",
        answer: { choice: "b", input: "A new reply\n" },
        journal: [
          { kind: "step", id: "check", result: [{ seq: 12, text: "I already fixed it in #11290" }], readOnly: true },
          { kind: "step", id: "probe", error: { name: "AgentApiError", message: "service unavailable", code: "UNAVAILABLE" }, readOnly: true },
          { kind: "ask", id: "fresh", answer: { choice: "b", input: "A new reply\n" } },
          { kind: "step", id: "send", result: { seq: 13 } },
        ],
        heartbeatAt: 2_500,
        result: { sent: false, seqs: [0, -1, 1e21], nested: { empty: {}, list: [] } },
        next: idB,
      });
      await store.put(record);
      expect(await store.get(idA)).toStrictEqual(record);
      const tombstone = sampleContinuationTombstone({ id: idA, finishedAt: null });
      await store.putTombstone(tombstone);
      expect(await store.getTombstone(idA)).toStrictEqual(tombstone);
      const finished = sampleContinuationTombstone({ id: idB, check: 'raft message read --target "#ops"' });
      await store.putTombstone(finished);
      expect(await store.getTombstone(idB)).toStrictEqual(finished);
    });

    test("put never overwrites an existing id", async () => {
      const store = await makeStore();
      const record = sampleContinuationRecord({ id: idA });
      await store.put(record);
      expect(await store.put({ ...record, command: "other" })).toBe(false);
      expect(await store.get(idA)).toEqual(record);
    });

    test("records are copies: changing one written or read changes nothing stored", async () => {
      const store = await makeStore();
      const record = sampleContinuationRecord({ id: idA });
      const written = structuredClone(record);
      await store.put(written);
      written.journal.push({ kind: "ask", id: "late", answer: { choice: "a" } });
      (await store.get(idA))?.journal.splice(0);
      expect(await store.get(idA)).toEqual(record);
    });

    test("update replaces the record only from the expected revision", async () => {
      const store = await makeStore();
      const record = sampleContinuationRecord({ id: idA });
      await store.put(record);
      const answered: ContinuationRecord = {
        ...record,
        revision: 1,
        status: "answered",
        answer: { choice: "b", input: "A new reply\n" },
        journal: [...record.journal, { kind: "ask", id: "fresh", answer: { choice: "b", input: "A new reply\n" } }],
        heartbeatAt: 2_000,
      };
      expect(await store.update(answered, 0)).toBe(true);
      expect(await store.get(idA)).toEqual(answered);
      // A writer still holding revision 0 lost the race.
      expect(await store.update({ ...record, revision: 1, answer: { choice: "c" } }, 0)).toBe(false);
      expect(await store.get(idA)).toEqual(answered);
      const done: ContinuationRecord = { ...answered, revision: 2, status: "done", result: { sent: true, seq: 13 }, heartbeatAt: undefined };
      expect(await store.update(done, 1)).toBe(true);
      expect(await store.get(idA)).toEqual(done);
    });

    test("update never inserts", async () => {
      const store = await makeStore();
      expect(await store.update(sampleContinuationRecord({ id: idA, revision: 1 }), 0)).toBe(false);
      expect(await store.get(idA)).toBeUndefined();
    });

    test("delete removes the record, not its tombstone; deleting a missing id does nothing", async () => {
      const store = await makeStore();
      await store.put(sampleContinuationRecord({ id: idA }));
      await store.put(sampleContinuationRecord({ id: idB }));
      await store.putTombstone(sampleContinuationTombstone({ id: idA }));
      await store.delete(idA);
      await store.delete(idC);
      expect(await store.get(idA)).toBeUndefined();
      expect(await store.get(idB)).toBeDefined();
      expect(await store.getTombstone(idA)).toEqual(sampleContinuationTombstone({ id: idA }));
    });

    test("a tombstone is kept apart from records and replaced by the next one for its id", async () => {
      const store = await makeStore();
      expect(await store.getTombstone(idA)).toBeUndefined();
      await store.putTombstone(sampleContinuationTombstone({ id: idA, finishedAt: null }));
      expect(await store.get(idA)).toBeUndefined();
      const finished = sampleContinuationTombstone({ id: idA, finishedAt: 5_000, deleteAfter: 90_000_000 });
      await store.putTombstone(finished);
      expect(await store.getTombstone(idA)).toEqual(finished);
    });

    test("deleteExpired deletes exactly what has deleteAfter before now: no status, deadline or lease counts", async () => {
      const store = await makeStore();
      // Past its answer deadline, but not its deleteAfter.
      await store.put(sampleContinuationRecord({ id: idA, expiresAt: 100, deleteAfter: 500 }));
      // An answered record with a fresh heartbeat: the runtime keeps deleteAfter ahead of a live lease, the store does not look.
      await store.put(sampleContinuationRecord({ id: idB, status: "answered", answer: { choice: "a" }, heartbeatAt: 199, deleteAfter: 150 }));
      await store.put(sampleContinuationRecord({ id: idC, status: "done", answer: { choice: "a" }, result: null, deleteAfter: 200 }));
      await store.putTombstone(sampleContinuationTombstone({ id: idA, deleteAfter: 100 }));
      await store.putTombstone(sampleContinuationTombstone({ id: idC, deleteAfter: 900 }));
      expect(await store.deleteExpired(200)).toBe(2);
      expect(await store.get(idA)).toBeDefined();
      expect(await store.get(idB)).toBeUndefined();
      // deleteAfter equal to now is not yet past.
      expect(await store.get(idC)).toBeDefined();
      expect(await store.getTombstone(idA)).toBeUndefined();
      expect(await store.deleteExpired(901)).toBe(3);
      expect(await store.get(idA)).toBeUndefined();
      expect(await store.get(idC)).toBeUndefined();
      expect(await store.getTombstone(idC)).toBeUndefined();
      expect(await store.deleteExpired(10_000)).toBe(0);
    });
  });
}

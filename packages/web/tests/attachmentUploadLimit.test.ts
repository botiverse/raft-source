import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  resetAttachmentUploadLimitForTests,
  resolveAttachmentUploadLimitBytes,
} from "../src/utils/attachmentUploadLimit";

function source(responses: Array<{ data: unknown } | Error>) {
  const calls: string[] = [];
  let index = 0;
  return {
    calls,
    get: async <T,>(path: string): Promise<{ data: T }> => {
      calls.push(path);
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (next instanceof Error) throw next;
      return next as { data: T };
    },
  };
}

beforeEach(() => {
  resetAttachmentUploadLimitForTests();
});

test("reports the ceiling the server served, verbatim", async () => {
  // A number that matches no plan constant: anything that re-derives the
  // ceiling locally cannot produce it.
  const api = source([{ data: { maxBytes: 137 * 1024 * 1024 } }]);

  assert.equal(await resolveAttachmentUploadLimitBytes(api), 137 * 1024 * 1024);
  assert.deepEqual(api.calls, ["/attachments/upload-capabilities"]);
});

test("a different served ceiling produces a different answer", async () => {
  const api = source([{ data: { maxBytes: 12 * 1024 * 1024 } }]);

  assert.equal(await resolveAttachmentUploadLimitBytes(api), 12 * 1024 * 1024);
});

test("an unreachable capability endpoint yields null, never a substituted ceiling", async () => {
  // This is the fail-safe contract: unknown blocks the upload. Returning any
  // number here — the Free constant, the plan limit, Infinity — would reinstate
  // the defect this replaces, so the assertion is deliberately `null` and not
  // "some small number".
  const api = source([new Error("network down")]);

  assert.equal(await resolveAttachmentUploadLimitBytes(api), null);
});

test("a non-positive or non-finite served ceiling is treated as unknown", async () => {
  for (const maxBytes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    resetAttachmentUploadLimitForTests();
    const api = source([{ data: { maxBytes } }]);
    assert.equal(await resolveAttachmentUploadLimitBytes(api), null, `maxBytes=${String(maxBytes)}`);
  }
});

test("each selection re-reads the ceiling instead of reusing an earlier answer", async () => {
  // The value is not cached on purpose. A ceiling can move under a tab that
  // never navigates: the plan can change on the same server, and the
  // direct-upload threshold can change on a deploy with no client event at all.
  const api = source([{ data: { maxBytes: 4096 } }]);

  assert.equal(await resolveAttachmentUploadLimitBytes(api), 4096);
  assert.equal(await resolveAttachmentUploadLimitBytes(api), 4096);
  assert.deepEqual(api.calls, [
    "/attachments/upload-capabilities",
    "/attachments/upload-capabilities",
  ]);
});

test("a ceiling that changes on the same server is picked up by the next selection", async () => {
  // The regression @Cody blocked on: `server:plan-updated` reaches
  // `applyServerPatch`, which does not fire the reset registry, so a cached
  // ceiling would survive a same-server plan change. Both directions are
  // wrong — a lowered cap re-creates the original defect (accept now, fail
  // later), a raised cap blocks an allowance the user has paid for.
  const api = source([
    { data: { maxBytes: 90 * 1024 * 1024 } },
    { data: { maxBytes: 12 * 1024 * 1024 } },
  ]);

  assert.equal(await resolveAttachmentUploadLimitBytes(api), 90 * 1024 * 1024);
  assert.equal(await resolveAttachmentUploadLimitBytes(api), 12 * 1024 * 1024);

  // And upward, from the new current value.
  const raised = source([{ data: { maxBytes: 200 * 1024 * 1024 } }]);
  assert.equal(await resolveAttachmentUploadLimitBytes(raised), 200 * 1024 * 1024);
});

test("concurrent callers share a single capability request", async () => {
  const api = source([{ data: { maxBytes: 4096 } }]);

  const results = await Promise.all([
    resolveAttachmentUploadLimitBytes(api),
    resolveAttachmentUploadLimitBytes(api),
    resolveAttachmentUploadLimitBytes(api),
  ]);

  assert.deepEqual(results, [4096, 4096, 4096]);
  assert.deepEqual(api.calls, ["/attachments/upload-capabilities"]);
});

test("a failed lookup does not poison later attempts", async () => {
  // Failure must stay retryable: the ceiling is unknown right now, not
  // permanently unavailable.
  const failing = source([new Error("network down")]);
  assert.equal(await resolveAttachmentUploadLimitBytes(failing), null);

  const recovered = source([{ data: { maxBytes: 8192 } }]);
  assert.equal(await resolveAttachmentUploadLimitBytes(recovered), 8192);
});

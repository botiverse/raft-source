// The socket bridge in plain node (no localStorage, no window), as the node
// bridge tests and any non-browser importer load it. A module the bridge
// reaches that touches browser storage at load (authStore, transitively, was
// the S5 CI failure) breaks this, wherever the import comes from; a source
// regex on socketBridge.ts only saw direct imports (review of #10885, r3).
// Also: the Artifacts handler is loaded when its event comes; a failed load is
// logged once, never an unhandled rejection per event.
import assert from "node:assert/strict";

vi.mock("../src/components/message/artifactAttachmentSaved", () => {
  throw new Error("chunk failed to load");
});

test("the bridge loads in node with no localStorage or window", async () => {
  assert.equal(typeof (globalThis as { localStorage?: unknown }).localStorage, "undefined");
  assert.equal(typeof (globalThis as { window?: unknown }).window, "undefined");
  const bridge = await import("../src/store/socketBridge");
  assert.equal(typeof bridge.buildMainLayoutSocketBindings, "function");
});

test("artifact:attachment-saved: a handler that fails to load is logged once, not rejected unhandled", async () => {
  const { buildMainLayoutSocketBindings } = await import("../src/store/socketBridge");
  const socket = {
    connected: true,
    emit: () => undefined,
    on: () => undefined,
    off: () => undefined,
    onAny: () => undefined,
    offAny: () => undefined,
    disconnect: () => undefined,
    connect: () => undefined,
  };
  const bindings = buildMainLayoutSocketBindings(socket as never, () => undefined, async () => undefined, () => undefined, () => undefined);
  const saved = bindings.find((binding) => binding.event === "artifact:attachment-saved");
  assert.ok(saved, "the bridge binds artifact:attachment-saved");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const event = { channelId: "c1", messageId: "m1", attachmentId: "a1" };
    saved.handler(event);
    saved.handler(event);
    await vi.waitFor(() => assert.equal(warn.mock.calls.length, 1));
    // Give any further rejection a chance to surface.
    await new Promise((resolve) => setTimeout(resolve, 20));
    saved.handler(event);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(warn.mock.calls.length, 1, "logged once for the page");
    assert.match(String(warn.mock.calls[0]![0]), /artifact:attachment-saved/);
    assert.equal(unhandled.length, 0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

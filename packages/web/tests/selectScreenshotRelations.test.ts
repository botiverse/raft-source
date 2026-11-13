import "./helpers/domSetup";
import assert from "node:assert/strict";

const toPng = vi.fn<(node: HTMLElement) => Promise<string>>();
vi.mock("html-to-image", () => ({ toPng: (node: HTMLElement) => toPng(node) }));

const { captureSelectedMessageImage } = await import("../src/utils/selectScreenshot");

const REAL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const restore: Array<() => void> = [];

function stub<T extends object>(target: T, key: PropertyKey, descriptor: PropertyDescriptor) {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  restore.push(() => {
    if (previous) Object.defineProperty(target, key, previous);
    else delete (target as Record<PropertyKey, unknown>)[key];
  });
}

function row(id: string): HTMLElement {
  const element = document.createElement("div");
  element.id = `message-${id}`;
  element.textContent = id;
  element.getBoundingClientRect = () => ({
    width: 400, height: 100, top: 0, left: 0, right: 400, bottom: 100, x: 0, y: 0, toJSON() {},
  });
  return element;
}

beforeEach(() => {
  toPng.mockReset();
  stub(HTMLElement.prototype, "offsetHeight", { get() { return 800; } });
  stub(window, "devicePixelRatio", { value: 1 });
  const realFetch = globalThis.fetch;
  stub(globalThis, "fetch", {
    value: (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith("data:") ? realFetch(input, init) : Promise.resolve(new Response(null, { status: 404 })),
  });
  stub(globalThis, "createImageBitmap", {
    value: async () => ({ width: 1, height: 1, close() {} }),
  });
  document.body.append(row("parent"), row("reply"));
});

afterEach(() => {
  while (restore.length) restore.pop()!();
  document.body.replaceChildren();
});

test("thread parents and children share the same left edge in exported images", async () => {
  toPng.mockImplementation(async (node) => {
    const parent = node.querySelector<HTMLElement>("#message-parent");
    const reply = node.querySelector<HTMLElement>("#message-reply");
    assert.ok(parent);
    assert.ok(reply);
    assert.equal(reply.style.paddingLeft, parent.style.paddingLeft);
    assert.notEqual(reply.style.paddingLeft, "32px");
    return REAL_PNG;
  });

  // Keep a legacy relation hint in the regression: the capture contract must
  // ignore it so a parent+reply selection cannot regain the old indentation.
  await captureSelectedMessageImage(["parent", "reply"], {
    timeoutMs: 5000,
    threadChildIds: new Set(["reply"]),
  } as Parameters<typeof captureSelectedMessageImage>[1] & { threadChildIds: Set<string> });
  assert.equal(toPng.mock.calls.length, 1);
});

import assert from "node:assert/strict";
import test, { after, afterEach, before } from "node:test";
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import MarkdownContent from "../src/components/markdown/MarkdownContent";
import { TestIntlProvider } from "./helpers/intl";

const render: typeof rtlRender = (ui, options) => rtlRender(ui, {
  wrapper: TestIntlProvider,
  ...options,
});
const block = (source: string) => ["```mermaid", source, "```"].join("\n");
const bbox = Object.getOwnPropertyDescriptor(SVGElement.prototype, "getBBox");
const textLength = Object.getOwnPropertyDescriptor(SVGElement.prototype, "getComputedTextLength");
const canvasContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");

function restoreProperty(target: object, key: PropertyKey, descriptor?: PropertyDescriptor) {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

before(() => {
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 100, height: 20 }),
  });
  Object.defineProperty(SVGElement.prototype, "getComputedTextLength", {
    configurable: true,
    value: () => 100,
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({ measureText: (text: string) => ({ width: text.length * 8 }) }),
  });
});

after(() => {
  restoreProperty(SVGElement.prototype, "getBBox", bbox);
  restoreProperty(SVGElement.prototype, "getComputedTextLength", textLength);
  restoreProperty(HTMLCanvasElement.prototype, "getContext", canvasContext);
});
afterEach(() => cleanup());

async function renderValid(source = "flowchart TD\n  A --> B") {
  const result = render(<MarkdownContent source={block(source)} enableMermaid />);
  await waitFor(() => assert.ok(result.container.querySelector("[data-mermaid-status=valid]")), {
    timeout: 15_000,
  });
  return result;
}

async function settleBufferedFrame(viewport: HTMLElement) {
  let active: HTMLIFrameElement | undefined;
  let prepared: HTMLIFrameElement | undefined;
  await waitFor(() => {
    const frames = Array.from(viewport.querySelectorAll<HTMLIFrameElement>('iframe[title="Mermaid diagram"]'));
    assert.equal(frames.length, 2);
    active = frames.find((frame) => frame.getAttribute("aria-hidden") !== "true");
    prepared = frames.find((frame) => frame.getAttribute("aria-hidden") === "true");
    assert.ok(active && prepared, "settle keeps the visible frame while preparing its replacement");
  }, { timeout: 3_000 });
  assert.equal(prepared?.getAttribute("sandbox"), "");
  assert.equal(prepared?.getAttribute("referrerpolicy"), "no-referrer");
  assert.match(prepared?.srcdoc ?? "", /Content-Security-Policy/);
  assert.equal(prepared?.srcdoc, active?.srcdoc);
  await act(async () => {
    fireEvent.load(prepared as HTMLIFrameElement);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  await waitFor(() => {
    const frames = viewport.querySelectorAll<HTMLIFrameElement>('iframe[title="Mermaid diagram"]');
    assert.equal(frames.length, 1);
    assert.notEqual(frames[0], active, "the painted replacement becomes the sole idle frame");
  });
}

test("valid Mermaid exposes the isolated surface, view controls, and sharp zoom paths", async () => {
  const result = render(<MarkdownContent source={block("flowchart TD\n  A --> B")} enableMermaid />);
  assert.ok(result.container.querySelector('[role="status"]'), "async rendering starts with a visible status");
  await waitFor(() => assert.ok(result.container.querySelector("[data-mermaid-status=valid]")), {
    timeout: 15_000,
  });

  const frame = result.container.querySelector<HTMLIFrameElement>('iframe[title="Mermaid diagram"]');
  assert.ok(frame);
  const diagram = result.container.querySelector<HTMLElement>('[data-mermaid-status="valid"]');
  assert.equal(diagram?.getAttribute("data-dom-capture-snapshot"), "");
  assert.equal(frame.getAttribute("sandbox"), "");
  assert.match(frame.srcdoc, /Content-Security-Policy/);
  assert.equal(document.querySelector('[id^="raft-mermaid-"]'), null);

  const toolbar = screen.getByTestId("mermaid-toolbar");
  assert.ok(toolbar.classList.contains("r-mermaid-toolbar"));
  const diagramTab = screen.getByRole("button", { name: "Diagram" });
  const codeTab = screen.getByRole("button", { name: "Code" });
  assert.ok(diagramTab.classList.contains("r-mermaid-toolbar__tab"));
  assert.equal(diagramTab.getAttribute("aria-pressed"), "true");
  assert.equal(codeTab.getAttribute("aria-pressed"), "false");
  assert.ok(screen.getByRole("group", { name: "Mermaid zoom controls" }).classList.contains("r-mermaid-toolbar__zoom"));
  for (const name of [
    "Zoom Mermaid diagram out",
    "Zoom Mermaid diagram in",
    "Copy Mermaid source",
    "Download Mermaid diagram",
    "Open Mermaid diagram fullscreen",
  ]) assert.ok(screen.getByRole("button", { name }));

  fireEvent.click(codeTab);
  assert.equal(diagram?.getAttribute("data-dom-capture-snapshot"), "",
    "capture always uses the complete rendered diagram, independent of the active tab");
  assert.match(result.container.querySelector("pre")?.textContent ?? "", /flowchart TD/);
  assert.equal(diagramTab.getAttribute("aria-pressed"), "false");
  assert.equal(codeTab.getAttribute("aria-pressed"), "true");
  assert.equal(screen.queryByRole("button", { name: "Zoom Mermaid diagram in" }), null);
  assert.equal(screen.queryByRole("button", { name: "Open Mermaid diagram fullscreen" }), null);
  assert.equal(screen.queryByRole("button", { name: "Copy code" }), null);
  fireEvent.click(diagramTab);

  const viewport = screen.getByTestId("mermaid-pan-zoom-viewport");
  const media = screen.getByTestId("mermaid-zoom-media");
  assert.ok(viewport.classList.contains("r-mermaid-viewport--inline"));
  const ordinaryWheel = new WheelEvent("wheel", { deltaY: 100, cancelable: true });
  viewport.dispatchEvent(ordinaryWheel);
  assert.equal(ordinaryWheel.defaultPrevented, false, "inline bare wheel remains page scroll");

  const zoomIn = screen.getByRole("button", { name: "Zoom Mermaid diagram in" });
  const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  zoomIn.dispatchEvent(mouseDown);
  assert.equal(mouseDown.defaultPrevented, true, "zoom controls own selection-starting mouse-down");
  const originalRaf = window.requestAnimationFrame;
  const originalCancel = window.cancelAnimationFrame;
  const pendingFrames = new Map<number, FrameRequestCallback>();
  let nextFrameId = 1;
  window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    pendingFrames.set(nextFrameId, callback);
    return nextFrameId++;
  }) as typeof requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) => pendingFrames.delete(id)) as typeof cancelAnimationFrame;
  try {
    fireEvent.click(zoomIn);
    assert.match(
      media.style.transform,
      /scale\(/,
      "the accepted target is observable without waiting for a host-scheduled animation frame",
    );
  } finally {
    window.requestAnimationFrame = originalRaf;
    window.cancelAnimationFrame = originalCancel;
  }
  fireEvent.transitionEnd(media, { propertyName: "transform" });
  await settleBufferedFrame(viewport);
  assert.equal(media.style.width, "120%");
  assert.doesNotMatch(media.style.transform, /scale\(/, "settled Mermaid stays vector-sharp");

  fireEvent.click(screen.getByRole("button", { name: "Open Mermaid diagram fullscreen" }));
  const fullscreen = screen.getByTestId("mermaid-fullscreen");
  assert.equal(fullscreen.querySelectorAll("button").length, 1);
  assert.equal(fullscreen.querySelector('[data-testid="mermaid-toolbar"]'), null);
  const close = screen.getByRole("button", { name: "Close fullscreen Mermaid diagram" });
  assert.equal(close.closest('[data-slot="tooltip-trigger"]'), null);
  const fullscreenViewport = screen.getAllByTestId("mermaid-pan-zoom-viewport").at(-1);
  const fullscreenMedia = screen.getAllByTestId("mermaid-zoom-media").at(-1);
  assert.ok(fullscreenViewport && fullscreenMedia);
  assert.ok(fullscreenViewport.classList.contains("r-mermaid-viewport--fullscreen"));
  Object.defineProperty(fullscreenMedia, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left: 300, top: 150, right: 700, bottom: 550 }) as DOMRect,
  });
  fireEvent.touchStart(fullscreenViewport, {
    touches: [{ identifier: 1, clientX: 450, clientY: 350 }, { identifier: 2, clientX: 550, clientY: 350 }],
  });
  fireEvent.touchMove(fullscreenViewport, {
    touches: [{ identifier: 1, clientX: 400, clientY: 350 }, { identifier: 2, clientX: 600, clientY: 350 }],
  });
  assert.match(fullscreenMedia.style.transform, /scale\(2\)/);
  fireEvent.touchEnd(fullscreenViewport, { touches: [], changedTouches: [{ identifier: 2 }] });
  await settleBufferedFrame(fullscreenViewport);
  assert.equal(fullscreenMedia.style.width, "200%");
  fireEvent.keyDown(document, { key: "Escape" });
  assert.equal(screen.queryByTestId("mermaid-fullscreen"), null);
});

test("retargeting during retirement never drops or reuses the visible frame", async () => {
  await renderValid();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const viewport = screen.getByTestId("mermaid-pan-zoom-viewport");
  const media = screen.getByTestId("mermaid-zoom-media");
  Object.defineProperty(viewport, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left: 0, top: 0, right: 800, bottom: 600 }) as DOMRect,
  });
  Object.defineProperty(media, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left: 100, top: 100, right: 500, bottom: 500 }) as DOMRect,
  });

  const originalRaf = window.requestAnimationFrame;
  const originalCancel = window.cancelAnimationFrame;
  const frames = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    frames.set(nextId, callback);
    return nextId++;
  }) as typeof requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) => frames.delete(id)) as typeof cancelAnimationFrame;
  const flushNext = (time = performance.now()) => {
    const next = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
    assert.ok(next);
    frames.delete(next[0]);
    next[1](time);
  };
  try {
    fireEvent.click(screen.getByRole("button", { name: "Zoom Mermaid diagram out" }));
    fireEvent.transitionEnd(media, { propertyName: "transform" });
    let active: HTMLIFrameElement | undefined;
    let prepared: HTMLIFrameElement | undefined;
    await waitFor(() => {
      const candidates = Array.from(viewport.querySelectorAll<HTMLIFrameElement>('iframe[title="Mermaid diagram"]'));
      active = candidates.find((frame) => frame.getAttribute("aria-hidden") !== "true");
      prepared = candidates.find((frame) => frame.getAttribute("aria-hidden") === "true");
      assert.ok(active && prepared);
    });
    act(() => {
      fireEvent.load(prepared as HTMLIFrameElement);
      flushNext();
      flushNext();
    });
    await waitFor(() => {
      assert.equal(prepared?.getAttribute("aria-hidden"), null);
      assert.equal(active?.getAttribute("aria-hidden"), "true");
      assert.equal(viewport.querySelectorAll('iframe[title="Mermaid diagram"]').length, 2);
    });

    fireEvent.click(screen.getByRole("button", { name: "Zoom Mermaid diagram in" }));
    fireEvent.transitionEnd(media, { propertyName: "transform" });
    await waitFor(() => {
      const candidates = Array.from(viewport.querySelectorAll<HTMLIFrameElement>('iframe[title="Mermaid diagram"]'));
      const visible = candidates.find((frame) => frame.getAttribute("aria-hidden") !== "true");
      const target = candidates.find((frame) => frame.getAttribute("aria-hidden") === "true");
      assert.equal(candidates.length, 2, "cancel-in retains one visible owner and one prepared target");
      assert.equal(visible, prepared);
      assert.ok(target && target !== active, "the retiring raster is discarded rather than reused");
      assert.equal(active?.isConnected, false);
    });
  } finally {
    window.requestAnimationFrame = originalRaf;
    window.cancelAnimationFrame = originalCancel;
  }
});

test("invalid Mermaid is generic, keeps source, and logs diagnostics only", async () => {
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    const result = render(<MarkdownContent source={block("not a diagram")} enableMermaid />);
    await waitFor(() => assert.ok(result.container.querySelector("[data-mermaid-status=error]")));
    assert.match(screen.getByRole("alert").textContent ?? "", /Couldn't render this diagram/);
    assert.doesNotMatch(result.container.textContent ?? "", /No diagram type detected|for text:/);
    assert.equal(screen.getByRole<HTMLButtonElement>("button", { name: "Zoom Mermaid diagram in" }).disabled, true);
    fireEvent.click(screen.getByRole("button", { name: "Code" }));
    assert.match(result.container.querySelector("pre")?.textContent ?? "", /not a diagram/);
    assert.equal(screen.queryByRole("alert"), null);
    assert.equal(logged[0]?.[0], "[Mermaid] render failed");
    assert.match(String(logged[0]?.[1]), /No diagram type detected/);
  } finally {
    console.error = original;
  }
});

test("copy exposes pending, success, and persistent failure without duplicates", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const writes: string[] = [];
  let resolveCopy: (() => void) | undefined;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (text: string) => {
      writes.push(text);
      return new Promise<void>((resolve) => { resolveCopy = resolve; });
    } },
  });
  try {
    await renderValid();
    fireEvent.click(screen.getByRole("button", { name: "Copy Mermaid source" }));
    const copying = screen.getByRole<HTMLButtonElement>("button", { name: "Copying Mermaid source" });
    assert.equal(copying.disabled, true);
    fireEvent.click(copying);
    assert.equal(writes.length, 1);
    await act(async () => {
      resolveCopy?.();
      await Promise.resolve();
    });
    const copied = await screen.findByRole("button", { name: "Copied Mermaid source" });
    assert.deepEqual(writes, ["flowchart TD\n  A --> B"]);

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
    await act(async () => {
      fireEvent.click(copied);
      await Promise.resolve();
    });
    await waitFor(() => assert.match(screen.getByRole("alert").textContent ?? "", /Couldn't copy/));
    fireEvent.click(screen.getByRole("button", { name: "Code" }));
    assert.match(screen.getByRole("alert").textContent ?? "", /Couldn't copy/);
  } finally {
    restoreProperty(navigator, "clipboard", descriptor);
  }
});

test("representative Mermaid families render through the shared body", async () => {
  for (const source of [
    "flowchart TD\n  A --> B",
    "sequenceDiagram\n  A->>B: Hello",
    "stateDiagram-v2\n  [*] --> Ready",
    "pie title Pets\n  \"Dogs\" : 42",
    "gantt\n  dateFormat YYYY-MM-DD\n  Build :2026-08-01, 1d",
  ]) {
    const result = await renderValid(source);
    assert.ok(result.container.querySelector('iframe[title="Mermaid diagram"]'), source);
    result.unmount();
  }
});

test("complex CJK labels stay portable XML inside the isolated frame", async () => {
  const result = await renderValid([
    "flowchart TD",
    '  Source["源文件"] --> Loader["文档站点"]',
    '  Loader --> Cleaner["LLM 管线"]',
    '  Cleaner --> Output["输出 llms.txt"]',
  ].join("\n"));
  const frame = result.container.querySelector<HTMLIFrameElement>('iframe[title="Mermaid diagram"]');
  assert.ok(frame);
  assert.match(frame.srcdoc, /源文件|LLM 管线/);
  assert.doesNotMatch(frame.srcdoc, /foreignObject/);
  const svg = frame.srcdoc.match(/<body>(<svg[\s\S]*<\/svg>)<\/body>/)?.[1];
  assert.ok(svg);
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  assert.equal(parsed.querySelector("parsererror"), null);
});

test("Mermaid chrome and generic errors are localized in zh-cn", async () => {
  const valid = rtlRender(
    <TestIntlProvider locale="zh-cn">
      <MarkdownContent source={block("flowchart LR\n  A --> B")} enableMermaid />
    </TestIntlProvider>,
  );
  await waitFor(() => assert.ok(valid.container.querySelector("[data-mermaid-status=valid]")));
  assert.ok(screen.getByRole("button", { name: "图表" }));
  assert.ok(screen.getByRole("button", { name: "代码" }));
  valid.unmount();

  const original = console.error;
  console.error = () => {};
  try {
    const invalid = rtlRender(
      <TestIntlProvider locale="zh-cn">
        <MarkdownContent source={block("仍然不是图表")} enableMermaid />
      </TestIntlProvider>,
    );
    await waitFor(() => assert.ok(invalid.container.querySelector("[data-mermaid-status=error]")));
    assert.equal(screen.getByRole("alert").textContent, "渲染失败");
    assert.doesNotMatch(invalid.container.textContent ?? "", /No diagram type detected|for text:/);
    fireEvent.click(screen.getByRole("button", { name: "代码" }));
    assert.match(invalid.container.querySelector("pre")?.textContent ?? "", /仍然不是图表/);
  } finally {
    console.error = original;
  }
});

test("an older render cannot overwrite an edited Mermaid message", async () => {
  const original = console.error;
  console.error = () => {};
  try {
    const result = render(<MarkdownContent source={block("gantt\n  title Earlier\n  dateFormat YYYY-MM-DD\n  Build :2026-01-01, 2d")} enableMermaid />);
    result.rerender(<MarkdownContent source={block("not the edited diagram")} enableMermaid />);
    await waitFor(() => assert.ok(result.container.querySelector("[data-mermaid-status=error]")));
    fireEvent.click(screen.getByRole("button", { name: "Code" }));
    assert.match(result.container.querySelector("pre")?.textContent ?? "", /not the edited diagram/);
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    assert.ok(result.container.querySelector("[data-mermaid-status=error]"));
    assert.match(result.container.querySelector("pre")?.textContent ?? "", /not the edited diagram/);
  } finally {
    console.error = original;
  }
});

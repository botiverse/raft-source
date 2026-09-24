import assert from "node:assert/strict";
import { test } from "vitest";
import { Readable } from "node:stream";
import vm from "node:vm";

import {
  ATTACHMENT_PREVIEW_BRIDGE_SCRIPT,
  createAttachmentPreviewBridgeTransform,
  findHtmlPreviewCspMetaStart,
} from "./attachmentPreviewBridge.js";

type Rect = { left: number; top: number; right: number; bottom: number; width?: number; height?: number };
type TextNode = { nodeType: 3; textContent: string; rects: Rect[] };

function runBridgeDescribe(textNodes: TextNode[], payload: Record<string, unknown>): string {
  const script = ATTACHMENT_PREVIEW_BRIDGE_SCRIPT
    .replace(/^\s*<script>/, "")
    .replace(/<\/script>\s*$/, "");
  const messages: Record<string, unknown>[] = [];
  let messageListener: ((event: { data: unknown }) => void) | null = null;
  let selectedNode: TextNode | null = null;

  const body = { scrollWidth: 800, scrollHeight: 600 };
  const documentElement = { scrollWidth: 800, scrollHeight: 600 };
  const context = {
    URLSearchParams,
    isFinite,
    requestAnimationFrame: (fn: () => void) => fn(),
    setTimeout: () => 0,
    NodeFilter: { SHOW_TEXT: 4 },
    window: {
      location: { search: "?acBridgeNonce=test-nonce&acBridgeParentOrigin=https://app.test" },
      parent: {
        postMessage: (message: Record<string, unknown>) => {
          messages.push(message);
        },
      },
      scrollX: 0,
      scrollY: 0,
      innerWidth: 800,
      innerHeight: 600,
      addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
        if (type === "message") messageListener = listener;
      },
      scrollTo: () => undefined,
      scrollBy: () => undefined,
    },
    document: {
      body,
      documentElement,
      addEventListener: () => undefined,
      createTreeWalker: () => {
        let index = -1;
        return {
          nextNode: () => {
            index += 1;
            return textNodes[index] ?? null;
          },
        };
      },
      createRange: () => ({
        selectNodeContents: (node: TextNode) => {
          selectedNode = node;
        },
        getClientRects: () => selectedNode?.rects ?? [],
        detach: () => undefined,
      }),
      elementFromPoint: () => ({
        innerText: "wrong center fallback",
        textContent: "wrong center fallback",
        parentElement: documentElement,
      }),
    },
  };
  context.window.parent = { ...context.window.parent };
  vm.runInNewContext(script, context);
  const listener = messageListener as ((event: { data: unknown }) => void) | null;
  assert.ok(listener, "bridge script must register message listener");
  listener({
    data: {
      slockAcBridge: 1,
      nonce: "test-nonce",
      type: "activate-document",
      documentEpoch: "test-document-epoch",
    },
  });
  listener({
    data: {
      slockAcBridge: 1,
      nonce: "test-nonce",
      documentEpoch: "test-document-epoch",
      type: "describe",
      requestId: 1,
      ...payload,
    },
  });
  const described = messages.find((message) => message.type === "described");
  assert.ok(described, "bridge should post a described response");
  return String(described.text ?? "");
}

function runBridgeExternalLinks(anchors: Array<{
  href: string;
  text?: string;
  rects: Rect[];
}>) {
  const script = ATTACHMENT_PREVIEW_BRIDGE_SCRIPT
    .replace(/^\s*<script>/, "")
    .replace(/<\/script>\s*$/, "");
  const messages: Record<string, unknown>[] = [];
  let scrollListener: (() => void) | null = null;
  let messageListener: ((event: { data: unknown }) => void) | null = null;
  const parent = {
    postMessage: (message: Record<string, unknown>) => messages.push(message),
  };
  const context = {
    URLSearchParams,
    isFinite,
    requestAnimationFrame: (fn: () => void) => fn(),
    setTimeout: (fn: () => void) => { fn(); return 0; },
    window: {
      location: { search: "?acBridgeNonce=test-nonce&acBridgeParentOrigin=https://app.test" },
      parent,
      scrollX: 0,
      scrollY: 0,
      innerWidth: 800,
      innerHeight: 600,
      addEventListener: (type: string, listener: (() => void) | ((event: { data: unknown }) => void)) => {
        if (type === "scroll") scrollListener = listener as () => void;
        if (type === "message") messageListener = listener as (event: { data: unknown }) => void;
      },
      scrollTo: () => undefined,
      scrollBy: () => undefined,
    },
    document: {
      body: { scrollWidth: 800, scrollHeight: 600 },
      documentElement: { scrollWidth: 800, scrollHeight: 600 },
      addEventListener: () => undefined,
      querySelectorAll: () => anchors.map((anchor) => ({
        textContent: anchor.text ?? "Booking",
        getAttribute: (name: string) => (name === "href" ? anchor.href : null),
        getClientRects: () => anchor.rects,
      })),
    },
  };
  vm.runInNewContext(script, context);
  return {
    reports: () => messages.filter((message) => message.type === "external-links"),
    activateDocument: () => {
      assert.ok(messageListener, "bridge script must register message listener");
      const listener = messageListener as (event: { data: unknown }) => void;
      listener({
        data: {
          slockAcBridge: 1,
          nonce: "test-nonce",
          type: "activate-document",
          documentEpoch: "test-document-epoch",
        },
      });
    },
    emitScroll: () => {
      assert.ok(scrollListener, "bridge script must observe viewport scrolling");
      const listener = scrollListener as () => void;
      listener();
    },
  };
}

test("html preview describe aggregates text from a multi-block selection rect", () => {
  const text = runBridgeDescribe(
    [
      {
        nodeType: 3,
        textContent: "left heading",
        rects: [{ left: 12, top: 14, right: 150, bottom: 30 }],
      },
      {
        nodeType: 3,
        textContent: "right heading",
        rects: [{ left: 180, top: 14, right: 340, bottom: 30 }],
      },
      {
        nodeType: 3,
        textContent: "left detail",
        rects: [{ left: 12, top: 54, right: 150, bottom: 72 }],
      },
      {
        nodeType: 3,
        textContent: "right detail",
        rects: [{ left: 180, top: 54, right: 340, bottom: 72 }],
      },
    ],
    { x: 0, y: 0, w: 360, h: 180 },
  );

  assert.equal(text, "left heading ... right heading ... left detail ... right detail");
});

test("html preview describe preserves left-to-right order within the top row", () => {
  const text = runBridgeDescribe(
    [
      {
        nodeType: 3,
        textContent: "left label",
        rects: [{ left: 40, top: 20, right: 120, bottom: 38 }],
      },
      {
        nodeType: 3,
        textContent: "right label",
        rects: [{ left: 180, top: 20, right: 280, bottom: 38 }],
      },
    ],
    { x: 20, y: 10, w: 300, h: 80 },
  );

  assert.equal(text, "left label ... right label");
});

test("html preview bridge reports clipped visible anchor rects as untrusted inventory", () => {
  const bridge = runBridgeExternalLinks([{
    href: "https://www.booking.com/search?ss=Atami",
    text: "  Booking   Atami  ",
    rects: [
      { left: -10, top: 12, right: 120, bottom: 32 },
      { left: 20, top: 590, right: 180, bottom: 620 },
      { left: 900, top: 12, right: 950, bottom: 32 },
    ],
  }]);
  assert.deepEqual(bridge.reports(), [], "reporter stays inert until the parent activates this loaded document");
  bridge.activateDocument();

  assert.deepEqual(
    JSON.parse(JSON.stringify(bridge.reports())),
    [{
      slockAcBridge: 1,
      nonce: "test-nonce",
      documentEpoch: "test-document-epoch",
      type: "external-links",
      links: [{
        href: "https://www.booking.com/search?ss=Atami",
        text: "Booking Atami",
        rects: [
          { x: 0, y: 12, w: 120, h: 20 },
          { x: 20, y: 590, w: 160, h: 10 },
        ],
      }],
    }],
  );
});

test("html preview bridge replaces stale link geometry after viewport scrolling", () => {
  const anchors = [{
    href: "https://www.booking.com/",
    rects: [{ left: 10, top: 20, right: 110, bottom: 40 }],
  }];
  const bridge = runBridgeExternalLinks(anchors);
  bridge.activateDocument();
  assert.deepEqual(
    JSON.parse(JSON.stringify((bridge.reports()[0].links as Array<{ rects: Rect[] }>)[0].rects)),
    [{ x: 10, y: 20, w: 100, h: 20 }],
  );

  anchors[0].rects = [{ left: 10, top: 70, right: 110, bottom: 90 }];
  bridge.emitScroll();
  const reports = bridge.reports();
  assert.deepEqual(
    JSON.parse(JSON.stringify((reports[reports.length - 1].links as Array<{ rects: Rect[] }>)[0].rects)),
    [{ x: 10, y: 70, w: 100, h: 20 }],
  );
});

test("html preview bridge has no click-to-parent navigation message path", () => {
  assert.doesNotMatch(ATTACHMENT_PREVIEW_BRIDGE_SCRIPT, /external-link-intent/);
  assert.doesNotMatch(ATTACHMENT_PREVIEW_BRIDGE_SCRIPT, /addEventListener\("click"/);
});

async function bridgePreview(chunks: Array<string | Buffer>): Promise<Buffer> {
  const transformed = Readable.from(chunks).pipe(createAttachmentPreviewBridgeTransform());
  const output: Buffer[] = [];
  for await (const chunk of transformed) output.push(Buffer.from(chunk));
  return Buffer.concat(output);
}

test("HTML preview bridge remains appended when the head has no CSP meta", async () => {
  const html = Buffer.from("<!doctype html><html><head><title>Report</title></head><body>ok</body></html>");
  assert.deepEqual(
    await bridgePreview([html]),
    Buffer.concat([html, Buffer.from(ATTACHMENT_PREVIEW_BRIDGE_SCRIPT)]),
  );
});

test("HTML preview bridge runs before an attachment-owned CSP meta without removing that policy", async () => {
  const before = "<!doctype html><html><head>";
  const meta = "<META content=\"default-src 'none'\" HTTP-EQUIV = 'Content-Security-Policy'>";
  const after = "<style>body{color:black}</style></head><body>report</body></html>";
  const output = await bridgePreview([
    before + meta.slice(0, 18),
    meta.slice(18, 49),
    meta.slice(49) + after,
  ]);
  const expected = Buffer.from(before + ATTACHMENT_PREVIEW_BRIDGE_SCRIPT + meta + after);
  assert.deepEqual(output, expected);
  assert.equal(output.includes(Buffer.from(meta)), true, "attachment CSP must remain byte-identical");
});

test("HTML preview bridge scan ignores CSP-looking text outside the parser-active head", async () => {
  const html = Buffer.from(`<!doctype html><html><head>
<!-- <meta http-equiv="Content-Security-Policy" content="default-src 'none'"> -->
<script>const decoy = '<meta http-equiv="Content-Security-Policy">';</script>
</head><body><meta http-equiv="Content-Security-Policy" content="default-src 'none'">ok</body></html>`);
  assert.deepEqual(findHtmlPreviewCspMetaStart(html), { kind: "head-closed" });
  assert.deepEqual(
    await bridgePreview([html]),
    Buffer.concat([html, Buffer.from(ATTACHMENT_PREVIEW_BRIDGE_SCRIPT)]),
  );
});

// #proj-raft-ui:#245 (xxchan): a Mermaid PNG export in a browser without a 2D
// canvas keeps its plain error, and is reported to slock.client_error so the
// rare case is traceable. Only the fixed site name goes out, never the diagram.
import "./helpers/domSetup";
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { svgToPngBlob } from "../src/components/mermaid/mermaidDownload";
import { __resetClientErrorThrottleForTest, __setClientErrorEmitterForTest } from "../src/utils/clientErrorTrace";

const originalImage = globalThis.Image;
const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

afterEach(() => {
  globalThis.Image = originalImage;
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  __setClientErrorEmitterForTest(null);
});

test("no 2D canvas: the export throws its message and reports mermaid_export with the fixed site only", async () => {
  __resetClientErrorThrottleForTest();
  URL.createObjectURL = () => "blob:mermaid";
  URL.revokeObjectURL = () => {};
  globalThis.Image = class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    decoding = "";
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  } as unknown as typeof Image;
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
  const records: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  __setClientErrorEmitterForTest(((name: string, attrs: Record<string, unknown>) => { records.push({ name, attrs }); }) as never);

  await assert.rejects(
    svgToPngBlob(
      { svg: "<svg>SECRET-DIAGRAM</svg>", srcDoc: "", width: 10, height: 10, theme: "light" },
      { imageLoadError: "load", canvasUnavailable: "No canvas here", createError: "create" },
    ),
    /No canvas here/,
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].name, "slock.client_error");
  assert.equal(records[0].attrs.captureSource, "mermaid_export");
  assert.equal(records[0].attrs.componentStackTop, "mermaid.png_canvas_unavailable");
  assert.ok(!JSON.stringify(records[0]).includes("SECRET"), "no diagram content");
  assert.ok(!JSON.stringify(records[0]).includes("No canvas here"), "no localized message");
});

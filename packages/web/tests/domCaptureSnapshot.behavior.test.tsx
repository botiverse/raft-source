import assert from "node:assert/strict";
import test from "node:test";
import {
  materializeDomCaptureSnapshots,
  registerDomCaptureSnapshot,
} from "../src/utils/domCaptureSnapshot";

test("a registered live boundary materializes only in its deep clone", async () => {
  const sourceRoot = document.createElement("div");
  sourceRoot.innerHTML = '<section><div class="live"><iframe></iframe></div></section>';
  const live = sourceRoot.querySelector<HTMLElement>(".live");
  assert.ok(live);
  let disposed = 0;
  const unregister = registerDomCaptureSnapshot(live, () => {
    const snapshot = document.createElement("img");
    snapshot.className = "static-snapshot";
    snapshot.src = "data:image/png;base64,AA==";
    return { element: snapshot, dispose: () => { disposed += 1; } };
  });
  const cloneRoot = sourceRoot.cloneNode(true) as HTMLElement;

  const dispose = await materializeDomCaptureSnapshots(sourceRoot, cloneRoot);
  assert.ok(sourceRoot.querySelector("iframe"), "the live component remains interactive");
  assert.equal(sourceRoot.querySelector(".static-snapshot"), null);
  assert.ok(cloneRoot.querySelector(".static-snapshot"));
  assert.equal(cloneRoot.querySelector("iframe"), null);

  dispose();
  dispose();
  assert.equal(disposed, 1, "temporary snapshot resources are disposed exactly once");
  unregister();
  assert.equal(live.hasAttribute("data-dom-capture-snapshot"), false);
});

test("an outer capture boundary owns nested registered surfaces", async () => {
  const source = document.createElement("div");
  source.innerHTML = '<div class="outer"><div class="inner"></div></div>';
  const outer = source.querySelector<HTMLElement>(".outer");
  const inner = source.querySelector<HTMLElement>(".inner");
  assert.ok(outer && inner);
  let innerCalls = 0;
  const unregisterInner = registerDomCaptureSnapshot(inner, () => {
    innerCalls += 1;
    return { element: document.createElement("span") };
  });
  const unregisterOuter = registerDomCaptureSnapshot(outer, () => {
    const replacement = document.createElement("figure");
    replacement.textContent = "outer snapshot";
    return { element: replacement };
  });
  const clone = source.cloneNode(true) as HTMLElement;

  const dispose = await materializeDomCaptureSnapshots(source, clone);
  assert.equal(clone.textContent, "outer snapshot");
  assert.equal(innerCalls, 0);
  dispose();
  unregisterOuter();
  unregisterInner();
});

test("a stale marked boundary fails instead of producing a blank capture", async () => {
  const source = document.createElement("div");
  source.innerHTML = '<div data-dom-capture-snapshot></div>';
  const clone = source.cloneNode(true) as HTMLElement;
  await assert.rejects(
    materializeDomCaptureSnapshots(source, clone),
    /provider is unavailable/,
  );
});

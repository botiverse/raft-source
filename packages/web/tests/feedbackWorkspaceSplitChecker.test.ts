import assert from "node:assert/strict";
import test from "node:test";
import { validateFeedbackWorkspaceSplit } from "../scripts/check-feedback-workspace-split.mjs";

const manifest = {
  "src/main.tsx": { file: "assets/main.js", isEntry: true, imports: ["_vendor.js"], css: ["assets/main.css"] },
  "_vendor.js": { file: "assets/vendor.js" },
  "src/components/settings/AboutFeedbackDialog.tsx": {
    file: "assets/feedback.js",
    isDynamicEntry: true,
  },
  "node_modules/.pnpm/@botiverse+hands-feedback-react/source/styles.css": {
    file: "assets/feedback.css",
    isDynamicEntry: true,
  },
};

function cleanAssets() {
  return new Map<string, Buffer>([
    ["assets/main.js", Buffer.from('import "./vendor.js";')],
    ["assets/vendor.js", Buffer.from("const vendor = true;")],
    ["assets/main.css", Buffer.from(".app{display:block}")],
    ["assets/feedback.js", Buffer.from('const workspace = "hands-feedback-workspace";')],
    ["assets/feedback.css", Buffer.from(".hands-feedback-workspace{display:block}")],
    ["assets/styles-reviewer-unrelated.css", Buffer.from(".unrelated{display:block}")],
  ]);
}

test("the split checker ignores an unrelated same-basename asset", () => {
  assert.doesNotThrow(() => validateFeedbackWorkspaceSplit({
    index: '<script type="module" src="/assets/main.js"></script><link rel="stylesheet" href="/assets/main.css">',
    manifest,
    assets: cleanAssets(),
  }));
});

test("the split checker recognizes a locally linked Hands workspace stylesheet", () => {
  const linkedStyleSource = "../../../../../../../botiverse/hands/packages/feedback-react/src/styles.css";
  const linkedManifest = {
    "src/main.tsx": manifest["src/main.tsx"],
    "_vendor.js": manifest["_vendor.js"],
    "src/components/settings/AboutFeedbackDialog.tsx": manifest["src/components/settings/AboutFeedbackDialog.tsx"],
    [linkedStyleSource]: {
      file: "assets/feedback.css",
      isDynamicEntry: true,
      src: linkedStyleSource,
    },
  };

  assert.doesNotThrow(() => validateFeedbackWorkspaceSplit({
    index: '<script type="module" src="/assets/main.js"></script><link rel="stylesheet" href="/assets/main.css">',
    manifest: linkedManifest,
    assets: cleanAssets(),
  }));
});

test("the split checker rejects a transitive startup JavaScript import", () => {
  const assets = cleanAssets();
  assets.set("assets/reviewer-entry-proxy.js", Buffer.from('import "./feedback.js";'));
  assert.throws(() => validateFeedbackWorkspaceSplit({
    index: '<script type="module" src="/assets/main.js"></script><script type="module" src="/assets/reviewer-entry-proxy.js"></script>',
    manifest,
    assets,
  }), /reachable from the startup graph/);
});

test("the split checker rejects a minified no-whitespace side-effect import", () => {
  const assets = cleanAssets();
  assets.set("assets/reviewer-entry-proxy.js", Buffer.from('import"./feedback.js";'));
  assert.throws(() => validateFeedbackWorkspaceSplit({
    index: '<script type="module" src="/assets/main.js"></script><script type="module" src="/assets/reviewer-entry-proxy.js"></script>',
    manifest,
    assets,
  }), /reachable from the startup graph/);
});

test("the split checker rejects a minified no-whitespace named import", () => {
  const assets = cleanAssets();
  assets.set("assets/reviewer-entry-proxy.js", Buffer.from('import{x}from"./feedback.js";'));
  assert.throws(() => validateFeedbackWorkspaceSplit({
    index: '<script type="module" src="/assets/main.js"></script><script type="module" src="/assets/reviewer-entry-proxy.js"></script>',
    manifest,
    assets,
  }), /reachable from the startup graph/);
});

test("the split checker does not treat a dynamic import as startup reachability", () => {
  const assets = cleanAssets();
  assets.set("assets/reviewer-entry-proxy.js", Buffer.from('import("./feedback.js");'));
  assert.doesNotThrow(() => validateFeedbackWorkspaceSplit({
    index: '<script type="module" src="/assets/main.js"></script><script type="module" src="/assets/reviewer-entry-proxy.js"></script>',
    manifest,
    assets,
  }));
});

test("the split checker rejects a transitive startup CSS import", () => {
  const assets = cleanAssets();
  assets.set("assets/reviewer-entry-proxy.css", Buffer.from('@import "./feedback.css";'));
  assert.throws(() => validateFeedbackWorkspaceSplit({
    index: '<script type="module" src="/assets/main.js"></script><link rel="stylesheet" href="/assets/reviewer-entry-proxy.css">',
    manifest,
    assets,
  }), /reachable from the startup graph/);
});

test("the split checker rejects an unquoted CSS url import", () => {
  const assets = cleanAssets();
  assets.set("assets/reviewer-entry-proxy.css", Buffer.from("@import url(./feedback.css);"));
  assert.throws(() => validateFeedbackWorkspaceSplit({
    index: '<script type="module" src="/assets/main.js"></script><link rel="stylesheet" href="/assets/reviewer-entry-proxy.css">',
    manifest,
    assets,
  }), /reachable from the startup graph/);
});

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useBlobDownload } from "../src/hooks/useBlobDownload";

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const originalAnchorClick = HTMLAnchorElement.prototype.click;

afterEach(() => {
  cleanup();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  HTMLAnchorElement.prototype.click = originalAnchorClick;
});

test("blob downloads retain at most one URL and revoke it on the next download or unmount", () => {
  const events: string[] = [];
  const urls = ["blob:mermaid-first", "blob:mermaid-second"];
  URL.createObjectURL = (() => {
    const url = urls.shift();
    assert.ok(url);
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => {
    events.push(`revoke:${url}`);
  }) as typeof URL.revokeObjectURL;
  HTMLAnchorElement.prototype.click = function click() {
    events.push(`click:${this.href}:${this.download}`);
  };

  const hook = renderHook(() => useBlobDownload());
  act(() => hook.result.current(new Blob(["first"]), "first.mmd"));
  assert.deepEqual(events, ["click:blob:mermaid-first:first.mmd"]);

  act(() => hook.result.current(new Blob(["second"]), "second.svg"));
  assert.deepEqual(events, [
    "click:blob:mermaid-first:first.mmd",
    "revoke:blob:mermaid-first",
    "click:blob:mermaid-second:second.svg",
  ]);

  hook.unmount();
  assert.deepEqual(events, [
    "click:blob:mermaid-first:first.mmd",
    "revoke:blob:mermaid-first",
    "click:blob:mermaid-second:second.svg",
    "revoke:blob:mermaid-second",
  ]);
});

test("blob download revokes the newly-created URL immediately when click throws", () => {
  const revoked: string[] = [];
  URL.createObjectURL = (() => "blob:mermaid-failed") as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => {
    revoked.push(url);
  }) as typeof URL.revokeObjectURL;
  HTMLAnchorElement.prototype.click = () => {
    throw new Error("download click failed");
  };

  const hook = renderHook(() => useBlobDownload());
  assert.throws(() => {
    act(() => hook.result.current(new Blob(["failed"]), "failed.svg"));
  }, /download click failed/);
  assert.deepEqual(revoked, ["blob:mermaid-failed"]);

  hook.unmount();
  assert.deepEqual(revoked, ["blob:mermaid-failed"], "unmount must not revoke the failed URL twice");
});

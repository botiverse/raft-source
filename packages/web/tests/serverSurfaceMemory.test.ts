import assert from "node:assert/strict";
import test from "node:test";
import { normalizeServerSurfaceMemory } from "../src/hooks/useTabRouteMemory";

test("server surface memory keeps deep server routes with right-panel query", () => {
  assert.equal(
    normalizeServerSurfaceMemory("dev", "/s/dev/channel/ch1?thread=ch1:msg1&msg=reply#latest"),
    "/s/dev/channel/ch1?thread=ch1:msg1&msg=reply#latest",
  );
  assert.equal(normalizeServerSurfaceMemory("dev", "/s/dev/tasks"), "/s/dev/tasks");
  assert.equal(normalizeServerSurfaceMemory("dev", "/s/dev/search?q=release"), "/s/dev/search?q=release");
  assert.equal(normalizeServerSurfaceMemory("dev", "/s/dev/settings/admin"), "/s/dev/settings/admin");
});

test("server surface memory rejects routes that do not belong to that server", () => {
  assert.equal(normalizeServerSurfaceMemory("dev", "/s/other/channel/ch1"), null);
  assert.equal(normalizeServerSurfaceMemory("dev", "/s/developer/channel/ch1"), null);
  assert.equal(normalizeServerSurfaceMemory("dev", "/login"), null);
  assert.equal(normalizeServerSurfaceMemory("dev", "https://example.com/s/dev/channel/ch1"), null);
  assert.equal(normalizeServerSurfaceMemory("dev", "/s/dev/unknown"), null);
});

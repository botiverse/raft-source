import assert from "node:assert/strict";
import { bootContentMs, isProductionHost, withoutBootPrefetch } from "./page";

test("production hosts, including a trailing dot; lookalikes are not", () => {
  assert.equal(isProductionHost("https://app.raft.build"), true);
  assert.equal(isProductionHost("https://raft.build/x"), true);
  assert.equal(isProductionHost("https://api.raft.build."), true);
  assert.equal(isProductionHost("https://xraft.build"), false);
  assert.equal(isProductionHost("https://raft.build.evil.example"), false);
  assert.equal(isProductionHost("https://raft-app-staging.botiverse.dev"), false);
});

test("the off arm empties only the boot prefetch config", () => {
  const html = '<head><script type="application/json" id="raft-boot-prefetch">{"api":"https://x/api","version":"1"}</script><script>boot()</script></head>';
  assert.equal(withoutBootPrefetch(html), '<head><script type="application/json" id="raft-boot-prefetch">null</script><script>boot()</script></head>');
  assert.equal(withoutBootPrefetch("<head></head>"), "<head></head>");
});

test("content_ms of a rendered boot timing event, nothing else", () => {
  const event = (outcome: string, content: number | null) => ({ type: "event", name: "slock.web.boot_timing", attrs: { landing: "channel", content_ms: content, outcome } });
  assert.equal(bootContentMs(JSON.stringify({ events: [{ name: "other", attrs: { content_ms: 1 } }, event("rendered", 812)] })), 812);
  assert.equal(bootContentMs(JSON.stringify([event("hidden", 400)])), null);
  assert.equal(bootContentMs(JSON.stringify([event("rendered", null)])), null);
  assert.equal(bootContentMs("not json"), null);
});

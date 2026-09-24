import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAppProtocolHandler } from "./appProtocol.ts";

test("SPA navigation still loads; missing static resources are real 404s", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "raft-protocol-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "index.html"), "<html>app</html>");
  await mkdir(path.join(root, "assets"));
  await writeFile(path.join(root, "assets", "test.js"), "export default 1");
  await writeFile(path.join(root, "assets", "index-Abc12345.js"), "export default 2");
  const handle = createAppProtocolHandler(root);
  for (const route of ["/", "/s/team/channel/123", "/servers"]) {
    const response = await handle(new Request(`app://raft${route}`));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "<html>app</html>");
    assert.equal(response.headers.get("cache-control"), "no-cache");
  }
  for (const asset of ["/assets/missing.js", "/assets/extensionless", "/brand/missing.svg", "/missing.woff2"]) {
    assert.equal((await handle(new Request(`app://raft${asset}`))).status, 404);
  }
  assert.equal((await handle(new Request("app://raft/assets/missing.js", { headers: { accept: "text/html" } }))).status, 404);
  assert.equal((await handle(new Request("app://raft/assets/index-Abc12345.js"))).headers.get("cache-control"), "public, max-age=31536000, immutable");
  const script = await handle(new Request("app://raft/assets/test.js"));
  assert.equal(script.headers.get("content-type"), "text/javascript");
  assert.equal(await script.text(), "export default 1");
  assert.equal((await handle(new Request("app://other/"))).status, 403);
  assert.equal((await handle(new Request("app://raft/%2e%2e%2fsecret"))).status, 403);
  assert.equal((await handle(new Request("app://raft/%zz"))).status, 400);
});

test("read failures other than missing files do not fall back to HTML", async () => {
  let reads = 0;
  const handle = createAppProtocolHandler("/frontend", async () => {
    reads++;
    throw Object.assign(new Error("denied"), { code: "EACCES" });
  });
  assert.equal((await handle(new Request("app://raft/s/team"))).status, 500);
  assert.equal(reads, 1);
});

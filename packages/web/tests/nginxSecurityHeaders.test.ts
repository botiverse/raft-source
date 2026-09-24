import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

const nginx = process.env.RAFT_TEST_NGINX_BIN || "nginx";
const available = spawnSync(nginx, ["-v"]).status === 0;

test("nginx sends security headers on successful, cached and error responses", {
  skip: available ? false : "Set RAFT_TEST_NGINX_BIN to run the actual nginx HTTP regression",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "raft-nginx-"));
  const socketPath = join(dir, "http.sock");
  mkdirSync(join(dir, "assets"));
  mkdirSync(join(dir, "logs"));
  writeFileSync(join(dir, "index.html"), "<html>fixture shell</html>");
  writeFileSync(join(dir, "assets/app.js"), "// fixture asset");
  writeFileSync(join(dir, "desktop-manifest.json"), '{"fixture":true}');
  writeFileSync(join(dir, "etag.conf"), 'add_header ETag \'"fixture-etag"\' always;');
  const source = readFileSync(resolve(import.meta.dirname, "../nginx.conf"), "utf8")
    .replace("listen 80;", `listen unix:${socketPath};`)
    .replace("/usr/share/nginx/html", dir)
    .replace("/etc/nginx/desktop-manifest-etag.conf", join(dir, "etag.conf"));
  writeFileSync(join(dir, "nginx.conf"), `pid ${dir}/nginx.pid;\nerror_log stderr;\nevents {}\nhttp { access_log off; ${source} }`);
  const child = spawn(nginx, ["-p", `${dir}/`, "-c", join(dir, "nginx.conf"), "-g", "daemon off; master_process off;"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  const exited = once(child, "exit");

  const get = (path: string, headers: Record<string, string> = {}) => new Promise<{
    status: number; headers: IncomingHttpHeaders; body: string;
  }>((resolveResponse, reject) => {
    const req = request({ socketPath, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolveResponse({ status: res.statusCode ?? 0, headers: res.headers, body }));
      res.on("error", reject);
    });
    req.setTimeout(2000, () => req.destroy(new Error("nginx fixture timed out")));
    req.on("error", reject);
    req.end();
  });
  const check = (headers: IncomingHttpHeaders) => {
    assert.equal(headers["x-frame-options"], "DENY");
    assert.equal(headers["referrer-policy"], "no-referrer");
    assert.equal(headers["x-content-type-options"], "nosniff");
    assert.match(String(headers["content-security-policy"]), /frame-ancestors 'none'/);
    assert.match(String(headers["content-security-policy"]), /script-src 'self'/);
    assert.doesNotMatch(String(headers["content-security-policy"]), /'unsafe-inline'/);
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await get("/"); ready = true; break; } catch {
        if (child.exitCode !== null) break;
        await delay(20);
      }
    }
    assert.ok(ready, `nginx failed to start: ${errors}`);
    for (const [path, status] of [["/", 200], ["/channels/general", 200], ["/assets/app.js", 200], ["/assets/missing.js", 404], ["/desktop-manifest.json", 200]] as const) {
      const res = await get(path);
      assert.equal(res.status, status, path);
      check(res.headers);
      if (path === "/channels/general") assert.match(res.body, /fixture shell/);
      if (path === "/assets/app.js") {
        assert.match(String(res.headers["cache-control"]), /immutable/);
        const cached = await get(path, { "If-None-Match": String(res.headers.etag) });
        assert.equal(cached.status, 304);
        check(cached.headers);
      }
    }
    rmSync(join(dir, "desktop-manifest.json"));
    const missing = await get("/desktop-manifest.json");
    assert.equal(missing.status, 404);
    assert.deepEqual(JSON.parse(missing.body), { error: "desktop_manifest_unavailable" });
    check(missing.headers);
    assert.equal(missing.headers["cache-control"], "no-store");
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
});

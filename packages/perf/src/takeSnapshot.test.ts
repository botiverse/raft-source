import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { takeSnapshot } from "./takeSnapshot";

let server: Server | null = null;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

const INDEX = `<!doctype html><html><head><script type="module" src="/assets/entry.js"></script><link rel="stylesheet" href="/assets/app.css"></head><body><div id="root"></div></body></html>`;
// The entry really imports ./dep.js; the template string names a path that does not exist (a regex false positive).
const ENTRY = 'import "./dep.js";const hint=`\nimport "./ghost.js";\n`;console.log(hint);';
const FILES: Record<string, [string, string]> = {
  "/assets/entry.js": ["text/javascript", ENTRY],
  "/assets/dep.js": ["text/javascript", "export const dep = 1;"],
  "/assets/app.css": ["text/css", "body{margin:0}"],
};

/** A server like Stamp's gateway: the page for a navigation to any path, another document for anything that is not one. */
async function listen(seen: { path: string; mode: string; dest: string }[]): Promise<string> {
  server = createServer((req, res) => {
    const path = req.url ?? "/";
    const mode = String(req.headers["sec-fetch-mode"] ?? "");
    seen.push({ path, mode, dest: String(req.headers["sec-fetch-dest"] ?? "") });
    const file = FILES[path];
    if (file) {
      res.writeHead(200, { "content-type": file[0], "cache-control": "public, max-age=31536000, immutable" }).end(file[1]);
    } else if (mode === "navigate") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(INDEX);
    } else if (path === "/") {
      res.writeHead(200, { "content-type": "text/html" }).end(`<html><head><link rel="stylesheet" href="/other-site.css"></head></html>`);
    } else {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

it("reads the document a browser navigation gets, and requests each file the way a browser requests that kind", async () => {
  const seen: { path: string; mode: string; dest: string }[] = [];
  const snapshot = await takeSnapshot(await listen(seen));
  expect(snapshot.files.map((f) => f.url).sort()).toEqual(["/assets/app.css", "/assets/dep.js", "/assets/entry.js"]);
  expect(snapshot.html.cacheControl).toBe("no-store");
  const by = (path: string) => seen.filter((s) => s.path === path).map((s) => `${s.dest}/${s.mode}`);
  expect(by("/")).toEqual(["document/navigate"]);
  expect(new Set(by("/assets/entry.js"))).toEqual(new Set(["script/cors"]));
  expect(new Set(by("/assets/app.css"))).toEqual(new Set(["style/no-cors"]));
});

it("a regex false positive is skipped even when the server answers navigations to unknown paths with its page", async () => {
  const seen: { path: string; mode: string; dest: string }[] = [];
  const snapshot = await takeSnapshot(await listen(seen));
  expect(snapshot.skipped).toEqual(["/assets/ghost.js"]);
  expect(snapshot.files.some((f) => f.url === "/assets/ghost.js")).toBe(false);
  // the bogus path was asked for as a script, never as a navigation (which this server would answer 200 with HTML)
  expect(seen.filter((s) => s.path === "/assets/ghost.js").map((s) => s.mode)).toEqual(["cors"]);
});

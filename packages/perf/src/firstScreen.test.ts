import { describe, expect, it } from "vitest";
import { type FirstScreenFile, type FirstScreenSnapshot, diffSnapshots, parseIndexHtml, sameOriginPath, stableName, staticImports, totals } from "./firstScreen";

const ORIGIN = "https://web.example";

describe("parseIndexHtml", () => {
  const html = `<!doctype html><html><head>
<script id="raft-frontend-release-identity" type="application/json">{"releaseId":"r1","commitSha":"abc123","builtAt":"2026-11-12T03:06:57Z","deploymentEnvironment":"staging"}</script>
<script type="application/json" id="raft-boot-prefetch">{"a":1}</script>
<script>window.x=1</script>
<script type="module" crossorigin src="/assets/index-y6OD2l41.js"></script>
<link rel="modulepreload" crossorigin href="/assets/vendor-react-Bm7dREOr.js">
<link rel="modulepreload" href="/assets/vendor-react-Bm7dREOr.js">
<link rel="modulepreload" href="https://cdn.other.example/x-AAAAAAAA.js">
<link rel="stylesheet" crossorigin href="/assets/app-shell-Cyq1Md2G.css">
<link rel="preload" as="image" href="/reactions/reaction-sprite.svg" />
<link rel="icon" href="/favicon.ico" />
</head></html>`;

  it("finds the entry, modulepreloads and stylesheets, same origin only, de-duplicated, in order", () => {
    expect(parseIndexHtml(html, ORIGIN).assets).toEqual([
      { url: "/assets/index-y6OD2l41.js", kind: "js", via: "entry" },
      { url: "/assets/vendor-react-Bm7dREOr.js", kind: "js", via: "modulepreload" },
      { url: "/assets/app-shell-Cyq1Md2G.css", kind: "css", via: "stylesheet" },
    ]);
  });

  it("ignores commented-out tags and print/alternate stylesheets; keeps query strings", () => {
    const h = `<!-- <script type="module" src="/a/old.js"></script> -->
<script type="module" src="/a/e-BBBBBBBB.js?v=2"></script>
<link rel="stylesheet" media="print" href="/a/print-CCCCCCCC.css">
<link rel="alternate stylesheet" href="/a/alt-DDDDDDDD.css">
<link rel="stylesheet" media="all" href="/a/main-EEEEEEEE.css">`;
    expect(parseIndexHtml(h, ORIGIN).assets).toEqual([
      { url: "/a/e-BBBBBBBB.js?v=2", kind: "js", via: "entry" },
      { url: "/a/main-EEEEEEEE.css", kind: "css", via: "stylesheet" },
    ]);
  });

  it("reads the release identity", () => {
    expect(parseIndexHtml(html, ORIGIN).release).toEqual({ commitSha: "abc123", builtAt: "2026-11-12T03:06:57Z", deploymentEnvironment: "staging" });
  });

  it("keeps nulls when the identity is missing or broken", () => {
    const r = parseIndexHtml(`<script id="raft-frontend-release-identity" type="application/json">{oops</script>`, ORIGIN).release;
    expect(r).toEqual({ commitSha: null, builtAt: null, deploymentEnvironment: null });
  });
});

describe("staticImports", () => {
  it("matches top-level static imports and re-exports, not dynamic import()", () => {
    const src = `import{a as b}from"./vendor-react-Bm7dREOr.js";import"./side-AAAAAAAA.js";export*from"../x/y-BBBBBBBB.js";
const l=()=>import("./lazy-CCCCCCCC.js");`;
    expect(staticImports(src)).toEqual(["./vendor-react-Bm7dREOr.js", "./side-AAAAAAAA.js", "../x/y-BBBBBBBB.js"]);
  });
  it("matches after a block comment or a closing paren, and with a query", () => {
    expect(staticImports(`/* banner */import"./a-AAAAAAAA.js";(0)\nimport"./b-BBBBBBBB.js?v=1";`)).toEqual(["./a-AAAAAAAA.js", "./b-BBBBBBBB.js?v=1"]);
    expect(staticImports(`x();import{ä as e}from"./c-CCCCCCCC.js";`)).toEqual(["./c-CCCCCCCC.js"]);
  });
  it("ignores bare specifiers", () => {
    expect(staticImports(`import x from "react";`)).toEqual([]);
  });
});

describe("names and paths", () => {
  it("strips the 8-char content hash", () => {
    expect(stableName("/assets/app-shell-BCVSriIS.js")).toBe("app-shell.js");
    expect(stableName("/assets/vendor-zod-axios-DD8_TXDl.js")).toBe("vendor-zod-axios.js");
    expect(stableName("/assets/app-shell-Cyq1Md2G.css")).toBe("app-shell.css");
    expect(stableName("/assets/e-BBBBBBBB.js?v=2")).toBe("e.js");
  });
  it("keeps a lowercase word that only looks like a hash", () => {
    expect(stableName("/a/app-settings.js")).toBe("app-settings.js");
    expect(stableName("/a/vendor.js")).toBe("vendor.js");
  });
  it("resolves same-origin paths only", () => {
    expect(sameOriginPath("/a.js", ORIGIN)).toBe("/a.js");
    expect(sameOriginPath("https://web.example/b.js", ORIGIN)).toBe("/b.js");
    expect(sameOriginPath("https://other.example/b.js", ORIGIN)).toBeNull();
  });
});

const file = (url: string, brBytes: number, kind: FirstScreenFile["kind"] = "js"): FirstScreenFile => ({ url, name: stableName(url), kind, via: "modulepreload", bytes: brBytes * 4, brBytes });
const snap = (commit: string, files: FirstScreenFile[]): FirstScreenSnapshot => ({
  schema: "raft-perf/first-screen@1",
  origin: ORIGIN,
  takenAt: "2026-11-12T00:00:00Z",
  release: { commitSha: commit, builtAt: null, deploymentEnvironment: "staging" },
  html: { bytes: 0, brBytes: 0 },
  files,
  skipped: [],
  totals: totals(files),
});

describe("diffSnapshots", () => {
  const base = snap("b", [file("/assets/vendor-react-AAAAAAAA.js", 70_000), file("/assets/app-shell-BBBBBBBB.js", 500_000), file("/assets/old-CCCCCCCC.js", 1_000), file("/assets/app-shell-DDDDDDDD.css", 60_000, "css")]);

  it("counts changed and added files as re-downloaded; unchanged and removed are not", () => {
    const head = snap("h", [file("/assets/vendor-react-AAAAAAAA.js", 70_000), file("/assets/app-shell-EEEEEEEE.js", 505_000), file("/assets/new-FFFFFFFF.js", 2_000), file("/assets/app-shell-DDDDDDDD.css", 60_000, "css")]);
    const d = diffSnapshots(base, head);
    expect(d.invalidatedBrBytes).toBe(507_000);
    expect(d.growthBrBytes).toBe(6_000);
    expect(d.verdict).toBe("ok");
    expect(Object.fromEntries(d.files.map((f) => [f.name, f.change]))).toEqual({ "vendor-react.js": "unchanged", "app-shell.js": "changed", "new.js": "added", "app-shell.css": "unchanged", "old.js": "removed" });
    expect(d.invalidatedShare).toBeCloseTo(507_000 / 637_000);
  });

  it("several files of one name: re-download decided by URL, not by name or order", () => {
    const b = snap("b", [file("/a/index-AAAAAAAA.js", 100), file("/a/index-BBBBBBBB.js", 200)]);
    const h1 = snap("h", [file("/a/index-AAAAAAAA.js", 100), file("/a/index-CCCCCCCC.js", 200)]);
    const h2 = snap("h", [file("/a/index-CCCCCCCC.js", 200), file("/a/index-AAAAAAAA.js", 100)]);
    for (const h of [h1, h2]) {
      const d = diffSnapshots(b, h);
      expect(d.invalidatedBrBytes).toBe(200);
      expect(d.files.find((f) => f.headUrl === "/a/index-AAAAAAAA.js")?.change).toBe("unchanged");
      expect(d.files.filter((f) => f.change === "changed").map((f) => [f.baseUrl, f.headUrl])).toEqual([["/a/index-BBBBBBBB.js", "/a/index-CCCCCCCC.js"]]);
    }
  });

  it("identical builds: nothing re-downloaded, ok", () => {
    const d = diffSnapshots(base, base);
    expect(d.invalidatedBrBytes).toBe(0);
    expect(d.verdict).toBe("ok");
  });

  it("grew past the threshold -> grew; at the threshold -> ok", () => {
    const head = snap("h", [...base.files, file("/assets/extra-GGGGGGGG.js", 10_241)]);
    expect(diffSnapshots(base, head, 10_240).verdict).toBe("grew");
    const headEq = snap("h", [...base.files, file("/assets/extra-GGGGGGGG.js", 10_240)]);
    expect(diffSnapshots(base, headEq, 10_240).verdict).toBe("ok");
  });
});

describe("toRows", () => {
  it("stamps every row with project, env, run id and tool version; the document is a row", async () => {
    const { toRows } = await import("./takeSnapshot");
    const s = snap("abc", [file("/assets/app-shell-BBBBBBBB.js", 10)]);
    const rows = toRows(s, { project: "raft-web", runId: "r1", toolVersion: "0.1.0" });
    expect(rows.map((r) => r.file_name)).toEqual(["index.html", "app-shell.js"]);
    for (const r of rows) expect(r).toMatchObject({ project: "raft-web", env: "staging", run_id: "r1", tool_version: "0.1.0", commit_sha: "abc" });
    expect(toRows(s, { project: "p", runId: "r", toolVersion: "v", env: "production" })[1].env).toBe("production");
  });
});

describe("other webs (not Raft)", () => {
  it("finds the module script after inline SSR state that contains '<!--'", () => {
    const h = `<script>window.$S="<!--x";</script><link rel="modulepreload" href="/assets/index-AAAAAAAA.js"><script type="module" async="" src="/assets/index-AAAAAAAA.js"></script><script>/* --> */</script>`;
    expect(parseIndexHtml(h, ORIGIN).assets.map((a) => [a.url, a.via])).toEqual([["/assets/index-AAAAAAAA.js", "entry"]]);
    const h2 = `<script>window.$S="<!--x";</script><script type="module" async="" src="/assets/main-BBBBBBBB.js"></script>`;
    expect(parseIndexHtml(h2, ORIGIN).assets.map((a) => a.via)).toEqual(["entry"]);
  });

  const f2 = (url: string, brBytes: number, sha?: string, cacheControl?: string | null): FirstScreenFile => ({ ...file(url, brBytes), ...(sha ? { sha256: sha } : {}), ...(cacheControl !== undefined ? { cacheControl } : {}) });

  it("unhashed names: same URL with new content is changed and re-downloaded; same content is kept", () => {
    const base = snap("b", [f2("/main.js", 700, "s1", "public, max-age=60"), f2("/main.css", 60, "c1", "public, max-age=60")]);
    const head = snap("h", [f2("/main.js", 710, "s2", "public, max-age=60"), f2("/main.css", 60, "c1", "public, max-age=60")]);
    const d = diffSnapshots(base, head);
    expect(d.invalidatedBrBytes).toBe(710);
    expect(Object.fromEntries(d.files.map((f) => [f.name, f.change]))).toEqual({ "main.css": "unchanged", "main.js": "changed" });
  });

  it("no-store files are re-downloaded on every visit, even unchanged", () => {
    const base = snap("b", [f2("/main.js", 700, "s1", "no-store")]);
    const d = diffSnapshots(base, base);
    expect(d.invalidatedBrBytes).toBe(700);
    expect(d.uncachedBrBytes).toBe(700);
    expect(d.files).toEqual([expect.objectContaining({ name: "main.js", change: "unchanged", uncached: true })]);
  });

  it("older snapshots without hashes fall back to the URL", () => {
    const base = snap("b", [file("/main.js", 700)]);
    const head = snap("h", [f2("/main.js", 700, "s9", "public")]);
    expect(diffSnapshots(base, head).invalidatedBrBytes).toBe(0);
  });
});

describe("review round 1 (#14450)", () => {
  const g = (url: string, brBytes: number, sha: string, cacheControl: string | null = "public"): FirstScreenFile => ({ ...file(url, brBytes), sha256: sha, cacheControl });
  it("pairs a same-URL file before name labels, even with duplicate names", () => {
    const base = snap("b", [g("/a/x-AAAAAAAA.js", 10, "a", "no-store"), g("/a/x-BBBBBBBB.js", 20, "b")]);
    const head = snap("h", [g("/a/x-CCCCCCCC.js", 30, "c"), g("/a/x-AAAAAAAA.js", 10, "a", "no-store")]);
    const d = diffSnapshots(base, head);
    expect(d.files.map((f) => [f.baseUrl, f.headUrl, f.change, !!f.uncached])).toEqual([
      ["/a/x-AAAAAAAA.js", "/a/x-AAAAAAAA.js", "unchanged", true],
      ["/a/x-BBBBBBBB.js", "/a/x-CCCCCCCC.js", "changed", false],
    ]);
    expect(d.invalidatedBrBytes).toBe(40);
    expect(d.uncachedBrBytes).toBe(10);
  });
  it("reports a base file as removed when its name partner is a same-URL no-store file", () => {
    const base = snap("b", [g("/a/x-BBBBBBBB.js", 20, "b"), g("/a/x-AAAAAAAA.js", 10, "a", "no-store")]);
    const head = snap("h", [g("/a/x-AAAAAAAA.js", 10, "a", "no-store")]);
    expect(diffSnapshots(base, head).files.map((f) => [f.baseUrl, f.change])).toEqual([["/a/x-AAAAAAAA.js", "unchanged"], ["/a/x-BBBBBBBB.js", "removed"]]);
  });
  it("the module script is the entry even when its preload comes first", () => {
    const h = `<link rel="modulepreload" href="/assets/index-AAAAAAAA.js"><script type="module" async src="/assets/index-AAAAAAAA.js"></script>`;
    expect(parseIndexHtml(h, ORIGIN).assets).toEqual([{ url: "/assets/index-AAAAAAAA.js", kind: "js", via: "entry" }]);
  });
});

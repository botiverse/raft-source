// The public Artifact page on the server (publicPage.ts): the same answers
// the Pages Worker gives at /artifacts/* (packages/web/public/_worker.js and
// its tests, cloudflareArtifactPreview.test.ts and the older-link cases of
// cloudflareAssetWorker.test.ts), for when app.raft.build's CloudFront sends
// /artifacts/* here. The router runs on a real Express app with a fake shell
// and fake page data: what it writes into the shell (escaped, every file
// listed), noindex, no-store and no validators, the Markdown answer for an
// Accept that prefers it, the 301 for an older link, the shell's own security
// headers in place of the API's, and that any failure leaves the shell as it
// is. Core's edge check (firstPartyAppRoutes.ts) answers a plain 404 to every
// request without the app edge marker, and to all while it isn't configured.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type RequestHandler } from "express";
import { artifactLinkId, artifactPublicPaths, asArtifactId, encodeArtifactShortId, parseArtifactId, type ArtifactId, type ArtifactPublicMeta } from "@botiverse/raft-shared";
import { APP_EDGE_HEADER, cameThroughAppEdge, mountFirstPartyAppPublicPages } from "../../routes/firstPartyAppRoutes";
import {
  ARTICLE_TEXT_MAX_BYTES,
  articleText,
  createArtifactPublicPageRouter,
  createShellSource,
  entryAlternateType,
  escapeHtml,
  injectPreview,
  legacyLinkLocation,
  pageShortId,
  prefersMarkdown,
  type PublicPageDeps,
  type ShellCopy,
} from "./publicPage";

const UUID = "0b6a2c1e-6f2d-4a8e-9a51-6a1f0e9d3c42";
const ID = artifactLinkId(asArtifactId(`pt_${UUID}`));
const API = "https://api.example.test";
const APP = "https://app.raft.build";
const SHELL = "<!doctype html><html><head><meta charset=\"UTF-8\" /><title>Raft</title></head><body><div id=\"root\"></div></body></html>";
const SHELL_CSP = "base-uri 'self'; object-src 'none'; frame-ancestors 'none'";
const META: ArtifactPublicMeta = {
  title: "Q3 report",
  description: "Revenue grew 12% on the quarter.",
  updatedAt: "2026-10-29T08:00:00.000Z",
  kind: "html",
  entry: "index.html",
  files: [
    { path: "data/q3 (final).csv", size: 2048, entry: false },
    { path: "index.html", size: 900, entry: true },
  ],
};
const MARKDOWN = "# Q3 report\n\nUpdated 2026-10-29\n\n## Text\n\nRevenue grew 12% on the quarter.\n";

const passThrough: RequestHandler = (_req, _res, next) => next();

function fakeShell(copy: ShellCopy | null = { body: SHELL, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": SHELL_CSP }, etag: "\"s1\"" }) {
  let asked = 0;
  return { source: { get: async () => { asked += 1; return copy; } }, asked: () => asked };
}

function fakeDeps(overrides: Partial<PublicPageDeps> = {}) {
  const asked: ArtifactId[] = [];
  const deps: PublicPageDeps = {
    page: async (id) => {
      asked.push(id);
      return { meta: META, markdown: MARKDOWN };
    },
    shell: fakeShell().source,
    pageOrigin: () => APP,
    apiOrigin: () => API,
    ...overrides,
  };
  return { deps, asked };
}

/** A real Express app with the router at /artifacts, as core mounts it, behind helmet-like API headers it must replace. */
async function serve(deps: PublicPageDeps, limiter: RequestHandler = passThrough) {
  const app = express();
  app.use((_req, res, next) => {
    res.setHeader("Content-Security-Policy", "default-src 'self'");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    next();
  });
  app.use("/artifacts", createArtifactPublicPageRouter(deps, limiter));
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    get: (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual", ...init }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function page(path: string, init: RequestInit = {}, overrides: Partial<PublicPageDeps> = {}) {
  const { deps, asked } = fakeDeps(overrides);
  const site = await serve(deps);
  try {
    const response = await site.get(path, init);
    return { response, body: await response.text(), asked };
  } finally {
    await site.close();
  }
}

describe("the public Artifact page's head", () => {
  test("writes the title, Open Graph, Twitter, canonical, both alternates and noindex from the public meta", async () => {
    const { response, body, asked } = await page(`/artifacts/${ID}`);
    assert.deepEqual(asked, [`pt_${UUID}`], "the page's data, once, by the id the short one stands for");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal(response.headers.get("cache-control"), "no-store", "made for this request only");
    assert.equal(response.headers.get("etag"), null, "no validator: a browser can't revalidate into an old copy");
    assert.equal(response.headers.get("last-modified"), null);
    assert.equal(response.headers.get("vary"), "Accept");
    assert.equal(response.headers.get("x-raft-artifact-preview"), "1", "marked for the service worker");
    assert.equal(response.headers.get("x-raft-artifact-diagnostic"), "injected");
    assert.match(body, /<title>Q3 report | Raft<\/title>/);
    assert.equal((body.match(/<title>/g) ?? []).length, 1);
    for (const tag of [
      `<meta name="robots" content="noindex, nofollow">`,
      `<meta property="og:title" content="Q3 report">`,
      `<meta property="og:description" content="Revenue grew 12% on the quarter.">`,
      `<meta property="og:type" content="article">`,
      `<meta property="og:url" content="${APP}/artifacts/${ID}">`,
      `<meta property="og:image" content="${APP}/android-chrome-512x512.png">`,
      `<meta name="twitter:card" content="summary">`,
      `<meta name="twitter:title" content="Q3 report">`,
      `<meta name="twitter:description" content="Revenue grew 12% on the quarter.">`,
      `<link rel="canonical" href="${APP}/artifacts/${ID}">`,
      `<link rel="alternate" type="text/markdown" href="${API}/api/public/artifacts/${ID}/index.md">`,
      `<link rel="alternate" type="text/html" title="Source" href="${API}/api/public/artifacts/${ID}/files/index.html">`,
    ]) {
      assert.ok(body.includes(tag), tag);
    }
    assert.ok(body.indexOf("og:title") < body.indexOf("</head>"), "in the head");
    // The Markdown alternate is the contract's index.md route, by the short id.
    assert.ok(body.includes(`${API}${artifactPublicPaths.markdown(asArtifactId(ID))}`));
  });

  test("a pinned version's page (/v/<n>) gets the same head, its canonical the Artifact's address", async () => {
    const { body } = await page(`/artifacts/${ID}/v/3`);
    assert.ok(body.includes(`<link rel="canonical" href="${APP}/artifacts/${ID}">`));
  });

  test("the canonical is the configured web origin, never the request's Host", async () => {
    const { body } = await page(`/artifacts/${ID}`, { headers: { Host: "api.example.test" } });
    assert.ok(body.includes(`<link rel="canonical" href="${APP}/artifacts/${ID}">`));
    assert.ok(!body.includes("http://api.example.test"));
  });

  test("escapes everything it injects: a title, description or entry path can't open a tag or leave its attribute", async () => {
    const hostile: ArtifactPublicMeta = {
      ...META,
      title: `</title><script>alert(1)</script>"'&`,
      description: `"><img src=x onerror=alert(1)>`,
      entry: `pages/a "b" <c>.html`,
    };
    const { body } = await page(`/artifacts/${ID}`, {}, { page: async () => ({ meta: hostile, markdown: "</pre><script>alert(4)</script>" }) });
    assert.ok(!body.includes("<script>alert"), "no script from the title or index.md");
    assert.ok(!body.includes("<img"), "no tag from the description");
    assert.match(body, /<title>&lt;\/title&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;&#39;&amp; | Raft<\/title>/);
    assert.ok(body.includes(`<meta property="og:description" content="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">`));
    assert.ok(body.includes(`href="${API}/api/public/artifacts/${ID}/files/pages/a%20%22b%22%20%3Cc%3E.html"`));
    assert.ok(body.includes("<pre>&lt;/pre&gt;&lt;script&gt;alert(4)&lt;/script&gt;</pre>"));
  });

  test("asks for the page's data on every view: nothing is cached, so unpublishing takes effect at once", async () => {
    let visible = true;
    const { deps, asked } = fakeDeps({ page: async (id) => { asked.push(id); return visible ? { meta: META, markdown: MARKDOWN } : null; } });
    const site = await serve(deps);
    try {
      assert.match(await (await site.get(`/artifacts/${ID}`)).text(), /Q3 report | Raft/);
      visible = false;
      const after = await site.get(`/artifacts/${ID}`);
      assert.equal(await after.text(), SHELL);
      assert.equal(after.headers.get("x-raft-artifact-diagnostic"), "skipped=not_public");
      assert.equal(asked.length, 2);
    } finally {
      await site.close();
    }
  });

  test("a conditional request gets the whole shell, never a 304 onto a copy rewritten before", async () => {
    const { response } = await page(`/artifacts/${ID}`, { headers: { "If-None-Match": "\"s1\"", "If-Modified-Since": new Date().toUTCString() } });
    assert.equal(response.status, 200);
  });
});

describe("the page's article", () => {
  test("puts a readable article in the mount element: title, date, the zip and every file, index.md's text, the Markdown version", async () => {
    const { body } = await page(`/artifacts/${ID}`);
    const article = /<div id="root">(<article data-raft-artifact-preview style="[^"]*">[\s\S]*?<\/article>)<\/div>/.exec(body)?.[1];
    assert.ok(article, "inside #root");
    assert.match(article, /style="position:absolute;width:1px;height:1px;[^"]*clip:rect\(0 0 0 0\)/, "visually hidden until the app mounts");
    const base = `${API}/api/public/artifacts/${ID}`;
    assert.equal(article.replace(/^<article[^>]*>\n/, ""), [
      "<h1>Q3 report</h1>",
      "<p>Updated 2026-10-29</p>",
      "<p>This is a Raft Artifact. Download its files:</p>",
      "<ul>",
      `<li><a href="${base}/download.zip">All files (zip)</a></li>`,
      `<li><a href="${base}/files/data/q3%20(final).csv">data/q3 (final).csv</a> (2.0 KB)</li>`,
      `<li><a href="${base}/files/index.html">index.html</a> (900 B, entry file)</li>`,
      "</ul>",
      `<pre>${escapeHtml(MARKDOWN)}</pre>`,
      `<p>Markdown version: <a href="${base}/index.md">${base}/index.md</a></p>`,
      "</article>",
    ].join("\n"));
  });

  test("cuts index.md's text at 50 KB of UTF-8, at a character boundary, with a note pointing at the Markdown version", async () => {
    const long = `${"a".repeat(ARTICLE_TEXT_MAX_BYTES - 1)}é and more`;
    const cut = articleText(long);
    assert.equal(cut.cut, true);
    assert.equal(cut.text, "a".repeat(ARTICLE_TEXT_MAX_BYTES - 1), "the two-byte é that straddles the limit is left out whole");
    assert.deepEqual(articleText("short"), { text: "short", cut: false });
    const { body } = await page(`/artifacts/${ID}`, {}, { page: async () => ({ meta: META, markdown: long }) });
    assert.ok(body.includes(`The text above is cut at ${ARTICLE_TEXT_MAX_BYTES / 1024} KB. The full text is in the Markdown version:`));
    assert.ok(!body.includes("and more"));
  });

  test("the entry file's alternate is typed by its extension: HTML or Markdown, none for any other file", () => {
    assert.equal(entryAlternateType("index.html"), "text/html");
    assert.equal(entryAlternateType("docs/page.HTM"), "text/html");
    assert.equal(entryAlternateType("README.md"), "text/markdown");
    assert.equal(entryAlternateType("notes.markdown"), "text/markdown");
    assert.equal(entryAlternateType("data.csv"), null);
    assert.equal(entryAlternateType(".md"), null, "a dotfile has no extension");
    assert.equal(entryAlternateType("dir.md/file"), null);
  });
});

describe("a page that isn't rewritten", () => {
  test("not public, an error, an empty title or no API origin: the shell exactly as it was, with the reason", async () => {
    const cases: Array<[string, Partial<PublicPageDeps>, string]> = [
      ["not public", { page: async () => null }, "skipped=not_public"],
      ["an error", { page: async () => { throw new TypeError("db down"); } }, "skipped=error_TypeError"],
      ["an empty title", { page: async () => ({ meta: { ...META, title: "  " }, markdown: MARKDOWN }) }, "skipped=invalid"],
      ["no API origin", { apiOrigin: () => null }, "skipped=no_api_origin"],
    ];
    for (const [why, overrides, diagnostic] of cases) {
      const { response, body } = await page(`/artifacts/${ID}`, {}, overrides);
      assert.equal(response.status, 200, why);
      assert.equal(body, SHELL, why);
      assert.equal(response.headers.get("x-raft-artifact-diagnostic"), diagnostic, why);
      assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow", `${why}: noindex all the same`);
      assert.equal(response.headers.get("x-raft-artifact-preview"), null, why);
    }
  });

  test("#root with attributes, as the built shell has it (`translate=\"no\" class=\"notranslate\"`): written in, the attributes kept", () => {
    const built = "<html><head><title>Raft</title></head><body><div id=\"root\" translate=\"no\" class=\"notranslate\"></div></body></html>";
    assert.equal(
      injectPreview(built, { title: "t", head: "<meta name=\"h\">", article: "<article>a</article>" }),
      "<html><head><title>t</title><meta name=\"h\">\n</head><body><div id=\"root\" translate=\"no\" class=\"notranslate\"><article>a</article></div></body></html>",
    );
    assert.equal(injectPreview("<html><head><title>x</title></head><body><div id=\"rootish\"></div></body></html>", { title: "t", head: "h", article: "a" }), null, "another id is no #root");
  });

  test("a shell without its markers is answered as it is", async () => {
    const odd = fakeShell({ body: "<html><body>maintenance</body></html>", headers: { "content-type": "text/html" }, etag: null });
    const { body, response } = await page(`/artifacts/${ID}`, {}, { shell: odd.source });
    assert.equal(body, "<html><body>maintenance</body></html>");
    assert.equal(response.headers.get("x-raft-artifact-diagnostic"), "skipped=shell_markers");
    assert.equal(injectPreview("<title>x</title><div id=\"root\"></div></head>", { title: "t", head: "h", article: "a" }), null, "#root before </head> is no shell of ours");
  });

  test("HEAD: the shell's headers and noindex, nothing asked, no body", async () => {
    const { response, body, asked } = await page(`/artifacts/${ID}`, { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.equal(body, "");
    assert.deepEqual(asked, []);
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  });

  test("no shell at all (the web never answered): 503", async () => {
    const { response } = await page(`/artifacts/${ID}`, {}, { shell: fakeShell(null).source });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  test("another path under /artifacts/ is the shell as it is, with no diagnostic and no noindex of the page's", async () => {
    for (const path of ["/artifacts/", "/artifacts/dashboard", `/artifacts/${ID}/files/a.html`, `/artifacts/${ID}x`]) {
      const { response, body, asked } = await page(path);
      assert.equal(body, SHELL, path);
      assert.deepEqual(asked, [], path);
      assert.equal(response.headers.get("x-raft-artifact-diagnostic"), null, path);
    }
  });

  test("a POST passes on: the page answers GET and HEAD only", async () => {
    const { response } = await page(`/artifacts/${ID}`, { method: "POST" });
    assert.equal(response.status, 404);
  });
});

describe("the page's security headers", () => {
  test("the shell's CSP and its defaults, never the API's helmet CSP or isolation headers", async () => {
    const { response } = await page(`/artifacts/${ID}`);
    assert.equal(response.headers.get("content-security-policy"), SHELL_CSP);
    assert.equal(response.headers.get("cross-origin-opener-policy"), null);
    assert.equal(response.headers.get("cross-origin-resource-policy"), null);
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  });

  test("a shell without a CSP header (its CSP in the HTML's meta): none from the API either", async () => {
    const shell = fakeShell({ body: SHELL, headers: { "content-type": "text/html" }, etag: null });
    const { response } = await page(`/artifacts/${ID}`, {}, { shell: shell.source });
    assert.equal(response.headers.get("content-security-policy"), null);
  });
});

describe("a request that prefers Markdown", () => {
  test("reads Accept's q values: Markdown only when it is listed and beats text/html", () => {
    assert.equal(prefersMarkdown("text/markdown"), true);
    assert.equal(prefersMarkdown("text/markdown, text/html;q=0.9"), true);
    assert.equal(prefersMarkdown("text/html, text/markdown;q=0.9"), false);
    assert.equal(prefersMarkdown("text/markdown;q=0"), false);
    assert.equal(prefersMarkdown("text/html"), false);
    assert.equal(prefersMarkdown("*/*"), false);
    assert.equal(prefersMarkdown(undefined), false);
  });

  test("gets index.md with its own headers, for the page and a pinned version", async () => {
    for (const path of [`/artifacts/${ID}`, `/artifacts/${ID}/v/2`]) {
      const { response, body } = await page(path, { headers: { Accept: "text/markdown" } });
      assert.equal(response.status, 200, path);
      assert.equal(body, MARKDOWN, path);
      assert.equal(response.headers.get("content-type"), "text/markdown; charset=utf-8");
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; sandbox", "its own CSP, not the app's");
      assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
      assert.equal(response.headers.get("x-raft-artifact-preview"), "1");
      assert.equal(response.headers.get("x-frame-options"), "DENY");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.equal(response.headers.get("vary"), "Accept");
    }
  });

  test("not public or a failure: the page as usual, saying why, the data asked once", async () => {
    const asked: ArtifactId[] = [];
    const { response, body } = await page(`/artifacts/${ID}`, { headers: { Accept: "text/markdown" } }, { page: async (id) => { asked.push(id); return null; } });
    assert.equal(body, SHELL);
    assert.equal(response.headers.get("x-raft-artifact-diagnostic"), "skipped=not_public; markdown=not_public");
    assert.equal(asked.length, 1, "not asked again for the page");
  });
});

describe("an older Artifact link moves to its short id", () => {
  test("GET and HEAD of /artifacts/pt_<uuid>[/v/<n>] get a 301 to /artifacts/<short id>, the query kept", async () => {
    const short = encodeArtifactShortId(UUID);
    for (const method of ["GET", "HEAD"]) {
      const { response } = await page(`/artifacts/pt_${UUID}/v/4?from=chat`, { method });
      assert.equal(response.status, 301, method);
      assert.equal(response.headers.get("location"), `/artifacts/${short}/v/4?from=chat`, method);
      assert.equal(response.headers.get("cache-control"), "public, max-age=86400", method);
    }
    assert.equal(legacyLinkLocation(`/artifacts/pt_${UUID}/`, ""), `/artifacts/${short}`);
  });

  test("the short id is the shared codec's, and it names the same Artifact", () => {
    const location = legacyLinkLocation(`/artifacts/pt_${UUID}`, "");
    const short = location!.slice("/artifacts/".length);
    assert.equal(pageShortId(location!), short);
    assert.equal(parseArtifactId(short), `pt_${UUID}`);
  });

  test("anything else isn't moved: the short form, a malformed or uppercase id, a file path", () => {
    for (const path of [`/artifacts/${ID}`, `/artifacts/pt_${UUID.toUpperCase()}`, `/artifacts/pt_${UUID.slice(0, -1)}`, `/artifacts/pt_${UUID}/files/a.html`, "/artifacts/"]) {
      assert.equal(legacyLinkLocation(path, ""), null, path);
    }
  });
});

describe("the shell source", () => {
  test("asks with the last copy's ETag, keeps it on a 304, answers it when the web fails, never follows a redirect", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const answers: Array<() => Response> = [
      () => new Response(SHELL, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", ETag: "\"a\"", "Content-Security-Policy": SHELL_CSP } }),
      () => new Response(null, { status: 304 }),
      () => { throw new TypeError("fetch failed"); },
      () => new Response(null, { status: 302, headers: { Location: "/elsewhere" } }),
      () => new Response("<html>new</html>", { status: 200, headers: { "Content-Type": "text/html", ETag: "\"b\"" } }),
    ];
    const source = createShellSource({
      url: () => `${APP}/`,
      fetch: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return answers.shift()!(); }) as unknown as typeof fetch,
    });
    const first = await source.get();
    assert.equal(first?.body, SHELL);
    assert.equal(first?.headers["content-security-policy"], SHELL_CSP);
    assert.equal((await source.get())?.body, SHELL, "a 304 keeps the copy");
    assert.equal((await source.get())?.body, SHELL, "a failure answers the last good copy");
    assert.equal((await source.get())?.body, SHELL, "a redirect isn't a shell");
    assert.equal((await source.get())?.body, "<html>new</html>", "a new 200 replaces it");
    assert.equal(calls[0]!.init.redirect, "manual");
    assert.deepEqual(calls[0]!.init.headers, { Accept: "text/html" }, "no validator the first time");
    assert.deepEqual(calls[1]!.init.headers, { Accept: "text/html", "If-None-Match": "\"a\"" });
    assert.ok(calls.every((call) => call.url === `${APP}/`));
  });

  test("never a shell before the first 200 HTML", async () => {
    const source = createShellSource({ url: () => `${APP}/`, fetch: (async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch });
    assert.equal(await source.get(), null);
  });
});

describe("core's edge check", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const request = (header: string | undefined) => ({ get: (name: string) => (name.toLowerCase() === APP_EDGE_HEADER ? header : undefined) }) as unknown as express.Request;

  test("only a request carrying the configured marker came through the app's edge", () => {
    assert.equal(cameThroughAppEdge(request("edge-1"), {}), false, "nothing while it isn't configured");
    assert.equal(cameThroughAppEdge(request("edge-1"), { RAFT_APP_EDGE_HEADER_VALUE: " " }), false, "a blank value is no value");
    assert.equal(cameThroughAppEdge(request(undefined), { RAFT_APP_EDGE_HEADER_VALUE: "edge-1" }), false, "no header");
    assert.equal(cameThroughAppEdge(request("edge-2"), { RAFT_APP_EDGE_HEADER_VALUE: "edge-1" }), false, "another value");
    assert.equal(cameThroughAppEdge(request("edge-1"), { RAFT_APP_EDGE_HEADER_VALUE: "edge-1" }), true);
  });

  test("the mounted page answers a plain 404 without the marker, and the page through it", async () => {
    const shellSite = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(SHELL);
    });
    await new Promise<void>((resolve) => shellSite.listen(0, "127.0.0.1", resolve));
    vi.stubEnv("ARTIFACT_PAGE_SHELL_URL", `http://127.0.0.1:${(shellSite.address() as AddressInfo).port}/`);
    const app = express();
    for (const { path, router } of mountFirstPartyAppPublicPages(() => passThrough)) app.use(path, router);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      // A path with no Artifact data to read: the shell as it is, once through the edge.
      const unconfigured = await fetch(`${base}/artifacts/`, { headers: { [APP_EDGE_HEADER]: "edge-1" } });
      assert.equal(unconfigured.status, 404, "dark until configured");
      assert.equal(unconfigured.headers.get("cache-control"), "no-store");
      vi.stubEnv("RAFT_APP_EDGE_HEADER_VALUE", "edge-1");
      assert.equal((await fetch(`${base}/artifacts/`)).status, 404, "no marker: the API's origin never serves the page");
      assert.equal((await fetch(`${base}/artifacts/`, { headers: { [APP_EDGE_HEADER]: "edge-2" } })).status, 404, "another marker");
      const through = await fetch(`${base}/artifacts/`, { headers: { [APP_EDGE_HEADER]: "edge-1" } });
      assert.equal(through.status, 200);
      assert.equal(await through.text(), SHELL);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => shellSite.close(() => resolve()));
    }
  });
});

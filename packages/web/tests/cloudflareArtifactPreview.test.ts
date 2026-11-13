// Public Artifact pages' preview head and the crawler-facing files
// (public/_worker.js, public/robots.txt, public/llms.txt,
// scripts/workerApiOrigin.ts). The Worker runs here with a stubbed fetch and
// a small stand-in for Cloudflare's HTMLRewriter (Node has none): what it
// asks the API (every time: nothing cached), what it writes into the shell's
// head and mount element (escaped, every file listed), noindex, the Markdown
// answer for an Accept that prefers it, and that any failure, a non-200, a
// timeout or no API origin leaves the page exactly as it was.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AI_TRAINING_CRAWLERS, artifactLinkId, asArtifactId } from "@botiverse/raft-shared";
import { WORKER_API_ORIGIN_PLACEHOLDER, applyWorkerApiOrigin, workerApiOrigin } from "../scripts/workerApiOrigin";

type Meta = { title: string; description: string; updatedAt: string; kind: string; entry: string; files: Array<{ path: string; size: number; entry: boolean }> };
type Deps = {
  apiOrigin: string | null;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  HTMLRewriter?: unknown;
  timeoutMs?: number;
};
type WorkerModule = {
  default: { fetch(request: Request, env: { ASSETS: { fetch(request: Request): Promise<Response> } }): Promise<Response> };
  artifactPageResponse(request: Request, response: Response, deps: Deps): Promise<Response>;
  artifactMarkdownResponse(request: Request, deps: Deps): Promise<Response | null>;
  prefersMarkdown(request: Request): boolean;
  handleRequest(request: Request, env: { ASSETS: { fetch(request: Request): Promise<Response> } }, deps: Deps): Promise<Response>;
  configuredApiOrigin(value?: string): string | null;
  escapeHtml(value: string): string;
};

const webRoot = resolve(import.meta.dirname, "..");
const workerUrl = pathToFileURL(resolve(webRoot, "public/_worker.js")).href;
const worker = await import(workerUrl) as WorkerModule;

// A page address carries the short id (an older pt_ one is moved to it first: cloudflareAssetWorker.test.ts).
const ID = artifactLinkId(asArtifactId("pt_0b6a2c1e-6f2d-4a8e-9a51-6a1f0e9d3c42"));
const API = "https://api.example.test";
const SHELL = "<!doctype html><html><head><meta charset=\"UTF-8\" /><title>Raft</title></head><body><div id=\"root\"></div></body></html>";
const META: Meta = {
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

/**
 * A stand-in for HTMLRewriter with the two calls the Worker makes:
 * `setInnerContent` on `<title>` and `append` to `<head>`, both with
 * `{ html: true }` (anything else is escaped, as Cloudflare's would).
 */
class FakeHTMLRewriter {
  private handlers: Array<[string, { element(element: unknown): void }]> = [];
  on(selector: string, handler: { element(element: unknown): void }) {
    this.handlers.push([selector, handler]);
    return this;
  }
  transform(response: Response): Response {
    const handlers = this.handlers;
    const body = (async () => {
      let html = await response.text();
      const content = (text: string, options?: { html?: boolean }) => (options?.html ? text : worker.escapeHtml(text));
      for (const [selector, handler] of handlers) {
        if (selector === "title") {
          handler.element({ setInnerContent: (text: string, options?: { html?: boolean }) => { html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${content(text, options)}</title>`); } });
        } else if (selector === "head") {
          handler.element({ append: (text: string, options?: { html?: boolean }) => { html = html.replace("</head>", `${content(text, options)}</head>`); } });
        } else if (selector === "#root") {
          handler.element({ prepend: (text: string, options?: { html?: boolean }) => { html = html.replace(/(<div id="root"[^>]*>)/, `$1${content(text, options)}`); } });
        } else {
          throw new Error(`unexpected selector ${selector}`);
        }
      }
      return html;
    })();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(await body));
        controller.close();
      },
    });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
}

function shell() {
  return new Response(SHELL, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", ETag: "\"shell-1\"", "Last-Modified": "Wed, 28 Oct 2026 08:00:00 GMT" } });
}

/** A stubbed fetch answering the API's meta route; records every URL asked. */
function api(answer: () => Response | Promise<Response>) {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url: string) => {
      calls.push(url);
      return answer();
    },
  };
}
const metaAnswer = (meta: unknown = META, status = 200) => () => Response.json(meta, { status, headers: { "Cache-Control": "private, no-store" } });

async function page(path: string, deps: Partial<Deps> & Pick<Deps, "fetch">, method = "GET") {
  return worker.artifactPageResponse(new Request(`https://app.raft.build${path}`, { method }), shell(), {
    apiOrigin: API,
    HTMLRewriter: FakeHTMLRewriter,
    ...deps,
  });
}

describe("public Artifact page preview head", () => {
  test("writes the title, Open Graph, Twitter, canonical, both alternates and noindex from the API's public meta", async () => {
    const stub = api(metaAnswer());
    const response = await page(`/artifacts/${ID}`, { fetch: stub.fetch });
    assert.deepEqual(stub.calls, [`${API}/api/public/artifacts/${ID}/meta`, `${API}/api/public/artifacts/${ID}/index.md`], "the meta, and index.md for the article");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal(response.headers.get("cache-control"), "no-store", "made for this request only");
    assert.equal(response.headers.get("etag"), null, "no validator: a browser can't revalidate into an old copy");
    assert.equal(response.headers.get("last-modified"), null);
    assert.equal(response.headers.get("x-raft-artifact-preview"), "1", "marked for the service worker");
    const html = await response.text();
    assert.match(html, /<title>Q3 report | Raft<\/title>/);
    assert.equal((html.match(/<title>/g) ?? []).length, 1);
    for (const tag of [
      `<meta name="robots" content="noindex, nofollow">`,
      `<meta property="og:title" content="Q3 report">`,
      `<meta property="og:description" content="Revenue grew 12% on the quarter.">`,
      `<meta property="og:type" content="article">`,
      `<meta property="og:url" content="https://app.raft.build/artifacts/${ID}">`,
      `<meta property="og:image" content="https://app.raft.build/android-chrome-512x512.png">`,
      `<meta name="twitter:card" content="summary">`,
      `<meta name="twitter:title" content="Q3 report">`,
      `<meta name="twitter:description" content="Revenue grew 12% on the quarter.">`,
      `<link rel="canonical" href="https://app.raft.build/artifacts/${ID}">`,
      `<link rel="alternate" type="text/markdown" href="${API}/api/public/artifacts/${ID}/index.md">`,
      `<link rel="alternate" type="text/html" title="Source" href="${API}/api/public/artifacts/${ID}/files/index.html">`,
    ]) {
      assert.ok(html.includes(tag), tag);
    }
    assert.ok(html.indexOf("og:title") < html.indexOf("</head>"), "in the head");
    assert.ok(!html.includes("summary_large_image"), "a small card: the image is the square app icon");
    // The image is a file that exists.
    readFileSync(resolve(webRoot, "public/android-chrome-512x512.png"));
  });

  test("a pinned version's page (/v/<n>) gets the same head, its canonical the Artifact's address", async () => {
    const stub = api(metaAnswer());
    const html = await (await page(`/artifacts/${ID}/v/3`, { fetch: stub.fetch })).text();
    assert.ok(html.includes(`<link rel="canonical" href="https://app.raft.build/artifacts/${ID}">`));
    assert.deepEqual(stub.calls, [`${API}/api/public/artifacts/${ID}/meta`, `${API}/api/public/artifacts/${ID}/index.md`]);
  });

  test("escapes everything it injects: a title, description or entry path can't open a tag or leave its attribute", async () => {
    const hostile: Meta = {
      ...META,
      title: `</title><script>alert(1)</script>"'&`,
      description: `"><img src=x onerror=alert(1)>`,
      entry: `pages/a "b" <c>.html`,
    };
    const html = await (await page(`/artifacts/${ID}`, { fetch: api(metaAnswer(hostile)).fetch })).text();
    assert.ok(!html.includes("<script>alert"), "no script from the title");
    assert.ok(!html.includes("<img"), "no tag from the description");
    assert.match(html, /<title>&lt;\/title&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;&#39;&amp; | Raft<\/title>/);
    assert.ok(html.includes(`<meta property="og:description" content="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">`));
    assert.ok(html.includes(`href="${API}/api/public/artifacts/${ID}/files/pages/a%20%22b%22%20%3Cc%3E.html"`));
  });

  test("asks the API on every page view: nothing is cached, so unpublishing takes effect at once", async () => {
    let answer = metaAnswer();
    const stub = api(() => answer());
    assert.match(await (await page(`/artifacts/${ID}`, { fetch: stub.fetch })).text(), /Q3 report | Raft/);
    answer = metaAnswer({ error: "artifact not visible", code: "NOT_VISIBLE" }, 404);
    assert.equal(await (await page(`/artifacts/${ID}`, { fetch: stub.fetch })).text(), SHELL);
    assert.equal(stub.calls.length, 4, "the meta and index.md, each time");
    const source = readFileSync(resolve(webRoot, "public/_worker.js"), "utf8");
    assert.ok(!/caches\.|\.put\(/.test(source), "no Cache API");
  });

  test("puts a readable article in the mount element: title, date, description, the zip and every file, the Markdown version", async () => {
    const html = await (await page(`/artifacts/${ID}`, { fetch: api(metaAnswer()).fetch })).text();
    const article = /<div id="root">(<article data-raft-artifact-preview style="[^"]*">[\s\S]*?<\/article>)<\/div>/.exec(html)?.[1];
    assert.ok(article, "inside #root");
    assert.match(article, /style="position:absolute;width:1px;height:1px;[^"]*clip:rect\(0 0 0 0\)/, "visually hidden until the app mounts");
    const base = `${API}/api/public/artifacts/${ID}`;
    assert.equal(article.replace(/^<article[^>]*>\n/, ""), [
      "<h1>Q3 report</h1>",
      "<p>Updated 2026-10-29</p>",
      "<p>Revenue grew 12% on the quarter.</p>",
      "<p>This is a Raft Artifact. Download its files:</p>",
      "<ul>",
      `<li><a href="${base}/download.zip">All files (zip)</a></li>`,
      `<li><a href="${base}/files/data/q3%20(final).csv">data/q3 (final).csv</a> (2.0 KB)</li>`,
      `<li><a href="${base}/files/index.html">index.html</a> (900 B, entry file)</li>`,
      "</ul>",
      `<p>Markdown version: <a href="${base}/index.md">${base}/index.md</a></p>`,
      "</article>",
    ].join("\n"));
    // The app mounts with createRoot (replacing the root's children), never hydrateRoot.
    const main = readFileSync(resolve(webRoot, "src/main.tsx"), "utf8");
    assert.match(main, /createRoot\(document\.getElementById\("root"\)!\)/);
    assert.ok(!main.includes("hydrateRoot"));
    assert.match(readFileSync(resolve(webRoot, "index.html"), "utf8"), /<div id="root"[^>]*><\/div>/);
  });

  test("the article escapes every title, description and path", async () => {
    const hostile: Meta = {
      ...META,
      title: `<img src=x onerror=alert(1)>`,
      description: `</p><script>alert(2)</script>`,
      files: [{ path: `a"><script>alert(3)</script>.html`, size: 1, entry: true }],
      entry: `a"><script>alert(3)</script>.html`,
    };
    const html = await (await page(`/artifacts/${ID}`, { fetch: api(metaAnswer(hostile)).fetch })).text();
    assert.ok(!/<script>|<img /.test(html), "nothing injected opens a tag");
    assert.ok(html.includes("<h1>&lt;img src=x onerror=alert(1)&gt;</h1>"));
    assert.ok(html.includes("<p>&lt;/p&gt;&lt;script&gt;alert(2)&lt;/script&gt;</p>"));
    assert.ok(html.includes(`>a&quot;&gt;&lt;script&gt;alert(3)&lt;/script&gt;.html</a>`));
  });

  test("a non-public Artifact, an error, a timeout or a malformed answer: the page exactly as it was, no head, no article", async () => {
    const cases: Array<[string, () => Response | Promise<Response>]> = [
      ["not public (404)", metaAnswer({ error: "artifact not visible", code: "NOT_VISIBLE" }, 404)],
      ["rate limited (429)", metaAnswer({ code: "RATE_LIMITED" }, 429)],
      ["a server error", () => new Response("oops", { status: 500 })],
      ["a network error", () => { throw new TypeError("fetch failed"); }],
      ["not JSON", () => new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } })],
      ["a malformed body", () => new Response("{", { status: 200, headers: { "Content-Type": "application/json" } })],
      ["a field missing", metaAnswer({ ...META, entry: undefined })],
      ["no file list", metaAnswer({ ...META, files: undefined })],
      ["a malformed file", metaAnswer({ ...META, files: [{ path: "a", size: -1, entry: false }] })],
      ["a field of another type", metaAnswer({ ...META, title: 42 })],
      ["an empty title", metaAnswer({ ...META, title: "  " })],
    ];
    for (const [why, answer] of cases) {
      const response = await page(`/artifacts/${ID}`, { fetch: api(answer).fetch });
      assert.equal(response.status, 200, why);
      const html = await response.text();
      assert.equal(html, SHELL, why);
      assert.ok(!html.includes("data-raft-artifact-preview"), `${why}: no article`);
      assert.equal(response.headers.get("x-robots-tag"), null, why);
    }
    // A meta that never answers: given up on after the timeout.
    const started = Date.now();
    const hanging = await page(`/artifacts/${ID}`, {
      timeoutMs: 50,
      fetch: (_url, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
    });
    assert.equal(await hanging.text(), SHELL);
    assert.ok(Date.now() - started < 2_000);
  });

  test("asks nothing and changes nothing off the Artifact page, for HEAD, a non-HTML or non-200 answer, without an API origin or HTMLRewriter", async () => {
    const stub = api(metaAnswer());
    const unchanged = async (response: Response) => assert.equal(await response.text(), SHELL);
    for (const path of ["/", "/artifacts", `/artifacts/${ID}/comments`, `/artifacts/${ID}/v/0`, `/artifacts/${ID.slice(1)}`, `/artifacts/${ID}0`, "/artifacts/pt_0b6a2c1e-6f2d-4a8e-9a51-6a1f0e9d3c42", "/artifacts/not-an-id", `/s/demo/artifacts/${ID}`]) {
      await unchanged(await page(path, { fetch: stub.fetch }));
    }
    await unchanged(await page(`/artifacts/${ID}`, { fetch: stub.fetch }, "HEAD"));
    await unchanged(await page(`/artifacts/${ID}`, { fetch: stub.fetch, apiOrigin: null }));
    await unchanged(await page(`/artifacts/${ID}`, { fetch: stub.fetch, HTMLRewriter: undefined }));
    assert.deepEqual(stub.calls, []);
    // The Artifact page's meta is asked before the shell is known (beside its fetch), but nothing else is changed.
    const asked = api(metaAnswer());
    const json = await worker.artifactPageResponse(new Request(`https://app.raft.build/artifacts/${ID}`), Response.json({}), { apiOrigin: API, fetch: asked.fetch, HTMLRewriter: FakeHTMLRewriter });
    assert.deepEqual(await json.json(), {});
    const missing = await worker.artifactPageResponse(new Request(`https://app.raft.build/artifacts/${ID}`), new Response("gone", { status: 404, headers: { "Content-Type": "text/html" } }), { apiOrigin: API, fetch: asked.fetch, HTMLRewriter: FakeHTMLRewriter });
    assert.equal(await missing.text(), "gone");
  });

  test("the deployed Worker keeps its security headers on an Artifact page, and with no API origin written in serves the shell unchanged", async () => {
    assert.equal(worker.configuredApiOrigin(), null, "the source holds the placeholder");
    const response = await worker.default.fetch(new Request(`https://app.raft.build/artifacts/${ID}`), { ASSETS: { fetch: async () => shell() } });
    assert.equal(await response.text(), SHELL);
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  });
});

describe("the deployed request path (handleRequest)", () => {
  /** Pages' assets: the shell, or a 304 to a request carrying the shell's ETag; records what it was asked. */
  function assets(delayMs = 0) {
    const seen: Request[] = [];
    return {
      seen,
      env: {
        ASSETS: {
          fetch: async (request: Request) => {
            seen.push(request);
            if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
            if (request.headers.get("if-none-match") === "\"shell-1\"") return new Response(null, { status: 304, headers: { ETag: "\"shell-1\"" } });
            return shell();
          },
        },
      },
    };
  }

  test("a conditional request after an unpublish gets the plain shell, never a 304 onto the rewritten copy", async () => {
    let answer = metaAnswer();
    const stub = api(() => answer());
    const deps = { apiOrigin: API, fetch: stub.fetch, HTMLRewriter: FakeHTMLRewriter };
    const pages = assets();
    const first = await worker.handleRequest(new Request(`https://app.raft.build/artifacts/${ID}`), pages.env, deps);
    assert.match(await first.text(), /Q3 report | Raft/);
    assert.equal(first.headers.get("x-frame-options"), "DENY", "the security headers stay");
    // Unpublished; the browser revalidates with what it holds.
    answer = metaAnswer({ error: "artifact not visible", code: "NOT_VISIBLE" }, 404);
    const conditional = new Request(`https://app.raft.build/artifacts/${ID}`, { headers: { "If-None-Match": "\"shell-1\"", "If-Modified-Since": "Wed, 28 Oct 2026 08:00:00 GMT" } });
    const after = await worker.handleRequest(conditional, pages.env, deps);
    assert.equal(after.status, 200);
    assert.equal(await after.text(), SHELL, "the plain shell");
    assert.equal(pages.seen[1]!.headers.get("if-none-match"), null, "Pages is asked without validators");
    assert.equal(pages.seen[1]!.headers.get("if-modified-since"), null);
    // Elsewhere the validators still reach Pages (its 304s are kept).
    const elsewhere = await worker.handleRequest(new Request("https://app.raft.build/s/demo/channel/general", { headers: { "If-None-Match": "\"shell-1\"" } }), pages.env, deps);
    assert.equal(elsewhere.status, 304);
  });

  test("asks the meta beside the shell's fetch: a slow meta and a slow shell take about the longer, not their sum", async () => {
    const DELAY = 250;
    let metaAskedAt = 0;
    const deps = {
      apiOrigin: API,
      HTMLRewriter: FakeHTMLRewriter,
      fetch: async () => {
        metaAskedAt = Date.now();
        await new Promise((resolve) => setTimeout(resolve, DELAY));
        return metaAnswer()();
      },
    };
    const pages = assets(DELAY);
    const started = Date.now();
    const response = await worker.handleRequest(new Request(`https://app.raft.build/artifacts/${ID}`), pages.env, deps);
    assert.match(await response.text(), /Q3 report | Raft/);
    const elapsed = Date.now() - started;
    assert.ok(metaAskedAt - started < DELAY, "the meta is asked before the shell arrives");
    assert.ok(elapsed < DELAY * 2 - 50, `about max(), not the sum: ${elapsed} ms`);
  });

  test("waits for a meta that takes 450 ms (as the API does from the edge), and gives up on one that never answers after 1.5 s", async () => {
    // The API answers a public meta in 250-450 ms from the edge (staging and production, 2026-10-29).
    const slow = { apiOrigin: API, HTMLRewriter: FakeHTMLRewriter, fetch: async () => { await new Promise((resolve) => setTimeout(resolve, 450)); return metaAnswer()(); } };
    assert.match(await (await worker.handleRequest(new Request(`https://app.raft.build/artifacts/${ID}`), assets().env, slow)).text(), /Q3 report | Raft/);
    const never = { apiOrigin: API, HTMLRewriter: FakeHTMLRewriter, fetch: (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))) };
    const started = Date.now();
    const response = await worker.handleRequest(new Request(`https://app.raft.build/artifacts/${ID}`), assets().env, never);
    assert.equal(await response.text(), SHELL);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 1_400 && elapsed < 2_500, `${elapsed} ms`);
  });
});

describe("the article's full text, the head's card and alternates", () => {
  type Answer = (init?: RequestInit) => Response | Promise<Response>;
  /** A stubbed API answering the meta and index.md routes apart (an unrouted one fails as a network error); records every URL asked. */
  function routes(answers: { meta?: Answer; markdown?: Answer }) {
    const calls: string[] = [];
    return {
      calls,
      fetch: async (url: string, init?: RequestInit) => {
        calls.push(url);
        const answer = url.endsWith("/index.md") ? answers.markdown : answers.meta;
        if (!answer) throw new TypeError("fetch failed");
        return answer(init);
      },
    };
  }
  // index.md as the API sends it (text/plain: ChatGPT's fetch refuses text/markdown).
  const markdown = (body: BodyInit, status = 200): Answer => () => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const hang: Answer = (init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
  const after = (ms: number, answer: Answer): Answer => async (init) => { await new Promise((resolve) => setTimeout(resolve, ms)); return answer(init); };
  const articleOf = (html: string) => /<div id="root">(<article data-raft-artifact-preview [^>]*>[\s\S]*?<\/article>)<\/div>/.exec(html)?.[1];
  const base = `${API}/api/public/artifacts/${ID}`;
  const MAX = 50 * 1024;

  test("puts index.md's text in the article, escaped inside a <pre>, in place of the description; nothing of it anywhere else", async () => {
    const body = "# Q3 report\n\nMarker sentence at 13:05 UTC.\n\n</pre></article><script>alert(1)</script>\n<img src=x onerror=alert(2)> & \"quotes\"\n";
    const stub = routes({ meta: metaAnswer(), markdown: markdown(body) });
    const response = await page(`/artifacts/${ID}`, { fetch: stub.fetch });
    assert.deepEqual(stub.calls, [`${base}/meta`, `${base}/index.md`]);
    assert.equal(response.headers.get("x-raft-artifact-diagnostic"), "injected");
    const html = await response.text();
    assert.ok(!/<script>|<img /.test(html), "the Markdown can't open a tag");
    assert.equal((html.match(/<\/article>/g) ?? []).length, 1, "nor close the article");
    const article = articleOf(html);
    assert.ok(article, "one article inside #root");
    const escaped = "# Q3 report\n\nMarker sentence at 13:05 UTC.\n\n&lt;/pre&gt;&lt;/article&gt;&lt;script&gt;alert(1)&lt;/script&gt;\n&lt;img src=x onerror=alert(2)&gt; &amp; &quot;quotes&quot;\n";
    assert.equal(article.replace(/^<article[^>]*>\n/, ""), [
      "<h1>Q3 report</h1>",
      "<p>Updated 2026-10-29</p>",
      "<p>This is a Raft Artifact. Download its files:</p>",
      "<ul>",
      `<li><a href="${base}/download.zip">All files (zip)</a></li>`,
      `<li><a href="${base}/files/data/q3%20(final).csv">data/q3 (final).csv</a> (2.0 KB)</li>`,
      `<li><a href="${base}/files/index.html">index.html</a> (900 B, entry file)</li>`,
      "</ul>",
      `<pre>${escaped}</pre>`,
      `<p>Markdown version: <a href="${base}/index.md">${base}/index.md</a></p>`,
      "</article>",
    ].join("\n"), "the text with its line breaks; the description is not repeated");
    assert.equal(html.split("Marker sentence").length, 2, "the text appears once, in the article");
    const head = html.slice(0, html.indexOf("</head>"));
    assert.ok(!head.includes("Marker sentence"), "nothing from index.md in the head");
    assert.ok(head.includes(`<meta name="description" content="Revenue grew 12% on the quarter.">`), "the head's description is the meta's");
  });

  test("cuts the text at 50 KB of UTF-8, at a character boundary, with a note pointing at the Markdown version; reads no more of the body", async () => {
    // "a" then two-byte "é"s: byte 51200 is the second byte of one, so the cut goes back a byte.
    const long = `a${"é".repeat(100_000)}`;
    const bytes = new TextEncoder().encode(long);
    let cancelled = false;
    let pulled = 0;
    const stream = () => new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= bytes.length) return controller.close();
        controller.enqueue(bytes.slice(pulled, pulled + 7_000));
        pulled += 7_000;
      },
      cancel() { cancelled = true; },
    });
    const html = await (await page(`/artifacts/${ID}`, { fetch: routes({ meta: metaAnswer(), markdown: () => markdown(stream())() }).fetch })).text();
    const article = articleOf(html)!;
    const text = /<pre>([\s\S]*)<\/pre>/.exec(article)?.[1];
    assert.equal(text, `a${"é".repeat((MAX - 2) / 2)}`, "51199 bytes: the last whole character under the limit");
    assert.ok(!text.includes("�"), "no broken character");
    assert.ok(article.includes(`</pre>\n<p>The text above is cut at 50 KB. The full text is in the Markdown version: <a href="${base}/index.md">${base}/index.md</a></p>`));
    assert.ok(cancelled, "the rest of the body is cancelled");
    assert.ok(pulled < bytes.length, `read ${pulled} of ${bytes.length} bytes`);
    // Exactly 50 KB is whole: no cut, no note.
    const exact = "x".repeat(MAX);
    const whole = articleOf(await (await page(`/artifacts/${ID}`, { fetch: routes({ meta: metaAnswer(), markdown: markdown(exact) }).fetch })).text())!;
    assert.ok(whole.includes(`<pre>${exact}</pre>`));
    assert.ok(!whole.includes("cut at 50 KB"));
  });

  test("index.md failing, refused, not Markdown or timing out: the article keeps the description; no meta: nothing injected whatever index.md says", async () => {
    const cases: Array<[string, Answer]> = [
      ["not public (404)", markdown("# hidden", 404)],
      ["a server error", markdown("oops", 500)],
      ["a network error", () => { throw new TypeError("fetch failed"); }],
      ["a redirect", () => new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/" } })],
      ["not Markdown", () => new Response("<html>", { headers: { "Content-Type": "text/html" } })],
      ["a timeout", hang],
    ];
    for (const [why, answer] of cases) {
      const response = await page(`/artifacts/${ID}`, { timeoutMs: 50, fetch: routes({ meta: metaAnswer(), markdown: answer }).fetch });
      const article = articleOf(await response.text());
      assert.ok(article, why);
      assert.ok(article.includes("<p>Revenue grew 12% on the quarter.</p>"), `${why}: the description`);
      assert.ok(!article.includes("<pre>"), `${why}: no text`);
    }
    for (const meta of [metaAnswer({ code: "NOT_VISIBLE" }, 404), hang]) {
      const response = await page(`/artifacts/${ID}`, { timeoutMs: 50, fetch: routes({ meta, markdown: markdown("# Marker") }).fetch });
      assert.equal(await response.text(), SHELL, "the meta decides");
    }
  });

  test("index.md is asked beside the meta and the shell: a slow meta and a slow index.md take about the longer, not their sum", async () => {
    const DELAY = 300;
    const asked: number[] = [];
    const stub = routes({ meta: after(DELAY, metaAnswer()), markdown: after(DELAY, markdown("# Q3 report\n\nMarker\n")) });
    const deps = { apiOrigin: API, HTMLRewriter: FakeHTMLRewriter, fetch: (url: string, init?: RequestInit) => { asked.push(Date.now()); return stub.fetch(url, init); } };
    const env = { ASSETS: { fetch: async () => { await new Promise((resolve) => setTimeout(resolve, DELAY)); return shell(); } } };
    const started = Date.now();
    const response = await worker.handleRequest(new Request(`https://app.raft.build/artifacts/${ID}`), env, deps);
    const html = await response.text();
    const elapsed = Date.now() - started;
    assert.ok(articleOf(html)?.includes("<pre># Q3 report\n\nMarker\n</pre>"));
    assert.equal(asked.length, 2);
    for (const at of asked) assert.ok(at - started < 50, "both asked at once, before the shell arrives");
    assert.ok(elapsed < DELAY * 2 - 50, `about max(), not the sum: ${elapsed} ms`);
  });

  test("a Markdown request that fell back doesn't ask index.md again for the article", async () => {
    const stub = routes({ meta: metaAnswer(), markdown: markdown("# hidden", 404) });
    const request = new Request(`https://app.raft.build/artifacts/${ID}`, { headers: { Accept: "text/markdown" } });
    const response = await worker.handleRequest(request, { ASSETS: { fetch: async () => shell() } }, { apiOrigin: API, fetch: stub.fetch, HTMLRewriter: FakeHTMLRewriter });
    assert.equal(response.headers.get("x-raft-artifact-diagnostic"), "injected; markdown=status_404");
    assert.deepEqual(stub.calls, [`${base}/index.md`, `${base}/meta`]);
    assert.ok(articleOf(await response.text())?.includes("<p>Revenue grew 12% on the quarter.</p>"));
  });

  test("the entry file's alternate is typed by its extension: HTML or Markdown, none for any other file", async () => {
    const source = (entry: string) => `<link rel="alternate" type="TYPE" title="Source" href="${base}/files/${entry.split("/").map(encodeURIComponent).join("/")}">`;
    const cases: Array<[string, string | null]> = [
      ["index.html", "text/html"],
      ["site/Page.HTM", "text/html"],
      ["notes.md", "text/markdown"],
      ["docs/README.Markdown", "text/markdown"],
      ["data.csv", null],
      ["report.pdf", null],
      ["Makefile", null],
      ["v1.2/notes", null],
      [".md", null],
    ];
    for (const [entry, type] of cases) {
      const meta = { ...META, entry, files: [{ path: entry, size: 10, entry: true }] };
      const html = await (await page(`/artifacts/${ID}`, { fetch: routes({ meta: metaAnswer(meta) }).fetch })).text();
      assert.ok(html.includes(`<link rel="alternate" type="text/markdown" href="${base}/index.md">`), `${entry}: the Markdown version always`);
      if (type) assert.ok(html.includes(source(entry).replace("TYPE", type)), `${entry}: ${type}`);
      else assert.ok(!html.includes(`title="Source"`), `${entry}: no entry alternate`);
      assert.equal((html.match(/rel="alternate"/g) ?? []).length, type ? 2 : 1, entry);
    }
  });
});

describe("a request that prefers Markdown", () => {
  const INDEX_MD = "# Q3 report\n\nUpdated 2026-10-29\n";
  const markdownApi = (status = 200) => api(() => new Response(status === 200 ? INDEX_MD : JSON.stringify({ code: "NOT_VISIBLE" }), {
    status,
    headers: { "Content-Type": status === 200 ? "text/plain; charset=utf-8" : "application/json" },
  }));
  const asking = (accept: string, path = `/artifacts/${ID}`, method = "GET") => new Request(`https://app.raft.build${path}`, { method, headers: { Accept: accept } });

  test("reads Accept's q values: Markdown only when it is listed and beats text/html", () => {
    for (const accept of ["text/markdown", "text/markdown, */*;q=0.1", "text/html;q=0.5, text/markdown", "text/markdown;q=0.9, text/html;q=0.8", "text/plain, text/markdown;q=0.3"]) {
      assert.equal(worker.prefersMarkdown(asking(accept)), true, accept);
    }
    for (const accept of ["", "*/*", "text/html", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "text/html, text/markdown", "text/markdown;q=0.5, text/html;q=0.5", "text/markdown;q=0", "text/*"]) {
      assert.equal(worker.prefersMarkdown(asking(accept)), false, accept);
    }
  });

  test("waits for an index.md that takes 1.5 s: a request that asked for Markdown has nothing else to show", async () => {
    const stub = markdownApi();
    const slow = async (url: string, init?: RequestInit) => { await new Promise((resolve) => setTimeout(resolve, 1_500)); return stub.fetch(url, init); };
    const response = await worker.artifactMarkdownResponse(asking("text/markdown"), { apiOrigin: API, fetch: slow });
    assert.ok(response);
    assert.equal(await response.text(), INDEX_MD);
  });

  test("gets index.md from the API with its headers, for the page and a pinned version", async () => {
    for (const path of [`/artifacts/${ID}`, `/artifacts/${ID}/v/2`]) {
      const stub = markdownApi();
      const response = await worker.artifactMarkdownResponse(asking("text/markdown", path), { apiOrigin: API, fetch: stub.fetch });
      assert.ok(response, path);
      assert.deepEqual(stub.calls, [`${API}/api/public/artifacts/${ID}/index.md`]);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), INDEX_MD);
      assert.equal(response.headers.get("content-type"), "text/markdown; charset=utf-8");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; sandbox");
      assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("vary"), "Accept");
    }
    // An API from before index.md went text/plain still answers text/markdown.
    const older = api(() => new Response(INDEX_MD, { headers: { "Content-Type": "text/markdown; charset=utf-8" } }));
    assert.equal(await (await worker.artifactMarkdownResponse(asking("text/markdown"), { apiOrigin: API, fetch: older.fetch }))?.text(), INDEX_MD, "text/markdown from an older API");
  });

  test("not public, a failure, HTML preferred, another path, HEAD or no API origin: no Markdown, the page as usual", async () => {
    const deps = (stub: ReturnType<typeof api>) => ({ apiOrigin: API, fetch: stub.fetch });
    assert.equal(await worker.artifactMarkdownResponse(asking("text/markdown"), deps(markdownApi(404))), null, "not public");
    assert.equal(await worker.artifactMarkdownResponse(asking("text/markdown"), deps(api(() => { throw new TypeError("down"); }))), null, "an error");
    assert.equal(await worker.artifactMarkdownResponse(asking("text/markdown"), deps(api(() => new Response("<html>", { headers: { "Content-Type": "text/html" } })))), null, "not Markdown");
    const untouched = markdownApi();
    assert.equal(await worker.artifactMarkdownResponse(asking("text/html"), deps(untouched)), null);
    assert.equal(await worker.artifactMarkdownResponse(asking("text/markdown", "/s/demo/channel/general"), deps(untouched)), null);
    assert.equal(await worker.artifactMarkdownResponse(asking("text/markdown", `/artifacts/${ID}`, "HEAD"), deps(untouched)), null);
    assert.equal(await worker.artifactMarkdownResponse(asking("text/markdown"), { apiOrigin: null, fetch: untouched.fetch }), null);
    assert.deepEqual(untouched.calls, []);
    // The deployed Worker without an API origin serves the page.
    const response = await worker.default.fetch(asking("text/markdown"), { ASSETS: { fetch: async () => shell() } });
    assert.equal(await response.text(), SHELL);
  });
});

describe("the Worker's API origin", () => {
  test("is the build's VITE_API_URL origin, written over the placeholder exactly once", () => {
    const source = readFileSync(resolve(webRoot, "public/_worker.js"), "utf8");
    assert.equal(workerApiOrigin("https://api.raft.build/"), "https://api.raft.build");
    assert.equal(workerApiOrigin("http://127.0.0.1:4174"), "http://127.0.0.1:4174");
    for (const value of [undefined, "", "  ", "/api", "ftp://api.example", "not a url"]) assert.equal(workerApiOrigin(value), null, String(value));
    const built = applyWorkerApiOrigin(source, "https://api.raft.build");
    assert.ok(!built.includes(`"${WORKER_API_ORIGIN_PLACEHOLDER}"`));
    assert.ok(built.includes(`const API_ORIGIN = "https://api.raft.build";`));
    assert.equal(applyWorkerApiOrigin(source, null), source, "no origin: the placeholder stays, and the Worker injects nothing");
    assert.throws(() => applyWorkerApiOrigin("const API_ORIGIN = null;", "https://api.raft.build"));
    assert.equal(worker.configuredApiOrigin("https://api.raft.build"), "https://api.raft.build");
    assert.equal(worker.configuredApiOrigin(WORKER_API_ORIGIN_PLACEHOLDER), null);
  });
});

describe("crawler-facing files", () => {
  test("/sitemap.xml is a real text/plain 404, not the SPA shell", async () => {
    let asked = false;
    const response = await worker.default.fetch(new Request("https://app.raft.build/sitemap.xml"), { ASSETS: { fetch: async () => { asked = true; return shell(); } } });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(await response.text(), "Not Found\n");
    assert.equal(asked, false);
  });

  test("robots.txt still disallows everything but lets crawlers read Artifact pages (which say noindex), their preview image and llms.txt", () => {
    const robots = readFileSync(resolve(webRoot, "public/robots.txt"), "utf8");
    const rules = robots.split("\n").filter((line) => line && !line.startsWith("#"));
    // Every AI training crawler is turned away from every path, first; then the `*` rules every other fetcher follows.
    const training = AI_TRAINING_CRAWLERS.flatMap((agent) => [`User-agent: ${agent}`, "Disallow: /"]);
    assert.deepEqual(rules, [...training, "User-agent: *", "Allow: /artifacts/", "Allow: /android-chrome-512x512.png", "Allow: /llms.txt", "Disallow: /"]);
    for (const fetcher of ["ChatGPT-User", "Claude-User", "Perplexity-User"]) assert.ok(!robots.includes(fetcher + "\n"), `${fetcher} follows the * rules`);
    assert.match(robots, /noindex/);
    // The card's image is fetched under these rules too: disallowed, X shows a blank card.
    const previewImage = /ARTIFACT_PREVIEW_IMAGE_PATH = "([^"]+)"/.exec(readFileSync(resolve(webRoot, "public/_worker.js"), "utf8"))?.[1];
    assert.ok(previewImage && rules.includes(`Allow: ${previewImage}`), "the preview image the Worker names is allowed");
  });

  test("llms.txt is a static file, served ahead of the SPA fallback, saying where a public Artifact's Markdown and files are", () => {
    const llms = readFileSync(resolve(webRoot, "public/llms.txt"), "utf8");
    assert.ok(llms.startsWith("# Raft\n"));
    assert.ok(llms.includes("\n## Public artifacts\n"));
    assert.ok(llms.includes("https://api.raft.build/api/public/artifacts/<id>/index.md"));
    assert.ok(llms.includes("https://api.raft.build/api/public/artifacts/<id>/files/<path>"));
    // Not one of the Worker's routes: Pages answers it from the file itself.
    const routes = JSON.parse(readFileSync(resolve(webRoot, "public/_routes.json"), "utf8")) as { include: string[] };
    assert.ok(!routes.include.some((route) => route === "/llms.txt" || route === "/*"));
  });
});

describe("the diagnostic header says why an Artifact page is or isn't rewritten", () => {
  const DIAGNOSTIC = "x-raft-artifact-diagnostic";
  const env = (answer: () => Response = shell) => ({ ASSETS: { fetch: async () => answer() } });
  const request = (accept = "text/html") => new Request(`https://app.raft.build/artifacts/${ID}`, { headers: { Accept: accept } });
  const diagnostic = async (deps: Deps, accept?: string, assets?: () => Response) =>
    (await worker.handleRequest(request(accept), env(assets), deps)).headers.get(DIAGNOSTIC);

  test("asks the API with redirect: manual (the Workers runtime refuses \"error\"), and a redirect it gets back is a skip, never followed", async () => {
    // workerd: 'Invalid redirect value, must be one of "follow" or "manual"': with "error" every ask threw before reaching the API.
    const inits: Array<RequestInit | undefined> = [];
    const recording = (answer: () => Response) => async (_url: string, init?: RequestInit) => { inits.push(init); return answer(); };
    assert.equal(await diagnostic({ apiOrigin: API, fetch: recording(metaAnswer()), HTMLRewriter: FakeHTMLRewriter }), "injected");
    assert.equal(await diagnostic({ apiOrigin: API, fetch: recording(() => new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/" } })), HTMLRewriter: FakeHTMLRewriter }), "skipped=status_302");
    await diagnostic({ apiOrigin: API, fetch: recording(() => new Response("# md", { headers: { "Content-Type": "text/markdown" } })), HTMLRewriter: FakeHTMLRewriter }, "text/markdown");
    assert.ok(inits.length >= 3);
    for (const init of inits) assert.equal(init?.redirect, "manual");
  });

  test("every answer to an Artifact page GET or HEAD says noindex, rewritten or not; other paths don't", async () => {
    const robots = async (deps: Deps, path = `/artifacts/${ID}`, method = "GET") =>
      (await worker.handleRequest(new Request(`https://app.raft.build${path}`, { method }), env(), deps)).headers.get("x-robots-tag");
    const ok = { apiOrigin: API, fetch: api(metaAnswer()).fetch, HTMLRewriter: FakeHTMLRewriter };
    assert.equal(await robots(ok), "noindex, nofollow", "injected");
    assert.equal(await robots({ ...ok, apiOrigin: null }), "noindex, nofollow", "skipped: no API origin");
    assert.equal(await robots({ ...ok, fetch: api(metaAnswer(META, 404)).fetch }), "noindex, nofollow", "skipped: not public");
    assert.equal(await robots({ ...ok, fetch: api(() => { throw new TypeError("x"); }).fetch }), "noindex, nofollow", "skipped: the ask failed");
    assert.equal(await robots(ok, `/artifacts/${ID}`, "HEAD"), "noindex, nofollow", "HEAD");
    assert.equal(await robots(ok, "/"), null, "not an Artifact page");
    assert.equal(await robots(ok, "/s/demo/channel/general"), null, "not an Artifact page");
  });

  test("injected, or the reason it was skipped", async () => {
    assert.equal(await diagnostic({ apiOrigin: API, fetch: api(metaAnswer()).fetch, HTMLRewriter: FakeHTMLRewriter }), "injected");
    assert.equal(await diagnostic({ apiOrigin: null, fetch: api(metaAnswer()).fetch, HTMLRewriter: FakeHTMLRewriter }), "skipped=no_api_origin", "the build left the placeholder");
    assert.equal(await diagnostic({ apiOrigin: API, fetch: api(metaAnswer()).fetch }), "skipped=no_rewriter");
    assert.equal(await diagnostic({ apiOrigin: API, fetch: api(metaAnswer(META, 403)).fetch, HTMLRewriter: FakeHTMLRewriter }), "skipped=status_403", "the API refused the Worker");
    assert.equal(await diagnostic({ apiOrigin: API, fetch: api(() => { throw new TypeError("redirect"); }).fetch, HTMLRewriter: FakeHTMLRewriter }), "skipped=error_TypeError", "a refused redirect, a DNS or TLS failure");
    assert.equal(await diagnostic({ apiOrigin: API, fetch: api(() => new Response("<html>", { headers: { "Content-Type": "text/html" } })).fetch, HTMLRewriter: FakeHTMLRewriter }), "skipped=not_json");
    assert.equal(await diagnostic({ apiOrigin: API, fetch: api(metaAnswer({ title: "" })).fetch, HTMLRewriter: FakeHTMLRewriter }), "skipped=invalid");
    assert.equal(await diagnostic({ apiOrigin: API, fetch: api(metaAnswer()).fetch, HTMLRewriter: FakeHTMLRewriter }, undefined, () => new Response("missing", { status: 404, headers: { "Content-Type": "text/html" } })), "skipped=shell_404");
  });

  test("a Markdown request that fell back to the page says why, beside the page's own reason", async () => {
    const markdownRefused = api((): Response => new Response("blocked", { status: 403, headers: { "Content-Type": "text/html" } }));
    assert.equal(await diagnostic({ apiOrigin: API, fetch: markdownRefused.fetch, HTMLRewriter: FakeHTMLRewriter }, "text/markdown"), "skipped=status_403; markdown=status_403");
    assert.equal(await diagnostic({ apiOrigin: null, fetch: markdownRefused.fetch, HTMLRewriter: FakeHTMLRewriter }, "text/markdown"), "skipped=no_api_origin; markdown=no_api_origin");
  });

  test("not an Artifact page: no diagnostic header, and a rewritten page keeps the service worker's own mark", async () => {
    const other = await worker.handleRequest(new Request("https://app.raft.build/s/demo/channel/general"), env(), { apiOrigin: API, fetch: api(metaAnswer()).fetch, HTMLRewriter: FakeHTMLRewriter });
    assert.equal(other.headers.get(DIAGNOSTIC), null);
    const skipped = await worker.handleRequest(request(), env(), { apiOrigin: null, fetch: api(metaAnswer()).fetch, HTMLRewriter: FakeHTMLRewriter });
    assert.equal(skipped.headers.get("x-raft-artifact-preview"), null, "an unrewritten shell is still the app's shell to the service worker");
  });
});

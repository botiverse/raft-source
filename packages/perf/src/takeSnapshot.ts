/**
 * The network side of `raft-perf snapshot`: fetch a deployed web's index.html
 * and its first-screen files, and measure them. Pure parsing lives in
 * firstScreen.ts.
 */
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { brotliCompressSync, constants } from "node:zlib";
import { type FirstScreenFile, type FirstScreenSnapshot, parseIndexHtml, stableName, staticImports, totals } from "./firstScreen";

const br = (b: Buffer) => brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

type Got = { status: number; body: Buffer; cacheControl: string | null; contentType: string | null };

const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 raft-perf-snapshot";

/**
 * Each request carries what a browser sends for that kind of resource. Node's
 * `fetch` cannot be used: it always sends `Sec-Fetch-Mode: cors`, and a server
 * that answers by that header hands it another document than a browser gets
 * (Stamp's gateway serves its agent/htmx site to it, so the snapshot listed
 * the wrong files). The navigation headers go on the document only: a server
 * that serves its app shell to any navigation would answer 200 with HTML for
 * a script path that does not exist, and a regex false positive would be
 * counted as a file.
 */
export const REQUEST_HEADERS = {
  document: { accept: "text/html,application/xhtml+xml,*/*;q=0.8", "accept-encoding": "identity", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none", "user-agent": USER_AGENT },
  js: { accept: "*/*", "accept-encoding": "identity", "sec-fetch-dest": "script", "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin", "user-agent": USER_AGENT },
  css: { accept: "text/css,*/*;q=0.1", "accept-encoding": "identity", "sec-fetch-dest": "style", "sec-fetch-mode": "no-cors", "sec-fetch-site": "same-origin", "user-agent": USER_AGENT },
} as const;

type RequestKind = keyof typeof REQUEST_HEADERS;

const MAX_REDIRECTS = 5;

function get(url: string, kind: RequestKind, redirectsLeft = MAX_REDIRECTS): Promise<Got> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === "http:" ? httpRequest : httpsRequest;
    const req = send(target, { method: "GET", headers: REQUEST_HEADERS[kind] }, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        if (redirectsLeft <= 0) reject(new Error(`${url}: more than ${MAX_REDIRECTS} redirects`));
        else resolve(get(new URL(location, target).href, kind, redirectsLeft - 1));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const cacheControl = res.headers["cache-control"];
        const contentType = res.headers["content-type"];
        resolve({ status, body: Buffer.concat(chunks), cacheControl: typeof cacheControl === "string" ? cacheControl : null, contentType: typeof contentType === "string" ? contentType : null });
      });
      res.on("error", reject);
    });
    req.setTimeout(60_000, () => req.destroy(new Error(`${url}: no answer in 60 s`)));
    req.on("error", reject);
    req.end();
  });
}

/** An HTML answer to a script or stylesheet request is the server's fallback page, not that file. */
const isHtml = (got: Got) => /^text\/html\b/i.test(got.contentType ?? "");

async function getOk(url: string, kind: RequestKind): Promise<Got> {
  const r = await get(url, kind);
  if (kind !== "document" && r.status >= 200 && r.status < 300 && isHtml(r)) throw new Error(`GET ${url} -> ${r.status} with an HTML body where a ${kind} file was expected`);
  if (r.status < 200 || r.status >= 300) throw new Error(`GET ${url} -> ${r.status}`);
  return r;
}

export async function takeSnapshot(originArg: string): Promise<FirstScreenSnapshot> {
  const origin = new URL(originArg).origin;
  const htmlGot = await getOk(origin + "/", "document");
  const htmlBuf = htmlGot.body;
  const { release, assets } = parseIndexHtml(htmlBuf.toString("utf8"), origin);
  // A server-rendered page may start its module from preloads or inline code; only a page with no script or stylesheet at all is refused.
  if (!assets.length) throw new Error(`${origin}/ names no module script, modulepreload or stylesheet`);
  const found = new Map<string, { url: string; kind: FirstScreenFile["kind"]; via: FirstScreenFile["via"]; got?: Got }>();
  for (const a of assets) found.set(a.url, { ...a });
  const skipped: string[] = [];
  const queue = assets.filter((a) => a.kind === "js").map((a) => a.url);
  while (queue.length) {
    const url = queue.shift()!;
    const f = found.get(url)!;
    if (f.got) continue;
    if (f.via === "static-import") {
      // found by regex: a 404, or the server's HTML fallback page, is a false positive, not a broken page
      const r = await get(origin + url, "js");
      if (r.status === 404 || (r.status >= 200 && r.status < 300 && isHtml(r))) {
        found.delete(url);
        skipped.push(url);
        continue;
      }
      if (r.status < 200 || r.status >= 300) throw new Error(`GET ${origin + url} -> ${r.status}`);
      f.got = r;
    } else f.got = await getOk(origin + url, "js");
    for (const rel of staticImports(f.got.body.toString("utf8"))) {
      const u = new URL(rel, origin + url);
      const path = u.pathname + u.search;
      if (!found.has(path) && !skipped.includes(path)) {
        found.set(path, { url: path, kind: "js", via: "static-import" });
        queue.push(path);
      }
    }
  }
  const files: FirstScreenFile[] = [];
  for (const f of found.values()) {
    const got = f.got ?? (await getOk(origin + f.url, f.kind === "css" ? "css" : "js"));
    files.push({ url: f.url, name: stableName(f.url), kind: f.kind, via: f.via, bytes: got.body.length, brBytes: br(got.body), sha256: sha256(got.body), cacheControl: got.cacheControl });
  }
  return {
    schema: "raft-perf/first-screen@1",
    origin,
    takenAt: new Date().toISOString(),
    release,
    html: { bytes: htmlBuf.length, brBytes: br(htmlBuf), cacheControl: htmlGot.cacheControl },
    files,
    skipped,
    totals: totals(files),
  };
}

export interface RowContext {
  /** Which product this web belongs to, e.g. raft-web, landing, raft-design. */
  project: string;
  /** One value for every row of one collection run (both perf tables). */
  runId: string;
  /** raft-perf's version, so a change of method can be told apart in the data. */
  toolVersion: string;
  /** Overrides the environment read from the page's release identity. */
  env?: string;
}

/** Rows for ScopeDB perf.first_screen_files (the html document itself is a row of kind "html"). */
export function toRows(s: FirstScreenSnapshot, ctx: RowContext): Record<string, string | number | null>[] {
  const base = {
    project: ctx.project,
    env: ctx.env ?? s.release.deploymentEnvironment,
    run_id: ctx.runId,
    tool_version: ctx.toolVersion,
    taken_at: s.takenAt,
    origin: s.origin,
    commit_sha: s.release.commitSha,
    built_at: s.release.builtAt,
  };
  return [
    { ...base, file_name: "index.html", url: "/", kind: "html", via: "document", bytes: s.html.bytes, br_bytes: s.html.brBytes, sha256: null, cache_control: s.html.cacheControl ?? null },
    ...s.files.map((f) => ({ ...base, file_name: f.name, url: f.url, kind: f.kind, via: f.via, bytes: f.bytes, br_bytes: f.brBytes, sha256: f.sha256 ?? null, cache_control: f.cacheControl ?? null })),
  ];
}

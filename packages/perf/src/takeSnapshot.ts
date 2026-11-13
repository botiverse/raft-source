/**
 * The network side of `raft-perf snapshot`: fetch a deployed web's index.html
 * and its first-screen files, and measure them. Pure parsing lives in
 * firstScreen.ts.
 */
import { createHash } from "node:crypto";
import { brotliCompressSync, constants } from "node:zlib";
import { type FirstScreenFile, type FirstScreenSnapshot, parseIndexHtml, stableName, staticImports, totals } from "./firstScreen";

const br = (b: Buffer) => brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

type Got = { status: number; body: Buffer; cacheControl: string | null };

async function get(url: string): Promise<Got> {
  const r = await fetch(url, { headers: { "accept-encoding": "identity", "user-agent": "raft-perf-snapshot" }, redirect: "follow" });
  return { status: r.status, body: Buffer.from(await r.arrayBuffer()), cacheControl: r.headers.get("cache-control") };
}

async function getOk(url: string): Promise<Got> {
  const r = await get(url);
  if (r.status < 200 || r.status >= 300) throw new Error(`GET ${url} -> ${r.status}`);
  return r;
}

export async function takeSnapshot(originArg: string): Promise<FirstScreenSnapshot> {
  const origin = new URL(originArg).origin;
  const htmlGot = await getOk(origin + "/");
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
      // found by regex: a 404 is a false positive, not a broken page
      const r = await get(origin + url);
      if (r.status === 404) {
        found.delete(url);
        skipped.push(url);
        continue;
      }
      if (r.status < 200 || r.status >= 300) throw new Error(`GET ${origin + url} -> ${r.status}`);
      f.got = r;
    } else f.got = await getOk(origin + url);
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
    const got = f.got ?? (await getOk(origin + f.url));
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

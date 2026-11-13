import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin, ResolvedConfig } from "vite";

/**
 * The page's own script policy, as a `<meta http-equiv>` CSP: `script-src` and
 * `worker-src`, the same sources every Web host's CSP header lists (public/_headers,
 * tests/bootShell.test.ts compares them), with the hash of each inline script the
 * build wrote. It keeps the page's script policy where the host sends none (an S3 +
 * CloudFront origin, whose response headers policy has no script-src). Where the
 * host does send one, the browser enforces both, so it must be no narrower than
 * the header. `frame-ancestors`, `report-uri` and `sandbox` don't work in a meta:
 * they stay headers.
 */
export const PAGE_SCRIPT_SOURCES = ["'self'", "'wasm-unsafe-eval'", "https://challenges.cloudflare.com", "https://static.cloudflareinsights.com"];
export const PAGE_WORKER_SOURCES = ["'self'", "blob:"];
const META_CSP = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/;

/**
 * The CSP source of each inline script the browser governs by script-src: every
 * type except a JSON data block (`application/json`, `+json`), which isn't run.
 * The text as the browser hashes it: the HTML parser turns CRLF and CR into LF.
 */
export function inlineScriptCspSources(html: string): string[] {
  const sources: string[] = [];
  for (const [, attributes, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\ssrc\s*=/i.test(attributes!)) continue;
    const type = /\stype\s*=\s*["']?([^"'\s>]*)/i.exec(attributes!)?.[1]?.toLowerCase() ?? "";
    if (/json$/.test(type)) continue;
    sources.push(`'sha256-${createHash("sha256").update(body!.replace(/\r\n?/g, "\n"), "utf8").digest("base64")}'`);
  }
  return sources;
}

export function pageMetaCsp(inlineSources: string[]): string {
  const [self, ...rest] = PAGE_SCRIPT_SOURCES;
  return `script-src ${[self, ...new Set(inlineSources), ...rest].join(" ")}; worker-src ${PAGE_WORKER_SOURCES.join(" ")}`;
}

/** The meta CSP as the first element of <head>: it governs only what comes after it, so it precedes every script. */
export function injectMetaCsp(html: string): string {
  if (!html.includes("<head>")) throw new Error("page CSP: index.html has no <head>");
  if (META_CSP.test(html)) throw new Error("page CSP: index.html already has a meta CSP");
  const meta = `<meta http-equiv="Content-Security-Policy" content="${pageMetaCsp(inlineScriptCspSources(html))}">`;
  return html.replace("<head>", `<head>\n    ${meta}`);
}

/** The sources of one directive in a policy (a header file: up to the end of its line). */
export function directiveSources(policy: string, name: string): string[] {
  return new RegExp(`(?:^|[;:"]\\s*)${name} ([^;"\\n]+)`, "u").exec(policy)?.[1]?.trim().split(/\s+/u) ?? [];
}

/** The attributes of every element outside script and style text, as [tag, name, value]. */
function attributesOf(html: string): [string, string, string][] {
  const markup = html.replace(/(<(script|style)\b[^>]*>)[\s\S]*?(<\/\2>)/gi, "$1$3").replace(/<!--[\s\S]*?-->/g, "");
  const found: [string, string, string][] = [];
  for (const [, tag, attributes] of markup.matchAll(/<([a-z][^\s/>]*)((?:\s+[^\s"'=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/gi)) {
    for (const [, name, double, single, bare] of attributes!.matchAll(/([^\s"'=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      found.push([tag!.toLowerCase(), name!.toLowerCase(), double ?? single ?? bare ?? ""]);
    }
  }
  return found;
}

/**
 * Fails the build when the written page's meta CSP isn't the first element of
 * <head> and before every script, an inline script it runs isn't allowed by its
 * hash, the hosts' header (public/_headers) would block what the meta allows
 * (the browser enforces both while a host sends one: a new inline script must be
 * added there too), an element has an inline event handler or a `javascript:`
 * URL (a hash allows neither), or it pushed <meta charset> out of the first 1024
 * bytes.
 */
export function assertMetaCsp(html: string, headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8")): void {
  const head = /<head>\s*([\s\S]*?)<\/head>/.exec(html)?.[1];
  if (!head) throw new Error("page CSP: index.html has no <head>");
  const meta = META_CSP.exec(head);
  if (!meta || meta.index !== 0) throw new Error("page CSP: the meta CSP must be the first element of <head>");
  const firstScript = html.search(/<script\b/i);
  if (firstScript >= 0 && firstScript < html.indexOf(meta[0])) throw new Error("page CSP: a script comes before the meta CSP");
  // The browser reads the encoding from the first 1024 bytes only.
  const charset = html.search(/<meta charset=/i);
  if (charset < 0 || Buffer.byteLength(html.slice(0, charset)) > 1000) throw new Error("page CSP: <meta charset> must stay in the first 1024 bytes");
  const scriptSrc = directiveSources(meta[1]!, "script-src");
  for (const source of inlineScriptCspSources(html)) {
    if (!scriptSrc.includes(source)) throw new Error(`page CSP: the meta CSP's script-src lacks inline script ${source}`);
  }
  for (const name of ["script-src", "worker-src"]) {
    const header = directiveSources(headers, name);
    const missing = directiveSources(meta[1]!, name).filter((source) => !header.includes(source));
    if (missing.length) throw new Error(`page CSP: public/_headers' ${name} lacks ${missing.join(" ")}; the hosts would block it (update every host)`);
  }
  for (const [tag, name, value] of attributesOf(html)) {
    if (name.startsWith("on")) throw new Error(`page CSP: an inline event handler is blocked by the CSP: <${tag} ${name}>`);
    if (/^\s*javascript:/i.test(value)) throw new Error(`page CSP: a javascript: URL is blocked by the CSP: <${tag} ${name}>`);
  }
}

/**
 * Writes the meta CSP into a separately built page's `index.html` (the
 * standalone feedback page, vite.feedback.config.ts) and checks it. The app's
 * own page gets it from bootShellPlugin, after the boot shell is in.
 */
export function pageMetaCspPlugin(): Plugin {
  let config: ResolvedConfig;
  return {
    name: "raft-page-meta-csp",
    apply: "build",
    configResolved(resolved) {
      config = resolved;
    },
    async closeBundle() {
      const indexPath = resolve(config.root, config.build.outDir, "index.html");
      const page = injectMetaCsp(await readFile(indexPath, "utf8"));
      assertMetaCsp(page);
      await writeFile(indexPath, page);
    },
  };
}

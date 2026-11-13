import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import postcss from "postcss";
import type { Plugin, ResolvedConfig } from "vite";
import { BOOT_LOCALE_CATALOGS_ID, BOOT_LOCALE_RULES, BOOT_PREFETCH_CONFIG_ID, buildBootInlineScript } from "../src/boot/bootInlineScript";
import { deriveRuntimeEndpoints } from "../src/runtimeEndpoints";
import { resolveWebAppVersion } from "../src/utils/webAppVersion";
import { COLUMN_BOUNDS } from "../src/lib/panelBounds";
import { assertMetaCsp, injectMetaCsp } from "./pageMetaCsp";
import { CATALOG_PARTS, partKey } from "../src/i18n/messages/catalogParts";
import { CATALOG_PARTS_FILE } from "./catalogPartsPlugin";

/** The display locales, as the boot script knows them (BOOT_LOCALE_RULES; tests compare with locale.ts). */
const SUPPORTED_LOCALES = BOOT_LOCALE_RULES.map(([, , locale]) => locale);

/**
 * The boot shell (docs/frontend/boot-shell.md): index.html carries the app's
 * own frame, prerendered at build time from the same component React renders
 * while a server loads (PendingServerLayout), with the CSS it needs inlined.
 * The first paint is the real top bar and rail as soon as the HTML arrives;
 * React then takes over the same frame.
 */

const THEME_BOOTSTRAP_TAG = '<script src="/app-theme-bootstrap.js"></script>';
const ROOT_TAG = /<div id="root"([^>]*)><\/div>/;

/** What the boot script's classes on <html> mean for the prerendered shell. */
export const BOOT_SHELL_CSS = [
  // No stored session, or not a server page: no app frame.
  "html.boot-off #root>[data-boot-shell]{display:none}",
  // The thread column only for a thread link.
  "html:not(.boot-thread) [data-boot-shell] [data-boot-thread]{display:none}",
  // Without it the conversation keeps its column on a phone (index.css gives a
  // phone's whole width to a thread column whenever one is in the row).
  "html:not(.boot-thread) [data-boot-shell] .thread-layout-container>.thread-main-column{display:flex}",
  // The columns at the widths the person left them (the boot script's
  // --boot-*-width), not the defaults the shell was prerendered with.
  `[data-boot-shell]>[data-slot=app-shell-root] [data-testid=shell-sidebar-column]{width:var(--boot-sidebar-width,${COLUMN_BOUNDS.sidebar.defaultWidth}px)!important}`,
  `[data-boot-shell] [data-boot-thread]{--thread-panel-width:var(--boot-thread-width,${COLUMN_BOUNDS.thread.defaultWidth}px)!important}`,
  // A phone at a server's root opens on Home (the channel list, its bar and
  // the tab bar): that frame instead of the conversation's.
  "[data-boot-frame=phone-home]{display:none}",
  "@media (max-width:767.98px){html.boot-home [data-boot-shell]>[data-slot=app-shell-root]{display:none}html.boot-home [data-boot-frame=phone-home]{display:contents}}",
  // A canonical Artifact link (html.boot-artifact): its own frame, "Loading Artifact" in the reader's language
  // (html[data-boot-locale]), instead of the server's frame.
  "[data-boot-frame=artifact],[data-boot-frame=artifact]>[data-boot-locale]{display:none}",
  "html.boot-artifact [data-boot-shell]>[data-slot=app-shell-root],html.boot-artifact [data-boot-frame=phone-home]{display:none!important}",
  "html.boot-artifact [data-boot-frame=artifact]{display:contents}",
  // In the App's WebView (a host-shell embed) the page's header row is the App's or another shape: not prerendered.
  "html.boot-embedded [data-boot-frame=artifact] [data-boot-artifact-head]{display:none}",
  ...SUPPORTED_LOCALES.map((locale) => `html[data-boot-locale=${locale}] [data-boot-frame=artifact]>[data-boot-locale=${locale}]{display:contents}`),
  // Its loading splash (ArtifactLinkLoading `prerender`): the icon and the line only after the page's first second,
  // as the live splash (ARTIFACT_SPLASH_APPEAR_AFTER_MS), which then continues from the same start (artifactLinkWait).
  "[data-splash-static]>*{animation:boot-splash-appear 0s linear 1s both}",
  "@keyframes boot-splash-appear{from{visibility:hidden}to{visibility:visible}}",
  // Words that depend on the reader's language and platform wait for the app.
  "[data-boot-shell] [data-testid=\"app-top-bar-search\"]>:not(svg){visibility:hidden}",
].join("");

export function readBootInlineScript(): string {
  return buildBootInlineScript(
    readFileSync(new URL("../public/app-theme-bootstrap.js", import.meta.url), "utf8"),
  );
}

/**
 * The theme bootstrap inlined (before the first paint, no round trip) and the
 * app stylesheet moved behind the content, so it no longer holds the first
 * paint: the shell's own CSS is inlined instead.
 */
export function injectBootScript(html: string, inlineScript: string): string {
  if (!html.includes(THEME_BOOTSTRAP_TAG)) throw new Error("boot shell: index.html no longer loads /app-theme-bootstrap.js");
  const stylesheets: string[] = [];
  const next = html
    .replace(/\s*<link rel="stylesheet"[^>]*>/g, (tag) => {
      stylesheets.push(tag.trim());
      return "";
    })
    .replace(THEME_BOOTSTRAP_TAG, `<script>${inlineScript}</script>`);
  return next.replace("</body>", `  ${stylesheets.join("\n    ")}\n  </body>`);
}

/**
 * What the boot prefetch (BOOT_PREFETCH_STATEMENT) needs from the build, as
 * the API client has it (client.ts): the API base (RUNTIME_API_BASE; `/api`
 * on the page's origin when the build names none) and this build's version
 * (WEB_APP_VERSION, sent as X-Raft-Client-Version). With an API on another
 * origin, a preconnect to it, so the first request (the prefetch, or the
 * app's on a page that sends none) doesn't open the connection itself.
 */
export function bootPrefetchConfig(env: Record<string, string | undefined>): { api: string; version: string; preconnect: string | null } {
  const compiledOrigin = env.VITE_API_URL?.replace(/\/$/, "") ?? "";
  const { apiBase } = deriveRuntimeEndpoints(compiledOrigin, "");
  return {
    api: apiBase,
    version: resolveWebAppVersion({ VITE_APP_VERSION: env.VITE_APP_VERSION }),
    preconnect: compiledOrigin ? new URL(compiledOrigin).origin : null,
  };
}

/** The prefetch's JSON (not run: no CSP hash) and the preconnect, just before the inline boot script that reads it. */
export function injectBootPrefetchConfig(html: string, config: ReturnType<typeof bootPrefetchConfig>): string {
  if (!html.includes(THEME_BOOTSTRAP_TAG)) throw new Error("boot shell: index.html no longer loads /app-theme-bootstrap.js");
  const json = JSON.stringify({ api: config.api, version: config.version }).replace(/</g, "\\u003c");
  const preconnect = config.preconnect
    ? `<link rel="preconnect" href="${config.preconnect.replace(/"/g, "&quot;")}" crossorigin>\n    `
    : "";
  return html.replace(
    THEME_BOOTSTRAP_TAG,
    `${preconnect}<script type="application/json" id="${BOOT_PREFETCH_CONFIG_ID}">${json}</script>\n    ${THEME_BOOTSTRAP_TAG}`,
  );
}

/**
 * A release built with RAFT_SHELL_URGENT=1 takes effect on the next open
 * instead of the one after: the service worker, which otherwise answers a
 * reopened page with the HTML it kept, sees this when it fetches the new HTML,
 * drops its copy and reloads a page that just opened (public/sw.js).
 */
export const SHELL_URGENT_META = '<meta name="raft-shell" content="urgent">';

export function markShellUrgent(html: string, urgent: boolean): string {
  return urgent ? html.replace("</head>", `  ${SHELL_URGENT_META}\n  </head>`) : html;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function classTokens(selector: string): string[] {
  // A class under :not() is one the element must lack, so it does not have to be in the markup.
  const positive = selector.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, "");
  return [...positive.matchAll(/\.((?:\\.|[\w-])+)/g)].map((match) => match[1].replace(/\\(.)/g, "$1"));
}

/**
 * The rules of `css` the prerendered `markup` can use: every selector whose
 * classes all appear in the markup (theme, mode and element rules have none),
 * with their at-rule wrappers; other rules are dropped.
 */
export function criticalCss(css: string, markup: string): string {
  const classes = new Set<string>(["dark", "light"]);
  for (const match of markup.matchAll(/class="([^"]*)"/g)) {
    // Markup escapes `&`, `'`, `"`, `<`, `>` in attributes; arbitrary variants use them (`[&_svg]:size-5`).
    for (const name of decodeEntities(match[1]).split(/\s+/)) if (name) classes.add(name);
  }
  const root = postcss.parse(css);
  // The cascade layer order, as the stylesheet declares it, before anything is dropped:
  // this <style> stays in <head>, so its layer order is the app's.
  const layerOrder: string[] = [];
  root.walkAtRules("layer", (atRule) => {
    for (const name of atRule.params.split(",").map((part) => part.trim()).filter(Boolean)) {
      if (!layerOrder.includes(name)) layerOrder.push(name);
    }
  });
  root.walkRules((rule) => {
    if (rule.parent?.type === "atrule" && /keyframes$/.test((rule.parent as postcss.AtRule).name)) return;
    const used = rule.selectors.filter((selector) => classTokens(selector).every((name) => classes.has(name)));
    if (used.length === 0) rule.remove();
    else rule.selectors = used;
  });
  // The shell has no visible text: no web fonts, nothing to import.
  root.walkAtRules(/^(import|font-face)$/, (atRule) => {
    atRule.remove();
  });
  // Custom properties: only those the kept declarations use, directly or
  // through other custom properties (the theme defines hundreds).
  const used = new Set<string>();
  const references = (value: string) => [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]);
  const definitions = new Map<string, string[]>();
  root.walkDecls((decl) => {
    if (decl.prop.startsWith("--")) {
      definitions.set(decl.prop, [...(definitions.get(decl.prop) ?? []), ...references(decl.value)]);
    } else {
      for (const name of references(decl.value)) used.add(name);
    }
  });
  const pending = [...used];
  while (pending.length > 0) {
    for (const name of definitions.get(pending.pop()!) ?? []) {
      if (!used.has(name)) {
        used.add(name);
        pending.push(name);
      }
    }
  }
  root.walkDecls(/^--/, (decl) => {
    if (!used.has(decl.prop)) decl.remove();
  });
  root.walkAtRules("property", (atRule) => {
    if (!used.has(atRule.params.trim())) atRule.remove();
  });
  // Keyframes only for the animations kept rules name.
  const animations = new Set<string>();
  root.walkDecls(/^animation(-name)?$/, (decl) => {
    for (const word of decl.value.split(/[\s,]+/)) animations.add(word);
  });
  root.walkAtRules(/keyframes$/, (atRule) => {
    if (!animations.has(atRule.params.trim())) atRule.remove();
  });
  root.walkRules((rule) => {
    if (rule.nodes.length === 0) rule.remove();
  });
  root.walkAtRules((atRule) => {
    if (atRule.nodes && atRule.nodes.length === 0) atRule.remove();
  });
  const order = layerOrder.length > 0 ? `@layer ${layerOrder.join(",")};` : "";
  return order + root.toString().replace(/\n\s*/g, "");
}

/** The shell inside #root (React replaces it on its first commit) and its CSS in <head>. */
export function injectBootShell(html: string, markup: string, css: string): string {
  if (!ROOT_TAG.test(html)) throw new Error("boot shell: index.html has no empty #root");
  return html
    .replace("</head>", `  <style id="boot-shell-style">${css}</style>\n  </head>`)
    .replace(ROOT_TAG, (_tag, attrs: string) => `<div id="root"${attrs}><div data-boot-shell="" class="contents">${markup}</div></div>`);
}

/** Renders PendingServerLayout to markup in Node, through a Vite SSR loader with a DOM shim. */
async function renderBootShellMarkup(root: string, configFile: string | false | undefined): Promise<string> {
  const { JSDOM } = await import("jsdom");
  const { createServer } = await import("vite");
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "https://app.raft.build/s/_/channel/_",
    pretendToBeVisual: true,
  });
  const scope = globalThis as Record<string, unknown>;
  const shimmed: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    sessionStorage: dom.window.sessionStorage,
    location: dom.window.location,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    matchMedia: (query: string) => ({
      matches: /min-width:\s*768px/.test(query),
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  };
  (dom.window as unknown as Record<string, unknown>).matchMedia = shimmed.matchMedia;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(shimmed)) {
    saved.set(key, Object.getOwnPropertyDescriptor(scope, key));
    Object.defineProperty(scope, key, { configurable: true, writable: true, value });
  }
  let server: Awaited<ReturnType<typeof createServer>> | null = null;
  try {
    server = await createServer({
      root,
      configFile,
      server: { middlewareMode: true, hmr: false, ws: false },
      appType: "custom",
      logLevel: "error",
    });
    const module = await server.ssrLoadModule("/src/boot/prerenderShell.tsx") as { renderBootShell: () => Promise<string> };
    // Awaited here, before `finally` closes the server: the render loads every catalog through it.
    return await module.renderBootShell();
  } finally {
    await server?.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(scope, key, descriptor);
      else delete scope[key];
    }
  }
}

/**
 * Each display locale's catalog parts (scripts/catalogPartsPlugin.ts writes
 * them and this map: `<code>` the first part, `<code>:boot` and `<code>:rest`
 * the others), as the JSON the boot script reads to modulepreload the boot
 * locale's first part (BOOT_CATALOG_PRELOAD_STATEMENT) and the app reads to
 * load them (i18n/messages/index.ts). A locale without every part fails the build.
 */
export function localeCatalogMap(parts: Record<string, unknown>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const locale of SUPPORTED_LOCALES) {
    for (const part of CATALOG_PARTS) {
      const key = partKey(locale, part);
      const file = parts[key];
      if (typeof file !== "string" || !/^\/assets\/[^"<>]+\.js$/.test(file)) {
        throw new Error(`boot shell: the ${locale} catalog has no ${part} part (${CATALOG_PARTS_FILE})`);
      }
      map[key] = file;
    }
  }
  return map;
}

/**
 * The catalog map, before the first script in <head>: before the inline boot
 * script that reads it, and after <meta charset> (which must stay in the
 * page's first 1024 bytes, pageMetaCsp.ts). Not run by the browser (no CSP hash).
 */
export function injectLocaleCatalogMap(html: string, map: Record<string, string>): string {
  const head = /<head>[\s\S]*?<\/head>/.exec(html);
  if (!head) throw new Error("boot shell: index.html has no <head>");
  const script = head[0].search(/<script\b/);
  if (script < 0) throw new Error("boot shell: index.html's <head> has no boot script");
  const at = head.index + script;
  const json = JSON.stringify(map).replace(/</g, "\\u003c");
  return `${html.slice(0, at)}<script type="application/json" id="${BOOT_LOCALE_CATALOGS_ID}">${json}</script>\n    ${html.slice(at)}`;
}

/**
 * The built index.html (in `outDir`) with the shell, its CSS, the catalog map
 * and the meta CSP.
 */
export async function renderBootShellPage(root: string, configFile: string | false, outDir: string): Promise<void> {
  const indexPath = join(outDir, "index.html");
  const html = await readFile(indexPath, "utf8");
  // Rendered already (a plain `vite build` renders it in closeBundle): once is enough.
  if (html.includes("data-boot-shell")) throw new Error("boot shell: index.html already has the shell; run `vite build` again first");
  const href = /<link rel="stylesheet"[^>]*href="\/([^"]+\.css)"/.exec(html)?.[1];
  if (!href) throw new Error("boot shell: no app stylesheet in index.html");
  const appCss = await readFile(join(outDir, href), "utf8");
  const markup = await renderBootShellMarkup(root, configFile);
  const shell = `<div data-boot-shell="" class="contents">${markup}</div>`;
  const parts = JSON.parse(await readFile(join(outDir, CATALOG_PARTS_FILE), "utf8")) as Record<string, unknown>;
  const withCatalogs = injectLocaleCatalogMap(html, localeCatalogMap(parts));
  const page = injectMetaCsp(injectBootShell(withCatalogs, markup, criticalCss(appCss, shell) + BOOT_SHELL_CSS));
  assertMetaCsp(page);
  await writeFile(indexPath, page);
}

/**
 * Set by `build:vite`, which renders the shell after `vite build` in a process of
 * its own (scripts/render-boot-shell.ts): the render starts a Vite SSR server
 * with JSDOM, and in closeBundle it stacks on the bundle's module graph, which
 * is still held then (~1 GiB more at the build's peak). A plain `vite build`
 * still renders it in closeBundle; the page is the same either way.
 */
export const BOOT_SHELL_AFTER_BUILD_ENV = "RAFT_BOOT_SHELL_AFTER_BUILD";

export function bootShellPlugin(): Plugin {
  let config: ResolvedConfig;
  return {
    name: "raft-boot-shell",
    configResolved(resolved) {
      config = resolved;
    },
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        // Only the app's page: other entries the dev server serves
        // (visual-testing.html) have no theme bootstrap and no shell.
        if (ctx.path !== "/index.html") return html;
        const withPrefetch = injectBootPrefetchConfig(html, bootPrefetchConfig(config.env));
        return markShellUrgent(injectBootScript(withPrefetch, readBootInlineScript()), process.env.RAFT_SHELL_URGENT === "1");
      },
    },
    async closeBundle() {
      if (config.command !== "build" || config.build.ssr || process.env[BOOT_SHELL_AFTER_BUILD_ENV] === "1") return;
      await renderBootShellPage(config.root, config.configFile ?? false, resolve(config.root, config.build.outDir));
    },
  };
}

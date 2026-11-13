import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ARTIFACT_SPLASH_APPEAR_AFTER_MS } from "../src/apps/artifacts/artifactSplash";
import {
  BOOT_SHELL_CSS,
  criticalCss,
  injectBootScript,
  markShellUrgent,
  SHELL_URGENT_META,
  bootPrefetchConfig,
  injectBootPrefetchConfig,
  injectBootShell,
  injectLocaleCatalogMap,
  localeCatalogMap,
  bootShellPlugin,
  readBootInlineScript,
  renderBootShellPage,
} from "../scripts/bootShellPlugin";
import { assertMetaCsp, injectMetaCsp, inlineScriptCspSources, pageMetaCsp, pageMetaCspPlugin } from "../scripts/pageMetaCsp";
import {
  BOOT_COMPLETE_LOCALES,
  BOOT_HINTS_SCRIPT,
  BOOT_HOST_SHELL_EMBED,
  BOOT_LOCALE_CATALOGS_ID,
  BOOT_LOCALE_RULES,
  BOOT_LOCALE_STORAGE_KEY,
  BOOT_PREFETCH_CONFIG_ID,
  BOOT_ROOT_CONVERSATION_PREFIX,
  BOOT_ROOT_REDIRECT_MEDIA_QUERY,
  BOOT_SCROLL_MEMORY_PREFIX,
  BOOT_SERVER_THEME_STORAGE_PREFIX,
  bootInlineScriptCspSource,
} from "../src/boot/bootInlineScript";
import { displayLocaleMatchRules } from "@botiverse/raft-shared";
import { DISPLAY_LOCALE_STORAGE_KEY, resolveInitialLocale, SUPPORTED_LOCALES } from "../src/i18n/locale";
import { SERVER_THEME_STORAGE_PREFIX } from "../src/theme/serverTheme";
import { __embedTestInternals } from "../src/embed";
import { SCROLL_MEMORY_PREFIX } from "../src/components/message/messageTimelineShared";
import { ROOT_CONVERSATION_STORAGE_PREFIX, ROOT_REDIRECT_MEDIA_QUERY } from "../src/store/rootConversation";
import { deriveRuntimeEndpoints } from "../src/runtimeEndpoints";
import { resolveWebAppVersion } from "../src/utils/webAppVersion";

const CSP_HOSTS = ["public/_headers", "public/_worker.js", "nginx.conf", "vercel.json"];

test("every Web host's CSP allows the inline boot script by its hash, and only by its hash", async () => {
  const source = await bootInlineScriptCspSource(readBootInlineScript());
  for (const host of CSP_HOSTS) {
    const config = readFileSync(new URL(`../${host}`, import.meta.url), "utf8");
    const scriptSrcs = [...config.matchAll(/script-src ([^;"]+)/gu)].map((match) => match[1]);
    assert.ok(scriptSrcs.length > 0, host);
    for (const scriptSrc of scriptSrcs) {
      assert.ok(
        scriptSrc.includes(source),
        `${host}: script-src must allow the boot script ${source}; public/app-theme-bootstrap.js or src/boot/bootInlineScript.ts changed, so update the hash on every host`,
      );
      assert.equal(scriptSrc.match(/'sha256-/g)?.length, 1, `${host}: no stale boot script hash left behind`);
    }
  }
});

const directiveSources = (policy: string, name: string) =>
  new Set(new RegExp(`(?:^|;\\s*)${name} ([^;"\\n]+)`, "u").exec(policy)?.[1]?.trim().split(/\s+/u));

test("the page's meta CSP allows exactly the scripts and workers the hosts' headers do", async () => {
  // Browsers enforce both where a host sends a header too (Pages until the move): narrower would break the page.
  const meta = pageMetaCsp([await bootInlineScriptCspSource(readBootInlineScript())]);
  for (const host of CSP_HOSTS) {
    const config = readFileSync(new URL(`../${host}`, import.meta.url), "utf8");
    assert.deepEqual(directiveSources(meta, "script-src"), directiveSources(config, "script-src"), `${host}: script-src`);
    assert.deepEqual(directiveSources(meta, "worker-src"), directiveSources(config, "worker-src"), `${host}: worker-src`);
  }
});

test("injectMetaCsp puts the CSP first in <head>, with the hash of each inline script that runs", async () => {
  const boot = readBootInlineScript();
  const built = injectLocaleCatalogMap(
    `<!DOCTYPE html><html><head>\n    <meta charset="UTF-8" />\n    <script>${boot}</script>\n    <script type="module" crossorigin src="/assets/index.js"></script>\n  </head><body></body></html>`,
    { en: "/assets/en.js" },
  );
  const page = injectMetaCsp(built);
  assert.match(page, /^<!DOCTYPE html><html><head>\n    <meta http-equiv="Content-Security-Policy" content="script-src 'self' 'sha256-/);
  assert.deepEqual(inlineScriptCspSources(page), [await bootInlineScriptCspSource(boot)], "the JSON catalog map and the src script need no hash");
  assert.ok(page.includes(await bootInlineScriptCspSource(boot)));
  assert.doesNotThrow(() => assertMetaCsp(page));
});

test("assertMetaCsp fails the build when the page and its meta CSP disagree", () => {
  const head = (inner: string) => `<html><head>${inner}<meta charset="UTF-8"></head><body><div id="root"></div></body></html>`;
  // Hosts' headers that allow exactly what the page's meta does.
  const hostsFor = (page: string) => `/*\n  Content-Security-Policy: base-uri 'self'; ${/content="([^"]*)"/.exec(page)![1]}\n`;
  const ok = injectMetaCsp(head("<script>a()</script>"));
  const check = (page: string, hosts = hostsFor(ok)) => () => assertMetaCsp(page, hosts);
  assert.doesNotThrow(check(ok));
  assert.throws(check(head("<script>a()</script>")), /first element of <head>/, "no meta CSP");
  assert.throws(check(ok.replace("<script>a()</script>", "<script>b()</script>")), /lacks inline script/, "a script changed after the hash");
  assert.throws(check(ok.replace("<html>", "<html><script>x()</script>")), /before the meta CSP/, "a script before <head>");
  assert.throws(check(ok, hostsFor(injectMetaCsp(head("")))), /public\/_headers' script-src lacks 'sha256-/, "a new inline script the hosts' header doesn't allow");
  assert.throws(check(ok, hostsFor(ok).replace(" blob:", "")), /worker-src lacks blob:/);
  assert.throws(check(ok.replace('<div id="root">', '<div id="root" onclick="x()">')), /inline event handler/);
  assert.throws(check(ok.replace('<div id="root">', '<div title="a>b" id="root" onclick="x()">')), /inline event handler/, "a > in an earlier quoted value");
  assert.throws(check(ok.replace('<div id="root">', '<a href=" javascript:x()" id="root">')), /javascript: URL/);
  assert.doesNotThrow(check(ok.replace('<div id="root">', '<div title="say onclick=hi" id="root">')), "on…= inside a value is text");
  const tricky = injectMetaCsp(head("<script>if(a<b&&c.onload=d)e()</script>"));
  assert.doesNotThrow(check(tricky, hostsFor(tricky)), "script text is not markup");
  const late = injectMetaCsp(head(`<script type="application/json">${"x".repeat(1024)}</script>`));
  assert.throws(check(late, hostsFor(late)), /first 1024 bytes/);
  assert.throws(() => injectMetaCsp(ok), /already has a meta CSP/);
});

test("inlineScriptCspSources hashes what the browser hashes", async () => {
  const lf = inlineScriptCspSources("<script>a()\nb()</script>")[0];
  assert.equal(inlineScriptCspSources("<script>a()\r\nb()</script>")[0], lf, "CRLF is LF to the browser");
  assert.equal(inlineScriptCspSources('<SCRIPT TYPE="text/ecmascript">a()\nb()</SCRIPT>')[0], lf, "any script type the browser runs");
  assert.equal(inlineScriptCspSources('<script type="importmap">{}</script>').length, 1, "an import map is governed by script-src");
  assert.deepEqual(inlineScriptCspSources('<script type="application/json">{}</script><script type="application/ld+json">{}</script><script src="/a.js"></script>'), []);
});

test("renderBootShellPage refuses a page that already has the shell (a plain vite build rendered it)", async () => {
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "boot-shell-twice-"));
  try {
    const page = `<!doctype html><html><head></head><body><div id="root"><div data-boot-shell="" class="contents"></div></div></body></html>`;
    await writeFile(join(root, "index.html"), page);
    await assert.rejects(renderBootShellPage(root, false, root), /already has the shell/);
    assert.equal(await readFile(join(root, "index.html"), "utf8"), page, "the page is left as it was");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pageMetaCspPlugin writes and checks the meta CSP in a separately built page (/feedback/)", async () => {
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "page-meta-csp-"));
  try {
    const run = async (html: string) => {
      await writeFile(join(root, "index.html"), html);
      const plugin = pageMetaCspPlugin() as { configResolved: (c: unknown) => void; closeBundle: () => Promise<void> };
      plugin.configResolved({ root, build: { outDir: "." } });
      await plugin.closeBundle();
      return readFile(join(root, "index.html"), "utf8");
    };
    const page = await run(`<!doctype html>\n<html lang="en"><head><meta charset="UTF-8" /><title>Raft</title></head><body><div id="root"></div><script type="module" crossorigin src="/feedback/assets/index.js"></script></body></html>`);
    assert.match(page, /<head>\n    <meta http-equiv="Content-Security-Policy" content="script-src 'self' 'wasm-unsafe-eval' /);
    await assert.rejects(run(`<html><head><meta charset="UTF-8"></head><body><button onclick="x()"></button></body></html>`), /inline event handler/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the boot script reads the same server-theme cache as serverTheme.ts", () => {
  assert.equal(BOOT_SERVER_THEME_STORAGE_PREFIX, SERVER_THEME_STORAGE_PREFIX);
});

test("criticalCss keeps what the markup uses, with its tokens, and drops the rest", () => {
  const css = [
    "@import url(https://fonts.example/x.css);",
    "@font-face{font-family:X;src:url(x.woff2)}",
    ":root{--used:red;--chain:var(--used);--unused:blue}",
    ".dark{--used:black}",
    ".shown{color:var(--chain)}",
    ".absent{color:green}",
    ".shown:not(.absent){outline:0}",
    ".shown .absent{margin:0}",
    "@media (min-width:768px){.shown{padding:1px}.absent{padding:2px}}",
    "@property --unused{syntax:'*';inherits:false}",
  ].join("");
  const out = criticalCss(css, '<div class="shown"></div>');
  assert.ok(out.includes(".shown{color:var(--chain)}"));
  assert.ok(out.includes("--chain:var(--used)") && out.includes("--used:red") && out.includes(".dark{--used:black}"), "custom properties the kept rules use, transitively");
  assert.ok(!out.includes("--unused"), "unused custom properties and their @property go");
  assert.ok(out.includes(".shown:not(.absent)"), "a class under :not() need not be present");
  assert.ok(!out.includes("color:green") && !out.includes("margin:0") && !out.includes("padding:2px"));
  assert.ok(out.includes("@media (min-width:768px){.shown{padding:1px}}"));
  assert.ok(!out.includes("@import") && !out.includes("@font-face"), "the shell shows no text: no web fonts");
});

test("criticalCss reads escaped classes, keeps the layer order and only the keyframes in use", () => {
  const css = [
    "@layer theme,base,components,utilities;",
    "@layer utilities{.\\[\\&_svg\\]\\:size-5 svg{width:1.25rem}.animate-pulse{animation:pulse 2s infinite}}",
    "@keyframes pulse{50%{opacity:.5}}",
    "@keyframes spin{to{transform:rotate(360deg)}}",
  ].join("");
  const out = criticalCss(css, '<div class="[&amp;_svg]:size-5 animate-pulse"></div>');
  assert.ok(out.startsWith("@layer theme,base,components,utilities;"), "the app's layer order, even if a layer keeps no rule");
  assert.ok(out.includes("svg{width:1.25rem}"), "an arbitrary variant escaped in the markup is still matched");
  assert.ok(out.includes("@keyframes pulse") && !out.includes("@keyframes spin"));
});

test("injectBootScript inlines the script and puts the app stylesheet after the content", () => {
  const html = [
    "<html><head>",
    '<script src="/app-theme-bootstrap.js"></script>',
    '<link rel="stylesheet" crossorigin href="/assets/app.css">',
    "</head><body>",
    '<div id="root"></div>',
    "</body></html>",
  ].join("\n");
  const out = injectBootScript(html, "BOOT()");
  assert.ok(out.includes("<script>BOOT()</script>"));
  assert.ok(!out.slice(0, out.indexOf("</head>")).includes('rel="stylesheet"'), "the app stylesheet no longer holds the first paint");
  assert.ok(out.indexOf('<div id="root">') < out.indexOf('rel="stylesheet"'));
  assert.throws(() => injectBootScript("<html><body></body></html>", ""), /app-theme-bootstrap/);
});

test("the boot script goes only into the app's index.html, not other pages the dev server serves", () => {
  const plugin = bootShellPlugin();
  (plugin.configResolved as (config: unknown) => void)({ env: {} });
  const hook = plugin.transformIndexHtml as { handler: (html: string, ctx: { path: string }) => string };
  const visualTesting = '<html><body><script type="module" src="/visual-testing/main.tsx"></script></body></html>';
  assert.equal(hook.handler(visualTesting, { path: "/visual-testing.html" }), visualTesting);
  assert.throws(() => hook.handler("<html><body></body></html>", { path: "/index.html" }), /app-theme-bootstrap/);
});

test("injectBootShell puts the shell inside #root, for React to replace, and its CSS in <head>", () => {
  const out = injectBootShell('<html><head></head><body><div id="root" class="notranslate"></div></body></html>', "<main>shell</main>", ".x{}");
  assert.ok(out.includes('<style id="boot-shell-style">.x{}</style>'));
  assert.ok(out.includes('<div id="root" class="notranslate"><div data-boot-shell="" class="contents"><main>shell</main></div></div>'));
  assert.throws(() => injectBootShell("<html><body></body></html>", "", ""), /#root/);
});

function runHints(path: string, storage: Record<string, string>, languages: readonly string[] = []) {
  const url = new URL(path, "https://app.raft.build");
  const root = { classList: new Set<string>(), dataset: {} as Record<string, string>, style: {} as Record<string, string>, attributes: {} as Record<string, string> };
  const entries = Object.entries(storage);
  const localStorage = {
    length: entries.length,
    key: (index: number) => entries[index]?.[0] ?? null,
    getItem: (key: string) => storage[key] ?? null,
  };
  const document = { documentElement: {
    classList: { add: (name: string) => root.classList.add(name) },
    dataset: root.dataset,
    style: { setProperty: (name: string, value: string) => { root.style[name] = value; } },
    setAttribute: (name: string, value: string) => { root.attributes[name] = value; },
  } };
  new Function("document", "localStorage", "location", "navigator", BOOT_HINTS_SCRIPT)(document, localStorage, url, { languages });
  return root;
}

test("boot hints: the shell only for a stored session on a server page", () => {
  assert.ok(runHints("/s/acme/channel/c1", {}).classList.has("boot-off"), "no session");
  assert.ok(runHints("/login", { slock_access_token: "t" }).classList.has("boot-off"), "not a server page");
  assert.ok(!runHints("/", { slock_access_token: "t" }).classList.has("boot-off"), "the root opens the last server");
});

test("boot hints: a host-shell embed (the App's WebView) never paints the app's frame", () => {
  assert.equal(BOOT_HOST_SHELL_EMBED, __embedTestInternals.SUPPORTED_EMBED, "the value embed.ts honours");
  const session = { slock_access_token: "t" };
  for (const path of [
    "/s/acme/settings/billing?embed=raft-settings-v1&shell=host",
    "/s/acme/settings/administration?shell=host&embed=raft-settings-v1",
    "/s/acme/computers?embed=raft-settings-v1",
    "/s/acme?embed=raft-settings-v1&shell=host",
  ]) {
    const root = runHints(path, session);
    assert.ok(root.classList.has("boot-off"), path);
    assert.ok(!root.classList.has("boot-home"), path);
  }
  assert.ok(!runHints("/s/acme/settings/billing?embed=raft-settings-v1&shell=web", session).classList.has("boot-off"), "web owns the chrome: as embed.ts, a normal page");
  assert.ok(!runHints("/s/acme/settings/billing?embed=raft-settings-v2&shell=host", session).classList.has("boot-off"), "an unknown version is a normal page");
});

test("boot hints: a server's root opens on a phone's Home", () => {
  assert.ok(runHints("/s/acme", { slock_access_token: "t" }).classList.has("boot-home"));
  assert.ok(runHints("/s/acme/", { slock_access_token: "t" }).classList.has("boot-home"));
  assert.ok(runHints("/", { slock_access_token: "t" }).classList.has("boot-home"));
  assert.ok(!runHints("/s/acme/channel/c1", { slock_access_token: "t" }).classList.has("boot-home"));
  assert.ok(BOOT_SHELL_CSS.includes("html.boot-home [data-boot-frame=phone-home]{display:contents}"));
});

test("boot hints: a thread link opens with its column, a server opens in its cached theme", () => {
  const root = runHints("/s/acme/channel/c1?thread=c1:m1&msg=m1", {
    slock_access_token: "t",
    "raft:server-theme:v1:other": JSON.stringify({ theme: "space", slug: "other" }),
    "raft:server-theme:v1:s1": JSON.stringify({ theme: "plants", decor: false, slug: "acme" }),
  });
  assert.ok(!root.classList.has("boot-off"));
  assert.ok(root.classList.has("boot-thread"));
  assert.equal(root.dataset.theme, "plants");
  assert.equal(root.dataset.themeDecor, "off");
  const hostile = runHints("/s/acme/channel/c1", {
    slock_access_token: "t",
    "raft:server-theme:v1:s1": JSON.stringify({ theme: "x\"]{}", slug: "acme" }),
  });
  assert.equal(hostile.dataset.theme, undefined);
});

test("boot hints: the columns open at their remembered widths, clamped; none stored keeps the default", () => {
  const root = runHints("/s/acme/channel/c1", {
    slock_access_token: "t",
    "slock:sidebarWidth": "396.4",
    "slock:threadPanelWidth": "660",
  });
  assert.equal(root.style["--boot-sidebar-width"], "396px");
  assert.equal(root.style["--boot-thread-width"], "660px");
  const clamped = runHints("/s/acme/channel/c1", {
    slock_access_token: "t",
    "slock:sidebarWidth": "9999",
    "slock:publicServer:threadPanelWidth": "10",
  });
  assert.equal(clamped.style["--boot-sidebar-width"], "400px", "the sidebar's maximum");
  assert.equal(clamped.style["--boot-thread-width"], "160px", "an earlier build's key, at the thread's minimum (160, #189)");
  assert.deepEqual(runHints("/s/acme/channel/c1", { slock_access_token: "t", "slock:sidebarWidth": "abc" }).style, {});
  assert.ok(BOOT_SHELL_CSS.includes("var(--boot-sidebar-width,240px)"));
  assert.ok(BOOT_SHELL_CSS.includes("var(--boot-thread-width,400px)"));
});

test("the classes the boot script puts on <html> are only ever read as html.<class>", () => {
  for (const name of ["boot-off", "boot-thread", "boot-home"]) {
    assert.ok(BOOT_HINTS_SCRIPT.includes(`"${name}"`), name);
    assert.ok(BOOT_SHELL_CSS.includes(`html.${name}`) || BOOT_SHELL_CSS.includes(`html:not(.${name})`), name);
    const bare = new RegExp(`(^|[},\\s])\\.${name}(?![\\w-])`, "m");
    assert.ok(!bare.test(BOOT_SHELL_CSS), `${name} never matches as a bare class`);
  }
});

test("an urgent release carries the marker the service worker looks for; others do not", async () => {
  const html = "<html><head><title>Raft</title></head><body></body></html>";
  assert.equal(markShellUrgent(html, false), html);
  const urgent = markShellUrgent(html, true);
  assert.ok(urgent.includes(SHELL_URGENT_META));
  const sw = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../public/sw.js", import.meta.url), "utf8"));
  // sw.js matches the marker by this exact prefix.
  assert.ok(sw.includes('<meta name="raft-shell" content="urgent"'));
});

test("boot hints: a canonical Artifact link shows its own frame, signed in or not, never the server's", () => {
  for (const path of ["/artifacts/pt_x", "/artifacts/pt_x/", "/artifacts/pt_x/v/2", "/artifacts/not-an-id"]) {
    for (const storage of [{}, { slock_access_token: "t" }]) {
      const root = runHints(path, storage);
      assert.ok(root.classList.has("boot-artifact"), path);
      assert.ok(!root.classList.has("boot-off") && !root.classList.has("boot-home"), path);
    }
  }
  assert.ok(!runHints("/artifacts", { slock_access_token: "t" }).classList.has("boot-artifact"), "the Artifacts home isn't a link");
  assert.ok(!runHints("/artifacts/pt_x/comments", {}).classList.has("boot-artifact"));
  // The App's WebView (a host-shell embed): the same frame, without the page's prerendered header row.
  const embedded = runHints("/artifacts/pt_x?embed=raft-settings-v1&chrome=none", {});
  assert.ok(embedded.classList.has("boot-artifact") && embedded.classList.has("boot-embedded"));
  assert.ok(!runHints("/artifacts/pt_x?embed=raft-settings-v1&shell=web", {}).classList.has("boot-embedded"), "a web-shell embed draws the page's header");
  assert.ok(!runHints("/artifacts/pt_x", {}).classList.has("boot-embedded"));
  assert.ok(BOOT_SHELL_CSS.includes("html.boot-embedded [data-boot-frame=artifact] [data-boot-artifact-head]{display:none}"));
  assert.ok(BOOT_SHELL_CSS.includes("html.boot-artifact [data-boot-frame=artifact]{display:contents}"));
  assert.ok(BOOT_SHELL_CSS.includes("html.boot-artifact [data-boot-shell]>[data-slot=app-shell-root],html.boot-artifact [data-boot-frame=phone-home]{display:none!important}"));
  for (const locale of SUPPORTED_LOCALES) {
    assert.ok(BOOT_SHELL_CSS.includes(`html[data-boot-locale=${locale}] [data-boot-frame=artifact]>[data-boot-locale=${locale}]{display:contents}`), locale);
  }
});

test("boot hints: the Artifact link's words in the locale the app will start in (resolveInitialLocale)", () => {
  assert.deepEqual(BOOT_LOCALE_RULES, displayLocaleMatchRules());
  assert.deepEqual(BOOT_LOCALE_RULES.map(([, , locale]) => locale), [...SUPPORTED_LOCALES]);
  assert.equal(BOOT_LOCALE_STORAGE_KEY, DISPLAY_LOCALE_STORAGE_KEY);
  const searches = ["", "?lang=ja", "?lang=zh-HK", "?lang=fr", "?lang=system", "?lang=%20ko%20"];
  const stored = [null, "es", "zh-tw", "zh-CN", "bogus"];
  const languageLists = [[], ["fr-FR"], ["en-US", "zh-CN"], ["en-US", "es-MX"], ["zh_TW"], ["zh-Hant-HK"], ["zh-Latn"], ["pt-PT"], ["x"], ["ko-KR", "ja"]];
  let cases = 0;
  for (const search of searches) {
    for (const value of stored) {
      for (const languages of languageLists) {
        const storage: Record<string, string> = value === null ? {} : { [DISPLAY_LOCALE_STORAGE_KEY]: value };
        const expected = resolveInitialLocale({
          storage: { getItem: (key: string) => storage[key] ?? null } as Storage,
          languages,
          search,
        });
        const root = runHints(`/artifacts/pt_x${search}`, storage, languages);
        assert.equal(root.attributes["data-boot-locale"], expected, `${search} ${value} ${languages.join(",")}`);
        cases += 1;
      }
    }
  }
  assert.equal(cases, 300);
});


// The build's map: each locale's first part under its code, its boot part and rest beside it (catalogParts.ts).
const CATALOG_MAP: Record<string, string> = Object.fromEntries(["en", "es", "pt-br", "ru", "ko", "ja", "zh-cn", "zh-tw"].flatMap((locale) => [
  [locale, `/assets/${locale}-AAAAAAAA.js`],
  [`${locale}:boot`, `/assets/${locale}-boot-AAAAAAAA.js`],
  [`${locale}:rest`, `/assets/${locale}-rest-AAAAAAAA.js`],
]));

/** The boot script on a page with the build's catalog map: the modulepreload links it adds. */
function runCatalogPreload(path: string, languages: readonly string[], map: unknown = CATALOG_MAP) {
  const links: { rel: string; href: string; crossOrigin: string | null }[] = [];
  const document = {
    documentElement: {
      classList: { add: () => {} },
      dataset: {},
      style: { setProperty: () => {} },
      setAttribute: () => {},
    },
    getElementById: (id: string) => (id === BOOT_LOCALE_CATALOGS_ID && map !== null ? { textContent: typeof map === "string" ? map : JSON.stringify(map) } : null),
    createElement: () => ({ rel: "", href: "", crossOrigin: null as string | null }),
    head: { appendChild: (link: { rel: string; href: string; crossOrigin: string | null }) => { links.push(link); } },
  };
  const storage = { length: 0, key: () => null, getItem: () => null };
  new Function("document", "localStorage", "location", "navigator", BOOT_HINTS_SCRIPT)(document, storage, new URL(path, "https://app.raft.build"), { languages });
  return links.map((link) => `${link.rel} ${link.href} ${link.crossOrigin}`);
}

test("boot hints: every page modulepreloads the boot locale's catalog (its first part, never the others), and en under a partial locale", () => {
  assert.deepEqual(runCatalogPreload("/s/demo/channel/general", ["zh-CN"]), ["modulepreload /assets/zh-cn-AAAAAAAA.js "], "zh-cn is complete: no en");
  assert.deepEqual(runCatalogPreload("/", ["en-US"]), ["modulepreload /assets/en-AAAAAAAA.js "]);
  assert.deepEqual(runCatalogPreload("/s/demo", ["ja-JP"]), ["modulepreload /assets/ja-AAAAAAAA.js ", "modulepreload /assets/en-AAAAAAAA.js "]);
  assert.deepEqual(runCatalogPreload("/login?lang=zh-TW", []), ["modulepreload /assets/zh-tw-AAAAAAAA.js ", "modulepreload /assets/en-AAAAAAAA.js "]);
  assert.deepEqual(runCatalogPreload("/artifacts/pt_x", ["ko"]), ["modulepreload /assets/ko-AAAAAAAA.js ", "modulepreload /assets/en-AAAAAAAA.js "], "an Artifact link too");
});

test("boot hints: no map, a broken one, or a URL that isn't a built JS file preloads nothing and breaks nothing", () => {
  assert.deepEqual(runCatalogPreload("/", ["en"], null), []);
  assert.deepEqual(runCatalogPreload("/", ["en"], "{not json"), []);
  assert.deepEqual(runCatalogPreload("/", ["en"], { en: "https://evil.example/x.js" }), []);
  assert.deepEqual(runCatalogPreload("/", ["en"], { en: "/assets/x.css" }), []);
});

test("the boot script's complete locales are the ones that load alone", async () => {
  const { catalogsFor } = await import("../src/i18n/messages");
  for (const locale of SUPPORTED_LOCALES) {
    const alone = (BOOT_COMPLETE_LOCALES as readonly string[]).includes(locale);
    assert.deepEqual(catalogsFor(locale), alone ? [locale] : [locale, "en"], locale);
  }
});

test("the build's catalog map: every part of every locale, before the first script in <head>", () => {
  assert.deepEqual(localeCatalogMap({ ...CATALOG_MAP, extra: 1 }), CATALOG_MAP);
  assert.throws(() => localeCatalogMap({ ...CATALOG_MAP, "ja:rest": undefined }), /ja catalog has no rest part/);
  assert.throws(() => localeCatalogMap({ ...CATALOG_MAP, "es:boot": undefined }), /es catalog has no boot part/);
  assert.throws(() => localeCatalogMap({ ...CATALOG_MAP, en: "https://evil.example/en.js" }), /en catalog has no first part/);
  const html = injectLocaleCatalogMap('<html><head><meta charset="UTF-8"><script>boot()</script></head><body><script>x()</script></body></html>', { en: "/assets/en-A.js</script>" });
  assert.equal(html, '<html><head><meta charset="UTF-8"><script type="application/json" id="raft-locale-catalogs">{"en":"/assets/en-A.js\\u003c/script>"}</script>\n    <script>boot()</script></head><body><script>x()</script></body></html>');
});

test("the Artifact link's prerendered loading splash shows its icon and line only after the page's first second, as the live one", () => {
  assert.ok(BOOT_SHELL_CSS.includes(`[data-splash-static]>*{animation:boot-splash-appear 0s linear ${ARTIFACT_SPLASH_APPEAR_AFTER_MS / 1000}s both}`));
  assert.ok(BOOT_SHELL_CSS.includes("@keyframes boot-splash-appear{from{visibility:hidden}to{visibility:visible}}"));
});

test("the boot prefetch reads the conversation's scroll memory as messageTimelineShared.ts writes it", () => {
  assert.equal(BOOT_SCROLL_MEMORY_PREFIX, `${SCROLL_MEMORY_PREFIX}channel:`);
});

test("the boot prefetch reads the root's conversation where and as rootConversation.ts keeps it", () => {
  assert.equal(BOOT_ROOT_CONVERSATION_PREFIX, ROOT_CONVERSATION_STORAGE_PREFIX);
  assert.equal(BOOT_ROOT_REDIRECT_MEDIA_QUERY, ROOT_REDIRECT_MEDIA_QUERY);
});

test("the build gives the boot prefetch the API client's base and version, and preconnects to an API on another origin", () => {
  const env = { VITE_API_URL: "https://api.raft.build/", VITE_APP_VERSION: "1.2.3" };
  assert.deepEqual(bootPrefetchConfig(env), {
    api: deriveRuntimeEndpoints("https://api.raft.build", "").apiBase,
    version: resolveWebAppVersion(env),
    preconnect: "https://api.raft.build",
  });
  assert.deepEqual(bootPrefetchConfig({}), { api: "/api", version: resolveWebAppVersion({}), preconnect: null }, "same origin: no preconnect");
  const html = '<html><head><meta charset="UTF-8" />\n    <script src="/app-theme-bootstrap.js"></script></head></html>';
  const out = injectBootPrefetchConfig(html, { api: "https://api.raft.build/api", version: "1</script>", preconnect: "https://api.raft.build" });
  assert.ok(out.indexOf('<link rel="preconnect" href="https://api.raft.build" crossorigin>') < out.indexOf(`id="${BOOT_PREFETCH_CONFIG_ID}"`));
  assert.ok(out.indexOf(`id="${BOOT_PREFETCH_CONFIG_ID}"`) < out.indexOf("app-theme-bootstrap.js"), "before the script that reads it");
  assert.ok(out.includes('{"api":"https://api.raft.build/api","version":"1\\u003c/script>"}'), "a value can't close the element");
  assert.ok(out.indexOf("<meta charset") < out.indexOf("preconnect"), "after the charset");
});

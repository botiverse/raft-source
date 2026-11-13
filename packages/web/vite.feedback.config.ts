import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DISPLAY_LOCALES, displayLocaleTag } from "@botiverse/raft-shared/src/displayLocales";
import { fileURLToPath } from "node:url";
import { FEEDBACK_CARD_COPY_IDS } from "./src/feedback/feedbackCardCopy";
import { pageMetaCspPlugin } from "./scripts/pageMetaCsp";
import { registeredVarFallbacksPlugin } from "./scripts/registeredVarFallbacks";
const root = fileURLToPath(new URL(".", import.meta.url));
// The page's own ids, plus the `feedback:submit` card form's (standalone/actionCard.tsx).
const copyKeys = [...FEEDBACK_CARD_COPY_IDS, "feedback.native.diagnostics.edit", "feedback.native.diagnostics.rejected", "feedback.native.diagnostics.unavailable", "feedback.native.diagnosticsTitle", "feedback.native.diagnostics.preparing", "feedback.native.diagnostics.uploading", "feedback.native.diagnostics.submitting", "feedback.native.diagnostics.failed", "feedback.native.diagnostics.skip", "feedback.native.diagnostics.retry", "feedback.native.diagnostics.omit", "feedback.native.hostRequired", "feedback.native.authRequired", "feedback.native.authRestored", "settings.about.feedbackTitle", "settings.about.feedbackAttachmentOpenError", "common.lightbox.close"];
// One copy per display locale, keyed by its BCP 47 tag: the session locale a
// native host sends (host.ts FEEDBACK_HOST_LOCALES).
// A catalog other than en and zh-cn may lack an id (it renders the English
// until backfilled), so such a key takes en's value; en must have them all.
function catalogValue(locale: string, key: string): string | undefined {
  const lines = readFileSync(resolve(root, `src/i18n/messages/${locale}.ts`), "utf8").split("\n");
  const index = lines.findIndex(line => line.trimStart().startsWith(`${JSON.stringify(key)}:`));
  if (index < 0) return undefined;
  // A long value sits on the line after its key.
  const rest = lines[index].trim().slice(JSON.stringify(key).length + 1).trim() || lines[index + 1].trim();
  return JSON.parse(rest.replace(/,$/, ""));
}
const englishCopy = Object.fromEntries(copyKeys.map(key => {
  const value = catalogValue("en", key);
  if (value === undefined) throw new Error(`Missing feedback copy en/${key}`);
  return [key, value];
}));
const copy = Object.fromEntries(DISPLAY_LOCALES.map(locale => {
  const entries = Object.fromEntries(copyKeys.map(key => [key, catalogValue(locale, key) ?? englishCopy[key]]));
  return [displayLocaleTag(locale), entries];
}));
export default defineConfig({
  define: { __RAFT_FEEDBACK_COPY__: JSON.stringify(copy) },
  root: resolve(root, "feedback"),
  publicDir: false,
  envDir: root,
  base: "/feedback/",
  resolve: { alias: { "/src": resolve(root, "src") } },
  plugins: [react(), tailwindcss({ optimize: true }), registeredVarFallbacksPlugin(), pageMetaCspPlugin(), {
    name: "feedback-entry-boundary",
    generateBundle() {
      const forbidden = [...this.getModuleIds()].filter(id => id.startsWith(resolve(root, "src") + "/") && !id.startsWith(resolve(root, "src/feedback") + "/"));
      if (forbidden.length) this.error(`Standalone feedback imported application startup: ${forbidden.join(", ")}`);
    },
    writeBundle() {
      const distDir = resolve(root, "dist/feedback");
      const directory = resolve(distDir, "assets");
      // Totals across every emitted asset: the deferred markdown chunk counts
      // here, so "on demand" cannot silently grow the entry without bound.
      const totals = { js: 0, css: 0 };
      for (const name of readdirSync(directory)) {
        if (name.endsWith(".js")) totals.js += statSync(resolve(directory, name)).size;
        if (name.endsWith(".css")) totals.css += statSync(resolve(directory, name)).size;
      }
      // First-paint graph: the entry plus everything it statically imports
      // (dynamic imports are deferred and only count toward the totals). This
      // line is what keeps the webview first paint fast — currently the
      // markdown renderer is loaded on demand and stays out of this number.
      const manifest = JSON.parse(
        readFileSync(resolve(distDir, ".vite/manifest.json"), "utf8"),
      ) as Record<string, { file?: string; css?: string[]; imports?: string[] }>;
      const firstPaint = { js: 0, css: 0 };
      const visited = new Set<string>();
      const walk = (key: string) => {
        if (visited.has(key)) return;
        visited.add(key);
        const item = manifest[key];
        if (!item) return;
        if (item.file?.endsWith(".js")) firstPaint.js += statSync(resolve(distDir, item.file)).size;
        for (const css of item.css ?? []) firstPaint.css += statSync(resolve(distDir, css)).size;
        for (const imp of item.imports ?? []) walk(imp);
      };
      // Resolve the entry from the manifest instead of hardcoding a key, and
      // refuse to pass the first-paint line blindly: a renamed entry or a
      // failed walk must fail the build, not silently read 0 (review).
      const entryKey = Object.keys(manifest).find((key) => manifest[key]?.isEntry);
      if (!entryKey) {
        this.error(
          "Feedback entry manifest has no isEntry item; refusing to check the first-paint budget blindly",
        );
      }
      walk(entryKey as string);
      if (firstPaint.js === 0) {
        this.error(
          "Feedback entry first-paint size resolved to 0 bytes; the static graph walk failed; refusing to pass blindly",
        );
      }
      // Raft Design System (2026-10): every raft-ui recipe gained a `raft`
      // branch and the foundation a raft scope, while the legacy brutal and
      // elegant families are still shipped. Measured on the same tree:
      // first-paint 941,681 -> 1,030,638 B, total 1,101,407 -> 1,190,364 B,
      // css 659,766 -> 806,269 B. The budgets keep ~4% headroom over that and
      // come back down once raft-ui retires the legacy families.
      const budget = { firstPaintJs: 1_075_000, totalJs: 1_240_000, css: 840_000 };
      console.log(
        `feedback entry sizes: first-paint js ${firstPaint.js}, total js ${totals.js}, css ${totals.css} ` +
          `(budget first-paint ${budget.firstPaintJs}, total ${budget.totalJs}, css ${budget.css})`,
      );
      if (firstPaint.js > budget.firstPaintJs)
        this.error(`Feedback entry first-paint budget exceeded: ${firstPaint.js} > ${budget.firstPaintJs}`);
      if (totals.js > budget.totalJs)
        this.error(`Feedback entry total js budget exceeded: ${totals.js} > ${budget.totalJs}`);
      if (totals.css > budget.css)
        this.error(`Feedback entry css budget exceeded: ${totals.css} > ${budget.css}`);
    },
  }],
  build: { outDir: resolve(root, "dist/feedback"), emptyOutDir: true, manifest: true, rolldownOptions: { input: resolve(root, "feedback/index.html") } },
});

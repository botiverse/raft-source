import { readFile, readdir } from "node:fs/promises";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { initSync, parse } from "es-module-lexer";

const FEEDBACK_DIALOG_SOURCE = "src/components/settings/AboutFeedbackDialog.tsx";
const FEEDBACK_STYLE_SOURCE = /(?:^|[\/+])(?:hands-feedback-react|feedback-react)\/(?:src|source)\/styles\.css$/;

initSync();

function normalizeAssetPath(path) {
  return path.replace(/^\/?/, "");
}

function resolveAssetReference(from, reference) {
  if (/^(?:[a-z]+:|\/\/|#|data:)/i.test(reference)) return null;
  const clean = reference.split(/[?#]/, 1)[0];
  if (!clean) return null;
  return normalizeAssetPath(
    clean.startsWith("/") ? clean : posix.join(posix.dirname(from), clean),
  );
}

function staticAssetReferences(path, source) {
  const references = [];
  if (path.endsWith(".css")) {
    for (const match of source.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?/g)) {
      references.push(match[1]);
    }
    for (const match of source.matchAll(/@import\s+url\(\s*([^)'"\s]+)\s*\)/g)) {
      references.push(match[1]);
    }
  } else if (path.endsWith(".js")) {
    const [imports] = parse(source, path);
    for (const imported of imports) {
      if (imported.d === -1 && imported.n) references.push(imported.n);
    }
  }
  return references;
}

function sourceIdentity(key, entry) {
  return String(entry.src ?? key).replaceAll("\\", "/");
}

export function validateFeedbackWorkspaceSplit({ index, manifest, assets }) {
  const byFile = new Map();
  for (const [key, entry] of Object.entries(manifest)) {
    if (entry.file) byFile.set(normalizeAssetPath(entry.file), { key, entry });
  }

  const dialogEntries = Object.entries(manifest).filter(([key, entry]) =>
    sourceIdentity(key, entry).endsWith(FEEDBACK_DIALOG_SOURCE)
  );
  const styleEntries = Object.entries(manifest).filter(([key, entry]) =>
    FEEDBACK_STYLE_SOURCE.test(sourceIdentity(key, entry))
  );
  if (dialogEntries.length !== 1 || styleEntries.length !== 1) {
    throw new Error(
      `feedback workspace manifest identity must resolve once; dialog=${dialogEntries.length} styles=${styleEntries.length}`,
    );
  }

  const feedbackJs = normalizeAssetPath(dialogEntries[0][1].file);
  const styleEntry = styleEntries[0][1];
  const feedbackCssFiles = new Set([
    ...(styleEntry.file?.endsWith(".css") ? [styleEntry.file] : []),
    ...(styleEntry.css ?? []),
  ].map(normalizeAssetPath));
  if (!feedbackJs.endsWith(".js") || feedbackCssFiles.size !== 1) {
    throw new Error(
      `feedback workspace manifest must emit one lazy JS and CSS asset; js=${feedbackJs || "none"} css=${[...feedbackCssFiles].join(",") || "none"}`,
    );
  }
  const feedbackCss = [...feedbackCssFiles][0];

  const initial = new Set(
    [...index.matchAll(/(?:src|href)=["']\/?([^"']+)["']/g)]
      .map((match) => normalizeAssetPath(match[1]))
      .filter((path) => path.endsWith(".js") || path.endsWith(".css")),
  );
  const pending = [...initial];
  while (pending.length > 0) {
    const path = pending.pop();
    if (!assets.has(path)) {
      throw new Error(`startup graph references a missing emitted asset: ${path}`);
    }
    const manifestNode = byFile.get(path)?.entry;
    const manifestEdges = [
      ...(manifestNode?.imports ?? []).map((key) => manifest[key]?.file),
      ...(manifestNode?.css ?? []),
    ].filter(Boolean).map(normalizeAssetPath);
    const source = assets.get(path)?.toString() ?? "";
    const emittedEdges = staticAssetReferences(path, source)
      .map((reference) => resolveAssetReference(path, reference))
      .filter(Boolean);

    for (const edge of [...manifestEdges, ...emittedEdges]) {
      if (!initial.has(edge)) {
        initial.add(edge);
        pending.push(edge);
      }
    }
  }

  for (const workspaceAsset of [feedbackJs, feedbackCss]) {
    if (initial.has(workspaceAsset)) {
      throw new Error(`feedback workspace asset is reachable from the startup graph: ${workspaceAsset}`);
    }
  }
  for (const path of initial) {
    const source = assets.get(path)?.toString() ?? "";
    if (source.includes("hands-feedback-")) {
      throw new Error(`startup graph contains Hands feedback workspace bytes: ${path}`);
    }
  }

  const jsBytes = assets.get(feedbackJs);
  const cssBytes = assets.get(feedbackCss);
  if (!jsBytes || !cssBytes) {
    throw new Error(`feedback workspace manifest references missing assets: ${feedbackJs}, ${feedbackCss}`);
  }
  if (!jsBytes.includes("hands-feedback-") || !cssBytes.includes("hands-feedback-")) {
    throw new Error("lazy feedback assets do not contain the expected workspace implementation and styles");
  }

  return { feedbackJs, feedbackCss, jsBytes, cssBytes };
}

async function readAssetDirectory(directory, prefix = "") {
  const output = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = posix.join(prefix, entry.name);
    const url = new URL(entry.name, directory);
    if (entry.isDirectory()) {
      const nested = await readAssetDirectory(new URL(`${entry.name}/`, directory), path);
      for (const item of nested) output.set(...item);
    } else {
      output.set(path, await readFile(url));
    }
  }
  return output;
}

async function main() {
  const dist = new URL("../dist/", import.meta.url);
  const index = await readFile(new URL("index.html", dist), "utf8");
  const manifest = JSON.parse(await readFile(new URL(".vite/manifest.json", dist), "utf8"));
  const assets = await readAssetDirectory(dist);
  const result = validateFeedbackWorkspaceSplit({ index, manifest, assets });
  console.log(
    `[feedback-workspace-split] startup closure excludes workspace assets; lazy JS ${result.jsBytes.byteLength} B (${gzipSync(result.jsBytes).byteLength} B gzip), CSS ${result.cssBytes.byteLength} B (${gzipSync(result.cssBytes).byteLength} B gzip)`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  await main();
}

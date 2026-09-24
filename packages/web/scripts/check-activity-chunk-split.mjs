// Production chunk split check for the Activity shadow runtime (task #393).
//
// PR #5678 wired the activity sync-core consumer through a STATIC import, so
// every gate-off user paid ~50KB brotli for code that never executed. The fix
// keeps the runtime behind the gate-resolved dynamic import in
// `src/store/activityPanel/bootstrap.ts`; THIS script keeps it there by
// inspecting the real Vite output (manifest module identity + emitted asset
// graph), never source text. Deleting or bypassing the lazy boundary makes
// the production build fail here.
//
// Same shape as check-feedback-workspace-split.mjs: startup graph = index.html
// script/link refs plus their full static closure (manifest imports/css edges
// and emitted static import specifiers via es-module-lexer).
//
// Two independent layers, because chunk identity alone can lie (review finding
// by Aiden on the first head: statically importing the CONSUMER kept the tiny
// runtime chunk dynamic while 176KB of consumer/schema/sync-core flowed back
// into the startup closure and the check stayed green):
// 1. CHUNK layer — the runtime must stay a dynamic manifest entry outside the
//    startup closure, and no startup asset may carry runtime marker literals.
// 2. MODULE layer — via dist/.vite/chunk-modules.json (Rollup OutputChunk
//    modules, repo-relative, emitted by the raft-chunk-modules-manifest vite
//    plugin), every module of the heavy activity tree (consumer/host/ingress/
//    runtime/windowAuthority, the generated activity schema, and the activity
//    domain of @botiverse/raft-sync-core) must live ONLY in chunks whose sole
//    entry-graph owner is the runtime's own static closure:
//      a. absent from the startup closure;
//      b. every chunk carrying such a module is inside the static closure of
//         the runtime dynamic entry;
//      c. no OTHER main-graph root (any other dynamic entry, or a non-startup
//         static entry) reaches such a chunk through static imports.
//    (c) exists because "absent from startup + present in some lazy chunk" is
//    NOT the task's guarantee (review finding by Aiden on the second head: a
//    static consumer import from an unrelated lazy feature — Settings — kept
//    startup clean and the flat lazy set green, yet gate-off users downloaded
//    the whole heavy tree the moment they opened Settings). The guarantee is
//    "gate-off never pays these bytes", and only single-ownership proves it.
// 3. WORKER layer — via dist/.vite/worker-modules.json (emitted by the
//    raft-worker-modules-collector vite plugin running INSIDE each worker
//    sub-build). Web workers are separate Rollup graphs invisible to the main
//    manifest and to layers 1–2 (review finding by Aiden on the third head: a
//    worker statically importing the consumer shipped +42KB brotli to
//    gate-off users while every main-graph assertion stayed green). No worker
//    graph may contain any heavy activity module — a worker is never the
//    gate-resolved runtime root, so there is no legitimate path. The artifact
//    must exist and must list the real composer worker, so deleting the
//    collector (or renaming the worker) cannot pass vacuously.

import { readFile, readdir } from "node:fs/promises";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync } from "node:zlib";
import { initSync, parse } from "es-module-lexer";

const RUNTIME_SOURCE = "src/store/activityPanel/runtime.ts";

// The heavy activity tree named by task #393. These are the ONLY lightweight
// activityPanel modules that may live outside the runtime closure:
// - gate/bootstrap decide whether to load the runtime;
// - useActivityShadow is a React facade over `store/activityShadowBridge.ts`
//   and must never statically import the runtime. If it regresses, the runtime's
//   consumer/host/schema modules below still trip the ownership checks.
const NON_HEAVY_ACTIVITY_MODULES = new Set([
  "src/store/activityPanel/gate.ts",
  "src/store/activityPanel/bootstrap.ts",
  "src/store/activityPanel/useActivityShadow.ts",
]);

// Scope note (review finding, second head): sync-core's SHARED roots
// (core.ts, violations.ts, domains/read-state.ts, types) are statically
// imported by shipped sync domains (notificationPrefs / threadReplies /
// message read-state) via @botiverse/raft-shared and were in the startup closure
// BEFORE PR #5678 — they are not part of this regression and cannot be
// banned without breaking live features. The activity-pulled weight is the
// activity domain module, the generated activity schema, and the entire Ajv
// tree (~165 modules), which today enters ONLY through the activity ingress.
// If a future startup feature legitimately needs Ajv, that deserves its own
// review — loosen this predicate consciously, not by deleting the check.
function isForbiddenStartupModule(moduleId) {
  const id = moduleId.replaceAll("\\", "/");
  const activityIndex = id.indexOf("src/store/activityPanel/");
  if (activityIndex !== -1) {
    return !NON_HEAVY_ACTIVITY_MODULES.has(id.slice(activityIndex));
  }
  if (id.includes("sync-core/src/domains/activity")) return true;
  if (id.includes("contracts/activity-v1") || id.includes("activity-sync.schema.json")) return true;
  if (id.includes("node_modules/ajv/")) return true;
  return false;
}

// Modules that must exist in the RUNTIME's own static closure (not merely in
// some lazy chunk), so the module-layer assertion cannot pass vacuously after
// a rename/deletion. S2 adds the projection/bundle pair to the runtime-owned
// closure; putting either in the thin receiver would make gate-off users pay.
const LAZY_REQUIRED_MODULE_SNIPPETS = [
  "src/store/activityPanel/runtime.ts",
  "src/store/activityPanel/host.ts",
  "src/store/activityPanel/consumer.ts",
  "src/store/activityPanel/ingress.ts",
  "src/store/activityPanel/projection.ts",
  "src/store/activityPanel/windowBundle.ts",
  "src/store/activityPanel/windowAuthority.ts",
  "sync-core/src/domains/activity",
  "activity-sync.schema.json",
  "node_modules/ajv/",
];
// String literals that only exist in the runtime/host/consumer tree and
// survive minification — belt-and-braces on top of module identity.
const ACTIVITY_MARKERS = [
  "/channels/activity/snapshot",
  "/channels/activity/difference",
  "gate_closed",
  "web-activity-",
];

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

// Full static closure (manifest imports/css edges + emitted static import
// specifiers) over emitted assets, from the given root asset paths. Dynamic
// import edges are intentionally NOT followed: each dynamic entry is its own
// root, and ownership is judged per root.
function staticAssetClosure(roots, { assets, manifest, byFile }) {
  const closure = new Set(roots);
  const pending = [...closure];
  while (pending.length > 0) {
    const path = pending.pop();
    if (!assets.has(path)) {
      throw new Error(`closure references a missing emitted asset: ${path}`);
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
      if (!closure.has(edge)) {
        closure.add(edge);
        pending.push(edge);
      }
    }
  }
  return closure;
}

// A worker graph that must exist in worker-modules.json: the real production
// worker gate-off users load from the composer. Its presence proves the
// worker collector actually ran; update if the worker moves or is renamed.
const REQUIRED_WORKER_GRAPH_SNIPPET = "src/workers/composerSuggestion.worker.ts";

export function validateActivityChunkSplit({ index, manifest, assets, chunkModules, workerModules }) {
  const byFile = new Map();
  for (const [key, entry] of Object.entries(manifest)) {
    if (entry.file) byFile.set(normalizeAssetPath(entry.file), { key, entry });
  }

  const runtimeEntries = Object.entries(manifest).filter(([key, entry]) =>
    sourceIdentity(key, entry).endsWith(RUNTIME_SOURCE)
  );
  if (runtimeEntries.length !== 1) {
    throw new Error(
      `activity runtime manifest identity must resolve once; got ${runtimeEntries.length} ` +
        "(either the runtime moved — update RUNTIME_SOURCE — or the dynamic " +
        "entry collapsed into another chunk)",
    );
  }
  const [, runtimeManifestEntry] = runtimeEntries[0];
  if (!runtimeManifestEntry.isDynamicEntry) {
    throw new Error(
      "activity runtime is no longer a dynamic entry — the gate-resolved " +
        "lazy boundary in store/activityPanel/bootstrap.ts was bypassed or deleted",
    );
  }
  const runtimeJs = normalizeAssetPath(runtimeManifestEntry.file);

  const graph = { assets, manifest, byFile };
  const initial = staticAssetClosure(
    [...index.matchAll(/(?:src|href)=["']\/?([^"']+)["']/g)]
      .map((match) => normalizeAssetPath(match[1]))
      .filter((path) => path.endsWith(".js") || path.endsWith(".css")),
    graph,
  );

  if (initial.has(runtimeJs)) {
    throw new Error(`activity runtime chunk is reachable from the startup graph: ${runtimeJs}`);
  }
  for (const path of initial) {
    if (!path.endsWith(".js")) continue;
    const source = assets.get(path)?.toString() ?? "";
    for (const marker of ACTIVITY_MARKERS) {
      if (source.includes(marker)) {
        throw new Error(`startup graph contains activity runtime bytes ("${marker}"): ${path}`);
      }
    }
  }

  const runtimeBytes = assets.get(runtimeJs);
  if (!runtimeBytes) {
    throw new Error(`activity runtime manifest references a missing asset: ${runtimeJs}`);
  }
  const runtimeText = runtimeBytes.toString();
  const missingMarkers = ACTIVITY_MARKERS.filter((marker) => !runtimeText.includes(marker));
  if (missingMarkers.length > 0) {
    throw new Error(
      "lazy activity chunk lacks expected runtime markers " +
        `(${missingMarkers.join(", ")}) — this tooth must not pass vacuously; ` +
        "update ACTIVITY_MARKERS if the literals changed",
    );
  }

  // MODULE layer: heavy activity modules must be owned by the runtime dynamic
  // root ALONE. "Not in startup" is necessary but not sufficient — a second
  // root (another dynamic entry, or a non-startup static entry like a worker)
  // sharing a heavy chunk makes gate-off users pay the bytes on an unrelated
  // feature load, which is the same regression through a different door.
  const forbiddenByChunk = new Map();
  for (const [chunkFile, moduleIds] of Object.entries(chunkModules)) {
    const forbidden = moduleIds
      .map((id) => id.replaceAll("\\", "/"))
      .filter(isForbiddenStartupModule);
    if (forbidden.length > 0) forbiddenByChunk.set(normalizeAssetPath(chunkFile), forbidden);
  }

  const startupModuleViolations = [];
  for (const [chunkFile, forbidden] of forbiddenByChunk) {
    if (!initial.has(chunkFile)) continue;
    startupModuleViolations.push(...forbidden.map((id) => `${chunkFile} bundles ${id}`));
  }
  if (startupModuleViolations.length > 0) {
    throw new Error(
      "startup closure bundles heavy activity modules (module-identity layer):\n  " +
        startupModuleViolations.join("\n  "),
    );
  }

  // Ownership containment: every chunk carrying a heavy activity module must
  // sit inside the runtime root's own static closure.
  const runtimeClosure = staticAssetClosure([runtimeJs], graph);
  const outsideRuntimeClosure = [...forbiddenByChunk.keys()].filter(
    (chunkFile) => !runtimeClosure.has(chunkFile),
  );
  if (outsideRuntimeClosure.length > 0) {
    throw new Error(
      "heavy activity modules live in chunks OUTSIDE the runtime's static " +
        `closure (${outsideRuntimeClosure.join(", ")}) — some other import ` +
        "path owns activity bytes; route it through the gate-resolved runtime",
    );
  }

  // Ownership exclusivity: no other root may reach a heavy chunk. Roots =
  // every other dynamic entry plus any static entry outside the startup
  // closure (startup-closure roots are already covered by the check above,
  // since their static closure is a subset of `initial`).
  const singleOwnerViolations = [];
  for (const [key, entry] of Object.entries(manifest)) {
    if (!entry.file || !(entry.isDynamicEntry || entry.isEntry)) continue;
    const rootFile = normalizeAssetPath(entry.file);
    if (rootFile === runtimeJs || initial.has(rootFile) || !rootFile.endsWith(".js")) continue;
    const closure = staticAssetClosure([rootFile], graph);
    const reached = [...forbiddenByChunk.keys()].filter((chunkFile) => closure.has(chunkFile));
    if (reached.length > 0) {
      singleOwnerViolations.push(
        `${sourceIdentity(key, entry)} (root ${rootFile}) statically reaches ${reached.join(", ")}`,
      );
    }
  }
  if (singleOwnerViolations.length > 0) {
    throw new Error(
      "heavy activity chunks are reachable from roots other than the " +
        "gate-resolved runtime (single-ownership layer) — gate-off users " +
        "would download activity bytes on an unrelated feature load:\n  " +
        singleOwnerViolations.join("\n  "),
    );
  }

  // Anti-vacuity: the runtime closure itself must actually contain the heavy
  // tree — judged against the RUNTIME closure's modules, not any lazy chunk.
  const runtimeClosureModules = [];
  for (const chunkFile of runtimeClosure) {
    const moduleIds = chunkModules[chunkFile] ?? chunkModules[`/${chunkFile}`] ?? [];
    runtimeClosureModules.push(...moduleIds.map((id) => id.replaceAll("\\", "/")));
  }
  const missingRuntimeModules = LAZY_REQUIRED_MODULE_SNIPPETS.filter(
    (snippet) => !runtimeClosureModules.some((id) => id.includes(snippet)),
  );
  if (missingRuntimeModules.length > 0) {
    throw new Error(
      "runtime static closure lacks expected activity modules " +
        `(${missingRuntimeModules.join(", ")}) — the module-identity layer must ` +
        "not pass vacuously; update the lists if modules moved",
    );
  }

  // WORKER layer: worker sub-builds are separate Rollup graphs the main
  // manifest never sees. No worker may carry heavy activity modules, and the
  // artifact itself must prove the collector ran on the real composer worker.
  const workerGraphs = Object.keys(workerModules ?? {});
  if (!workerGraphs.some((graph) => graph.includes(REQUIRED_WORKER_GRAPH_SNIPPET))) {
    throw new Error(
      "worker-modules.json does not list the composer worker graph " +
        `("${REQUIRED_WORKER_GRAPH_SNIPPET}"; got ${workerGraphs.length ? workerGraphs.join(", ") : "an empty artifact"}) — ` +
        "either the raft-worker-modules-collector plugin was detached from " +
        "worker.plugins (worker graphs are now unverified) or the worker " +
        "moved; fix the wiring or update REQUIRED_WORKER_GRAPH_SNIPPET",
    );
  }
  const workerViolations = [];
  for (const [graph, moduleIds] of Object.entries(workerModules)) {
    const forbidden = moduleIds
      .map((id) => id.replaceAll("\\", "/"))
      .filter(isForbiddenStartupModule);
    if (forbidden.length > 0) {
      workerViolations.push(`${graph} bundles ${forbidden.join(", ")}`);
    }
  }
  if (workerViolations.length > 0) {
    throw new Error(
      "worker graphs bundle heavy activity modules (worker layer) — workers " +
        "load for gate-off users and are never the gate-resolved runtime " +
        "root:\n  " + workerViolations.join("\n  "),
    );
  }

  let initialRaw = 0;
  let initialBrotli = 0;
  for (const path of initial) {
    const bytes = assets.get(path);
    if (!bytes) continue;
    initialRaw += bytes.byteLength;
    initialBrotli += brotliCompressSync(bytes).byteLength;
  }

  return { runtimeJs, runtimeBytes, initialCount: initial.size, initialRaw, initialBrotli };
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
  const chunkModules = JSON.parse(await readFile(new URL(".vite/chunk-modules.json", dist), "utf8"));
  const workerModules = JSON.parse(await readFile(new URL(".vite/worker-modules.json", dist), "utf8"));
  const assets = await readAssetDirectory(dist);
  const result = validateActivityChunkSplit({ index, manifest, assets, chunkModules, workerModules });
  console.log(
    `[activity-chunk-split] startup closure (${result.initialCount} assets, ` +
      `${result.initialRaw} B raw / ${result.initialBrotli} B brotli) excludes the ` +
      `activity runtime; lazy chunk ${result.runtimeJs} ${result.runtimeBytes.byteLength} B ` +
      `(${brotliCompressSync(result.runtimeBytes).byteLength} B brotli)`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  await main();
}

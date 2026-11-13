// Builds the H5 offline bundle the native apps load: a manifest plus a staged
// copy of the static files it lists. Hands zips, verifies and publishes the
// result; this script never uploads. Contract: Hands H5 manifest v1 (draft).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const H5_BUNDLE_SCHEMA = 1;

// Deployment plumbing and the service worker are not part of the bundle: the
// host serves files itself and the offline host must not run a worker.
// `.br`: the CDN's brotli-11 copies (precompress-assets.ts); the app reads the files themselves.
const EXCLUDED = [/^_headers$/, /^_routes\.json$/, /^_worker\.js$/, /^\.vite\//, /^sw\.js$/, /^robots\.txt$/, /\.br$/];
const NETWORK_ONLY = ["/api/", "/internal/", "/socket.io/", "/sw.js"];
const SPA_FALLBACK = {
  serve: "/index.html",
  forNavigationsNotUnder: ["/api/", "/internal/", "/socket.io/", "/assets/", "/.well-known/"],
};
const DOCUMENT_HEADERS = [
  "Content-Security-Policy",
  "Referrer-Policy",
  "Permissions-Policy",
  "Cross-Origin-Opener-Policy",
  "Cross-Origin-Embedder-Policy",
  "X-Content-Type-Options",
  "X-Frame-Options",
];
const PATH_RULE = /^\/[^?#\\%\u0000- ]*$/;
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};

export function isBundledPath(relativePath) {
  return !EXCLUDED.some((rule) => rule.test(relativePath));
}

/** The headers the deployed site sends for every document (`/*` in `_headers`), limited to the ones a host must reproduce. */
export function documentHeadersFromHeadersFile(text) {
  const headers = {};
  let inAllPaths = false;
  for (const line of text.split("\n")) {
    if (!/^\s/.test(line)) {
      inAllPaths = line.trim() === "/*";
      continue;
    }
    if (!inAllPaths) continue;
    const match = /^\s+([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (match && DOCUMENT_HEADERS.includes(match[1])) headers[match[1]] = match[2].trim();
  }
  return headers;
}

// Each platform states its minimum in that platform's own version form; they are never compared across hosts.
const IOS_BUILD_VERSION = /^[0-9]+(?:\.[0-9]+){0,2}$/;
const ELECTRON_APP_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const isVersionCode = (value) => Number.isInteger(value) && value >= 1;
// Dotted versions compare part by part as numbers, with missing parts as zero: 10.2 < 10.10, and 10 equals 10.0.0.
const compareDotted = (a, b) => {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};
const HOST_VERSION_FIELDS = {
  android: { min: "minVersionCode", max: "maxVersionCode", valid: isVersionCode, compare: (a, b) => a - b, form: "an integer of at least 1" },
  ohos: { min: "minVersionCode", max: "maxVersionCode", valid: isVersionCode, compare: (a, b) => a - b, form: "an integer of at least 1" },
  ios: { min: "minBuildVersion", max: "maxBuildVersion", valid: (value) => typeof value === "string" && IOS_BUILD_VERSION.test(value), compare: compareDotted, form: "a build version of one to three numeric parts, as a string" },
  electron: { min: "minAppVersion", max: "maxAppVersion", valid: (value) => typeof value === "string" && ELECTRON_APP_VERSION.test(value), compare: compareDotted, form: "a three-part app version, as a string" },
};

/** Only hosts whose owner has supplied values are listed; a host with no entry gets no bundle. */
export function validateHosts(hosts) {
  const names = Object.keys(hosts ?? {});
  if (names.length === 0) {
    throw new Error("h5-bundle.config.json lists no host. A host is added by its native owner with a real minimum version; there is no default.");
  }
  for (const name of names) {
    const fields = HOST_VERSION_FIELDS[name];
    if (!fields) throw new Error(`Unknown host "${name}" in h5-bundle.config.json`);
    const host = hosts[name] ?? {};
    const unknown = Object.keys(host).filter((key) => ![fields.min, fields.max, "requiredCapabilities"].includes(key));
    if (unknown.length > 0) throw new Error(`Host "${name}" has fields it does not use: ${unknown.join(", ")}`);
    if (!fields.valid(host[fields.min])) throw new Error(`Host "${name}" needs ${fields.min}: ${fields.form}`);
    if (host[fields.max] !== undefined && !fields.valid(host[fields.max])) throw new Error(`Host "${name}" has an invalid ${fields.max}: ${fields.form}`);
    // A range no host can satisfy would publish a bundle nobody loads.
    if (host[fields.max] !== undefined && fields.compare(host[fields.max], host[fields.min]) < 0) {
      throw new Error(`Host "${name}" has ${fields.max} below ${fields.min}`);
    }
    const capabilities = host.requiredCapabilities;
    if (!Array.isArray(capabilities) || capabilities.some((item) => typeof item !== "string" || !item) || new Set(capabilities).size !== capabilities.length) {
      throw new Error(`Host "${name}" needs requiredCapabilities as a list of distinct names (it may be empty)`);
    }
  }
  return hosts;
}

/**
 * @param {{ files: Array<{ path: string, bytes: Uint8Array }>, config: { runtimeId: string, hosts: object }, gitSha: string, committedAt: string, webVersion: string, headersText: string }} input
 */
export function buildH5BundleManifest({ files, config, gitSha, committedAt, webVersion, headersText }) {
  if (!/^[0-9a-f]{40}$/.test(gitSha)) throw new Error("gitSha must be a full 40-character commit id");
  if (typeof config.runtimeId !== "string" || !config.runtimeId) throw new Error("h5-bundle.config.json needs a runtimeId");
  const hosts = validateHosts(config.hosts);

  const entries = files
    .filter((file) => isBundledPath(file.path))
    .map((file) => {
      const path = `/${file.path}`;
      if (!PATH_RULE.test(path) || path.split("/").some((segment) => segment === "." || segment === "..")) {
        throw new Error(`Path is not allowed in an H5 bundle: ${path}`);
      }
      const contentType = CONTENT_TYPES[extname(file.path).toLowerCase()];
      if (!contentType) throw new Error(`No content type is defined for ${path}; add its extension to build-h5-bundle.ts`);
      return { path, sha256: createHash("sha256").update(file.bytes).digest("hex"), size: file.bytes.length, contentType };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) throw new Error("Duplicate path in the H5 bundle");
  if (!entries.some((entry) => entry.path === SPA_FALLBACK.serve)) throw new Error("The build has no /index.html entry");

  // The bundle's identity is its content. The commit id alone does not prove two builds are the same bytes.
  const contentDigest = createHash("sha256")
    .update(entries.map((entry) => `${entry.path}\0${entry.sha256}\0${entry.size}\n`).join(""))
    .digest("hex");

  return {
    schema: H5_BUNDLE_SCHEMA,
    buildId: `${webVersion}-${gitSha.slice(0, 12)}-${contentDigest.slice(0, 12)}`,
    webVersion,
    gitSha,
    createdAt: committedAt,
    runtimeId: config.runtimeId,
    hosts,
    entry: SPA_FALLBACK.serve,
    files: entries,
    totalSize: entries.reduce((total, entry) => total + entry.size, 0),
    networkOnly: NETWORK_ONLY,
    spaFallback: SPA_FALLBACK,
    documentHeaders: documentHeadersFromHeadersFile(headersText),
  };
}

async function listRelativeFiles(root, relative = "") {
  const out = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await listRelativeFiles(root, path));
    else if (entry.isFile()) out.push(path);
    else throw new Error(`Only regular files can be bundled: ${path}`);
  }
  return out;
}

async function main() {
  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const distRoot = resolve(webRoot, "dist");
  const outRoot = resolve(webRoot, "h5-bundle");
  const git = (...args) => execFileSync("git", args, { cwd: webRoot, encoding: "utf8" }).trim();

  const files = [];
  for (const path of await listRelativeFiles(distRoot)) files.push({ path, bytes: await readFile(join(distRoot, path)) });

  const manifest = buildH5BundleManifest({
    files,
    config: JSON.parse(await readFile(resolve(webRoot, "h5-bundle.config.json"), "utf8")),
    gitSha: git("rev-parse", "HEAD"),
    committedAt: new Date(git("show", "-s", "--format=%cI", "HEAD")).toISOString(),
    webVersion: JSON.parse(await readFile(resolve(webRoot, "package.json"), "utf8")).version,
    headersText: await readFile(join(distRoot, "_headers"), "utf8"),
  });

  // The manifest sits beside the staged directory, not inside it: it does not list itself.
  await rm(outRoot, { recursive: true, force: true });
  for (const entry of manifest.files) {
    const target = join(outRoot, "root", entry.path);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(distRoot, entry.path), target);
  }
  await writeFile(join(outRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[h5-bundle] ${manifest.buildId}: ${manifest.files.length} files, ${manifest.totalSize} B for ${Object.keys(manifest.hosts).join(", ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

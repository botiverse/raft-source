import { defineConfig, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPwaAppName } from "./scripts/pwaManifestName";
import { resolveWebProxyTarget } from "./scripts/webProxyTarget";
import {
  createDesktopManifestContractAdapter,
  createFrontendReleaseIdentityDefines,
  createFrontendReleaseIdentityPlugin,
  resolveFrontendReleaseIdentity,
} from "./scripts/frontendReleaseIdentity";

const webProxyTarget = resolveWebProxyTarget(process.env);
const serverTarget = webProxyTarget.origin;
const remotePreviewDefines = webProxyTarget.name === "local"
  ? {}
  : {
      "import.meta.env.VITE_DEPLOYMENT_ENV": JSON.stringify(process.env.VITE_DEPLOYMENT_ENV || "web-preview"),
      "import.meta.env.VITE_PREVIEW_API_TARGET": JSON.stringify(process.env.VITE_PREVIEW_API_TARGET || webProxyTarget.name),
    };
const devPort = process.env.VITE_DEV_PORT ? Number(process.env.VITE_DEV_PORT) : 5173;
const webRoot = dirname(fileURLToPath(import.meta.url));
const frontendReleaseIdentity = resolveFrontendReleaseIdentity(process.env);
const desktopManifestContract = createDesktopManifestContractAdapter(process.env);

// Optional comma-separated list of extra hostnames the dev server should
// accept. Use this when exposing the local dev server through a tunnel
// (cloudflared / ngrok / tailscale serve) for a remote preview reviewer.
// Vite supports leading-dot wildcards (e.g. `.trycloudflare.com`). Leave
// unset for the standard local-only behavior.
const extraAllowedHosts = (process.env.VITE_DEV_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

// Serve/ship the canonical pixel-avatar JSON at a stable public URL
// (/config/pixelAvatars.json) without a committed duplicate: the single
// source stays at assets/avatars/pixelAvatars.json (imported by
// PixelAvatar.tsx); build copies it into dist/config/, dev serves it via
// middleware. The mobile app downloads this URL at runtime (task #352).
const pixelAvatarsConfigPlugin = () => ({
  name: "raft-pixel-avatars-config",
  configureServer(server: ViteDevServer) {
    server.middlewares.use("/config/pixelAvatars.json", async (_req, res) => {
      const body = await readFile(resolve(webRoot, "assets/avatars/pixelAvatars.json"), "utf8");
      res.setHeader("Content-Type", "application/json");
      res.end(body);
    });
  },
  async closeBundle() {
    const source = resolve(webRoot, "assets/avatars/pixelAvatars.json");
    const targetDir = resolve(webRoot, "dist/config");
    await mkdir(targetDir, { recursive: true });
    await copyFile(source, resolve(targetDir, "pixelAvatars.json"));
  },
});

// Rollup module ids are absolute build-machine paths (some NUL-prefixed
// virtual ids). Publish them repo-relative so the dist artifacts are
// deterministic across machines and leak no local directory layout.
const repoRoot = `${resolve(webRoot, "../..").replaceAll("\\", "/")}/`;
const toRepoRelativeModuleId = (id: string) => {
  const posixId = id.replaceAll("\\", "/");
  const virtualPrefix = posixId.startsWith("\u0000") ? "\u0000" : "";
  const path = virtualPrefix ? posixId.slice(1) : posixId;
  return path.startsWith(repoRoot)
    ? `${virtualPrefix}${path.slice(repoRoot.length)}`
    : posixId;
};

type RollupishBundle = Record<string, { type: string; facadeModuleId?: string | null; modules?: Record<string, unknown> }>;

// Web workers are SEPARATE Rollup sub-builds: their chunks never appear in the
// main build's manifest or bundle, so the main-graph artifact below is blind
// to them (review finding by Aiden on the third head: a worker statically
// importing the activity consumer shipped +42KB brotli to gate-off users with
// every check green). This collector runs inside each worker sub-build (wired
// via `worker.plugins`) and records worker-graph module ids into module scope;
// worker sub-builds complete while the main build processes the importing
// module, i.e. before the main build's generateBundle writes the artifacts.
const collectedWorkerModules: Record<string, string[]> = {};
const workerModulesCollectorPlugin = () => ({
  name: "raft-worker-modules-collector",
  apply: "build" as const,
  generateBundle(_options: unknown, bundle: RollupishBundle) {
    for (const [fileName, output] of Object.entries(bundle)) {
      if (output.type !== "chunk") continue;
      const graph = output.facadeModuleId
        ? toRepoRelativeModuleId(output.facadeModuleId)
        : fileName;
      const modules = Object.keys(output.modules ?? {}).map(toRepoRelativeModuleId);
      collectedWorkerModules[graph] = [...(collectedWorkerModules[graph] ?? []), ...modules];
    }
  },
});

// Emits dist/.vite/chunk-modules.json (main graph: emitted JS chunk file ->
// bundled Rollup module ids) and dist/.vite/worker-modules.json (worker
// graphs: worker entry module -> bundled module ids). Consumed by
// scripts/check-activity-chunk-split.mjs to assert MODULE IDENTITY (which
// source modules reached which graph), not just chunk/file identity — a heavy
// module can be inlined into any chunk without changing file names, and only
// these maps make that visible.
const chunkModulesManifestPlugin = () => ({
  name: "raft-chunk-modules-manifest",
  apply: "build" as const,
  async generateBundle(_options: unknown, bundle: RollupishBundle) {
    const map: Record<string, string[]> = {};
    for (const [fileName, output] of Object.entries(bundle)) {
      if (output.type !== "chunk") continue;
      map[fileName] = Object.keys(output.modules ?? {}).map(toRepoRelativeModuleId);
    }
    const targetDir = resolve(webRoot, "dist/.vite");
    await mkdir(targetDir, { recursive: true });
    await writeFile(
      resolve(targetDir, "chunk-modules.json"),
      `${JSON.stringify(map, null, 2)}\n`,
    );
    await writeFile(
      resolve(targetDir, "worker-modules.json"),
      `${JSON.stringify(collectedWorkerModules, null, 2)}\n`,
    );
  },
});

const pwaManifestNamePlugin = () => ({
  name: "raft-pwa-manifest-name",
  apply: "build" as const,
  async closeBundle() {
    const manifestPath = resolve(webRoot, "dist/site.webmanifest");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const nextManifest = applyPwaAppName(manifest, process.env.VITE_DEPLOYMENT_ENV);
    await writeFile(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
  },
});

export default defineConfig({
  define: {
    ...remotePreviewDefines,
    ...createFrontendReleaseIdentityDefines(frontendReleaseIdentity),
  },
  plugins: [
    react(),
    chunkModulesManifestPlugin(),
    createFrontendReleaseIdentityPlugin(
      frontendReleaseIdentity,
      desktopManifestContract,
    ),
    pwaManifestNamePlugin(),
    pixelAvatarsConfigPlugin(),
  ],
  server: {
    host: true,
    allowedHosts: [".trycloudflare.com", ".loca.lt"],
    port: devPort,
    // Per-commit previews expose this Vite dev server through quick tunnels
    // such as trycloudflare/localtunnel. Pre-transform the main shell so the
    // first remote reviewer does not pay the whole module transform waterfall
    // over the tunnel.
    warmup: {
      clientFiles: [
        "./src/main.tsx",
        "./src/App.tsx",
        "./src/components/layout/MainLayout.tsx",
        "./src/store/authStore.ts",
        "./src/store/serverStore.ts",
        "./src/store/channelStore.ts",
        "./src/store/messageStore.ts",
        "./src/api/client.ts",
        "./src/api/socket.ts",
      ],
    },
    ...(extraAllowedHosts.length > 0 ? { allowedHosts: extraAllowedHosts } : {}),
    proxy: {
      "/api": {
        target: serverTarget,
        changeOrigin: true,
        xfwd: true,
      },
      "/internal": {
        target: serverTarget,
        changeOrigin: true,
        xfwd: true,
      },
      "/socket.io": {
        target: serverTarget,
        changeOrigin: true,
        ws: true,
      },
      "/daemon": {
        target: serverTarget,
        ws: true,
      },
    },
  },
  // `vite preview` (used by the Playwright e2e webServer — serves the built
  // `dist/` instead of the dev server) does NOT inherit `server.proxy`, so the
  // `/api` `/internal` `/socket.io` `/daemon` routes must be mirrored here or
  // they 404 under preview. Serving the built bundle (static chunks, no on-
  // demand dynamic-import HTTP fetch, no HMR ws competing with app socket.io)
  // is what eliminates the Vite-dev dynamic-chunk-reject e2e flake this config
  // change targets.
  preview: {
    port: devPort,
    allowedHosts: [".trycloudflare.com", ".loca.lt"],
    proxy: {
      "/api": { target: serverTarget, changeOrigin: true, xfwd: true },
      "/internal": { target: serverTarget, changeOrigin: true, xfwd: true },
      "/socket.io": { target: serverTarget, changeOrigin: true, ws: true },
      "/daemon": { target: serverTarget, ws: true },
    },
  },
  worker: {
    plugins: () => [workerModulesCollectorPlugin()],
  },
  build: {
    outDir: "dist",
    manifest: true,
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-markdown": ["react-markdown", "remark-breaks", "remark-gfm", "rehype-raw", "rehype-sanitize"],
          "vendor-socketio": ["socket.io-client"],
        },
      },
    },
  },
});

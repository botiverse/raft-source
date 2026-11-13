import { defineConfig } from "vite";
import type { Plugin, ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPwaAppName } from "./scripts/pwaManifestName";
import { bootShellPlugin } from "./scripts/bootShellPlugin";
import { catalogPartsPlugin } from "./scripts/catalogPartsPlugin";
import { startupCodeSplittingGroups } from "./scripts/startupChunkGroups";
import { registeredVarFallbacksPlugin } from "./scripts/registeredVarFallbacks";
import { resolveWebProxyTarget } from "./scripts/webProxyTarget";
import { applyWorkerApiOrigin, workerApiOrigin } from "./scripts/workerApiOrigin";
import { webVersionFilePlugin } from "./scripts/webVersionFile";
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
// source is packages/shared/assets/pixelAvatars.json (imported by
// PixelAvatar.tsx and the server's pixelAvatarService); build copies it into
// dist/config/, dev serves it via middleware. The mobile app downloads this
// URL at runtime (task #352), so the URL must not change.
const pixelAvatarsSource = resolve(webRoot, "../shared/assets/pixelAvatars.json");
const pixelAvatarsConfigPlugin = () => ({
  name: "raft-pixel-avatars-config",
  configureServer(server: ViteDevServer) {
    server.middlewares.use("/config/pixelAvatars.json", async (_req, res) => {
      const body = await readFile(pixelAvatarsSource, "utf8");
      res.setHeader("Content-Type", "application/json");
      res.end(body);
    });
  },
  async closeBundle() {
    const targetDir = resolve(webRoot, "dist/config");
    await mkdir(targetDir, { recursive: true });
    await copyFile(pixelAvatarsSource, resolve(targetDir, "pixelAvatars.json"));
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

// dist/_worker.js asks the API for public Artifacts' preview meta: write the
// build's API origin into it (scripts/workerApiOrigin.ts).
const workerApiOriginPlugin = () => ({
  name: "raft-worker-api-origin",
  apply: "build" as const,
  async closeBundle() {
    const workerPath = resolve(webRoot, "dist/_worker.js");
    const worker = await readFile(workerPath, "utf8");
    await writeFile(workerPath, applyWorkerApiOrigin(worker, workerApiOrigin(process.env.VITE_API_URL)));
  },
});

// packages/shared is consumed through its barrel (src/index.ts) and has no
// import-time side effects the web app relies on: its modules only declare
// exports (lazySchema registers a schema for warmContractSchemas, which only
// the server calls). Marking them side-effect free lets the build drop the
// ones the app never uses (Agent API contracts, tracing fields, ...: ~45 KB
// gzip of the first screen). Scoped to this build, not packages/shared's
// package.json, so the CLI / daemon / desktop bundles keep their behaviour.
const SHARED_SRC = /[\\/]packages[\\/]shared[\\/]src[\\/]/;
function sharedWithoutSideEffectsPlugin(): Plugin {
  return {
    name: "raft-shared-without-side-effects",
    transform: {
      filter: { id: SHARED_SRC },
      handler: () => ({ moduleSideEffects: false }),
    },
  };
}

const webEntry = resolve(webRoot, "src/main.tsx");

export default defineConfig({
  define: {
    ...remotePreviewDefines,
    ...createFrontendReleaseIdentityDefines(frontendReleaseIdentity),
  },
  plugins: [
    react(),
    // Resolve imported asset URLs before Tailwind optimizes the CSS.
    tailwindcss({ optimize: true }),
    // Rings, shadows and filters in a Chromium 111-118 WebView (#triage:#322).
    registeredVarFallbacksPlugin(),
    createFrontendReleaseIdentityPlugin(
      frontendReleaseIdentity,
      desktopManifestContract,
    ),
    pwaManifestNamePlugin(),
    workerApiOriginPlugin(),
    webVersionFilePlugin(frontendReleaseIdentity),
    pixelAvatarsConfigPlugin(),
    bootShellPlugin(),
    // Each catalog in a first-screen part and the rest (docs/frontend/i18n/README.md).
    catalogPartsPlugin(),
    sharedWithoutSideEffectsPlugin(),
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
  build: {
    outDir: "dist",
    manifest: true,
    // Vite 8 bundles with Rolldown: the object form of `manualChunks` is gone,
    // `codeSplitting` groups replace it.
    rolldownOptions: {
      output: {
        codeSplitting: {
          // The startup chunk groups (scripts/startupChunkGroups.ts, shared with
          // Raft Desktop's renderer build).
          groups: startupCodeSplittingGroups(webEntry, { appStable: true }),
        },
      },
    },
  },
});

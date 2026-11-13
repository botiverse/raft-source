// The boot shell (docs/frontend/boot-shell.md) written into dist/index.html, right
// after `vite build` (package.json build:vite, which sets RAFT_BOOT_SHELL_AFTER_BUILD=1
// so closeBundle leaves it): its own process, so the render's Vite SSR server and
// JSDOM do not add to the build's peak memory.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderBootShellPage } from "./bootShellPlugin";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// As in the build's process, where the render used to run (`vite build` sets it):
// the SSR server then loads React's production build. Same markup, but in
// development the render peaks ~1 GiB higher.
process.env.NODE_ENV ??= "production";

await renderBootShellPage(webRoot, resolve(webRoot, "vite.config.ts"), resolve(webRoot, "dist"));

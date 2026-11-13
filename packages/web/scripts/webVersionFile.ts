import type { Plugin } from "vite";
import type { FrontendReleaseIdentity } from "../src/buildIdentity";
import { resolveWebRelease } from "../src/utils/webAppVersion";

export const WEB_VERSION_FILE = "version.json";

/** The bytes of /version.json: the release this build's tabs compare themselves with. */
export function renderWebVersionFile(release: string): string {
  return `${JSON.stringify({ release })}\n`;
}

/**
 * Emits /version.json, the Web release this deploy publishes, so an open tab
 * can tell it is running an older one (src/utils/webVersionCheck.ts). The
 * release comes from the same identity the bundle is built with (vite.config.ts
 * defines it as __RAFT_FRONTEND_RELEASE_IDENTITY__'s releaseId), so it is the
 * one the new tabs carry; a build without one publishes the Web version.
 */
export function webVersionFilePlugin(identity: FrontendReleaseIdentity): Plugin {
  let release = "";
  return {
    name: "raft-web-version-file",
    apply: "build",
    configResolved(config) {
      release = resolveWebRelease(identity.releaseId, config.env);
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: WEB_VERSION_FILE, source: renderWebVersionFile(release) });
    },
  };
}

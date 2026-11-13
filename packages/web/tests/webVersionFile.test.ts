import assert from "node:assert/strict";
import { version as packageVersion } from "../package.json";
import { resolveFrontendReleaseIdentity } from "../scripts/frontendReleaseIdentity";
import { webVersionFilePlugin } from "../scripts/webVersionFile";

// /version.json publishes the release the build's own tabs carry: the frontend
// release id (VITE_FRONTEND_RELEASE_ID, else VITE_COMMIT_SHA), the identity
// vite.config.ts also defines into the bundle; without one, the Web version.

type Emitted = { type: string; fileName: string; source: string };

function emitFor(buildEnv: Record<string, string>): Emitted[] {
  const plugin = webVersionFilePlugin(resolveFrontendReleaseIdentity(buildEnv));
  const emitted: Emitted[] = [];
  (plugin.configResolved as unknown as (config: { env: Record<string, string> }) => void)({ env: buildEnv });
  (plugin.generateBundle as unknown as (this: { emitFile: (file: Emitted) => string }) => void).call({
    emitFile: (file) => {
      emitted.push(file);
      return "version-json";
    },
  });
  return emitted;
}

const SHA = "2d5f9c0cb89af6250974d29aa598cae5e18607d3";

test("emits version.json with the build's frontend release id", () => {
  const [file] = emitFor({ VITE_FRONTEND_RELEASE_ID: " web-2026.11.05-1 ", VITE_COMMIT_SHA: SHA, VITE_APP_VERSION: "1.21.54" });
  assert.equal(file.type, "asset");
  assert.equal(file.fileName, "version.json");
  assert.deepEqual(JSON.parse(file.source), { release: "web-2026.11.05-1" });
});

test("falls back to the commit SHA", () => {
  const [file] = emitFor({ VITE_COMMIT_SHA: SHA });
  assert.deepEqual(JSON.parse(file.source), { release: SHA });
});

test("without either, the Web version (a local build; its tabs do not check)", () => {
  assert.deepEqual(JSON.parse(emitFor({ VITE_APP_VERSION: "1.21.54-local" })[0].source), { release: "1.21.54-local" });
  assert.deepEqual(JSON.parse(emitFor({})[0].source), { release: packageVersion });
});

test("only in a build", () => {
  assert.equal(webVersionFilePlugin(resolveFrontendReleaseIdentity({})).apply, "build");
});

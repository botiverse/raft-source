import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Pre-publish artifact guard. Added after @botiverse/raft-daemon@0.57.7 was
// found published as an empty husk on npm (tarball = package.json only — no
// dist, no bins; publish ran without a build). Runs AFTER build, BEFORE
// publish: asserts the packed tarball actually contains the dist entries and
// no workspace-protocol dependency leaked.

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// --ignore-scripts: packages/daemon has a `prepack` build script whose stdout
// would pollute the --json payload. The workflow builds explicitly before
// running this guard, so the file list is identical either way.
function extractFirstJsonValue(raw) {
  const objectStart = raw.indexOf("{");
  const arrayStart = raw.indexOf("[");
  const starts = [objectStart, arrayStart].filter((index) => index !== -1);
  const start = Math.min(...starts);
  if (start === -1) {
    throw new Error(`npm pack --json output did not contain JSON: ${raw}`);
  }

  const open = raw[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const char = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }

  throw new Error(`npm pack --json output contained unterminated JSON: ${raw}`);
}

const raw = execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json", "--loglevel=error"], {
  cwd: root,
  encoding: "utf8",
});
const out = JSON.parse(extractFirstJsonValue(raw));
const pack = Array.isArray(out) ? out[0] : Object.values(out)[0];
const files = pack?.files?.map((f) => f.path) ?? [];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(files.length > 2, `packed artifact has only ${files.length} file(s) — looks like an unbuilt husk: ${files.join(", ")}`);
assert(files.includes("dist/index.js"), "packed artifact must contain the built dist entry");
assert(files.includes("dist/core.js"), "packed artifact must contain the core export entry");
assert(files.includes("dist/raft-daemon.js"), "packed artifact must contain the raft-daemon bin wrapper");
assert(files.includes("dist/slock-daemon.js"), "packed artifact must contain the slock-daemon bin wrapper (legacy shim deep-imports it)");
assert(files.includes("package.json"), "packed artifact must contain package.json");

const pkgJson = JSON.parse(execFileSync("node", ["-p", "JSON.stringify(require('./package.json').dependencies||{})"], { cwd: root, encoding: "utf8" }));
assert(!Object.values(pkgJson).some((v) => String(v).startsWith("workspace:")), "packed artifact must not carry workspace-protocol dependencies (use pnpm publish/pack, not npm)");

console.log(`@botiverse/raft-daemon packed artifact is valid (${files.length} files).`);

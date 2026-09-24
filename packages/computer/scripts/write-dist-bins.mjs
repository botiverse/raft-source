import { chmodSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Post-tsup step: write the thin published bin wrapper for
// @botiverse/raft-computer.
//
// The wrappers must CALL runCliAsMain(), not just `import` the entry:
// dist/index.js has an import-safe main guard keyed on process.argv[1],
// which is the wrapper's own path here — a bare import would be a silent
// no-op bin (exit 0, no output).

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(root, "dist");

const path = join(distDir, "raft-computer.js");
writeFileSync(path, '#!/usr/bin/env node\nconst { runCliAsMain } = await import("./index.js");\nrunCliAsMain();\n');
chmodSync(path, 0o755);

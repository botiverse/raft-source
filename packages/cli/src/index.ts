import { enforceSupportedNodeRuntime } from "./runtimePreflight.js";

enforceSupportedNodeRuntime();

void import("./main.js").catch((err: unknown) => {
  process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});

#!/usr/bin/env node
import { DaemonCore, DAEMON_CLI_USAGE, parseDaemonCliArgs } from "./core";
import { CONTEXT_VIEW_RESTORE_CHILD_MODE, runContextViewRestoreChildMain } from "./agentContextView/contextViewRestoreChild";
import { RUNTIME_DETECTION_CHILD_MODE, runRuntimeDetectionChildMain } from "./runtimeDetectionChild";
import { privacyModeFromEnv } from "@botiverse/raft-shared";

// task #1268: `<daemon> __detect-runtimes` is the detection child the running
// daemon spawns for one runtime detection round (streams JSON lines, exits).
if (process.argv[2] === CONTEXT_VIEW_RESTORE_CHILD_MODE) {
  void runContextViewRestoreChildMain().then((code) => process.exit(code));
} else if (process.argv[2] === RUNTIME_DETECTION_CHILD_MODE) {
  void runRuntimeDetectionChildMain().then((code) => process.exit(code));
} else {
  runDaemonMain();
}

function runDaemonMain(): void {
const parsedArgs = parseDaemonCliArgs(process.argv.slice(2));

if (!parsedArgs) {
  console.error(DAEMON_CLI_USAGE);
  process.exit(1);
}

let daemon: DaemonCore;
try {
  // RAFT_PRIVACY_MODE: read once; an invalid value stops startup.
  daemon = new DaemonCore({ ...parsedArgs, localTrace: true, privacyMode: privacyModeFromEnv(process.env) });
  daemon.start();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const shutdown = async (signal: NodeJS.Signals) => {
  await daemon.stop({ source: "external_signal", signal });
  process.exit(0);
};

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
}

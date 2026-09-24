#!/usr/bin/env node
import { DaemonCore, DAEMON_CLI_USAGE, parseDaemonCliArgs } from "./core.js";

const parsedArgs = parseDaemonCliArgs(process.argv.slice(2));

if (!parsedArgs) {
  console.error(DAEMON_CLI_USAGE);
  process.exit(1);
}

const daemon = new DaemonCore({ ...parsedArgs, localTrace: true });
try {
  daemon.start();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const shutdown = async () => {
  await daemon.stop();
  process.exit(0);
};

process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});

// `raft-computer logs` — CLI presenter over `api.logs`. Per-server scope: a
// Computer manages N daemons, each with its own log; `logs` picks one server's
// log per invocation (or the global service log with `--service`).
//
// Server selection (the v4 ambient rule) is resolved presenter-side via
// `resolveTargetServerId`; the api takes a concrete serverId. The api returns
// the trailing (already secret-redacted) lines — every emitted line is passed
// through `redactSecrets()` so a daemon that accidentally logs a credential
// still cannot surface it via this command. The api throws `NO_DAEMON_LOG`
// when the target log is absent; `present()` maps it to the shared stderr
// error contract.
import { resolveRaftHome } from "./paths.js";
import { resolveTargetServerId } from "./targetServer.js";
import { info, present } from "./output.js";
import { createComputerApi } from "./lib/api.js";

export async function runLogs(opts: {
  lines?: number;
  server?: string | null;
  service?: boolean;
}): Promise<void> {
  const serverId = opts.service ? undefined : await resolveTargetServerId({ server: opts.server });
  const api = createComputerApi(resolveRaftHome());
  await present(async () => {
    const lines = await api.logs({
      lines: opts.lines,
      service: !!opts.service,
      ...(serverId ? { serverId } : {}),
    });
    for (const line of lines) info(line);
  });
}

// `raft-computer attach <serverSlug>` — CLI presenter over the ComputerApi
// (CLI-over-lib convergence). The pure logic lives in `lib/api.ts`
// (`api.attach` drives the AttachService — fail-closed preflight, secret-free
// events, the ATTACH_* closed-set codes). This presenter supplies the EVENT
// SINK (`onEvent`) that maps attach events → `info()` lines, and `present()`
// maps a thrown `ComputerError` → the shared stderr error contract. All §6/§9
// closed-set codes and user-visible info() strings stay byte-identical.
import { info, present } from "./output.js";
import { resolveRaftHome } from "./paths.js";
import { formatServerSlugDisplay } from "./serverState.js";
import { createComputerApi } from "./lib/api.js";

export async function runAttach(opts: {
  serverSlug: string;
  serverUrl?: string;
  name?: string;
  start?: boolean;
  foreground?: boolean;
  orchestrated?: boolean;
}): Promise<void> {
  const api = createComputerApi(resolveRaftHome());
  await present(async () => {
    await api.attach(
      { serverSlug: opts.serverSlug, serverUrl: opts.serverUrl, name: opts.name },
      (event) => {
        if (event.kind === "attach.attaching") {
          info(`Attaching this machine to server ${formatServerSlugDisplay(event.serverSlug)}…`);
        } else if (event.kind === "attach.preflight") {
          info(event.resumed ? "Resumed existing attachment; running preflight…" : "Attachment issued; running preflight…");
        } else if (event.kind === "attach.attached") {
          info(`Attached. Computer state written to ${event.attachmentPath}`);
          info(`  server:        ${formatServerSlugDisplay(event.serverSlug)}`);
          info(`  serverMachine: ${event.serverMachineId}`);
        }
      },
    );
  });

  if (opts.orchestrated) {
    return;
  }
  if (opts.start === false) {
    info("Next: run `raft-computer start` to run it in the background.");
  } else {
    // `attach` writes local state only; the resident process is started
    // explicitly by `start` (its own lifecycle / pidfile). Auto-spawn on
    // attach is intentionally not coupled here.
    info("Next: run `raft-computer start` (background) — closing the terminal is fine.");
  }
}

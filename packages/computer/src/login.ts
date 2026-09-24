// `raft-computer login` / `logout` — CLI presenters over the ComputerApi
// (CLI-over-lib convergence). The pure logic lives in `lib/api.ts`
// (`api.login` drives the device-code LoginService; `api.logout` clears the
// user session). These presenters supply the EVENT SINK (`onEvent`) that maps
// the device-code/approved events to `info()` lines, and `present()` maps a
// thrown `ComputerError` → the shared stderr error contract.
// §6 closed-set error codes stay byte-identical.
import { canInstallEnterToOpenUrl, installEnterToOpenUrl, openUrlInBrowser } from "./browserHandoff.js";
import { info, present } from "./output.js";
import { resolveRaftHome } from "./paths.js";
import { createComputerApi } from "./lib/api.js";

export type RunLoginOptions = {
  serverUrl?: string;
  orchestrated?: boolean;
  input?: NodeJS.ReadableStream;
  openUrl?: (url: string) => void;
};

export async function runLogin(opts: RunLoginOptions): Promise<void> {
  const api = createComputerApi(resolveRaftHome());
  const input = opts.input ?? process.stdin;
  const openUrl = opts.openUrl ?? openUrlInBrowser;
  let cleanupEnterToOpen: (() => void) | undefined;
  await present(async () => {
    try {
      await api.login({ serverUrl: opts.serverUrl }, (event) => {
        if (event.kind === "login.device-code") {
          let browserOpenRequested = false;
          try {
            openUrl(event.verifyUrl);
            browserOpenRequested = true;
          } catch {
            // Best-effort convenience only. The URL/code are still printed.
          }

          // Action-first ordering (ghostex case: user skimmed past the URL
          // to "Waiting…"). The sign-in URL leads; the code is the "if the
          // page asks" secondary; keep-running comes last. The URL lands on
          // the account-level /login/device page — device approval is
          // user-scoped, so we never point at a server-scoped surface (e.g. a
          // Connect Computer dialog) to approve it.
          const enterOpensBrowser = canInstallEnterToOpenUrl(input);
          info("To finish signing in, open this link in a browser:");
          info(`  ${event.verifyUrl}`);
          if (browserOpenRequested) {
            info(
              enterOpensBrowser
                ? "  (opened automatically — if it didn't, press Enter to open it again)"
                : "  (opened automatically — open it on any device, including your phone, if it didn't)",
            );
          } else {
            info(
              enterOpensBrowser
                ? "  (press Enter to open it, or open it on any device including your phone)"
                : "  (open it on any device, including your phone)",
            );
          }
          info(`If the page asks for a code: ${event.userCode}`);
          info(`Keep this command running — sign-in completes here automatically (expires in ${event.expiresInSeconds}s).`);
          if (enterOpensBrowser) {
            cleanupEnterToOpen = installEnterToOpenUrl({ input, url: event.verifyUrl, openUrl });
          }
        } else if (event.kind === "login.approved" && !opts.orchestrated) {
          info(`Logged in. User session written to ${event.sessionPath}`);
          info(`Next: run \`raft-computer attach <serverSlug>\` to attach this machine.`);
        }
      });
    } finally {
      cleanupEnterToOpen?.();
    }
  });
}

// `raft-computer logout` — sign out this Computer's user identity (one user
// identity per SLOCK_HOME). Clears the user-session.json file AND stops the
// service so every per-server runner exits — sign-out disconnects every
// workspace Computer (the web shows them offline). Per-server attachments (and
// their sk_computer_* credentials) are NEVER deleted, so a later re-login
// resumes the SAME Computers. Idempotent: a missing session file
// (ENOENT) means "already logged out" and is treated as success.
export async function runLogout(): Promise<void> {
  const api = createComputerApi(resolveRaftHome());
  await present(async () => {
    const result = await api.logout();
    if (result.status === "logged-out") {
      info(`Logged out. Cleared user session at ${result.sessionPath}.`);
    } else {
      info("Already logged out (no saved user session).");
    }
    if (result.runnersStopped === "stopped") {
      info("Stopped the service — every workspace Computer is now offline. Re-login to bring them back online.");
    }
  });
}

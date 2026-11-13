// `raft-computer login` / `logout` — CLI presenters over the ComputerApi
// (CLI-over-lib convergence).
//
// Device-auth design v2 §3.2: a machine no longer keeps a user session. It
// joins each server with a one-time approval (`raft-computer attach`).
//   - `login` stays so old docs and scripts keep working: it says so, then
//     runs the approval flow (the server is picked on the approval page). On
//     a server older than one-time approvals that flow signs in with a user
//     session exactly as `login` did before.
//   - `logout` changes nothing (no session to end, nothing revoked, nothing
//     stopped): turning an existing command into one that takes the machine
//     offline would break old scripts.
//   - `runSessionLogin` is the user-session login itself, kept for setup's
//     legacy-daemon migration branch on a server too old for its one-time
//     `computer_migrate` approval (services/migrateGrant.ts).
// §6 closed-set error codes stay byte-identical.
import { presentAttachEvent, presentDeviceCode } from "./deviceApprovalPrompt";
import { info, present } from "./output";
import { resolveRaftHome } from "./paths";
import { createComputerApi } from "./lib/api";

export type RunLoginOptions = {
  serverUrl?: string;
  orchestrated?: boolean;
  input?: NodeJS.ReadableStream;
  openUrl?: (url: string) => void;
};

/** `raft-computer login`: points at `attach`, then runs its approval flow. */
export async function runLogin(opts: Omit<RunLoginOptions, "orchestrated">): Promise<void> {
  const api = createComputerApi(resolveRaftHome());
  let cleanupEnterToOpen: (() => void) | undefined;
  info("Note: `raft-computer login` is no longer a separate step. Use `raft-computer attach /<server>`: it asks for one approval and connects this machine to that server.");
  info("Continuing as attach; choose the server on the approval page.");
  const signedIn: { sessionPath: string | null } = { sessionPath: null };
  await present(async () => {
    try {
      const result = await api.approveMachine({ serverUrl: opts.serverUrl }, (event) => {
        if (event.kind === "login.device-code") {
          cleanupEnterToOpen = presentDeviceCode(event, {
            purpose: "approval",
            ...(opts.input ? { input: opts.input } : {}),
            ...(opts.openUrl ? { openUrl: opts.openUrl } : {}),
          });
          return;
        }
        if (event.kind === "attach.attaching" || event.kind === "attach.session-fallback") {
          // Approved: the Enter-to-open listener is no longer useful.
          cleanupEnterToOpen?.();
          cleanupEnterToOpen = undefined;
        }
        if (event.kind === "attach.session-fallback") {
          // An older server: this is the old login, word it as before.
          signedIn.sessionPath = event.sessionPath;
          return;
        }
        presentAttachEvent(event);
      });
      if (result.outcome === "signed-in") signedIn.sessionPath = result.sessionPath;
    } finally {
      cleanupEnterToOpen?.();
    }
  });
  if (signedIn.sessionPath) {
    info("This server does not support one-time approvals yet, so this machine signed in with a user session instead.");
    info(`Logged in. User session written to ${signedIn.sessionPath}`);
    info(`Next: run \`raft-computer attach <serverSlug>\` to attach this machine.`);
    return;
  }
  info("Next: run `raft-computer start` (background) — closing the terminal is fine.");
}

/**
 * The user-session device login (writes user-session.json). Only setup's
 * legacy-daemon migration branch still runs it, and only against a server
 * that refuses the `computer_migrate` grant kind (older than it).
 */
export async function runSessionLogin(opts: RunLoginOptions): Promise<void> {
  const api = createComputerApi(resolveRaftHome());
  let cleanupEnterToOpen: (() => void) | undefined;
  await present(async () => {
    try {
      await api.login({ serverUrl: opts.serverUrl }, (event) => {
        if (event.kind === "login.device-code") {
          cleanupEnterToOpen = presentDeviceCode(event, {
            purpose: "sign-in",
            ...(opts.input ? { input: opts.input } : {}),
            ...(opts.openUrl ? { openUrl: opts.openUrl } : {}),
          });
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

// `raft-computer logout` — there is no session to end in the one-time
// approval model, so it changes nothing: no file is deleted, nothing is
// revoked on the server, the service keeps running. Taking this machine off
// one server is done on that server's Computers page (per-Computer revoke).
export async function runLogout(): Promise<void> {
  info("Nothing to log out of: this machine joins each server with a one-time approval and keeps no sign-in. Nothing was changed, and every connected server stays connected.");
  info("To take this machine off a server, run `raft-computer detach /<server>`.");
}

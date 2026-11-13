// CLI entry point.
//
// Resource-based command surface (singular nouns per v0 spec
// thread #slock-cli:75b30164):
//   raft auth whoami
//   raft version
//   raft server info
//   raft channel members "#name"
//   raft channel create --name <name>
//   raft channel update --target "#name" --name <new-name>
//   raft channel archive --target "#name"
//   raft channel unarchive --target "#name"
//   raft channel add-member --target "#name" --user @name
//   raft channel remove-member --target "#name" --user @name
//   raft channel join --target "#name"
//   raft channel leave --target "#name"
//   raft channel mute --target "#name"
//   raft channel unmute --target "#name"
//   raft thread list
//   raft thread unfollow --target "#name:shortid"
//   raft manual get <topic>
//   raft manual search <keywords>
//   raft context search/read
//   raft inbox check/read/dismiss
//   raft message send/check/read/search/resolve/react/update-card
//   raft attachment upload/view
//   raft task list/create/claim/unclaim/assign/unassign/update/amend/history/convert/delete
//   raft mention pending/notify/invite
//   raft profile show/update
//   raft integration list/marketplace/login/env/invoke/app prepare|rotate-secret|update|transfer-owner
//   raft reminder schedule/list/cancel/snooze/update/log/trigger
//   raft action prepare/withdraw
//   raft migration retry
//   raft proc start/list/logs/stop

import { CliError } from "./core/errors";
import { defaultCliIo } from "./core/io";
import { forwardManagedTransportIfNeeded, ManagedTransportError } from "./auth/managedTransport";
import { installStdoutEpipeGuard } from "./core/stdoutEpipe";
import { buildRaftProgram, handleRaftCliError, runRaftArgv } from "./program";

// The command tree, root options and parse-stage error mapping live in
// program.ts (side-effect free, shared with tests); this module is the process
// entry: managed-transport forwarding, stdout EPIPE guard, exit code.
const program = buildRaftProgram();

function setExitCode(exitCode: number): void {
  // Leave process.exitCode untouched on success, as before the extraction.
  if (exitCode !== 0) process.exitCode = exitCode;
}

async function runCli(): Promise<void> {
  // A login/interactive shell may rewrite PATH after the daemon prepended its
  // per-launch wrapper. If that selects a host-global CLI, route back to the
  // exact daemon-owned current-launch wrapper before parsing any command or
  // reading an ambient profile. The wrapper-authenticated child carries a
  // proxy/token-file marker, so it does not recurse.
  const forwarded = await forwardManagedTransportIfNeeded(process.argv.slice(2), process.env);
  if (forwarded) {
    if (forwarded.signal) {
      // The forwarding listeners have been removed. Preserve signal-based
      // termination for shell callers instead of turning every signal into 1.
      process.kill(process.pid, forwarded.signal);
      return;
    }
    process.exitCode = forwarded.status ?? 1;
  } else {
    setExitCode(await runRaftArgv(program, process.argv, defaultCliIo()));
  }
}

installStdoutEpipeGuard(process.stdout);

void runCli().catch((err: unknown) => {
  if (err instanceof ManagedTransportError) {
    setExitCode(handleRaftCliError(new CliError({
      code: err.code as "MANAGED_WRAPPER_UNAVAILABLE" | "MANAGED_WRAPPER_REQUIRED" | "MANAGED_WRAPPER_FORWARD_FAILED",
      message: err.message,
      cause: err,
      suggestedNextAction: "Restart the managed runtime; no local profile was used.",
    }), program, process.argv));
  } else {
    setExitCode(handleRaftCliError(err, program, process.argv));
  }
});

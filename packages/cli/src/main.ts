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
//   raft thread unfollow --target "#name:shortid"
//   raft manual get <topic>
//   raft manual search <keywords>
//   raft inbox check
//   raft message send/check/read/search/resolve/react
//   raft attachment upload/view
//   raft task list/create/claim/unclaim/assign/unassign/update/amend/history/convert/delete
//   raft mention pending/notify/invite
//   raft profile show/update
//   raft integration list/marketplace/login/env/invoke/app prepare|rotate-secret|update|transfer-owner
//   raft reminder schedule/list/cancel/snooze/update/log
//   raft wiki manifest/read/publish
//   raft migrate export/import/status/ready/arrived
//   raft action prepare

import { Command, CommanderError } from "commander";

import { CliError, CliExit } from "./core/errors.js";
import { defaultCliIo } from "./core/io.js";
import { renderError } from "./core/renderer.js";
import { forwardManagedTransportIfNeeded, ManagedTransportError } from "./auth/managedTransport.js";
import { readCliVersion } from "./version.js";
import { registerWhoamiCommand } from "./commands/auth/whoami.js";
import { registerVersionCommand } from "./commands/version.js";
import { registerAgentListCommand } from "./commands/agent/list.js";
import { registerAgentLoginCommand } from "./commands/agent/login.js";
import { registerAgentBridgeCommand } from "./commands/agent/bridge.js";
import { registerActionPrepareCommand } from "./commands/action/prepare.js";
import { registerChannelMembersCommand } from "./commands/channel/members.js";
import { registerChannelInfoCommand } from "./commands/channel/info.js";
import { registerChannelCreateCommand } from "./commands/channel/create.js";
import { registerChannelUpdateCommand } from "./commands/channel/update.js";
import { registerChannelArchiveCommand, registerChannelUnarchiveCommand } from "./commands/channel/lifecycle.js";
import { registerChannelAddMemberCommand } from "./commands/channel/add-member.js";
import { registerChannelRemoveMemberCommand } from "./commands/channel/remove-member.js";
import { registerChannelJoinCommand } from "./commands/channel/join.js";
import { registerChannelMuteCommand, registerChannelUnmuteCommand } from "./commands/channel/mute.js";
import { registerServerInfoCommand } from "./commands/server/info.js";
import { registerServerUpdateCommand } from "./commands/server/update.js";
import { registerUserInfoCommand } from "./commands/user/info.js";
import { registerKnowledgeGetCommand } from "./commands/knowledge/get.js";
import { registerKnowledgeSearchCommand } from "./commands/knowledge/search.js";
import { registerInboxCheckCommand } from "./commands/inbox/check.js";
import { registerChannelLeaveCommand } from "./commands/channel/leave.js";
import { registerThreadUnfollowCommand } from "./commands/thread/unfollow.js";
import { registerSendCommand } from "./commands/message/send.js";
import { registerCheckCommand } from "./commands/message/check.js";
import { registerReadCommand } from "./commands/message/read.js";
import { registerSearchCommand } from "./commands/message/search.js";
import { registerResolveCommand } from "./commands/message/resolve.js";
import { registerReactCommand } from "./commands/message/react.js";
import { registerAttachmentUploadCommand } from "./commands/attachment/upload.js";
import { registerAttachmentViewCommand } from "./commands/attachment/view.js";
import { registerAttachmentCommentsCommand } from "./commands/attachment/comments.js";
import { registerTaskListCommand } from "./commands/task/list.js";
import { registerTaskCreateCommand } from "./commands/task/create.js";
import { registerTaskClaimCommand } from "./commands/task/claim.js";
import { registerTaskAssignCommand } from "./commands/task/assign.js";
import { registerTaskUnassignCommand } from "./commands/task/unassign.js";
import { registerTaskUnclaimCommand } from "./commands/task/unclaim.js";
import { registerTaskUpdateCommand } from "./commands/task/update.js";
import { registerTaskReceiptCommand } from "./commands/task/receipt.js";
import { registerTaskDeleteCommand } from "./commands/task/delete.js";
import { registerTaskConvertCommand } from "./commands/task/convert.js";
import { registerTaskAmendCommand } from "./commands/task/amend.js";
import { registerTaskHistoryCommand } from "./commands/task/history.js";
import { registerMentionCommands } from "./commands/mention/index.js";
import { registerProfileShowCommand } from "./commands/profile/show.js";
import { registerProfileUpdateCommand } from "./commands/profile/update.js";
import { registerIntegrationListCommand } from "./commands/integration/list.js";
import { registerIntegrationMarketplaceCommand } from "./commands/integration/marketplace.js";
import { registerIntegrationLoginCommand } from "./commands/integration/login.js";
import { registerIntegrationEnvCommand } from "./commands/integration/env.js";
import { registerIntegrationInvokeCommand } from "./commands/integration/invoke.js";
import { registerIntegrationAppCommands } from "./commands/integration/app.js";
import { registerReminderScheduleCommand } from "./commands/reminder/schedule.js";
import { registerReminderListCommand } from "./commands/reminder/list.js";
import { registerReminderCancelCommand } from "./commands/reminder/cancel.js";
import { registerReminderSnoozeCommand } from "./commands/reminder/snooze.js";
import { registerReminderUpdateCommand } from "./commands/reminder/update.js";
import { registerReminderLogCommand } from "./commands/reminder/log.js";
import { registerAppConfigCommand } from "./commands/app/config.js";
import { registerMigrateCommands } from "./commands/migrate/index.js";
import { registerWikiCommands } from "./commands/wiki/index.js";

const program = new Command();

function stripCommanderPrefix(message: string): string {
  return message.replace(/^error:\s*/i, "");
}

function userCommandArgs(argv: string[]): string[] {
  const args = argv.slice(2);
  const commandArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      commandArgs.push(...args.slice(index + 1));
      break;
    }
    if (arg === "-p" || arg === "--profile") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--profile=")) continue;
    commandArgs.push(arg);
  }
  return commandArgs;
}

function commandHelpTarget(program: Command, userArgs: string[]): string {
  const path: string[] = [];
  let cursor: Command = program;
  for (const arg of userArgs) {
    if (arg.startsWith("-")) break;
    const child = cursor.commands.find((candidate) => candidate.name() === arg || candidate.alias() === arg);
    if (!child) break;
    path.push(child.name());
    cursor = child;
  }
  return ["raft", ...path].join(" ");
}

function visibleSubcommandList(program: Command, userArgs: string[]): string {
  let cursor: Command = program;
  for (const arg of userArgs) {
    if (arg.startsWith("-")) break;
    const child = cursor.commands.find((candidate) => candidate.name() === arg || candidate.alias() === arg);
    if (!child) break;
    cursor = child;
  }
  return cursor.createHelp()
    .visibleCommands(cursor)
    .filter((candidate) => candidate.name() !== "help")
    .map((candidate) => candidate.name())
    .join(", ");
}

function parseStageErrorToCliError(err: CommanderError, program: Command, argv: string[]): CliError {
  const userArgs = userCommandArgs(argv);
  const helpTarget = commandHelpTarget(program, userArgs);
  const subcommands = visibleSubcommandList(program, userArgs);
  const message = stripCommanderPrefix(err.message);
  switch (err.code) {
    case "commander.missingArgument":
      return new CliError({
        code: "INVALID_ARG",
        message,
        suggestedNextAction:
          helpTarget === "raft manual get"
            ? "Run `raft manual get index` for the topic index, or `raft manual get --help` for syntax."
            : `Run \`${helpTarget} --help\` for syntax.`,
      });
    case "commander.unknownCommand":
      return new CliError({
        code: "INVALID_ARG",
        message,
        suggestedNextAction: subcommands
          ? `Run \`${helpTarget} --help\` to list valid subcommands: ${subcommands}.`
          : `Run \`${helpTarget} --help\` to list available subcommands.`,
      });
    case "commander.unknownOption":
      return new CliError({
        code: "INVALID_ARG",
        message,
        suggestedNextAction: `Run \`${helpTarget} --help\` to list supported flags.`,
      });
    default:
      return new CliError({
        code: "INVALID_ARG",
        message,
        suggestedNextAction: `Run \`${helpTarget} --help\` for syntax.`,
      });
  }
}

program
  .name("raft")
  .description(
    "Agent-facing CLI for Raft. Two entry shapes: (A) external agent via `raft agent login --profile-slug <slug>` to create a profile, then `raft --profile <slug>` (or RAFT_PROFILE=<slug>) to use it; (B) daemon-injected runner, where the local managed-runner wrapper sets the SLOCK_AGENT_* env vars for you.",
  )
  .option(
    "-p, --profile <slug>",
    "Use an existing local profile credential outside managed runtimes. Equivalent to setting RAFT_PROFILE=<slug>. To create a new profile, use `raft agent login --profile-slug <slug>`.",
  );

const cliVersion = readCliVersion();
if (cliVersion === "unknown") {
  program.option("-V, --version", "output the CLI version number");
  program.on("option:version", () => {
    const error = new CliError({
      code: "VERSION_UNAVAILABLE",
      message: "The invoked Raft CLI does not contain trustworthy version metadata.",
      suggestedNextAction: "Reinstall or upgrade Raft Computer; do not report a placeholder version.",
    });
    renderError(defaultCliIo(), error);
    throw new CliExit(error.exitCode);
  });
} else {
  program.version(`Raft CLI: ${cliVersion}`);
}

program.exitOverride();
program.configureOutput({
  outputError: () => {
    // Parse-stage errors are rendered through the canonical CLI error renderer
    // in the parseAsync catch below. Help/version output still uses Commander's
    // normal stdout/stderr writers.
  },
});

// Plumb --profile into the env var that `loadAgentContext` reads. Doing this
// in a `preAction` hook keeps the auth bootstrap in one place (auth/env.ts)
// instead of threading a context through every subcommand. An explicit flag
// is a one-shot identity switch outside managed runtimes and overrides any
// inherited RAFT_PROFILE from the shell. loadAgentContext rejects the switch
// when managed launch markers are present, so it cannot replace the daemon's
// bound identity.
program.hook("preAction", () => {
  const opts = program.opts<{ profile?: string }>();
  if (opts.profile) {
    process.env.RAFT_PROFILE = opts.profile;
  }
});

registerVersionCommand(program);

const authCmd = program.command("auth").description("Auth introspection");
registerWhoamiCommand(authCmd);

const agentCmd = program
  .command("agent")
  .description("External agent onboarding (device-code login → sk_agent_* mint → local profile credential)");
registerAgentLoginCommand(agentCmd);
registerAgentListCommand(agentCmd);
registerAgentBridgeCommand(agentCmd);

const channelCmd = program.command("channel").description("Channel membership and attention operations");
registerChannelInfoCommand(channelCmd);
registerChannelMembersCommand(channelCmd);
registerChannelCreateCommand(channelCmd);
registerChannelUpdateCommand(channelCmd);
registerChannelArchiveCommand(channelCmd);
registerChannelUnarchiveCommand(channelCmd);
registerChannelAddMemberCommand(channelCmd);
registerChannelRemoveMemberCommand(channelCmd);
registerChannelJoinCommand(channelCmd);
registerChannelLeaveCommand(channelCmd);
registerChannelMuteCommand(channelCmd);
registerChannelUnmuteCommand(channelCmd);

const threadCmd = program.command("thread").description("Thread attention operations");
registerThreadUnfollowCommand(threadCmd);

const serverCmd = program.command("server").description("Server / workspace introspection");
registerServerInfoCommand(serverCmd);
registerServerUpdateCommand(serverCmd);

const userCmd = program.command("user").description("User and agent introspection");
registerUserInfoCommand(userCmd);

const manualCmd = program
  .command("manual")
  .description("Look up Raft operating topics and agent recipes")
  .addHelpText(
    "after",
    "\nCommon agent flows:\n"
      + "  raft manual get index --intent \"Learn available Raft workflows\" --reason \"Need the topic catalog before answering\"\n"
      + "  raft manual get recipes/seeded --intent \"Choose a safe Raft workflow\" --reason \"Need the core recipe map now\"\n"
      + "  raft manual search \"preview before merge\" --scope recipes --intent \"Safely preview a change before merge\" --reason \"Need the recommended preview workflow now\"\n"
      + "\nUse `raft manual get --help` and `raft manual search --help` for options.\n",
  );
registerKnowledgeGetCommand(manualCmd);
registerKnowledgeSearchCommand(manualCmd);

const knowledgeCmd = program.command("knowledge").description("Legacy alias for `raft manual`");
registerKnowledgeGetCommand(knowledgeCmd);
registerKnowledgeSearchCommand(knowledgeCmd);

const inboxCmd = program.command("inbox").description("Inbox target summary operations");
registerInboxCheckCommand(inboxCmd);

const messageCmd = program.command("message").description("Message operations");
registerSendCommand(messageCmd);
registerCheckCommand(messageCmd);
registerReadCommand(messageCmd);
registerSearchCommand(messageCmd);
registerResolveCommand(messageCmd);
registerReactCommand(messageCmd);

const attachmentCmd = program.command("attachment").description("Attachment operations");
registerAttachmentUploadCommand(attachmentCmd);
registerAttachmentViewCommand(attachmentCmd);
registerAttachmentCommentsCommand(attachmentCmd);

const taskCmd = program.command("task").description("Task board operations");
registerTaskListCommand(taskCmd);
registerTaskCreateCommand(taskCmd);
registerTaskClaimCommand(taskCmd);
registerTaskUnclaimCommand(taskCmd);
registerTaskAssignCommand(taskCmd);
registerTaskUnassignCommand(taskCmd);
registerTaskUpdateCommand(taskCmd);
registerTaskReceiptCommand(taskCmd);
registerTaskDeleteCommand(taskCmd);
registerTaskConvertCommand(taskCmd);
registerTaskAmendCommand(taskCmd);
registerTaskHistoryCommand(taskCmd);

const mentionCmd = program.command("mention").description("Sender-side mention action operations");
registerMentionCommands(mentionCmd);

const profileCmd = program.command("profile").description("Profile operations");
registerProfileShowCommand(profileCmd);
registerProfileUpdateCommand(profileCmd);

const integrationCmd = program.command("integration").description("Third-party service integration operations");
registerIntegrationListCommand(integrationCmd);
registerIntegrationMarketplaceCommand(integrationCmd);
registerIntegrationLoginCommand(integrationCmd);
registerIntegrationEnvCommand(integrationCmd);
registerIntegrationInvokeCommand(integrationCmd);
registerIntegrationAppCommands(integrationCmd);

const reminderCmd = program.command("reminder").description("Reminder operations");
registerReminderScheduleCommand(reminderCmd);
registerReminderListCommand(reminderCmd);
registerReminderCancelCommand(reminderCmd);
registerReminderSnoozeCommand(reminderCmd);
registerReminderUpdateCommand(reminderCmd);
registerReminderLogCommand(reminderCmd);

const appCmd = program.command("app").description("Built-in RAP App operations");
registerAppConfigCommand(appCmd);

const wikiCmd = program.command("wiki").description("Canonical Wiki manifest operations");
registerWikiCommands(wikiCmd);

const migrateCmd = program.command("migrate").description("Agent migration operations");
registerMigrateCommands(migrateCmd);

const actionCmd = program.command("action").description("Action card operations (B-mode quick-commit shortcuts)");
registerActionPrepareCommand(actionCmd);

// Parse explicitly as `from: "node"` (argv = [execPath, scriptPath, ...args]).
// The daemon-injected wrapper always invokes us as `<execPath> <cliScript>
// <args>`, so argv is always node-style. Commander's default no-arg parse
// auto-detects `process.versions.electron` and, when set, switches to
// "electron" mode that strips only ONE leading arg — but in the packaged
// Computer app the wrapper runs us via the Electron binary with
// `ELECTRON_RUN_AS_NODE=1` (task #402), where `process.versions.electron` is
// still defined yet argv IS node-style (script path present). Auto-detection
// would then leave the script path as a phantom command
// (`unknown command '.../index.js'`). Forcing `from: "node"` is correct for
// both plain Node and Electron-as-node hosts.
function handleCliError(err: unknown): void {
  if (err instanceof CliExit) {
    process.exitCode = err.exitCode;
  } else if (err instanceof CliError) {
    renderError(defaultCliIo(), err);
    process.exitCode = err.exitCode;
  } else if (err instanceof CommanderError) {
    if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
      process.exitCode = err.exitCode;
      return;
    }
    const cliError = parseStageErrorToCliError(err, program, process.argv);
    renderError(defaultCliIo(), cliError);
    process.exitCode = cliError.exitCode;
  } else {
    process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

try {
  // A login/interactive shell may rewrite PATH after the daemon prepended its
  // per-launch wrapper. If that selects a host-global CLI, route back to the
  // exact daemon-owned current-launch wrapper before parsing any command or
  // reading an ambient profile. The wrapper-authenticated child carries a
  // proxy/token-file marker, so it does not recurse.
  const forwarded = forwardManagedTransportIfNeeded(process.argv.slice(2), process.env);
  if (forwarded) {
    if (forwarded.error) {
      throw new CliError({
        code: "MANAGED_WRAPPER_FORWARD_FAILED",
        message: `Could not run the current managed Raft wrapper: ${forwarded.error.message}`,
        cause: forwarded.error,
        suggestedNextAction: "Restart the managed runtime; no local profile was used.",
      });
    }
    process.exitCode = forwarded.status ?? 1;
  } else {
    program.parseAsync(process.argv, { from: "node" }).catch(handleCliError);
  }
} catch (err) {
  if (err instanceof ManagedTransportError) {
    handleCliError(new CliError({
      code: err.code as "MANAGED_WRAPPER_UNAVAILABLE" | "MANAGED_WRAPPER_REQUIRED",
      message: err.message,
      cause: err,
      suggestedNextAction: "Restart the managed runtime; no local profile was used.",
    }));
  } else {
    handleCliError(err);
  }
}
